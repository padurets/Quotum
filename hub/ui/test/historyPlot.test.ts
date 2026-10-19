import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compose, targetOf, type Chunk, type HistoryMeta} from '../../server/domain/history';
import {covered, plotBar, plotGroups, plotOf, type PlotGroup} from '../lib/historyPlot';
import {groupRegistry} from '../lib/plotRegistry';
import {CATEGORY_COLORS} from '../lib/providers';
import {OTHER_COLOR} from '../lib/activity';
import {HistoryTile} from '../lib/historyTiles';

const M = 60_000, H = 60 * M, NOW = 48 * H;
const meta: HistoryMeta = {now: NOW, historyStart: 0, known: {work: 0, sources: {s: 0}}};
const chunk = (from: number, to: number, cell = 5 * M): Chunk => ({from, to, series: [{source: 's', window: 'w', hold: H, open: 100, cells: Array.from({length: (to - from) / cell}, (_, i) => [i, 100 - i, 1, cell])}], activity: {sessions: [['r', 's', 'P', 'd']], devices: {d: 'Device'}, cells: Array.from({length: (to - from) / cell}, (_, i) => [i, cell, [0], []])}, resets: [], grants: []});

test('filling a tile head preserves the same grouped reset time and window order as the complete answer', () => {
  const tile = new HistoryTile(0, M);
  const make = (from: number, to: number, resets: Chunk['resets']): Chunk => ({...chunk(from, to, M), resets});
  tile.merge(make(10 * M, H, [['s', 'w', 12 * M]]), meta.known);
  tile.readFrom = 10 * M; tile.readTo = tile.validTo = H;
  tile.merge(make(0, 10 * M, [['s', 'u', 5 * M]]), meta.known); tile.readFrom = 0;
  const held = tile.chunk(meta.known, true), windows = new Set(['s w', 's u']);
  const target = targetOf(H, NOW, 'head', {from: 0, to: H});
  const expected = compose([held], meta, target, windows).events;
  assert.deepEqual(held.resets.map(r => r[2]), [12 * M, 5 * M], 'the real tile retains arrival order');
  assert.deepEqual(expected, [{sourceId: 's', at: 5 * M, kind: 'early_reset', windows: ['u', 'w']}]);
  assert.deepEqual(plotOf([held], meta, target, [[0, H]], windows, 1, 1, 1).events, expected);
});

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

test('plot metadata extends a seven-group seed through Nord Warm and neutral overflow without recolouring surviving groups', () => {
  const seed = CATEGORY_COLORS.slice(0, 7).map((color, i) => ({key: `g${i}`, name: `Group ${i}`, color}));
  const group = (i: number) => ({key: `g${i}`, name: `Group ${i}`});
  const eighth = groupRegistry(seed, seed, [group(7), group(1)]);
  assert.equal(eighth[7].color, '#5e81ac');
  const ninth = groupRegistry(seed, eighth, [group(8), group(7), group(1)]);
  assert.equal(ninth[8].color, '#b48ead');
  const overflow = groupRegistry(seed, ninth, [group(10), group(9), group(8), group(7), group(1)]);
  assert.deepEqual(overflow.map(g => g.color), [...CATEGORY_COLORS, OTHER_COLOR, OTHER_COLOR]);
  assert.equal(new Set(overflow.map(g => g.key)).size, 11, 'neutral groups keep independent identities');

  const reversed = groupRegistry(seed, overflow, [group(9), group(1), group(7), group(8), group(10)]);
  assert.deepEqual(reversed, overflow, 'rank swaps and reversal keep every surviving colour');
  const returned = groupRegistry(seed, reversed, [group(1)]);
  assert.deepEqual(returned, seed, 'returning to the seed removes only transient groups');

  const freed = groupRegistry(seed, overflow, [group(9), group(8), group(10), group(11)]);
  assert.equal(freed.find(g => g.key === 'g9')!.color, OTHER_COLOR, 'a surviving neutral group is not promoted');
  assert.equal(freed.find(g => g.key === 'g11')!.color, '#5e81ac', 'a new group can use a released slot');
  assert.equal(seed.length, 7, 'navigation leaves the seed unchanged');
});

test('a changed strip reuses immutable activity cells while retaining exact edge accounting', () => {
  const target = targetOf(24 * H, NOW, 'strip', {from: 0, to: 2 * H});
  const source = chunk(0, 2 * H);
  const a = plotOf([source], meta, target, [[0, 2 * H]], new Set(['s w']), 1, 1, 1);
  const b = plotOf([source], meta, {...target, k0: 1}, [[0, 2 * H]], new Set(['s w']), 1, 1, 2);
  assert.equal(a.activityCells.get(5 * M), b.activityCells.get(5 * M));
  assert.equal(plotBar(b, 0, {...target, k0: 1}, 'project')!.agentMs, 55 * M);
});

test('filling an unread bridge joins the new line without rewriting an earlier plot', () => {
  const target = targetOf(24 * H, NOW, 'strip', {from: 0, to: 3 * H});
  const first = chunk(0, H), last = chunk(2 * H, 3 * H), windows = new Set(['s w']);
  const before = plotOf([first, last], meta, target, [[0, H], [2 * H, 3 * H]], windows, 1, 1, 1);
  const after = plotOf([first, chunk(H, 2 * H), last], meta, target, [[0, 3 * H]], windows, 1, 1, 2);
  assert.equal(before.series[0].points[0], after.series[0].points[0], 'unchanged block points are reused');
  assert.equal(before.series[0].points[12][2], 2, 'the original unread hole still breaks its line');
  assert.equal(after.series[0].points[24][2], 1, 'the newly covered bridge is continuous');
});

test('every activity dimension remains exact when first read from a retained plot cell', () => {
  const target = targetOf(24 * H, NOW, 'strip', {from: 0, to: H});
  const source = chunk(0, H);
  const buffer = plotOf([source], meta, target, [[0, H]], new Set(['s w']), 1, 1, 1);
  const expected = compose([source], meta, target, new Set(['s w'])).activity;
  for (const by of ['project', 'source', 'device'] as const) {
    const bar = plotBar(buffer, 0, target, by)!;
    assert.deepEqual([...bar.groups].map(([key, value]) => [key, value.ms]), expected.by[by].map(group => [group.key, group.agentMs]));
  }
  const cell = buffer.activityCells.get(0)!;
  assert.equal(cell.parts.project, cell.parts.project);
});

test('strip groups match detailed whole-cell bars without computing their unused metrics', () => {
  const target = targetOf(24 * H, NOW, 'groups', {from: 5 * M, to: 24 * H + 5 * M});
  const first = chunk(0, H), second = chunk(H, 3 * H);
  second.activity.devices.d = 'Renamed device';
  for (const part of [first, second]) {
    part.activity.sessions.push(['other', 's', 'Q', 'e']);
    part.activity.devices.e = 'Other device';
    for (const cell of part.activity.cells) cell[2] = [[0, 5 * M], [1, 2.5 * M]];
  }
  for (const coverage of [[[0, 25 * H]], [[0, H], [H + 5 * M, 25 * H]], []] as [number, number][][]) {
    const buffer = plotOf([first, second], meta, target, coverage, new Set(['s w']), 1, 1, 1);
    for (const by of ['source', 'project', 'device'] as const) {
      const expected = new Map<string, PlotGroup>();
      for (let at = 0; at < 25 * H; at += H) {
        const bar = plotBar(buffer, at, target, by);
        if (!bar) continue;
        for (const [key, part] of bar.groups) {
          let group = expected.get(key);
          if (!group) {group = {key, name: part.name, cells: []}; expected.set(key, group);}
          group.cells.push([at, part.ms]);
        }
      }
      assert.deepEqual(plotGroups(buffer, target, by), [...expected.values()]);
    }
  }
});
