import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {cellOf, cellStart, TILE_CELLS} from '../../server/domain/history.js';
import type {CycleSeed} from './historyPoolCycleSeed.js';
import {cycleFixture, DAY, cycleTiles} from './historyPoolCycleFixture.js';

/** Replay the ranges committed by the Activity drag and Back before an isolated late update. */
export async function fixedActivityCycle(t: TestContext, now: number, seed: CycleSeed) {
  const range = {from: now - 30 * DAY + 123, to: now},
    cell = cellOf(range.to - range.from),
    span = cell * TILE_CELLS,
    fixture = cycleFixture(t, now, range, seed);
  await fixture.settle();
  // A 48px drag on the monthly plot shifts the fixed interval about 1.35 days.
  const drag = Math.round(1.35 * DAY),
    shifted = {from: range.from - drag, to: range.to - drag};
  fixture.advance(1000);
  fixture.selectRange(shifted);
  await fixture.settle();
  fixture.advance(1000);
  fixture.selectRange(range);
  await fixture.settle();
  const baseline = cycleTiles(fixture.quota, cell).map(tile => ({
      from: tile.from,
      to: tile.to,
      ref: new WeakRef(tile),
    })),
    first = cellStart(shifted.from, span),
    last = Math.ceil(range.to / span) * span;
  assert.deepEqual(
    baseline.map(tile => tile.from).sort((a, b) => a - b),
    Array.from({length: (last - first) / span}, (_, i) => first + i * span),
    'the gesture and Back populate the entire union of monthly tiles',
  );
  const retained = {
    period: fixture.period.estimatedBytes,
    quota: fixture.quota.estimatedBytes,
    budget: fixture.budget.estimatedBytes,
    funds: fixture.funds.estimatedBytes,
  };
  const beforeWork = fixture.period.project(fixture.quota.get().history!, 'quota', now, true)
    .activity.agentMs;
  fixture.advance(1000);
  const dirtyAt = now - 1000,
    device = fixture.directory.devices(fixture.user).find(d => d.name === 'win-desktop'),
    source = fixture.store.sources(fixture.board).find(s => s.provider === 'antigravity');
  assert.ok(device && source);
  const beforeRead = fixture.requests.length;
  fixture.store.creditWork(device.id, dirtyAt, dirtyAt + 100, [
    {
      accountBy: 'login',
      source: source.id,
      origin: 'terminal',
      startedAt: dirtyAt,
      project: 'Observed benchmark',
      folder: '',
      client: 'antigravity',
      identity: {kind: 'stable', sessionId: 'cycle-isolated-work'},
    },
  ]);
  fixture.events.flush();
  await fixture.settle();
  const reads = fixture.requests.slice(beforeRead),
    exact = reads.find(body => body.sessions),
    current = cycleTiles(fixture.quota, cell),
    clean = baseline.filter(tile => tile.to <= cellStart(dirtyAt, cell));
  assert.ok(exact, 'the observed work refreshed the exact period');
  assert.deepEqual(exact.selection, {mode: 'range', ...range});
  assert.equal(
    fixture.period.project(fixture.quota.get().history!, 'quota', now, true).activity.agentMs,
    beforeWork + 100,
  );
  const peak = fixture.peak();
  t.diagnostic(JSON.stringify({retained, peak, cleanTiles: clean.length}));
  assert.ok(clean.length);
  for (const tile of clean)
    assert.ok(
      current.some(held => held === tile.ref.deref()),
      'clean monthly tile at ' + tile.from + ' must stay reusable',
    );
  assert.ok(peak <= fixture.pool.budget - 1.5 * 1024 ** 2, 'fixed Activity pool peak ' + peak);
}
