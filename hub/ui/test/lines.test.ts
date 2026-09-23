import {test} from 'node:test';
import assert from 'node:assert/strict';
import {linesOf} from '../lib/lines';
import type {History, HistorySeries, Overview, SourceState, View} from '../lib/types';

const view: View = {order: [], sizes: {}, names: {}, hidden: [], windows: [], plans: {}, unplanned: [], colors: {}};
const series = (windowId: string, kind: 'weekly' | 'session' = 'weekly'): HistorySeries => ({
  sourceId: 'codex:1', provider: 'codex', windowId, kind, label: null, minutes: 10080, consumed: 0, coveredMs: 0, samples: 1, remainingAtStart: 50, remainingAtEnd: 50, points: [[0, 50, 0]],
});
const history = {range: '24h', now: 0, since: 0, to: 0, cellMs: 60_000, historyStart: 0, events: [], series: [series('weekly'), series('spark'), series('session', 'session')]} as History;
const source = {id: 'codex:1', provider: 'codex', windows: [{id: 'weekly', kind: 'weekly', label: null, used: 40, remaining: 60, resetAt: null, minutes: 10080}]} as unknown as SourceState;
const overview = {sources: [source]} as unknown as Overview;

test('the chart and the table show only what the cards show', () => {
  assert.deepEqual(linesOf(history, overview, view, 'weekly').map(l => [l.windowId, l.current]), [['weekly', 60]], 'a window no longer reported is left out');
  assert.deepEqual(linesOf(history, overview, {...view, windows: ['codex:1/weekly']}, 'weekly'), [], 'nor one hidden on the board');
  assert.deepEqual(linesOf(history, overview, {...view, hidden: ['source:codex:1']}, 'weekly'), [], 'nor any of a hidden card');
  assert.deepEqual(linesOf(history, null, view, 'weekly'), [], 'nothing before the board is known');
});
