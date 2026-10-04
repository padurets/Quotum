import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {clipPrepared} from '../lib/forecast';
import {weeklyPlanLine} from '../lib/plan';
import {plotPathPrepared} from '../lib/plotPath';
import {preparationFixture} from './preparationFixture';
import {axisPresentationFixture} from './axisPresentationFixture';

test('full future facts produce bounded artwork and a rare clock rebase preserves the cutoff and presentation', () => {
  const DAY = 86_400_000, end = 10 * DAY, hook = preparationFixture(); let calculations = 0;
  const raw = weeklyPlanLine(12 * DAY, 5 * DAY, 40 * DAY);
  type Model = {basis: {from: number; to: number; end: number}; now: number; paths: {last: [number, number]}[]; planPaths: string[]; forecastPaths: string[]};
  const context = {...hook, axis: {active: false, basis: {from: 9 * DAY, to: 11 * DAY, end}},
    incomingLines: [{points: [[9 * DAY, 70, 1], [end, 60, 1]]}], incomingPlans: [{key: 'plan', runs: raw}], incomingForecasts: [{points: [[end, 60], [12 * DAY, 0]]}], incomingMarkers: [],
    incomingStrip: null as {from: number; to: number} | null, desiredFrom: 9 * DAY, desiredTo: 11 * DAY, desiredNow: end,
    modelContext: '', navigation: undefined, desiredLive: true, incomingReady: true,
    cellMs: 60_000, width: 900, height: 220, left: 40, right: 12, top: 12, bottom: 28, clipPrepared,
    plotPathPrepared: function* (...args: Parameters<typeof plotPathPrepared>) {calculations++; return yield* plotPathPrepared(...args);},
    draw: null as unknown as () => {value: Model | null; ready: boolean},
  };
  const source = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8'), start = source.indexOf('  const inputs = ');
  const region = source.slice(start, source.indexOf('  const model = ', start));
  runInNewContext(ts.transpileModule(`function draw(){${region}\nreturn prepared;}\nglobalThis.draw=draw;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  const render = () => {hook.begin(); return context.draw();};
  render(); hook.commit(); hook.finish(); const first = render().value!;
  const xs = (model: Model) => [...[...model.planPaths, ...model.forecastPaths].join('').matchAll(/[ML]([-\d.]+),/g)].map(match => Number(match[1]));
  const bounded = (model: Model) => assert.ok(xs(model).every(x => x >= 40 - 424 && x <= 888 + 424), 'raw future cycles cannot inflate the displayed SVG beyond its overscan');
  bounded(first); assert.equal(calculations, 1); assert.equal(raw.length, 5);
  context.desiredFrom += 60_000; context.desiredNow += 60_000; context.desiredTo += 60_000;
  context.axis.basis = {from: context.desiredFrom, to: context.desiredTo, end: context.desiredNow};
  assert.equal(render().value, first); hook.commit(); hook.finish(); assert.equal(calculations, 1);
  const shift = .6 * DAY;
  context.desiredFrom = 9 * DAY + shift; context.desiredTo = 11 * DAY + shift; context.desiredNow = end + shift;
  context.axis.basis = {from: context.desiredFrom, to: context.desiredTo, end: context.desiredNow};
  const presentation = axisPresentationFixture(first.basis, {context: 'same', range: 'live'}, 900, 1, 40, 12);
  presentation.navigate(context.axis.basis, {context: 'same', range: 'live'}); presentation.context.commit(first.basis, true);
  const before = presentation.point(end);
  render(); hook.commit(); hook.finish(); const recentered = render().value!;
  assert.equal(recentered.now, first.now, 'a geometry rebase cannot advance the factual cutoff');
  assert.equal(recentered.basis.end, end); assert.equal(calculations, 2); bounded(recentered);
  presentation.context.commit(recentered.basis, true);
  assert.ok(Math.abs(presentation.point(end) - before) < 1e-8);
  assert.ok(Math.abs(recentered.paths[0].last[0] - presentation.point(end)) < .1);
  context.axis.active = true; context.incomingStrip = {from: 7 * DAY, to: 9 * DAY};
  render(); hook.commit(); hook.finish(); const moving = render().value!;
  const movingTimes = xs(moving).map(x => moving.basis.from + (x - 40) / 848 * (moving.basis.to - moving.basis.from));
  assert.ok(movingTimes.every(at => at >= 7 * DAY && at <= 9 * DAY + context.desiredTo - context.desiredNow));
  assert.equal(raw.length, 5, 'viewport clipping leaves all raw cycles available for later navigation');
});
