import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compose, targetOf, type Chunk, type HistoryMeta} from '../../server/domain/history';
import {covered, plotBar, plotOf} from '../lib/historyPlot';
import {groupRegistry} from '../lib/plotRegistry';

const M = 60_000, H = 60 * M, NOW = 48 * H;
const meta: HistoryMeta = {now: NOW, historyStart: 0, known: {work: 0, sources: {s: 0}}};
const chunk = (from: number, to: number, cell = 5 * M): Chunk => ({from, to, series: [{source: 's', window: 'w', hold: H, open: 100, cells: Array.from({length: (to - from) / cell}, (_, i) => [i, 100 - i, 1, cell])}], activity: {sessions: [['r', 's', 'P', 'd']], devices: {d: 'Device'}, cells: Array.from({length: (to - from) / cell}, (_, i) => [i, cell, [0], []])}, resets: [], grants: []});

test('loaded empty coverage is separate from unknown and line segments never cross a hole', () => {
  const target = targetOf(24 * H, NOW, 'plot', {from: 0, to: 3 * H});
  const buffer = plotOf([chunk(0, H), chunk(2 * H, 3 * H)], meta, target, [[0, H], [2 * H, 3 * H]], new Set(['s w']), 1, 1, 1);
  assert.equal(covered(buffer.coverage, H, H + 5 * M), false);
  assert.equal(covered(buffer.coverage, 0, H), true);
  assert.notEqual(buffer.series[0].points[11][2], buffer.series[0].points[12][2]);
  assert.equal(plotBar(buffer, H, target, 'project'), null);
});

test('a moving edge immediately changes 60 minutes to 55, using whole-cell composition', () => {
  const target = targetOf(24 * H, NOW, 'strip', {from: 0, to: 2 * H});
  const full = chunk(0, 2 * H);
  const buffer = plotOf([full], meta, target, [[0, 2 * H]], new Set(['s w']), 1, 1, 1);
  assert.equal(plotBar(buffer, 0, target, 'project')!.agentMs, H);
  const moved = {...target, k0: 1};
  const actual = plotBar(buffer, 0, moved, 'project')!;
  assert.equal(actual.agentMs, 55 * M);
  assert.equal(actual.agentMs, compose([full], meta, moved, new Set(['s w'])).activity.cells[0][2]);
  assert.equal(plotBar({...buffer, coverage: [[5 * M, 2 * H]]}, 0, moved, 'project')!.agentMs, 55 * M, 'unknown outside the contributing cells is irrelevant');
  assert.equal(plotBar({...buffer, coverage: [[0, 5 * M], [10 * M, 2 * H]]}, 0, moved, 'project'), null, 'one unread contributing cell hides the whole bar');
});

test('plot metadata preserves surviving colors through a rank swap and new groups', () => {
  const seed = [{key: 'P', name: 'P', color: 'blue'}, {key: 'Q', name: 'Q', color: 'violet'}];
  const next = groupRegistry(seed, seed, [{key: 'Q', name: 'Q'}, {key: 'R', name: 'R'}]);
  assert.equal(next.find(g => g.key === 'Q')!.color, 'violet');
  assert.ok(next.find(g => g.key === 'R')!.color !== 'violet');
  assert.deepEqual(groupRegistry(seed, next, [{key: 'Q', name: 'Q'}]).map(g => g.key), ['P', 'Q']);
});

test('a changed strip reuses immutable activity cells while retaining exact edge accounting', () => {
  const target = targetOf(24 * H, NOW, 'strip', {from: 0, to: 2 * H});
  const source = chunk(0, 2 * H);
  const a = plotOf([source], meta, target, [[0, 2 * H]], new Set(['s w']), 1, 1, 1);
  const b = plotOf([source], meta, {...target, k0: 1}, [[0, 2 * H]], new Set(['s w']), 1, 1, 2);
  assert.equal(a.activityCells.get(5 * M), b.activityCells.get(5 * M));
  assert.equal(plotBar(b, 0, {...target, k0: 1}, 'project')!.agentMs, 55 * M);
});
