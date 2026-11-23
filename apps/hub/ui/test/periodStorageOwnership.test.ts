import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, drawings, flush, NOW, H} from './periodRuntimeFixture';
import {PeriodAccounting} from '../lib/periodAccounting';
import {periodValueAt, withValueStates, type PeriodValues} from '../../server/domain/periodValues';

test('dropping a retained view cannot free accounting still owned by the current view', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const h = await fixture({personal: true}),
    drawing = await drawings(h);
  try {
    const period = h.period,
      quota = period.tapes.get('quota'),
      view = h.directory.view(h.board);
    assert.ok(quota.accounting.bytes > 0);
    assert.equal(period.retained.size, 0);
    h.directory.saveView(
      h.board,
      {...view, shown: ['agents', 'quota-history', 'budget-history'], hidden: ['activity']},
      h.alice.id,
      NOW + 1,
    );
    h.events.flush();
    await flush();
    assert.equal(period.tapes.get('quota').tape, quota.tape);
    assert.equal(period.tapes.get('quota').accounting, quota.accounting);
    assert.equal(period.retained.size, 1);
    const [key, entry] = [...period.retained][0];
    const shared = period.estimatedBytes;
    const replacement = new PeriodAccounting(quota.tape, period.work.value, period.index?.curves);
    assert.notEqual(replacement, quota.accounting);
    period.tapes.set('quota', {...quota, accounting: replacement});
    period.measureBytes();
    assert.equal(
      period.estimatedBytes - shared,
      replacement.bytes,
      'a distinct accounting index remains charged while the retained view owns the original',
    );
    period.tapes.set('quota', quota);
    period.measureBytes();
    assert.equal(period.estimatedBytes, shared);
    const before = period.estimatedBytes,
      poolBefore = h.pool.estimatedBytes;
    period.retained.delete(key);
    const released = before - period.estimatedBytes;
    assert.ok(
      released <= entry.bytes - entry.activityBytes - quota.accounting.bytes,
      `dropping another owner freed ${released} bytes including still-current accounting`,
    );
    assert.equal(
      poolBefore - h.pool.estimatedBytes,
      released,
      'the pool releases only the actual marginal storage',
    );
  } finally {
    drawing.close();
    await h.close();
  }
});

test('returning to the value replay start charges its shared fields once in current and cached storage', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const h = await fixture({personal: true, fixed: true});
  try {
    const {period, source} = h,
      reading = period.getValue(source),
      base: PeriodValues = {
        ...reading.value,
        creditBalance: {
          id: 'balance:credits',
          unit: 'credits:codex',
          status: 'finite',
          at: NOW,
          staleAfterMs: H,
        },
        validFor: {from: NOW, to: NOW + H},
      },
      earlier = {...base, validFor: {from: NOW - H, to: NOW}},
      sequence = withValueStates(base, [earlier], () => {}),
      replay = periodValueAt(sequence, NOW - 1)!,
      returned = periodValueAt(replay, NOW)!;
    const publish = (value: PeriodValues) => {
      period.values.set(source, {...reading, value});
      period.measureBytes();
      return period.estimatedBytes;
    };
    const serialized = (value: unknown) => JSON.stringify(value).length * 3;
    publish(replay);
    const program = replay.states!,
      proof = period.storage.get(program);
    assert.equal(proof, serialized(program) - 8);
    assert.equal(
      period.storage.get(replay) + proof,
      serialized(replay),
      'the replay owns a full copy and its program',
    );
    const withAlias = publish(returned),
      owned = period.storage.get(returned),
      saved = serialized(returned) - (owned + proof);
    assert.ok(saved > 0);
    assert.ok(owned > 8, 'the value wrapper and each reference slot remain charged');
    assert.equal(period.storage.get(program), proof);
    for (const field of ['windows', 'meters', 'keys', 'creditBalance', 'validFor'] as const) {
      assert.strictEqual(returned[field], returned.states!.start![field]);
      const partial = {...returned, [field]: structuredClone(returned[field])};
      assert.equal(publish(partial) - withAlias, saved, field);
      assert.equal(period.storage.get(partial) + period.storage.get(program), serialized(partial));
    }
    assert.equal(publish(returned), withAlias);
    const copyBytes = serialized([...period.values]);
    // An outstanding work read permits only the values to enter the LRU.
    period.workNeeded = true;
    h.selectRange({from: NOW - 3 * H, to: NOW - 2 * H});
    const cached = [...period.valueCache.values()].find(
      entry => entry.values.get(source)?.value === returned,
    );
    assert.ok(cached);
    assert.equal(cached.storage.get(returned), owned);
    assert.equal(cached.storage.get(program), proof);
    assert.equal(cached.bytes, copyBytes - saved, 'the reading wrapper cannot absorb the saving');
    assert.equal(cached.copyBytes, copyBytes, 'replaying can still allocate an independent copy');
    await flush();
    assert.ok(!period.storage.has(returned), 'the cache now owns this root alone');
    const before = period.estimatedBytes;
    period.valueCache.clear();
    assert.equal(before - period.estimatedBytes, cached.bytes);
  } finally {
    await h.close();
  }
});

function measurement(
  h: Awaited<ReturnType<typeof fixture>>,
  at: number,
  used: number,
  count: number,
  label: string | null = null,
) {
  h.store.record(h.source, {
    observedAt: at,
    plan: '',
    resets: null,
    staleAfterMs: H,
    windows: Array.from({length: count}, (_, i) => ({
      id: i ? 'w' + i : 'w',
      kind: 'weekly',
      label,
      minutes: 10080,
      used,
      remaining: 100 - used,
      resetAt: NOW + H,
    })),
  });
}
async function replayAcrossMeasurement(
  h: Awaited<ReturnType<typeof fixture>>,
  count = 1,
  label: string | null = null,
) {
  measurement(h, NOW - 1000, 40, count, label);
  h.events.flush();
  await flush();
  const initial = h.selectedRange()!;
  for (const offset of [-1002, -995, -1001]) {
    h.selectRange({from: initial.from + offset, to: initial.to + offset});
    await flush();
  }
  const before = h.period.getValue(h.source).value;
  assert.equal(before.windows, before.states!.start!.windows);
  assert.ok(h.period.storage.has(before));
  return initial;
}

test('a clock correction preserves a shared replay start while its facts remain current', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const h = await fixture({personal: true, fixed: true, clocked: true});
  t.after(() => h.close());
  await replayAcrossMeasurement(h);
  const before = h.period.getValue(h.source).value,
    bytes = h.period.estimatedBytes;
  h.clock.heard(NOW - 5000, NOW);
  h.clock.heard(NOW, NOW);
  assert.equal(h.period.getValue(h.source).value, before);
  assert.ok(h.period.storage.has(before));
  assert.equal(h.period.estimatedBytes, bytes);
});

for (const pressure of ['cache', 'pinned', 'close'] as const)
  test(`a late clock replay respects ${pressure} admission and publishes its storage atomically`, async t => {
    t.mock.method(Date, 'now', () => NOW);
    const h = await fixture({personal: true, fixed: true, clocked: true});
    t.after(() => h.close());
    const initial = await replayAcrossMeasurement(h),
      {pool, period, source} = h;
    h.clock.heard(NOW - 5000, NOW);
    h.selectRange({from: initial.from - 994, to: initial.to - 994});
    await flush();
    const previous = period.getValue(source);
    assert.equal(previous.value.windows[0].used, 17);
    assert.ok(previous.value.states?.start);
    for (const candidate of period.evictionCandidates()) candidate.drop();
    const pinned = new Uint8Array(
      pool.budget - pool.estimatedBytes - (pressure === 'pinned' ? 0 : 4096),
    );
    let cache = pressure === 'pinned' ? null : new Uint8Array(4096),
      drops = 0;
    const other = {
      get estimatedBytes() {
        return pinned.byteLength + (cache?.byteLength ?? 0);
      },
      evictionCandidates: () =>
        cache
          ? [
              {
                bytes: cache.byteLength,
                shownAt: 0,
                drop: () => {
                  cache = null;
                  drops++;
                  // Admission can synchronously retire the entire view before it commits.
                  if (pressure === 'close') h.page.dispatch({type: 'board-close'});
                },
              },
            ]
          : [],
    };
    pool.register(other);
    assert.equal(pool.estimatedBytes, pool.budget);
    const values: number[] = [];
    const stop = period.subscribeValue(source, () => {
      const reading = period.getValue(source);
      if (!reading.value) return;
      values.push(reading.value.windows[0].used);
      assert.ok(period.storage.has(reading.value));
      assert.ok(pool.estimatedBytes <= pool.budget);
      const bytes = period.estimatedBytes;
      period.measureBytes();
      assert.equal(period.estimatedBytes, bytes);
    });
    try {
      h.elapseTo(NOW + 5000);
      h.clock.wakeDue();
      if (pressure === 'close') {
        assert.equal(drops, 1);
        assert.deepEqual(values, []);
        assert.equal(period.values.size, 0);
        assert.equal(period.estimatedBytes, 0);
      } else if (pressure === 'cache') {
        assert.equal(drops, 1);
        assert.deepEqual(values, [40]);
        assert.equal(period.getValue(source).error, null);
        assert.ok(!period.storage.has(previous.value));
      } else {
        const limited = period.getValue(source);
        assert.equal(drops, 0);
        assert.deepEqual(values, [17]);
        assert.equal(limited.error, 'history_limit');
        assert.equal(limited.basis, previous.basis);
        assert.equal(limited.value.windows[0].validUntil, previous.value.windows[0].validUntil);
        assert.ok(pool.estimatedBytes <= pool.budget);
        pool.unregister(other);
        period.retry();
        await flush();
        assert.equal(period.getValue(source).error, null);
        assert.equal(period.getValue(source).value.windows[0].used, 40);
      }
    } finally {
      stop();
      pool.unregister(other);
    }
  });

for (const pinned of [false, true])
  test(`a multi-source first clock replay updates only changed owners with ${pinned ? 'pinned' : 'available'} storage`, async t => {
    t.mock.method(Date, 'now', () => NOW);
    const h = await fixture({personal: true, clocked: true, tableOnly: true});
    const {period, pool} = h,
      sources: string[] = [];
    const member = {estimatedBytes: 0, evictionCandidates: () => []};
    t.after(async () => {
      pool.unregister(member);
      await h.close();
    });
    for (let i = 1; i <= 16; i++) {
      const source = h.store.source('codex', i.toString(16).padStart(24, '0'), NOW - H);
      sources.push(source);
      h.store.hold(source, h.alice.id, NOW - H);
      h.store.record(source, {
        observedAt: NOW - 30_000,
        plan: '',
        resets: null,
        staleAfterMs: 60_000,
        windows: ['a', 'b'].map(id => ({
          id,
          kind: 'weekly',
          label: null,
          minutes: 10080,
          used: 17,
          remaining: 83,
          resetAt: NOW + H,
        })),
      });
    }
    h.events.flush();
    await flush();
    h.selectRange({from: NOW - 30 * 24 * H, to: NOW + H});
    await flush();
    const before = sources.map(id => period.getValue(id).value);
    assert.ok(before.every(v => v.states && !v.states.start && !v.windows[0].stale));
    if (pinned) {
      for (const entry of period.evictionCandidates()) entry.drop();
      member.estimatedBytes = pool.budget - pool.estimatedBytes;
      pool.register(member);
    } else {
      const view = h.directory.view(h.board);
      h.directory.saveView(
        h.board,
        {
          ...view,
          shown: [...view.shown, 'budget-history'],
          hidden: view.hidden.filter(k => k !== 'budget-history'),
        },
        h.alice.id,
        NOW + 1,
      );
      h.events.flush();
      await flush();
    }
    const cached = [...period.retained.values()].find(e => e.storage.has(before[0]));
    if (!pinned) assert.ok(cached);
    const full = period.measureBytes.bind(period),
      measure = t.mock.method(period, 'measureBytes');
    h.elapseTo(NOW + 31_000);
    h.clock.wakeDue();
    assert.equal(
      measure.mock.callCount(),
      0,
      'a value deadline must not measure every source and tape',
    );
    for (const [i, id] of sources.entries()) {
      const {value, error} = period.getValue(id),
        raw = before[i];
      assert.ok(period.storage.has(value));
      assert.equal(period.storage.get(value.states!), JSON.stringify(value.states).length * 3 - 8);
      if (pinned) {
        assert.equal(error, 'history_limit');
        assert.equal(value, raw);
      } else {
        assert.equal(error, null);
        assert.ok(value.windows.every(w => w.stale));
        assert.notEqual(value.states, raw.states);
        assert.equal(value.states!.pieces, raw.states!.pieces);
        assert.equal(value.states!.paths, raw.states!.paths);
        assert.ok(cached!.storage.has(raw) && cached!.storage.has(raw.states));
        assert.ok(!period.storage.has(raw) && !period.storage.has(raw.states!));
      }
    }
    const bytes = pool.estimatedBytes,
      roots = new Map(period.storage);
    assert.ok(bytes <= pool.budget);
    full();
    assert.equal(pool.estimatedBytes, bytes);
    assert.equal(period.storage.size, roots.size);
    for (const [root, size] of roots) assert.equal(period.storage.get(root), size);
  });

test('a late clock replays beside a retained owner without evicting a warm chart', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const h = await fixture({personal: true, fixed: true, clocked: true}),
    d = await drawings(h);
  t.after(async () => {
    d.close();
    await h.close();
  });
  const {period, pool} = h;
  measurement(h, NOW - 4000, 17, 20);
  measurement(h, NOW - 1000, 40, 20);
  h.events.flush();
  await flush();
  const initial = h.selectedRange()!,
    earlier = {from: initial.from - 1.75 * H, to: initial.to - 1.75 * H};
  const choose = async (r: {from: number; to: number}) => {
    h.selectRange(r);
    d.loader.choose('1h', r);
    d.runScheduled();
    await flush();
    d.runScheduled();
    await flush();
  };
  await choose(earlier);
  for (const step of [-1002, -995, -1001])
    await choose({from: initial.from + step, to: initial.to + step});
  h.clock.heard(NOW - 3000, NOW);
  await choose({from: initial.from - 994, to: initial.to - 994});
  for (const entry of period.evictionCandidates()) entry.drop();
  h.directory.saveView(
    h.board,
    {
      ...h.directory.view(h.board),
      shown: ['agents', 'quota-history', 'budget-history'],
      hidden: ['activity'],
    },
    h.alice.id,
    NOW + 1,
  );
  h.events.flush();
  await flush();
  const before = period.getValue(h.source).value;
  assert.equal(before.windows[0].used, 17);
  const entry = [...period.retained.values()].find(entry => entry.storage.has(before));
  assert.ok(entry);
  const warm = d.loader.estimatedBytes;
  assert.ok(d.loader.evictionCandidates().length);
  const pin = new Uint8Array(pool.budget - pool.estimatedBytes - 15000),
    member = {estimatedBytes: pin.byteLength, evictionCandidates: () => []};
  pool.register(member);
  t.after(() => pool.unregister(member));
  h.elapseTo(NOW + 5000);
  h.clock.wakeDue();
  await flush();
  const after = period.getValue(h.source).value,
    bytes = pool.estimatedBytes;
  assert.equal(after.windows[0].used, 40);
  assert.equal(after.states, before.states);
  assert.ok([...period.retained.values()].includes(entry));
  assert.ok(bytes <= pool.budget);
  period.measureBytes();
  assert.equal(pool.estimatedBytes, bytes);
  assert.equal(d.loader.estimatedBytes, warm);
  pool.unregister(member);
  const requests = h.requests.length;
  d.loader.choose('1h', earlier);
  d.runScheduled();
  await flush();
  d.runScheduled();
  await flush();
  assert.equal(h.requests.length, requests);
});
test('exact restore with an expired replay admits the displayed value before notifying or preserves its last basis for retry', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const h = await fixture({personal: true, fixed: true, clocked: true});
  t.after(() => h.close());
  const {period, pool, source} = h,
    label = '🍎'.repeat(240);
  measurement(h, NOW - 119000, 17, 32, label);
  const initial = await replayAcrossMeasurement(h, 32, label);
  h.clock.heard(NOW - 5000, NOW);
  const target = {from: initial.from + 15, to: initial.to + 15},
    distant = {from: initial.from - 5 * H, to: initial.to - 5 * H};
  h.selectRange(target);
  await flush();
  h.clock.heard(NOW, NOW);
  h.clock.wakeDue();
  await flush();
  h.selectRange(distant);
  await flush();
  h.clock.heard(NOW - 5000, NOW);
  h.clock.wakeDue();
  await flush();
  h.selectRange(target);
  await flush();
  const last = period.getValue(source);
  assert.equal(last.value.windows[0].used, 17);
  assert.ok(last.value.states?.start);
  assert.equal(last.value.windows, last.value.states.start.windows);
  const key = period.cacheKey;
  h.selectRange(distant);
  await flush();
  h.elapseTo(NOW + 5000);
  h.clock.wakeDue();
  for (const cache of [...period.retained.keys()]) if (cache !== key) period.retained.delete(cache);
  const pinned = new Uint8Array(pool.budget - pool.estimatedBytes - 55_000),
    member = {estimatedBytes: pinned.byteLength, evictionCandidates: () => []};
  pool.register(member);
  t.after(() => pool.unregister(member));
  const notices: string[] = [];
  const stop = period.subscribeValue(source, () => {
    const reading = period.getValue(source);
    assert.ok(pool.estimatedBytes <= pool.budget);
    assert.ok(period.storage.has(reading.value));
    notices.push(reading.error ?? 'ok');
  });
  try {
    h.selectRange(target);
    await flush();
    const limited = period.getValue(source);
    assert.deepEqual(notices, ['history_limit']);
    assert.equal(limited.value, last.value);
    assert.deepEqual(limited.basis, last.basis);
    const bytes = pool.estimatedBytes;
    period.measureBytes();
    assert.equal(pool.estimatedBytes, bytes);
    pool.unregister(member);
    h.requests.length = 0;
    period.retry();
    await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(period.getValue(source).value.windows[0].used, 40);
    assert.equal(period.getValue(source).error, null);
  } finally {
    stop();
  }
});
