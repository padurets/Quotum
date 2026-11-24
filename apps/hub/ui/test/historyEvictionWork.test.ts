import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HistoryStore} from '../lib/history';
import {HistoryTile} from '../lib/historyTiles';

const M = 60_000,
  H = 60 * M;
type Domain = {cell: number; k0: number; k1: number};
type Fixture = ReturnType<typeof fixture>;

function fixture(budget: number, direction = 0, seed = 0) {
  const counts = {visits: 0, targets: 0};
  const grids = new Map<number, Map<number, HistoryTile>>();
  for (const cell of [M, 5 * M, 2 * H]) {
    const tiles = new Map<number, HistoryTile>();
    for (let n = 0; n < 12; n++) {
      const tile = new HistoryTile(n * 60 * cell, cell);
      tile.merge(
        {
          from: tile.from,
          to: tile.from + cell,
          series: Array.from({length: 1 + ((n + seed) % 4)}, (_, i) => ({
            source: 's',
            window: `w${i}`,
            hold: cell,
            open: null,
            cells: [[0, 80, 0, 0]],
          })),
          activity: {sessions: [], devices: {}, cells: []},
          resets: [],
          grants: [],
        },
        {work: 0, sources: {s: 0}},
      );
      tile.shownAt = (n * 13 + seed) % 11;
      tile.readTo = n % 4 ? tile.from + cell : tile.from;
      tiles.set(n, tile);
    }
    const original = tiles[Symbol.iterator].bind(tiles);
    tiles[Symbol.iterator] = function* (): Generator<[number, HistoryTile], undefined, unknown> {
      for (const row of original()) {
        counts.visits++;
        yield row;
      }
      return undefined;
    };
    grids.set(cell, tiles);
  }
  const target: Domain = {cell: M, k0: 5 * 60, k1: 8 * 60 - 1};
  const state = {
    grids,
    budget,
    env: {preparations: null},
    reservations: new Set([`${M}:2`, `${5 * M}:${seed % 12}`]),
    version: 4,
    aheadStopped: !!(seed % 2),
    interest: direction ? {direction} : null,
    target: () => {
      counts.targets++;
      return target;
    },
    plotTarget: () => {
      counts.targets++;
      return target;
    },
    aheadTarget: (value: Domain) => ({
      ...value,
      k0: value.k0 + direction * 180,
      k1: value.k1 + direction * 180,
    }),
    get estimatedBytes() {
      let bytes = 0;
      for (const tiles of grids.values()) for (const tile of tiles.values()) bytes += tile.bytes;
      return bytes;
    },
  };
  Object.setPrototypeOf(state, HistoryStore.prototype);
  return {state, counts, evict: () => Reflect.apply(HistoryStore.prototype['evict'], state, [])};
}

const snapshot = (h: Fixture) => ({
  grids: [...h.state.grids].map(([cell, tiles]) => [cell, [...tiles.keys()]]),
  bytes: h.state.estimatedBytes,
  version: h.state.version,
  aheadStopped: h.state.aheadStopped,
});

test('actual eviction does no candidate work below the unchanged cache budget', () => {
  const h = fixture(15 * 1024 * 1024, -1),
    before = snapshot(h);
  let sorts = 0;
  const sort = Array.prototype.sort;
  Array.prototype.sort = function (compare) {
    sorts++;
    return sort.call(this, compare);
  };
  try {
    for (let i = 0; i < 100; i++) h.evict();
  } finally {
    Array.prototype.sort = sort;
  }
  assert.deepEqual(snapshot(h), before);
  assert.equal(h.counts.visits, 0, 'under-budget pan must not visit candidate tiles');
  assert.equal(sorts, 0);
  assert.equal(h.counts.targets, 0);
});

// The previous loop is the independent pressure-behavior oracle.
function original(h: Fixture) {
  const state = h.state,
    target = state.interest ? state.plotTarget() : state.target();
  const ahead = state.interest?.direction ? state.aheadTarget(target) : null;
  const candidates: {cell: number; n: number; tile: HistoryTile}[] = [];
  for (const [cell, tiles] of state.grids)
    for (const [n, tile] of tiles) {
      if (state.reservations.has(`${cell}:${n}`)) continue;
      if (cell === target.cell && tile.to > target.k0 * cell && tile.from <= target.k1 * cell)
        continue;
      candidates.push({cell, n, tile});
    }
  let bytes = state.estimatedBytes;
  for (const {cell, n, tile} of candidates.sort((a, b) => a.tile.shownAt - b.tile.shownAt)) {
    if (bytes <= state.budget) break;
    state.grids.get(cell)!.delete(n);
    state.version++;
    bytes -= tile.bytes;
    if (
      ahead &&
      cell === ahead.cell &&
      tile.readTo > tile.readFrom &&
      tile.readTo > ahead.k0 * cell &&
      tile.readFrom <= ahead.k1 * cell
    )
      state.aheadStopped = true;
  }
}

test('over-budget eviction preserves reservations, visible frames, mixed grids, LRU ties and reversal behavior', () => {
  for (const direction of [-1, 0, 1])
    for (let seed = 0; seed < 6; seed++)
      for (const fraction of [0, 0.1, 0.5, 0.9]) {
        const budget = Math.floor(fixture(0, direction, seed).state.estimatedBytes * fraction);
        const actual = fixture(budget, direction, seed),
          expected = fixture(budget, direction, seed);
        actual.evict();
        original(expected);
        assert.deepEqual(
          snapshot(actual),
          snapshot(expected),
          `direction=${direction}, seed=${seed}, fraction=${fraction}`,
        );
      }
});
