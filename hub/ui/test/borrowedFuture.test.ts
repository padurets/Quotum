import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {plotPathPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {navigationKey} from '../lib/axisNavigation';
import {preparationFixture} from './preparationFixture';

test('a borrowed live model in a requested past frame neither clamps future paths nor keeps its future labels', () => {
  const H = 3_600_000, hook = preparationFixture();
  const source = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const inputs = '), region = source.slice(start, source.indexOf('  const model = ', start));
  const forecast = {key: 's', name: 'source', points: [[2 * H, 80], [3 * H, 0]], zero: 3 * H, at: 3 * H};
  const marker = {key: 'future', at: 3 * H, strong: true, past: false, label: 'future'};
  type Model = {planPaths: string[]; forecasts: unknown[]; markers: unknown[]};
  const context = {...hook, axis: {active: false}, requested: {from: 0, to: H, end: H},
    incomingLines: [], incomingPlans: [{key: 'p', runs: [[[2 * H, 80], [3 * H, 0]]]}], incomingForecasts: [forecast], incomingMarkers: [marker],
    incomingStrip: null, desiredFrom: 0, desiredTo: H, desiredNow: H, desiredLive: false, incomingReady: true, valueAxis: undefined, stepped: false, modelContext: 'test', navigation: {context: 'test', range: 'past'}, navigationKey,
    NO_FORECASTS: [], cellMs: 60_000, width: 900, height: 220, left: 40, right: 12, top: 12, bottom: 28, plotPathPrepared, clipPrepared,
    currentClock: H, prepared: {value: {forecasts: [forecast], forecastPaths: ['future'], markers: [marker]}},
    runOutPast: (values: unknown[]) => {assert.equal(values.length, 0, 'past navigation must not use old future labels'); return [];}, stamp: () => '', t: () => '',
    draw: null as unknown as () => {value: Model | null; ready: boolean}, read: null as unknown as () => {forecasts: unknown[]; beyond: unknown[]; announced: unknown[]},
  };
  const modelStart = source.indexOf('  const model = ', start), modelHead = source.slice(modelStart, source.indexOf('  const strip = ', modelStart));
  const labels = source.slice(source.indexOf('  const beyond = '), source.indexOf('  const {shown: past', source.indexOf('  const beyond = ')));
  runInNewContext(ts.transpileModule(`function draw(){${region}\nreturn prepared;}\nfunction read(){${modelHead}\n${labels}\nreturn {forecasts,beyond,announced};}\nglobalThis.draw=draw;globalThis.read=read;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  Object.defineProperty(context.axis, 'basis', {get: () => context.requested});
  const render = () => {hook.begin(); return context.draw();};
  // The saved live model still exists while only preparation is paused.
  const labelsWhilePending = context.read();
  assert.equal(labelsWhilePending.forecasts.length, 0); assert.equal(labelsWhilePending.beyond.length, 0); assert.equal(labelsWhilePending.announced.length, 0);
  assert.equal(render().value, null); hook.commit(); hook.finish();
  const ready = render().value!;
  assert.equal(ready.forecasts.length, 0); assert.equal(ready.markers.length, 0);
  const coordinates = [...ready.planPaths[0].matchAll(/[ML]([-\d.]+),/g)].map(match => Number(match[1]));
  assert.equal(coordinates.length, 0, 'the old future plan is outside the bounded drawing extent');
  assert.equal(context.incomingPlans[0].runs[0].length, 2, 'clipping artwork cannot change the retained raw plan');
});
