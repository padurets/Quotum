import {test} from 'node:test';
import assert from 'node:assert/strict';
import {linesOf, valueIn} from '../lib/lines';
import type {History, HistorySeries, Overview, SourceState, View} from '../lib/types';

const view: View = {order: [], sizes: {}, names: {}, hidden: [], windows: [], plans: {}, unplanned: [], colors: {}};
const series = (windowId: string, kind: 'weekly' | 'session' = 'weekly'): HistorySeries => ({
  sourceId: 'codex:1', provider: 'codex', windowId, kind, label: null, minutes: 10080, consumed: 0, coveredMs: 0, samples: 1, remainingAtStart: 50, remainingAtEnd: 50, staleAfterMs: 300_000, points: [[0, 50, 0]],
});
const history = {range: '24h', now: 0, since: 0, to: 0, cellMs: 60_000, historyStart: 0, events: [], refreshInMs: null, series: [series('weekly'), series('spark'), series('session', 'session')]} as History;
const source = {id: 'codex:1', provider: 'codex', windows: [{id: 'weekly', kind: 'weekly', label: null, used: 40, remaining: 60, resetAt: null, minutes: 10080}]} as unknown as SourceState;
const overview = {sources: [source]} as unknown as Overview;

test('the chart and the table show only what the cards show', () => {
  assert.deepEqual(linesOf(history, overview, view, 'weekly').map(l => [l.windowId, l.current]), [['weekly', 60]], 'a window no longer reported is left out');
  assert.deepEqual(linesOf(history, overview, {...view, windows: ['codex:1/weekly']}, 'weekly'), [], 'nor one hidden on the board');
  assert.deepEqual(linesOf(history, overview, {...view, hidden: ['source:codex:1']}, 'weekly'), [], 'nor any of a hidden card');
  assert.deepEqual(linesOf(history, null, view, 'weekly'), [], 'nothing before the board is known');
});

test('a line reads its last value in cells without a measurement of their own, until it breaks', () => {
  const points: [number, number, number][] = [
    [0, 90, 0],
    [120_000, 88, 0],
    [600_000, 80, 1],
  ];
  const read = (cell: number) => valueIn(points, cell, 1_000_000, 300_000);
  assert.equal(read(120_000), 88, 'its own');
  assert.equal(read(60_000), 90, 'held from the cell before');
  assert.equal(read(300_000), undefined, 'a break in the line');
  assert.equal(read(840_000), 80, 'the latest, while it is fresh');
  assert.equal(valueIn(points, 960_000, 2_000_000, 300_000), undefined, 'not a line that ended long ago');
  assert.equal(read(1_200_000), undefined, 'nothing ahead of now');
  assert.equal(read(-60_000), undefined);
});
