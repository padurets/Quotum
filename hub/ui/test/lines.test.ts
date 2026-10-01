import {test} from 'node:test';
import assert from 'node:assert/strict';
import {linesOf, valueIn} from '../lib/lines';
import type {History, HistorySeries, View, Win} from '../lib/types';

const view: View = {layout: {columns: 6, places: {}}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};
const series = (windowId: string): HistorySeries => ({
  sourceId: 'codex:1', windowId, consumed: 0, coveredMs: 0, remainingAtStart: 50, remainingAtEnd: 50, staleAfterMs: 300_000, points: [[0, 50, 0]], work: null,
});
const history = {range: '24h', live: true, since: 0, to: 0, cellMs: 60_000, historyStart: 0, events: [], series: [series('weekly'), series('spark'), series('session')], activity: {since: 0, known: null, barMs: 60_000, activeMs: 0, agentMs: 0, agents: 0, cells: [], by: {source: [], project: [], device: []}}} as History;
const weekly: Win = {id: 'weekly', kind: 'weekly', label: null, used: 40, remaining: 60, resetAt: null, minutes: 10080};
const sources = [{id: 'codex:1', provider: 'codex', windows: [weekly]}];

test('the chart and the table show only what the cards show', () => {
  assert.deepEqual(linesOf(history, sources, view, 'weekly').map(l => [l.windowId, l.current]), [['weekly', 60]], 'a window no longer reported is left out');
  assert.deepEqual(linesOf(history, sources, {...view, windows: ['codex:1/weekly']}, 'weekly'), [], 'nor one hidden on the board');
  assert.deepEqual(linesOf(history, sources, {...view, hidden: ['source:codex:1']}, 'weekly'), [], 'nor any of a hidden card');
  assert.deepEqual(linesOf(history, null, view, 'weekly'), [], 'nothing before the board is known');
});

test('metadata and ordering follow the cards and their windows, independently of chunk order', () => {
  const other = {...weekly, id: 'other', label: 'Pool', minutes: 720};
  const data = {...history, series: [series('weekly'), series('other')]};
  const lines = linesOf(data, [{id: 'codex:1', provider: 'claude', windows: [other, weekly]}], view, 'weekly');
  assert.deepEqual(lines.map(l => [l.windowId, l.provider, l.kind, l.label, l.minutes]), [['other', 'claude', 'weekly', 'Pool', 720], ['weekly', 'claude', 'weekly', null, 10080]]);
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
