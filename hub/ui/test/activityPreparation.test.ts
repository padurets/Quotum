import {plotBar} from '../lib/historyPlot';
import {targetOf} from '../../server/domain/history';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {activityScale} from '../lib/activity';
import {plotGroupsPrepared, type PlotBuffer, type PlotGroup} from '../lib/historyPlot';
import {StackPaths} from '../lib/stackPaths';
import {groupRegistry} from '../lib/plotRegistry';
import {cellStart} from '../../server/domain/history';
import {niceTicks} from '../lib/periods';
import {navigationKey} from '../lib/axisNavigation';
import {preparationFixture} from './preparationFixture';

test('the actual activity edge painter advances clipped bars without preparing the interior again', () => {
  const source = readFileSync(new URL('../components/Activity.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const paintEdges = () => {');
  const region = source.slice(start, source.indexOf('  // Input uses the committed groups', start));
  const attributes = new Map<string, string>(), path = new Map<string, string>();
  const clips: number[][] = []; let draft: {token: number} | null = null;
  const node = (values: Map<string, string>) => ({getAttribute: (name: string) => values.get(name), setAttribute: (name: string, value: string) => values.set(name, value)});
  const context = {heights:new Map(),paintValue:()=>{},bandClip: {current: {}}, mask: {current: node(attributes)}, edges: {current: {querySelectorAll: () => [node(path)]}},
    currentActivity: {}, activity: {by: {source: [{key: 's', cells: [[0, 25_000], [60_000, 60_000], [120_000, 5_000]]}]}},
    strip: null, groups: [{group: {key: 's'}}], from: 15_000, to: 135_000, by: 'source', barMs: 60_000, vertical: {max: 60_000}, height: 100, perMs: 0.001,
    left: 0, right: 0, width: 120, scale: 1, x: (at: number) => at / 1000, y: (ms: number) => 100 - ms / 1000,
    axis: {held: false, visualGeometry: () => ({})}, pan: {get: () => draft}, painted: {current: ''}, clipPlot: (_node: unknown, ...bounds: number[]) => clips.push(bounds), cellStart,plotBar,targetOf,
    paint: null as unknown as () => void,
  };
  runInNewContext(ts.transpileModule(region + '\nglobalThis.paint=paintEdges;', {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  context.paint();
  assert.equal(attributes.get('x'), '60'); assert.equal(attributes.get('width'), '60', 'the interior is drawn from the retained paths');
  assert.equal(path.get('d'), 'M0.5,75.0H59.5V100.0H0.5ZM120.5,95.0H179.5V100.0H120.5Z');
  context.from = 30_000; context.to = 150_000;
  context.activity = {by: {source: [{key: 's', cells: [[0, 10_000], [60_000, 60_000], [120_000, 5_000]]}]}};
  context.paint();
  assert.equal(path.get('d'), 'M0.5,90.0H59.5V100.0H0.5ZM120.5,95.0H179.5V100.0H120.5Z', 'only the exact boundary height changes');
  const retained = path.get('d');
  for (const released of [false, true]) {
    draft = released ? null : {token: 1}; context.axis.held = released;
    context.from = 1_000_000; context.to = 1_120_000; clips.length = 0;
    context.paint();
    assert.deepEqual(clips, [[0, 120, 120]], 'an unread moving frame keeps the retained drawing visible until its strip arrives');
    assert.equal(path.get('d'), retained, 'the previous boundaries do not pretend to describe the gesture');
  }
});

test('actual Activity generators hold one coherent model and produce exact stacks after interrupted preparation', () => {
  const H = 3_600_000, length = 30 * 24 * H, barMs = 2 * H;
  const buffer = (start: number): PlotBuffer => {
    const activityCells: PlotBuffer['activityCells'] = new Map();
    for (let i = 0; i < 480; i++) {
      const at = start + i * barMs, parts = new Map(Array.from({length: 30}, (_, j) => [`s${j}`, {ms: at>=length?60*3_600_000:(j + 1) * 60_000, name: null}]));
      activityCells.set(at, {at, agentMs: 465 * 60_000, activeMs: 0, refs: new Set(), parts: {source: parts, project: parts, device: parts}});
    }
    return {token: 1, epoch: 1, version: start, from: start, to: start + 480 * barMs, cell: barMs, length, barMs, coverage: [[start, start + 480 * barMs]], activityCells, series: [], events: [], knownFrom: start};
  };
  const parent = preparationFixture(), child = preparationFixture(); let aggregates = 0, draws = 0, tickFrame: [number, number] = [0, 0];
  class CountedPaths extends StackPaths {override *drawPrepared(...args: Parameters<StackPaths['drawPrepared']>) {draws++; return yield* super.drawPrepared(...args);}}
  const source = readFileSync(new URL('../components/Activity.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const prepared = usePrepared(');
  const region = source.slice(start, source.indexOf('  const currentGroups=', start));
  type Model = {identities: {key: string; name: string | null}[]; shown: {group: PlotGroup; color: string; name: string}[]; strip: PlotBuffer};
  const navigation = {context: 'test', range: 'range'};
  const axis = {box: {current: null}, svg: {current: null}, width: 400, scale: 1, hover: null, drag: null, clip: 'c', handlers: {}, basis: {from: 0, to: length, end: length}, active: false, screenX: (at: number) => 48 + (at - axis.basis.from) / length * 340, commitDrawing: () => {}};
  const context = {navigationKey, React, ...parent, memo: (fn: unknown) => fn, useState: child.useState, useEffect: () => {}, seriesFocusStyle:()=>({}), useId: () => 'c',
    EMPTY_CELLS: [], registry: {current: null}, groups: [], colors: [], shown: [], strip: buffer(0), by: 'project', prefs: {muted: {}}, locale: 'en', history: {board: 'b'}, authority: 0, arrange: {view: {}}, titles: {},
    groupMuted:()=>false,groupRegistry, groupName: (group: {key: string}) => group.key, mutedKey: (_by: string, key: string) => key,
    plotGroupsPrepared: function* (...args: Parameters<typeof plotGroupsPrepared>) {aggregates++; return yield* plotGroupsPrepared(...args);},
    StackPaths: CountedPaths, stacksHeight: () => 160, activityScale, niceTicks: (...args: Parameters<typeof niceTicks>) => {tickFrame = [args[0], args[1]]; return niceTicks(...args);}, cellStart,plotBar,targetOf, MINUTE: 60_000,
    CSS: {escape: (id: string) => id}, pan: {active: () => 1, subscribe: () => () => {}}, useLocale: () => 'en',
    useTimeAxis: () => axis,
    useTip: () => ({tip: {current: null}, style: {}}), PlotLayer: () => null, PlotOverlay: () => null, Tooltip: () => null,
    clock: () => '', shortDay: () => '', workHours: () => '', stamp: () => '', t: (key: string) => key,
    prepareParent: null as unknown as () => {value: Model | null; ready: boolean}, Stacks: null as unknown as (props: object) => React.ReactNode,
  };
  runInNewContext(ts.transpileModule(`function prepareParent(){${region}\nreturn prepared;}\n${source.slice(source.indexOf('const Stacks = memo(function Stacks('))}\nglobalThis.prepareParent=prepareParent;globalThis.Stacks=Stacks;`, {compilerOptions: {target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React}}).outputText, context);
  const renderParent = () => {Object.assign(context, parent); parent.begin(); return context.prepareParent();};
  assert.equal(renderParent().value, null); assert.equal(aggregates, 0); parent.commit(); parent.finish();
  const first = renderParent().value!; assert.equal(first.identities.length, 30); assert.equal(aggregates, 1);
  const replacement = buffer(barMs); replacement.coverage = [[replacement.from, replacement.to - barMs]];
  replacement.activityCells.get(replacement.to - barMs)!.parts.project.set('pending', {ms: 60_000, name: 'New group'});
  context.strip = replacement; assert.equal(renderParent().value, first); parent.commit(); parent.tick();
  context.strip = buffer(2 * barMs); renderParent(); parent.commit(); parent.tick();
  context.strip = replacement; renderParent(); parent.commit(); parent.finish();
  const current = renderParent().value!;
  assert.equal(current.identities.find(group => group.key === 'pending')?.name, 'New group');
  assert.equal(current.shown.find(row => row.group.key === 'pending')!.group.cells.length, 0, 'an unread bar contributes no height');
  const pathsOf = (node: React.ReactNode): string[] => {
    if (Array.isArray(node)) return node.flatMap(pathsOf);
    if (!React.isValidElement<{className?: string; d?: string; children?: React.ReactNode}>(node)) return [];
    return node.props.className === 'activity-stack' && node.props.d !== undefined ? [node.props.d] : pathsOf(node.props.children);
  };
  const props = {activity: {barMs}, origin: 0, groups: current.shown, from: 0, to: length, unknownTo: null, plot: undefined, onBase: () => {}, onSelect: () => {}, strip: current.strip as PlotBuffer | null, prepared: true, navigation, by: 'project', allMuted: false, empty: null};
  const renderChild = () => {Object.assign(context, child); child.begin(); return pathsOf(context.Stacks(props));};
  assert.deepEqual(renderChild(), []); assert.equal(draws, 0); child.commit(); child.finish();
  const actual = renderChild();
  const expected = new StackPaths().draw(current.shown, 0, 340 / length, barMs, 160, activityScale(465 * 60_000).max);
  assert.deepEqual([...actual], expected); assert.equal(draws, 1);
  props.from += 60_000; props.to += 60_000;
  axis.basis = {from: props.from, to: props.to, end: props.to};
  assert.deepEqual([...renderChild()], expected); child.commit(); child.finish();
  assert.equal(draws, 1, 'clock movement cannot redraw numeric stacks');
  props.prepared = false; props.from += barMs; props.to += barMs;
  axis.basis = {from: props.from, to: props.to, end: props.to};
  renderChild(); child.commit(); child.finish(); assert.equal(draws, 1, 'unready parent input cannot prepare borrowed data');
  props.prepared = true; renderChild(); child.commit(); child.finish(); assert.equal(draws, 2, 'reenabling schedules only the latest ready owner');
  props.strip = null; renderChild(); child.commit(); child.finish(); renderChild(); assert.equal(draws, 3);
  props.from += 60_000; props.to += 60_000; axis.basis = {from: props.from, to: props.to, end: props.to};
  renderChild(); child.commit(); child.finish();
  assert.equal(draws, 3); assert.deepEqual(tickFrame, [props.from, props.to], 'new clock ticks enter the current axis without redrawing its retained stacks');
});

test('native Activity value projection excludes a departed peak before release and survives the typed handoff',async()=>{
  const {workHours}=await import('../lib/format');const H=3_600_000,M=60000;
  let queries=0,draft:{length:number}|null=null,visualFrom=0;
  const element=()=>{const attrs=new Map<string,string>();return {style:{display:''},textContent:'',getAttribute:(name:string)=>attrs.get(name)??null,setAttribute:(name:string,value:string)=>attrs.set(name,value),hasAttribute:(name:string)=>attrs.has(name),removeAttribute:(name:string)=>attrs.delete(name)};};
  const rows=Array.from({length:4},()=>{const line=element(),text=element();return {...element(),line,text,querySelector:(name:string)=>{queries++;return name==='line'?line:text;}};});
  const band=element(),edges={...element(),querySelectorAll:()=>[]},axis={held:false,visualGeometry:()=>({from:visualFrom}),screenX:(at:number)=>at/M};
  const context={activityScale,workHours,valueBand:{current:band},valueAxis:{current:{children:rows}},paintedValue:{current:''},vertical:{max:12*H},height:300,top:12,bottom:28,
    heights:new Map([[0,12*H],[M,H],[-M,100*H]]),bandClip:{current:{}},mask:{current:element()},edges:{current:edges},pan:{get:()=>draft},axis,strip:null,
    groups:[{group:{key:'s'}}],activity:{by:{source:[]}},currentActivity:{},from:0,to:2*M,barMs:M,by:'source',left:0,right:0,width:120,scale:1,perMs:1/M,x:(at:number)=>at/M,y:(value:number)=>272-value/(12*H)*260,
    cellStart,plotBar,targetOf,clipPlot:()=>{},painted:{current:''},paint:null as unknown as ()=>void};
  const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8'),start=source.indexOf('  const paintValue=');
  const body=source.slice(start,source.indexOf('  // Input uses the committed groups',start));
  runInNewContext(ts.transpileModule(body+'\nglobalThis.paint=paintEdges;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  context.paint();assert.equal(band.getAttribute('transform'),null,'an overscan peak cannot enlarge the visible scale');
  visualFrom=M;draft={length:2*M};context.paint();assert.match(band.getAttribute('transform')!,/scale\(1 12\)/);
  const projected=(base:number)=>{const ratio=Number(band.getAttribute('transform')?.match(/scale\(1 ([^)]+)\)/)?.[1]??1);return 272+(272-H/base*260-272)*ratio;};
  const lastInput=projected(12*H),labels=rows.map(row=>row.text.textContent);
  const reads=queries;for(let i=0;i<100;i++)context.paint();assert.equal(queries,reads,'an unchanged native scale neither traverses nor rewrites the axis');
  draft=null;axis.held=true;context.paint();assert.equal(projected(12*H),lastInput);assert.deepEqual(rows.map(row=>row.text.textContent),labels);
  context.vertical.max=H;context.from=M;context.to=3*M;axis.held=false;context.paintedValue.current='';context.paint();
  assert.equal(band.getAttribute('transform'),null);assert.ok(Math.abs(projected(H)-lastInput)<1e-9,'prepared paths adopt the displayed value projection without a release zoom');assert.deepEqual(rows.map(row=>row.text.textContent),labels);
});
