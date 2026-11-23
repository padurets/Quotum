import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {setImmediate as turn} from 'node:timers/promises';
import type {Frame} from '../../server/events';
import type {PeriodRequest} from '../../server/domain/periodRead';
import type {WorkStamp} from '../../server/domain/workCalendar';
import {page, type HubEvent} from '../lib/board';
import {budgetHistory, followPan, fundsHistory, historyReaders, quotaHistory} from '../lib/history';
import {historyPool} from '../lib/historyPool';
import type {HistoryStore} from '../lib/history';
import type {HistoryTile} from '../lib/historyTiles';
import {boardPeriod} from '../lib/period';
import {onDataFilters, publishDataFilters} from '../lib/filterSelection';
import {pan} from '../lib/pan';
import {setPrefs} from '../lib/prefs';
import {setTimeRange, timeRange, type TimeRange} from '../lib/timeRange';
import {cycleSeed, type CycleSeed} from './historyPoolCycleSeed';

export const DAY = 86_400_000;
const boundary = 4156 * 5 * DAY;
const phase = (name: string, hours: number, minutes = 0, seconds = 0) => ({
  name,
  now: boundary + ((hours * 60 + minutes) * 60 + seconds) * 1000,
});
export const PHASES = [
  phase('0h01m', 0, 1),
  phase('11h55m', 11, 55),
  phase('13h54m', 13, 54),
  phase('31h', 31),
  phase('85h49m', 85, 49),
  phase('119h59m40s', 119, 59, 40),
];

// The router owns its position across successive boards in the same page.
const address = new URL('http://board.example/');
const history = {
  state: {quotumPosition: 0},
  pushState(state: {quotumPosition: number}, _title: string, path: string) {
    address.href = new URL(path, address).href;
    this.state = state;
  },
};

export function cycleTiles(store: HistoryStore, cell: number) {
  const {grids} = store as unknown as {grids: Map<number, Map<number, HistoryTile>>};
  return [...grids.get(cell)!.values()];
}

type Reservation = Parameters<typeof historyPool.reserve>[0] & {
  operation?: string;
  intent?: object;
};

function observePool(t: TestContext) {
  const reservations = (historyPool as unknown as {reservations: Map<Reservation, number>})
    .reservations;
  const reserve = historyPool.reserve,
    trim = historyPool.trim;
  const state = () => ({total: 0, foreground: 0, retirement: 0, at: '', reclaimed: 0, declined: 0});
  let max = state(),
    requesting: Reservation | undefined,
    requestedPeak = 0;
  const sample = (bytes: number, accepted: boolean, at: string) => {
    let retirement = 0;
    for (const [owner, size] of reservations) if (owner.evict === false) retirement += size;
    // Ordinary admission must include every concurrent owner. A trim with only a
    // free-headroom retirement reservation can also observe its in-progress copy.
    const foreground = requesting && requesting.evict !== false ? bytes : bytes - retirement;
    max.foreground = Math.max(max.foreground, foreground);
    if (accepted && bytes > max.total) Object.assign(max, {total: bytes, retirement, at});
  };
  historyPool.reserve = function (owner: Reservation, bytes) {
    const previous = requesting;
    requesting = owner;
    try {
      const accepted = reserve.call(this, owner, bytes);
      if (owner.evict === false) {
        if (accepted) sample(this.estimatedBytes, true, 'optional retirement');
        else max.declined++;
      }
      return accepted;
    } finally {
      requesting = previous;
    }
  };
  historyPool.trim = function () {
    // This pre-eviction reading includes the requested growth and every concurrent owner.
    const before = this.estimatedBytes;
    requestedPeak = Math.max(requestedPeak, before);
    const at =
      requesting?.operation ??
      (requesting?.intent
        ? 'period response'
        : requesting
          ? 'drawing reservation'
          : 'drawing trim');
    if (before > this.budget) sample(before, false, at);
    const accepted = trim.call(this);
    // Below the limit trim is a no-op. After a reclaim only the resulting balance is admitted.
    const after = before <= this.budget ? before : this.estimatedBytes;
    max.reclaimed += before - after;
    if (accepted) sample(after, true, at);
    return accepted;
  };
  t.after(() => {
    historyPool.reserve = reserve;
    historyPool.trim = trim;
  });
  return {
    resetPeak() {
      max = state();
      requestedPeak = historyPool.estimatedBytes;
      sample(requestedPeak, true, 'settled');
    },
    peak: () => requestedPeak,
    usage: () => ({...max}),
  };
}

export function cycleFixture(
  t: TestContext,
  now: number,
  initialRange: TimeRange | null,
  seed: CycleSeed,
) {
  const realNow = Date.now;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });
  const env = cycleSeed(seed, now);
  t.mock.timers.enable({apis: ['setTimeout']});
  const requests: PeriodRequest[] = [];
  let latency = 0;
  const failures: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit) => {
    try {
      assert.equal(input, '/api/boards/' + env.board + '/period');
      assert.equal(init.method, 'POST');
      const body = JSON.parse(String(init.body)) as PeriodRequest;
      requests.push(body);
      const wire = env.reader.read(env.board, env.user, body);
      if (latency) await new Promise<void>(resolve => setTimeout(resolve, latency));
      init.signal?.throwIfAborted();
      return new Response(wire);
    } catch (error) {
      if (!init.signal?.aborted) failures.push(error);
      throw error;
    }
  });

  const readers = [quotaHistory, budgetHistory, fundsHistory];
  const pressure = observePool(t);
  let frame: FrameRequestCallback | null = null;
  const bindings = {
    location: address,
    history,
    requestAnimationFrame: (run: FrameRequestCallback) => {
      frame = run;
      return 1;
    },
    cancelAnimationFrame: () => {
      frame = null;
    },
  };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  for (const [key, value] of Object.entries(bindings))
    Object.defineProperty(globalThis, key, {configurable: true, value});

  const syncSelection = () => {
    boardPeriod.changed();
    for (const reader of readers) reader.choose('30d', timeRange());
  };
  const selectRange = (range: TimeRange | null) => {
    setTimeRange(range);
    syncSelection();
  };
  const stops = [
    page.listen((event, state) => boardPeriod.changed(event, state)),
    onDataFilters(() => boardPeriod.changed()),
    pan.subscribe(() => {
      if (!pan.active()) syncSelection();
    }),
    ...readers.map(reader => followPan(reader, pan, timeRange)),
    pan.onPhase(() => boardPeriod.refreshWorkClock()),
  ];
  const feed = (batch: Frame[]) => {
    for (const part of batch) {
      const data: unknown = JSON.parse(part.data);
      const stamp = (data as {workStamp?: WorkStamp}).workStamp;
      if (part.type === 'ping') {
        if (stamp) boardPeriod.acceptWorkFreshness(stamp);
      } else {
        if (part.type === 'snapshot')
          page.dispatch({type: 'connection', status: 'live', lostAt: null});
        page.dispatch({type: 'hub', event: {type: part.type, data} as HubEvent});
        if (part.type === 'snapshot' && stamp) boardPeriod.acceptWorkFreshness(stamp);
      }
    }
  };
  const secret = 'cycle-fixture';
  env.directory.createSession(secret, env.user, now - DAY, 3 * DAY);
  const stream = env.events.open({
    user: env.user,
    secret,
    board: env.board,
    kind: 'stream',
    send: feed,
    end: () => {},
  });
  assert.ok(stream && stream !== 'limit');
  t.after(() => {
    pan.cancel();
    historyReaders.setActive(false);
    page.dispatch({type: 'board-close'});
    stops.forEach(stop => stop());
    setTimeRange(null);
    publishDataFilters(null, false);
    stream.close();
    env.close();
    for (const key of Object.keys(bindings)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  setPrefs({range: '30d'});
  selectRange(initialRange);
  page.dispatch({type: 'board-open', id: env.board});
  feed(stream.frames);
  publishDataFilters(env.directory.filtersState(env.board).filters);
  historyReaders.setActive(true);

  const settle = async () => {
    for (let n = 0; n < 300; n++) {
      await turn();
      t.mock.timers.tick(200);
      await turn();
      if (failures.length) throw failures[0];
      if (
        !historyPool.activeFlights &&
        readers.every(reader => !reader.get().loading) &&
        !boardPeriod.get().loading
      ) {
        for (const reader of readers) {
          assert.equal(reader.get().error, undefined);
          assert.ok(reader.get().history);
        }
        assert.equal(boardPeriod.get().error, null);
        return;
      }
    }
    assert.fail('Monthly period and drawing reads did not settle');
  };

  return {
    ...env,
    pool: historyPool,
    period: boardPeriod,
    quota: quotaHistory,
    budget: budgetHistory,
    funds: fundsHistory,
    pan,
    requests,
    selectRange,
    settle,
    advance(ms: number) {
      now += ms;
    },
    frame() {
      const run = frame;
      frame = null;
      run?.(now);
    },
    ...pressure,
    setLatency(ms: number) {
      latency = ms;
    },
    tick(ms: number) {
      t.mock.timers.tick(ms);
    },
  };
}
