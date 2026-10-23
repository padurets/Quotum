import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {plotPathPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {preparationFixture} from './preparationFixture';
import {niceTicks} from '../lib/periods';

test('actual quota generators prepare outside render and retain displayed paths through replacement and cancellation', () => {
  const cellMs = 60_000, end = 720 * cellMs;
  const lines = Array.from({length: 50}, (_, i) => ({points: [...Array.from({length: 720}, (_, j) => [j * cellMs, (i + j) % 100, 1]), [end + 4500, 5, 1], [end + 15_000, 0, 1]]}));
  const hook = preparationFixture(); let calculations = 0, markerStrings = 0;
  const source = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const inputs = '), region = source.slice(start, source.indexOf('  const model = ', start))
    .replace(/latest\s*=\s*(`\$\{[^`]+`)/g, 'latest = formatLatest($1)');
  type Model = {paths: {line: string; last: [number, number] | null}[]};
  const context = {...hook, axis: {active: false}, incomingStrip: null as object | null,
    desiredFrom: 0, desiredTo: end, desiredNow: end, requested: {from: 0, to: end, end}, incomingLines: lines,
    valueAxis: undefined, stepped: false, modelContext: '', navigation: undefined, desiredLive: true, incomingReady: true, incomingPlans: [], incomingForecasts: [], incomingMarkers: [], cellMs, width: 900, height: 220, left: 40, right: 12, top: 12, bottom: 28, clipPrepared,
    plotPathPrepared: function* (...args: Parameters<typeof plotPathPrepared>) {calculations++; return yield* plotPathPrepared(...args);},
    formatLatest: (value: string) => {markerStrings++; return value;},
    draw: null as unknown as () => {value: Model | null; ready: boolean},
  };
  runInNewContext(ts.transpileModule(`function draw(){${region}\nreturn prepared;}\nglobalThis.draw=draw;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  Object.defineProperty(context.axis, 'basis', {get: () => context.requested});
  const render = () => {hook.begin(); return context.draw();};
  assert.equal(render().value, null); assert.equal(calculations, 0, 'urgent render cannot run the generator');
  hook.commit(); hook.tick(); assert.ok(calculations < 50); hook.finish();
  const current = render().value!; assert.equal(calculations, 50);
  assert.equal(markerStrings, 50, 'each line formats only its final measurement marker, without discarded strings for earlier points');
  context.desiredFrom += cellMs; context.desiredTo += cellMs; context.desiredNow += cellMs;
  context.requested = {from: context.desiredFrom, to: context.desiredTo, end: context.desiredNow};
  assert.equal(render().value, current); hook.commit(); hook.finish();
  assert.equal(render().ready, true); assert.equal(calculations, 50, 'a pure clock wake projects the existing paths without numeric preparation');
  context.desiredFrom = 0; context.desiredTo = end; context.desiredNow = end; context.requested = {from: 0, to: end, end};
  context.axis.active = true; context.desiredFrom += 9000; context.desiredTo += 9000; context.desiredNow += 9000;
  assert.equal(render().value, current, 'a new intent keeps the displayed numeric model'); hook.commit(); hook.tick();
  context.incomingStrip = {from: 0}; assert.equal(render().value, current); hook.commit(); hook.finish();
  const replacement = render().value!;
  assert.notEqual(replacement, current);
  assert.ok(replacement.paths.every(path => path.last![0] > 888), 'a matching strip admits the fresh tail on the captured scale');
  context.axis.active = false; context.incomingStrip = null;
  context.requested = {from: context.desiredFrom, to: context.desiredTo, end: context.desiredNow};
  assert.equal(render().value, replacement); hook.commit(); hook.finish();
  const final = render(); assert.equal(final.ready, true);
  assert.ok(final.value!.paths.every(path => path.last![0] === 888 && path.last![1] === 183), 'the completed frame draws the latest tail at its own edge');

  const emptyLine=source.split('\n').find(line=>line.includes('<div className="chart-empty">'))!.trim();
  const caption={model:final.value as Model|null,prepared:final,lines:lines as unknown[],empty:'All series are hidden',React:{createElement:()=>({caption:true})},show:null as unknown as ()=>unknown};
  runInNewContext(ts.transpileModule(`globalThis.show=()=>${emptyLine.slice(1,-1)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,caption);
  for(const width of [390,1280]){
    context.width=width;caption.prepared=render();caption.model=caption.prepared.value;caption.lines=[];
    assert.equal(caption.model,null,'a resize changes the preparation lifetime');
    assert.ok(!caption.show(),'pending geometry is not evidence that enabled series were hidden');
    hook.commit();hook.finish();caption.prepared=render();caption.model=caption.prepared.value;caption.lines=lines;
    assert.ok(!caption.show());
  }
  context.incomingLines=[];render();hook.commit();hook.finish();caption.prepared=render();caption.model=caption.prepared.value;caption.lines=[];
  assert.ok(caption.show(),'a completed empty model still shows the supplied empty or all-muted state');
  context.incomingLines=lines;caption.prepared=render();
  assert.ok(!caption.show(),'reenabling series cannot keep the old all-muted caption while their paths prepare');
});

test('the shared chart keeps held time labels while ordinary navigation and strips use their own range',()=>{
  const source=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8');
  const start=source.indexOf('  const tickFrom = '),region=source.slice(start,source.indexOf('  useLayoutEffect(() => {axis.commitDrawing',start));
  assert.ok(start>=0&&region.includes('niceTicks'));
  const H=3_600_000,to=Date.UTC(2026,9,23,3,17,17),basis={from:to-72*H,to};
  const context={niceTicks,strip:null as {from:number;to:number}|null,axis:{held:false},basis,from:basis.from,to:basis.to,width:400,span:72*H,read:null as unknown as ()=>number[]};
  runInNewContext(ts.transpileModule(`globalThis.read=()=>{${region}\nreturn ticks;};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const read=()=>[...context.read()],original=read();
  assert.equal(original.length,3);
  for(const period of [H,24*H,72*H]){
    context.axis.held=true;context.from=to+1000-period;context.to=to+1000;
    assert.deepEqual(read(),original,'the captured drawing owns pending timestamp labels');
    context.axis.held=false;
    assert.deepEqual(read(),niceTicks(context.from,context.to,4*period/context.span).ticks,'explicit navigation uses the requested projection');
    context.axis.held=true;context.strip={from:to-96*H,to:to+24*H};
    assert.deepEqual(read(),niceTicks(context.strip.from,context.strip.to,4*120*H/context.span).ticks,'a prepared strip still supplies its complete tick inventory');
    context.strip=null;
  }
});
