import assert from 'node:assert/strict';
import {test} from 'node:test';
import {tileOf, type Chunk} from '../../server/domain/history';
import {composeMeters} from '../../server/domain/meterHistory';
import {HistoryStore} from '../lib/history';
import {HistoryPool} from '../lib/historyPool';
import {HistoryTile} from '../lib/historyTiles';
import {drain, Preparations} from '../lib/prepare';

const CELL = 7_200_000,
  DAY = 86_400_000,
  NOW = 1_793_231_751_478;
const LEFT = 1_788_912_000_000,
  END = LEFT + 60 * CELL,
  CUT = END - CELL,
  RETURN = 1_791_936_000_000;
const RANGE = {from: 1_789_343_751_478, to: 1_791_935_751_478},
  known = {work: 0, sources: {}};
function input(from: number): Chunk {
  return {
    from,
    to: from + 60 * CELL,
    series: [],
    activity: {sessions: [], devices: {}, cells: []},
    resets: [],
    grants: [],
    meterSeries: Array.from({length: 12}, (_, source) => ({
      source: `s${source}`,
      meter: 'balance',
      kind: 'balance',
      unit: 'USD',
      role: 'total',
      accounting: {spending: 'unavailable', topups: 'unavailable'},
      pointMode: 'cell',
      semantics: null,
      cells: Array.from({length: 60}, (_, i) => [
        i,
        String(9_007_199_254_740_993n + BigInt(i + source)),
        null,
        null,
        CELL,
        {semantics: {limit: null, resetAt: null, minutes: null, scope: null, label: `terms ${i}`}},
      ]),
    })),
  };
}
function tile(from: number, chunk = input(from)) {
  const value = drain(new HistoryTile(from, CELL).staged(chunk, known));
  value.readFrom = value.nativeFrom = from;
  value.readTo = value.validTo = value.nativeTo = value.nativeValidTo = from + 60 * CELL;
  return value;
}
function fixture(preparations: Preparations | null = null) {
  let latest = RANGE.from;
  const queued: (() => void)[] = [],
    pool = new HistoryPool(),
    edge = tile(LEFT),
    returned = tile(RETURN);
  const store = new HistoryStore(
    {
      now: () => NOW,
      visibleFrom: () => latest,
      preparations,
      schedule: run => queued.push(run),
      read: async () => {
        throw Error('Eviction must not read history');
      },
      setTimeout: () => ({}),
      clearTimeout() {},
      dropTimeRange() {},
    },
    undefined,
    'budget',
    pool,
  );
  store.open('b');
  store.hello('run');
  store.choose('30d', RANGE);
  const state = store as unknown as {
    grids: Map<number, Map<number, HistoryTile>>;
    reservations: Map<string, unknown>;
    composeOwner: object;
    plotOwner: object;
  };
  state.grids.set(
    CELL,
    new Map([
      [tileOf(LEFT, CELL), edge],
      [tileOf(RETURN, CELL), returned],
    ]),
  );
  edge.shownAt = 2;
  returned.shownAt = 1;
  return {
    store,
    state,
    pool,
    edge,
    returned,
    latest: (from: number) => {
      latest = from;
    },
    close() {
      store.close();
      preparations?.dispose();
      pool.unregister(store);
    },
  };
}

test('a visible monetary edge can release its never-requested prefix and retain an older visited tile', () => {
  const h = fixture();
  try {
    const candidates = h.store.evictionCandidates(),
      prefix = candidates.find(candidate => candidate.priority === 0);
    assert.ok(prefix, 'partial visibility must not pin every unvisited packed cell');
    assert.equal(
      candidates.filter(candidate => candidate.priority !== 0).length,
      1,
      'the previously visited return tile is still an ordinary victim',
    );
    const before = h.edge.bytes,
      total = h.pool.estimatedBytes,
      published = h.edge.chunk(known),
      copy = structuredClone(published),
      returned = h.returned.chunk(known);
    const kept = composeMeters([{from: LEFT, meterSeries: published.meterSeries}], CELL, CUT, END);
    prefix.drop();
    assert.ok(before - h.edge.bytes >= 3218, 'reclaim exceeds the recorded CI pressure excess');
    assert.equal(
      total - h.pool.estimatedBytes,
      before - h.edge.bytes,
      'only physically removed packed storage reduces the estimate',
    );
    assert.equal(h.pool.budget, 15 * 1024 * 1024);
    assert.equal(h.edge.readFrom, CUT);
    assert.equal(h.edge.nativeFrom, CUT);
    assert.equal(h.edge.nativeTo, END);
    assert.deepEqual(
      composeMeters([{from: CUT, meterSeries: h.edge.chunk(known).meterSeries}], CELL, CUT, END),
      kept,
    );
    assert.deepEqual(published, copy, 'already decoded data remains unchanged');
    assert.deepEqual(h.returned.chunk(known), returned);
    assert.equal(h.state.grids.get(CELL)!.get(tileOf(RETURN, CELL)), h.returned);
  } finally {
    h.close();
  }
});

test('reclaiming a dense edge never copies its visible suffix beyond a full pool', t => {
  const h = fixture();
  try {
    const chunk = input(LEFT);
    const series = chunk.meterSeries![0];
    series.pointMode = 'observation';
    series.cells = Array.from({length: 60}, (_, i) => [
      i,
      '1000000',
      null,
      null,
      CELL,
      {
        observations: Array.from({length: 15}, (_, j) => ({
          at: LEFT + i * CELL + (j * CELL) / 15,
          value: '1000000',
          validUntil: LEFT + (i + 1) * CELL,
        })),
      },
    ]);
    chunk.meterSeries = [series];
    const edge = tile(LEFT, chunk);
    h.state.grids.set(CELL, new Map([[tileOf(LEFT, CELL), edge]]));
    h.latest(LEFT + 3 * CELL);
    assert.ok(h.store.evictionCandidates().some(candidate => candidate.priority === 0));
    const pinned = new Uint8Array(h.pool.budget - h.pool.estimatedBytes);
    h.pool.register({
      get estimatedBytes() {
        return pinned.byteLength;
      },
      evictionCandidates: () => [],
    });
    assert.equal(h.pool.estimatedBytes, h.pool.budget);

    // These three arrays are simultaneously reachable inside the copy, before
    // the new suffix can replace its source. They are a lower bound on live bytes.
    const slice = Uint8Array.prototype.slice;
    let peak = pinned.byteLength;
    t.mock.method(
      Uint8Array.prototype,
      'slice',
      function (this: Uint8Array, start?: number, end?: number) {
        const copy = slice.call(this, start, end);
        peak = Math.max(peak, pinned.byteLength + this.buffer.byteLength + copy.buffer.byteLength);
        return copy;
      },
    );
    const flight = {role: 'visible' as const};
    assert.equal(h.pool.reserve(flight, 1), false, 'the visible tile is the only candidate');
    assert.equal(edge.readFrom, LEFT);
    assert.deepEqual(edge.chunk(known).meterSeries, chunk.meterSeries);
    assert.ok(peak <= h.pool.budget, `live buffers occupied at least ${peak} B`);
  } finally {
    h.close();
  }
});

test('pressure can evict an older tile when the visible edge has no room to shrink', () => {
  const h = fixture();
  try {
    const grid = h.state.grids.get(CELL)!;
    const held = h.pool.budget - h.pool.estimatedBytes;
    h.pool.register({estimatedBytes: held, evictionCandidates: () => []});
    const flight = {role: 'visible' as const};
    assert.equal(h.pool.reserve(flight, 1), true);
    assert.equal(grid.get(tileOf(LEFT, CELL)), h.edge);
    assert.equal(h.edge.nativeFrom, LEFT);
    assert.equal(grid.has(tileOf(RETURN, CELL)), false);
    assert.ok(h.pool.estimatedBytes <= h.pool.budget);
    h.pool.release(flight);
  } finally {
    h.close();
  }
});

test('a full pool can release a wholly unseen series in either order and preserve the return tile', () => {
  for (const last of [false, true]) {
    const h = fixture();
    try {
      const chunk = input(LEFT);
      chunk.meterSeries!.at(last ? -1 : 0)!.cells.pop();
      const edge = tile(LEFT, chunk),
        grid = h.state.grids.get(CELL)!,
        shown = composeMeters([{from: LEFT, meterSeries: chunk.meterSeries}], CELL, CUT, END);
      grid.set(tileOf(LEFT, CELL), edge);
      const held = h.pool.budget - h.pool.estimatedBytes;
      h.pool.register({estimatedBytes: held, evictionCandidates: () => []});
      const flight = {role: 'visible' as const};
      assert.equal(h.pool.reserve(flight, 1), true);
      assert.equal(edge.nativeFrom, CUT);
      assert.equal(grid.get(tileOf(RETURN, CELL)), h.returned);
      assert.deepEqual(composeMeters([edge.chunk(known)], CELL, CUT, END), shown);
      assert.ok(h.pool.estimatedBytes <= h.pool.budget);
      h.pool.release(flight);
    } finally {
      h.close();
    }
  }
});

test('shared versions, outstanding borrowers, reserved writes and requested prefixes cannot be reclaimed', () => {
  for (const kind of [
    'clone',
    'activity',
    'plans',
    'decode',
    'staging',
    'reserved',
    'visited',
  ] as const) {
    const h = fixture();
    let work: Generator | undefined;
    try {
      if (kind === 'clone') drain(h.edge.staged(input(LEFT), known));
      if (kind === 'activity') h.edge.retireActivity();
      if (kind === 'plans') h.edge.retirePlans(Infinity);
      if (kind === 'decode') {
        work = h.edge.chunkPrepared(known);
        work.next();
      }
      if (kind === 'staging') {
        work = h.edge.staged(input(LEFT), known);
        work.next();
      }
      if (kind === 'reserved') h.state.reservations.set(`${CELL}:${tileOf(LEFT, CELL)}`, {});
      if (kind === 'visited') h.store.choose('30d', {from: LEFT, to: LEFT + 30 * DAY});
      const bytes = h.edge.bytes;
      for (const candidate of h.store.evictionCandidates())
        if (candidate.priority === 0) candidate.drop();
      assert.equal(h.edge.bytes, bytes, kind);
      assert.equal(h.edge.nativeFrom, LEFT, kind);
    } finally {
      work?.return(undefined);
      h.close();
    }
  }
});

test('prefix eviction cancels owned yielding decoders before releasing their input', () => {
  let ticks = 0;
  const tasks: (() => void)[] = [],
    scheduler = new Preparations({now: () => ticks++, post: run => tasks.push(run)}),
    h = fixture(scheduler);
  try {
    scheduler.replace(
      h.state.composeOwner,
      h.edge.composeChunkPrepared(NOW, 'all', new Set()),
      () => true,
      () => assert.fail('compose must be cancelled'),
    );
    scheduler.replace(
      h.state.plotOwner,
      h.edge.chunkPrepared(known, true, NOW),
      () => true,
      () => assert.fail('plot must be cancelled'),
    );
    tasks.shift()!();
    tasks.shift()!();
    assert.equal(scheduler.size, 2);
    assert.equal(h.edge.discardPrefix(CUT), 0, 'an active decoder owns its packed input');
    h.store
      .evictionCandidates()
      .find(candidate => candidate.priority === 0)!
      .drop();
    assert.equal(scheduler.size, 0);
    assert.equal(h.edge.nativeFrom, CUT);
  } finally {
    h.close();
  }
});

test('a newly requested left boundary protects cells before this reader receives the selection or gesture', () => {
  const h = fixture();
  try {
    const pending = h.store.evictionCandidates().find(candidate => candidate.priority === 0)!;
    h.latest(RANGE.from - CELL);
    pending.drop();
    assert.equal(h.edge.nativeFrom, LEFT, 'the earlier candidate must recheck the latest request');
    h.store
      .evictionCandidates()
      .find(candidate => candidate.priority === 0)!
      .drop();
    assert.equal(h.edge.nativeFrom, CUT - CELL, 'the newly requested cell stays cached');
    h.store.choose('30d', {from: RANGE.from - CELL, to: RANGE.to - CELL});
    h.latest(RANGE.from);
    for (const candidate of h.store.evictionCandidates())
      if (candidate.priority === 0) candidate.drop();
    assert.equal(
      h.edge.nativeFrom,
      CUT - CELL,
      'returning right cannot reclassify requested cells as unseen',
    );
  } finally {
    h.close();
  }
});
