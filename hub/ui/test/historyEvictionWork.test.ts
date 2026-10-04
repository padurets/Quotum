import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {HistoryTile} from '../lib/historyTiles';

const M = 60_000, H = 60 * M;
type Domain = {cell: number; k0: number; k1: number};
type Fixture = ReturnType<typeof fixture>;

function fixture(budget: number, direction = 0, seed = 0) {
  const counts = {visits: 0, sorts: 0, targets: 0};
  const grids = new Map<number, Map<number, HistoryTile>>();
  for (const cell of [M, 5 * M, 2 * H]) {
    const tiles = new Map<number, HistoryTile>();
    for (let n = 0; n < 12; n++) {
      const tile = new HistoryTile(n * 60 * cell, cell);
      tile.merge({from: tile.from, to: tile.from + cell, series: Array.from({length: 1 + (n + seed) % 4}, (_, i) => ({source: 's', window: `w${i}`, hold: cell, open: null, cells: [[0, 80, 0, 0]]})), activity: {sessions: [], devices: {}, cells: []}, resets: [], grants: []}, {work: 0, sources: {s: 0}});
      tile.shownAt = (n * 13 + seed) % 11; tile.readTo = n % 4 ? tile.from + cell : tile.from;
      tiles.set(n, tile);
    }
    const original = tiles[Symbol.iterator].bind(tiles);
    tiles[Symbol.iterator] = function* (): Generator<[number, HistoryTile], undefined, unknown> {for (const row of original()) {counts.visits++; yield row;} return undefined;};
    grids.set(cell, tiles);
  }
  const target: Domain = {cell: M, k0: 5 * 60, k1: 8 * 60 - 1};
  const state = {grids, budget, reservations: new Set([`${M}:2`, `${5 * M}:${seed % 12}`]), version: 3, aheadStopped: !!(seed % 2), interest: direction ? {direction} : null,
    target: () => {counts.targets++; return target;}, plotTarget: () => {counts.targets++; return target;},
    aheadTarget: (value: Domain) => ({...value, k0: value.k0 + direction * 180, k1: value.k1 + direction * 180}),
    get estimatedBytes() {let bytes = 0; for (const tiles of grids.values()) for (const tile of tiles.values()) bytes += tile.bytes; return bytes;},
  };
  return {state, counts};
}

const source = readFileSync(new URL('../lib/history.ts', import.meta.url), 'utf8');
const start = source.indexOf('  private evict()'), body = source.slice(start, source.indexOf('  private clear(', start));
function current(h: Fixture) {
  const context = {counts: h.counts, evict: null as unknown as (this: Fixture['state']) => void};
  runInNewContext(ts.transpileModule(`const original=Array.prototype.sort;Array.prototype.sort=function(...args){counts.sorts++;return original.apply(this,args);};class Reader{${body}}globalThis.evict=Reader.prototype.evict;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  return () => context.evict.call(h.state);
}
const snapshot = (h: Fixture) => ({grids: [...h.state.grids].map(([cell, tiles]) => [cell, [...tiles.keys()]]), bytes: h.state.estimatedBytes, version: h.state.version, aheadStopped: h.state.aheadStopped});

test('actual eviction does no candidate work below the unchanged cache budget', () => {
  const h = fixture(15 * 1024 * 1024, -1), before = snapshot(h), evict = current(h);
  for (let i = 0; i < 100; i++) evict();
  assert.deepEqual(snapshot(h), before);
  assert.equal(h.counts.visits, 0, 'under-budget pan must not visit candidate tiles');
  assert.equal(h.counts.sorts, 0); assert.equal(h.counts.targets, 0);
});

// The previous loop is the independent pressure-behavior oracle.
function original(h: Fixture) {
  const state = h.state, target = state.interest ? state.plotTarget() : state.target();
  const ahead = state.interest?.direction ? state.aheadTarget(target) : null;
  const candidates: {cell: number; n: number; tile: HistoryTile}[] = [];
  for (const [cell, tiles] of state.grids) for (const [n, tile] of tiles) {
    if (state.reservations.has(`${cell}:${n}`)) continue;
    if (cell === target.cell && tile.to > target.k0 * cell && tile.from <= target.k1 * cell) continue;
    candidates.push({cell, n, tile});
  }
  let bytes = state.estimatedBytes;
  for (const {cell, n, tile} of candidates.sort((a, b) => a.tile.shownAt - b.tile.shownAt)) {
    if (bytes <= state.budget) break;
    state.grids.get(cell)!.delete(n); state.version++; bytes -= tile.bytes;
    if (ahead && cell === ahead.cell && tile.readTo > tile.readFrom && tile.readTo > ahead.k0 * cell && tile.readFrom <= ahead.k1 * cell) state.aheadStopped = true;
  }
}

test('over-budget eviction preserves reservations, visible frames, mixed grids, LRU ties and reversal behavior', () => {
  for (const direction of [-1, 0, 1]) for (let seed = 0; seed < 6; seed++) for (const fraction of [0, .1, .5, .9]) {
    const budget = Math.floor(fixture(0, direction, seed).state.estimatedBytes * fraction);
    const actual = fixture(budget, direction, seed), expected = fixture(budget, direction, seed);
    current(actual)(); original(expected);
    assert.deepEqual(snapshot(actual), snapshot(expected), `direction=${direction}, seed=${seed}, fraction=${fraction}`);
  }
});
