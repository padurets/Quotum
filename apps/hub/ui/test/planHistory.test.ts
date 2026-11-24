import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HistoryTile} from '../lib/historyTiles';
import {HistoryStore} from '../lib/history';
import {PageClock} from '../lib/clock';
import {compose, targetOf, planRowBytes, type Chunk} from '../../server/domain/history';
import {plotOf} from '../lib/historyPlot';
import {drain, Preparations} from '../lib/prepare';
const M = 60_000,
  H = 60 * M,
  known = {work: 0, sources: {s: 0}};
const chunk = (plans: NonNullable<Chunk['plans']>): Chunk => ({
  from: 0,
  to: H,
  series: [],
  activity: {sessions: [], devices: {}, cells: []},
  resets: [],
  grants: [],
  plans,
});
test('plan facts survive packing, exact frame composition and plot extraction without duplicate source markers', () => {
  const raw = chunk([['s', M, 'max', {at: 0, plan: 'pro'}, H + M + 1]]),
    tile = new HistoryTile(0, M);
  tile.readTo = H;
  tile.merge(raw, known);
  const meta = {known, now: H, historyStart: 0},
    target = targetOf(H, H, 'test', {from: 0, to: H}),
    accepted = tile.chunk(known, false, H);
  assert.deepEqual(accepted.plans, raw.plans);
  assert.equal(tile.bytes, new HistoryTile(0, M).bytes + planRowBytes(raw.plans![0]));
  assert.equal(compose([accepted, accepted], meta, target, new Set()).events.length, 1);
  assert.equal(plotOf([accepted], meta, target, [[0, H]], new Set(), 1, 1, 1).events.length, 1);
  const redacted = tile.retirePlans(H + 1)!;
  assert.equal(redacted.chunk(known, false, H + 1).plans![0][3], null);
  assert.deepEqual(accepted.plans, raw.plans, 'published predecessor remains untouched');
  assert.equal(
    tile.chunk(known, false, H + 1).plans![0][3],
    null,
    'an inactive cache redacts before its next read',
  );
  const expired = redacted.retirePlans(H + M + 1)!;
  assert.equal(expired.chunk(known, false, H + M + 1).plans, undefined);
  const replacement = drain(tile.staged(chunk([]), known));
  assert.equal(replacement.chunk(known, false, H).plans, undefined);
  assert.deepEqual(tile.chunk(known, false, H).plans, raw.plans);
  assert.equal(
    drain(new HistoryTile(0, M).staged(raw, known, () => false)),
    null,
    'failed bounded staging cannot publish a partial plan generation',
  );
});
test('the actual history owner redacts active and sleeping facts through the shared clock without HTTP', async () => {
  let now = H,
    reads = 0;
  const timers = new Map<object, {at: number; run: () => void}>();
  const clock = new PageClock({
    now: () => now,
    visible: () => true,
    setTimeout: (run, ms) => {
      const token = {};
      timers.set(token, {at: now + ms, run});
      return token;
    },
    clearTimeout: token => {
      timers.delete(token as object);
    },
  });
  const store = new HistoryStore(
    {
      clock,
      now: () => now,
      preparations: null,
      read: async (_board, _cell, from, to) => {
        reads++;
        return {
          run: 'r',
          now,
          historyStart: 0,
          known,
          chunks: [{...chunk([['s', M, 'max', {at: 0, plan: 'pro'}, H + M + 1]]), from, to}],
        };
      },
      dropTimeRange: () => {},
      setTimeout: () => null,
      clearTimeout: () => {},
    },
    undefined,
    'quota',
  );
  store.choose('1h', null);
  store.open('b');
  store.hello('r');
  store.snapshot(['s'], [], 0);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  const initial = store.get().history!;
  assert.equal(initial.events.length, 1);
  assert.equal(initial.events[0].kind, 'plan');
  const initialReads = reads;
  now = H + 1;
  clock.wakeDue();
  const changed = store.get().history!;
  assert.equal(changed.events[0].kind === 'plan' && changed.events[0].previous, null);
  assert.equal(initial.events[0].kind === 'plan' && initial.events[0].previous?.plan, 'pro');
  assert.equal(reads, initialReads);
  // Eviction can leave a published frame alive after its supporting tile is gone.
  (store as unknown as {grids: Map<number, unknown>}).grids.clear();
  store.setActive(false);
  assert.equal(timers.size, 0);
  now = H + M + 1;
  assert.deepEqual(store.get().history!.events, []);
  assert.equal(reads, initialReads);
  store.close();
  assert.equal(timers.size, 0);
});

for (const onlyWork of [false, true])
  test(`a ${onlyWork ? 'work-only' : 'mixed'} update replaces the panned Activity cells after plan retirement`, async t => {
    const at = H - M,
      range = {from: 0, to: H},
      reads: boolean[] = [];
    let now = H,
      activeMs = 20_000;
    const clock = new PageClock({
      now: () => now,
      visible: () => true,
      setTimeout: () => null,
      clearTimeout: () => {},
    });
    const store = new HistoryStore(
      {
        clock,
        now: () => now,
        preparations: null,
        read: async (_board, cell, from, to, _signal, _meters, _meta, _owner, activityOnly) => {
          reads.push(!!activityOnly);
          const row = chunk(from <= M ? [['s', M, 'max', {at: 0, plan: 'pro'}, H + M + 1]] : []);
          const i = (at - from) / cell;
          row.from = from;
          row.to = to;
          row.activity = {
            sessions: [['r', 's', 'p', 'd']],
            devices: {},
            cells: [[i, activeMs, [0], []]],
          };
          if (!activityOnly) {
            const left = reads.length === 1 ? 80 : 60;
            row.series = [
              {source: 's', window: 'w', hold: H, open: left, cells: [[i, left, 0, 0]]},
            ];
          }
          return {run: 'run', now, known, historyStart: 0, chunks: [row]};
        },
        dropTimeRange: () => {},
        setTimeout: () => null,
        clearTimeout: () => {},
      },
      undefined,
      'quota',
    );
    t.after(() => store.close());
    const flush = async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    };
    store.open('b');
    store.hello('run');
    store.setWorkFilter('all');
    store.choose('1h', range);
    store.snapshot(['s'], ['s w'], 0);
    await flush();
    const interest = {...range, length: H, token: 1, direction: 0 as const};
    store.pan(interest);
    await flush();
    assert.equal(store.getActivityPlot()?.activityCells.get(at)?.agentMs, 20_000);
    now++;
    clock.wakeDue();
    await flush();
    const native = store.getPlot()!;
    assert.ok(native.events.some(e => e.kind === 'plan' && e.previous === null));
    assert.equal(native.series[0].points[0][1], 80);
    activeMs = 50_000;
    store.news(at, undefined, at, onlyWork ? Infinity : at);
    await flush();
    if (onlyWork) assert.equal(store.getPlot(), native);
    const displayed = () => [
      store.getActivityPlot()?.token,
      store.getActivityPlot()?.activityCells.get(at)?.agentMs,
      store.getPlot()?.series[0].points[0][1],
    ];
    const updated = displayed();
    store.endPan(true);
    store.pan({...interest, token: 2});
    await flush();
    const left = onlyWork ? 80 : 60;
    assert.deepEqual(
      [updated, displayed()],
      [
        [1, 50_000, left],
        [2, 50_000, left],
      ],
    );
    assert.deepEqual(reads, [false, onlyWork]);
  });

for (const expiry of [false, true])
  for (const pan of [false, true])
    test(`pending cached ${pan ? 'pan completion' : 'range'} survives plan retirement (${expiry ? 'exclusive expiry' : 'control'})`, async () => {
      let now = H,
        reads = 0,
        elapsed = 0;
      const posts: (() => void)[] = [],
        scheduler = new Preparations({now: () => ++elapsed, post: run => posts.push(run)}, 1);
      const clock = new PageClock({
        now: () => now,
        visible: () => true,
        setTimeout: () => null,
        clearTimeout: () => {},
      });
      const store = new HistoryStore(
        {
          clock,
          now: () => now,
          preparations: scheduler,
          read: async (_board, _cell, from, to) => {
            reads++;
            return {
              run: 'r',
              now,
              historyStart: 0,
              known,
              chunks: [{...chunk([['s', M, 'max', {at: 0, plan: 'pro'}, H + M + 1]]), from, to}],
            };
          },
          dropTimeRange: () => {},
          setTimeout: () => null,
          clearTimeout: () => {},
        },
        undefined,
        'quota',
      );
      const flush = async () => {
        for (let i = 0; i < 200; i++) {
          posts.shift()?.();
          await Promise.resolve();
        }
      };
      try {
        store.choose('1h', null);
        store.open('b');
        store.hello('r');
        store.snapshot(['s'], [], 0);
        await flush();
        const before = store.get().history!,
          initialReads = reads;
        assert.equal(before.range, '1h');
        if (pan) {
          store.pan({from: M, to: H, length: H - M, token: 1, direction: -1});
          await flush();
          store.endPan(true);
        }
        store.choose('1h', {from: M, to: H});
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assert.ok(posts.length, 'the cached target has asynchronous preparation queued');
        if (expiry) {
          now = H + 1;
          clock.wakeDue();
          const retired = store.get().history!.events[0];
          assert.equal(retired.kind === 'plan' && retired.previous, null);
        }
        await flush();
        const ready = store.get();
        assert.equal(ready.history!.range, `${M}-${H}`);
        assert.equal(ready.loading, false);
        assert.equal(
          reads,
          initialReads,
          'retirement resumes cached work without another HTTP read',
        );
        assert.equal(
          before.events[0].kind === 'plan' && before.events[0].previous?.plan,
          'pro',
          'the published predecessor is copy-on-write',
        );
        if (expiry)
          assert.equal(
            ready.history!.events[0].kind === 'plan' && ready.history!.events[0].previous,
            null,
            'replacement never restores expired evidence',
          );
      } finally {
        store.close();
        scheduler.dispose();
      }
    });
