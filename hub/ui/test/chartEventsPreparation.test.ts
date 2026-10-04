import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {chartEvents, chartEventsPrepared, chartResets, chartResetsPrepared, type PlotLine} from '../lib/lines';
import {drain} from '../lib/prepare';
import type {SourceEvent} from '../lib/types';
import type {PastResets} from '../lib/resets';

const line = (source: string, window: string, provider = 'claude') => ({sourceId: source, windowId: window, provider, color: 'blue', points: []}) as unknown as PlotLine;
const eventOracle = (events: SourceEvent[], lines: PlotLine[], from: number) => events.flatMap(event => {
  const on = lines.filter(line => line.sourceId === event.sourceId && (event.kind !== 'early_reset' || event.windows.includes(line.windowId)));
  return event.at < from || !on.length ? [] : [{event, lines: on}];
});
const resetOracle = (past: PastResets, lines: PlotLine[], from: number, to: number) => (Object.keys(past) as (keyof PastResets)[]).flatMap(provider => {
  const line = lines.find(line => line.provider === provider);
  return line ? (past[provider] ?? []).filter(reset => reset.at >= from && reset.at <= to).map(reset => ({provider, reset, line})) : [];
});

test('sliced event and tracker selectors retain their original order, window membership and boundaries', () => {
  const lines = [line('s', 'one'), line('other', 'x', 'codex'), line('s', 'two'), line('s', 'one', 'codex')];
  const events: SourceEvent[] = Array.from({length: 2000}, (_, i) => i % 2 ? {sourceId: 's', kind: 'early_reset', windows: ['two', 'missing', 'one'], at: i} : {sourceId: i % 3 ? 's' : 'absent', kind: 'resets_granted', at: i, count: i});
  const past: PastResets = {codex: Array.from({length: 500}, (_, i) => ({url: '', text: `C${i}`, at: i})), claude: Array.from({length: 500}, (_, i) => ({url: '', text: `A${i}`, at: i}))};
  for (const from of [0, 73, 499, 2001]) {
    assert.deepEqual(chartEvents(events, lines, from), eventOracle(events, lines, from));
    assert.deepEqual(drain(chartEventsPrepared(events, lines, from)), eventOracle(events, lines, from));
    assert.deepEqual(chartResets(past, lines, from, 400), resetOracle(past, lines, from, 400));
    assert.deepEqual(drain(chartResetsPrepared(past, lines, from, 400)), resetOracle(past, lines, from, 400));
  }
});

test('the actual History marker producer reaches a bounded checkpoint before scanning the full event/line product', () => {
  let comparisons = 0;
  const visible = Array.from({length: 50}, (_, i) => ({...line(`s${i}`, `w${i}`), get sourceId() {comparisons++; return `s${i}`;}}));
  const events: SourceEvent[] = Array.from({length: 2000}, (_, i) => ({sourceId: `s${i % 50}`, at: i * 1_200_000, kind: 'resets_granted', count: 1}));
  const source = readFileSync(new URL('../components/History.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('    for (const {event, lines: shown} of yield* chartEventsPrepared(');
  assert.ok(start >= 0);
  const region = source.slice(start, source.indexOf('    for (const {provider, reset, line}', start));
  const context = {chartEventsPrepared, strip: {events, from: 0}, history: null, visible, from: 0, sources: [], sourceLabel: () => '', markers: [] as unknown[], t: () => '', produce: null as unknown as () => Generator<void, void, void>};
  runInNewContext(ts.transpileModule(`function* produce(){${region}}\nglobalThis.produce=produce;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  const work = context.produce();
  assert.equal(work.next().done, false); assert.ok(comparisons <= 1);
  for (let n = 0; n < 63; n++) work.next();
  assert.ok(comparisons <= 64, 'no checkpoint can hide 100000 comparisons');
  assert.equal(context.markers.length, 0, 'selection has not published a partial marker list');
  work.return();
  assert.equal(context.markers.length, 0);
});

test('large early-reset membership and provider-line lookup can both be cancelled before completing their scans', () => {
  let comparisons = 0;
  const lines = Array.from({length: 200}, (_, i) => ({...line('s', 'wanted'), get provider() {comparisons++; return i === 199 ? 'codex' : 'other';}}));
  const work = chartResetsPrepared({codex: [{at: 1, text: '', url: ''}]}, lines, 0, 2);
  work.next(); assert.equal(comparisons, 0); work.next(); assert.equal(comparisons, 1); work.return([]);
  const events = chartEventsPrepared([{sourceId: 's', at: 1, kind: 'early_reset', windows: Array.from({length: 2000}, (_, i) => `w${i}`)}], [line('s', 'wanted')], 0);
  events.next(); events.next(); events.next(); assert.equal(events.next().done, false); events.return([]);
});
