import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Chunk} from '../../server/domain/history';
import {HistoryTile} from '../lib/historyTiles';

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
