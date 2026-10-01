import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Chunk} from '../../server/domain/history';
import {compose, targetOf} from '../../server/domain/history';
import {HistoryTile} from '../lib/historyTiles';
import {plotOf} from '../lib/historyPlot';

const M = 60_000;
const known = {work: 0, sources: {s: 0}};
function chunk(from: number, ref: string): Chunk {
  const project = `P${ref}`, device = `d${ref}`;
  return {
    from, to: from + M,
    series: [{source: 's', window: `w${ref}`, hold: M, open: null, cells: [[0, 80, 0, 0]]}],
    activity: {
      sessions: [[`${ref}a`, 's', project, device], [`${ref}b`, 's', project, device]], devices: {[device]: `Device ${ref}`},
      cells: [[0, M, [[0, 40_000], [1, 40_000]], [['s', 's', M], ['p', JSON.stringify(project), M], ['d', device, M]]]],
    },
    resets: [], grants: [],
  };
}

test('plot extraction from packed cells preserves points, gaps, holds and activity through each readable cut', () => {
  const tile = new HistoryTile(0, M);
  const input = chunk(0, 'A');
  input.to = 3 * M;
  input.series[0].cells = [[0, 80, 1, M], [1, 70, 1, M, {g: 1, h: 2 * M}], [2, 60, 1, M]];
  tile.merge(input, known);
  const meta = {known, now: 3 * M, historyStart: 0};
  for (let first = 0; first < 3; first++) for (let end = first + 1; end <= 3; end++) {
    tile.readFrom = first * M; tile.readTo = end * M;
    const target = targetOf(15 * M, 3 * M, 'plot', {from: tile.readFrom, to: tile.readTo});
    const coverage = [[tile.readFrom, tile.readTo]] as [number, number][];
    const full = plotOf([tile.chunk(known)], meta, target, coverage, new Set(['s wA']), 1, 1, 1);
    const quick = plotOf([tile.chunk(known, true)], meta, target, coverage, new Set(['s wA']), 1, 1, 1);
    assert.deepEqual(quick.series, full.series);
    assert.deepEqual(quick.activityCells, full.activityCells);
  }
});

test('replacing one cell compacts unused sessions, groups, devices and empty series', () => {
  const tile = new HistoryTile(0, M);
  tile.readTo = M;
  tile.merge(chunk(0, '0'), known);
  const bytes = tile.bytes;
  for (let i = 1; i < 100; i++) {
    tile.merge(chunk(0, String(i)), known);
    const held = tile.chunk(known);
    assert.equal(held.activity.sessions.length, 2);
    assert.deepEqual(Object.keys(held.activity.devices), [`d${i}`]);
    assert.deepEqual(held.series.map(s => s.window), [`w${i}`]);
    assert.equal(tile.bytes, bytes, 'protected tiles cannot grow solely from replacement');
  }
});

test('compaction preserves other retained cells and remaps their session and group indexes', () => {
  const tile = new HistoryTile(0, M);
  tile.readTo = 2 * M;
  tile.merge(chunk(0, 'A'), known);
  tile.merge(chunk(M, 'B'), known);
  tile.merge(chunk(M, 'C'), known);
  const held = tile.chunk(known);
  assert.deepEqual(held.series.map(s => s.window), ['wA', 'wC']);
  assert.deepEqual(held.activity.sessions.map(s => s[0]), ['Aa', 'Ab', 'Ca', 'Cb']);
  assert.deepEqual(Object.keys(held.activity.devices), ['dA', 'dC']);
  assert.deepEqual(held.activity.cells[1], [1, M, [[2, 40_000], [3, 40_000]], [['s', 's', M], ['p', '"PC"', M], ['d', 'dC', M]]]);
  assert.deepEqual(held.activity.cells[0], chunk(0, 'A').activity.cells[0]);
});

test('a partial new epoch retains still-held suffix rows while clearing replaced dictionaries', () => {
  const tile = new HistoryTile(0, M);
  tile.merge(chunk(0, 'A'), known); tile.merge(chunk(M, 'B'), known);
  tile.readTo = 0;
  tile.merge(chunk(0, 'C'), known); tile.readTo = M;
  assert.equal(tile.chunk(known).activity.cells.length, 1);
  tile.readTo = 2 * M;
  const held = tile.chunk(known);
  assert.deepEqual(new Set(held.activity.sessions.map(s => s[0])), new Set(['Ba', 'Bb', 'Ca', 'Cb']));
  assert.deepEqual(new Set(Object.keys(held.activity.devices)), new Set(['dB', 'dC']));
  assert.equal(held.activity.cells.length, 2);
  tile.merge({from: 0, to: 2 * M, series: [], activity: {sessions: [], devices: {}, cells: []}, resets: [], grants: []}, known);
  assert.deepEqual(tile.chunk(known), {from: 0, to: 2 * M, series: [], activity: {sessions: [], devices: {}, cells: []}, resets: [], grants: []});
});

test('a readable suffix remaps sparse activity and filters series and events at both edges', () => {
  const tile = new HistoryTile(0, M);
  const a = chunk(10 * M, 'A'), b = chunk(20 * M, 'B');
  a.resets = [['s', 'wA', 10 * M]]; b.resets = [['s', 'wB', 20 * M]];
  a.grants = [['s', 10 * M, 1]]; b.grants = [['s', 20 * M, 2]];
  tile.merge(a, known); tile.merge(b, known);
  tile.readFrom = 20 * M; tile.readTo = 21 * M;
  const held = tile.chunk(known);
  assert.equal(held.from, b.from);
  assert.deepEqual(held.series, b.series);
  assert.equal(held.activity.cells[0][0], 0);
  assert.deepEqual(held.resets, b.resets); assert.deepEqual(held.grants, b.grants);
  const target = targetOf(M, b.to, 'past', {from: b.from, to: b.to});
  const meta = {now: b.to, historyStart: 0, known}, windows = new Set(['s wA', 's wB']);
  assert.deepEqual(compose([held], meta, target, windows), compose([b], meta, target, windows));
});

test('every whole-cell cut of a packed tile composes as the original complete cells', () => {
  const whole: Chunk = {from: 0, to: 60 * M, series: [], activity: {sessions: [], devices: {}, cells: []}, resets: [['s', 'wA', 5 * M], ['s', 'wB', 25 * M]], grants: [['s', 12 * M, 2], ['s', 59 * M, 1]]};
  for (let i = 0; i < 60; i += 3) {
    const piece = chunk(i * M, i % 2 ? 'A' : 'B');
    for (const line of piece.series) {
      let series = whole.series.find(s => s.window === line.window);
      if (!series) {series = {...line, cells: []}; whole.series.push(series);}
      series.cells.push([i, 80 - i / 10, .1234, 12_345, {o: i % 2 ? 80.0123 : null, l: 80.0045, g: 1, w: [.1234, 5000, .1]}]);
    }
    const offset = whole.activity.sessions.length;
    whole.activity.sessions.push(...piece.activity.sessions.map(([ref, ...rest]): Chunk['activity']['sessions'][number] => [`${i}-${ref}`, ...rest]));
    Object.assign(whole.activity.devices, piece.activity.devices);
    whole.activity.cells.push([i, M, [[offset, 40_000], [offset + 1, 40_000]], piece.activity.cells[0][3]]);
  }
  const tile = new HistoryTile(0, M); tile.merge(whole, known);
  const windows = new Set(['s wA', 's wB']), meta = {now: whole.to, historyStart: 0, known};
  for (let a = 0; a < 60; a++) for (let b = a + 1; b <= 60; b++) {
    tile.readFrom = a * M; tile.readTo = b * M;
    const target = targetOf((b - a) * M, whole.to, 'cut', {from: a * M, to: b * M});
    assert.deepEqual(compose([tile.chunk(known)], meta, target, windows), compose([whole], meta, target, windows), `${a}..${b}`);
  }
});
