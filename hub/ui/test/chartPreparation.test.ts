import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {plotPathPrepared} from '../lib/plotPath';
import {preparationFixture} from './preparationFixture';

test('actual quota generators prepare outside render and retain displayed paths through replacement and cancellation', () => {
  const cellMs = 60_000, end = 720 * cellMs;
  const lines = Array.from({length: 50}, (_, i) => ({points: [...Array.from({length: 720}, (_, j) => [j * cellMs, (i + j) % 100, 1]), [end + 4500, 5, 1], [end + 15_000, 0, 1]]}));
  const hook = preparationFixture(); let calculations = 0;
  const source = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const blockPaths = '), region = source.slice(start, source.indexOf('  const model = ', start));
  type Model = {paths: {line: string; last: [number, number] | null}[]};
  const context = {...hook, axis: {active: false}, incomingStrip: null as object | null,
    desiredFrom: 0, desiredTo: end, desiredNow: end, requested: {from: 0, to: end, end}, incomingLines: lines,
    modelContext: '', navigation: undefined, desiredLive: true, incomingPlans: [], incomingForecasts: [], incomingMarkers: [], cellMs, width: 900, height: 220, left: 40, right: 12, top: 12, bottom: 28,
    plotPathPrepared: function* (...args: Parameters<typeof plotPathPrepared>) {calculations++; return yield* plotPathPrepared(...args);},
    draw: null as unknown as () => {value: Model | null; ready: boolean},
  };
  runInNewContext(ts.transpileModule(`function draw(){${region}\nreturn prepared;}\nglobalThis.draw=draw;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  const render = () => {hook.begin(); return context.draw();};
  assert.equal(render().value, null); assert.equal(calculations, 0, 'urgent render cannot run the generator');
  hook.commit(); hook.tick(); assert.ok(calculations < 50); hook.finish();
  const current = render().value!; assert.equal(calculations, 50);
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
});
