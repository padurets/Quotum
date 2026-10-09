import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {navigationKey} from '../lib/axisNavigation';
import {historyProjection} from '../lib/historyProjection';
import {chartEventsPrepared, chartResetsPrepared} from '../lib/lines';
import {chartMoments} from '../lib/readout';
import {preparationFixture} from './preparationFixture';

test('the actual History producer retains data on clock wakes and keeps forecast availability independent of its switch', () => {
  const H = 3_600_000, minute = 60_000, hook = preparationFixture(); let calculations = 0;
  const line = {key: 's@w', provider: 'claude', sourceId: 's', windowId: 'w', color: 'red'};
  const source = readFileSync(new URL('../components/History.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const prepared = usePrepared(');
  const region = source.slice(start, source.indexOf('\n  return (', start));
  type Result = {prepared: {ready: boolean}; model: {forecasts: unknown[]; markers: {at: number}[]}; currentHints: {forecast: boolean; zeros: number[]}; wantedTo: number};
  const context = {...hook, now: H, measured: H, from: 0, frame: {from: 0, to: H, future: H, live: true}, history: {board: 'b', events: []}, drawing: {board: 'b', events: []}, strip: null,
    sources: [{id: 's', successAt: H, windows: [{id: 'w', kind: 'weekly', resetAt: 3 * H}]}], view: {},
    prefs: {kind: 'weekly', muted: {}, showPlan: false, showForecast: false, horizon: 'auto'}, locale: 'en',
    futureSources: [] as unknown[], futureForecasts: {}, futureLineup: [], futureNews: null, futureCodex: null, futureView: {},
    navigation: {context: 'b', range: '24h'}, navigationKey, registry: {current: null}, context: null,
    subscriptionLinesPrepared: function* () {calculations++; yield; return [line];}, planOf: () => null, announcedOf: () => null, started: () => true,
    forecastLinePrepared: function* () {yield; return {zero: 2 * H, until: H + 2 * minute, points: [[H, 60], [2 * H, 0]], at: 2 * H};},
    chartEventsPrepared, chartResetsPrepared, chartMoments, historyProjection, past: {}, PROVIDERS: {}, t: () => '', sourceLabel: () => '',
    draw: null as unknown as () => Result,
  };
  context.futureSources = context.sources;
  runInNewContext(ts.transpileModule(`function draw(){${region}\nreturn {prepared,model,currentHints,wantedTo};}\nglobalThis.draw=draw;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  const render = () => {hook.begin(); return context.draw();};
  render(); hook.commit(); hook.finish(); const first = render();
  assert.equal(calculations, 1); assert.equal(first.model.forecasts.length, 0);
  assert.equal(first.currentHints.forecast, true, 'turning the drawing off must leave its switch available');
  assert.ok(first.model.markers.some(marker => marker.at === 3 * H), 'reset markers beyond the initial edge are retained');
  context.now += minute; context.measured += minute; context.from += minute;
  context.frame = {...context.frame, from: context.from, to: context.measured};
  context.history = {...context.history};
  const clock = render(); hook.commit(); hook.finish();
  assert.equal(clock.model, first.model); assert.equal(clock.prepared.ready, true); assert.equal(calculations, 1);
  context.prefs = {...context.prefs, showForecast: true}; render(); hook.commit(); hook.finish();
  const enabled = render(); assert.equal(enabled.model.forecasts.length, 1); assert.equal(calculations, 2);
  context.now = H + 2 * minute; context.measured = context.now; context.frame = {...context.frame, to: context.now};
  const expired = render(); hook.commit(); hook.finish();
  assert.equal(expired.model, enabled.model); assert.equal(calculations, 2, 'expiry updates availability without rebuilding series');
  assert.equal(expired.currentHints.forecast, false); assert.equal(expired.currentHints.zeros.length, 0); assert.equal(expired.wantedTo, context.measured);
  context.drawing = {...context.drawing}; render(); hook.commit(); hook.finish();
  assert.equal(calculations, 3, 'new evidence still rebuilds the paths');
});
