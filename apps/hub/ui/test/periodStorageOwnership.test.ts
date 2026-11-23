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
    assert.equal(period.storage.get(replay), serialized(replay), 'the replay owns a full copy');
    const withAlias = publish(returned),
      owned = period.storage.get(returned),
      saved = serialized(returned) - owned;
    assert.ok(saved > 0);
    assert.ok(owned > serialized(returned.states), 'the complete start, proof and wrapper remain');
    for (const field of ['windows', 'meters', 'keys', 'creditBalance', 'validFor'] as const) {
      assert.strictEqual(returned[field], returned.states!.start![field]);
      const partial = {...returned, [field]: structuredClone(returned[field])};
      assert.equal(publish(partial) - withAlias, saved, field);
      assert.equal(period.storage.get(partial), serialized(partial));
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

async function replayAcrossMeasurement(h: Awaited<ReturnType<typeof fixture>>) {
  h.store.record(h.source, {
    observedAt: NOW - 1000,
    plan: '',
    resets: null,
    staleAfterMs: H,
    windows: [
      {
        id: 'w',
        kind: 'weekly',
        label: null,
        minutes: 10080,
        used: 40,
        remaining: 60,
        resetAt: NOW + H,
      },
    ],
  });
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
