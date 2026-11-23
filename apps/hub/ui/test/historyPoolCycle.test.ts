import {after, before, test, type TestContext} from 'node:test';
import {CLOCK_TOLERANCE_MS} from '../../server/domain/history';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import type {TimeRange} from '../lib/timeRange';
import {cycleFixture, cycleTiles, DAY, PHASES} from './historyPoolCycleFixture';
import {fixedActivityCycle} from './fixedActivityCycle';
import {seedCyclePhase, type CycleSeed} from './historyPoolCycleSeed';

async function drawingCycle(t: TestContext, now: number, latency: number, seed: CycleSeed) {
  const c = cycleFixture(t, now, null, seed);
  await c.settle();
  const length = 30 * DAY,
    future = DAY,
    width = 1000;
  const chart = Symbol('quota');
  let selected: TimeRange | null = null;
  const unregister = c.pan.register(chart, () => ({
    end: selected?.to ?? Date.now(),
    future: selected ? 0 : future,
  }));
  t.after(unregister);
  for (const reader of [c.quota, c.budget, c.funds]) {
    const h = reader.get().history!;
    assert.ok((reader === c.quota ? h.series.length : (h.meterSeries?.length ?? 0)) >= 12);
  }

  // The live reader admits a cell just beyond the five-day boundary when a provider's
  // clock is ahead. Check the admitted cell bounds before the gesture can extend them.
  const cell = c.quota.get().history!.cellMs;
  const liveEnd = (Math.floor((now + CLOCK_TOLERANCE_MS) / cell) + 1) * cell;
  for (const reader of [c.quota, c.budget, c.funds])
    assert.equal(Math.max(...cycleTiles(reader, cell).map(tile => tile.readTo)), liveEnd);

  const scroll = async (pixels: number) => {
    // Both widgets keep their displayed frame while the replacement is being prepared.
    const releaseCalendar = c.period.calendar.retain(c.period.calendar.get());
    const drawing = c.period.project(c.quota.get().history!, 'quota', Date.now(), true);
    const releaseActivity = c.period.retainActivity(c.period.captureActivity(drawing));
    try {
      const token = c.pan.begin({
        source: chart,
        input: 'wheel',
        selected,
        length,
        now: Date.now(),
        historyStart: now - 75 * DAY,
        span: length + (selected ? 0 : future),
        width,
      });
      assert.notEqual(token, null);
      for (let i = 0; i < 46; i++) {
        c.pan.move(token!, pixels / 46);
        c.frame();
        await turn();
        c.tick(16);
        await turn();
      }
      const result = c.pan.finish(token!);
      assert.ok(result);
      selected = result === 'live' ? null : result;
      await c.settle();
      const range = selected ? `${selected.from}-${selected.to}` : '30d';
      for (const reader of [c.quota, c.budget, c.funds])
        assert.equal(reader.get().history!.range, range);
      return selected;
    } finally {
      releaseCalendar();
      releaseActivity();
    }
  };

  c.advance(1000);
  c.resetPeak();
  const from = c.requests.length;
  c.setLatency(latency);
  const cold = await scroll(-width / 2);
  c.setLatency(0);
  assert.ok(cold);
  assert.equal(cold.to, Date.now() - (length + future) / 2);
  assert.ok(c.requests.length > from);
  const retained = {
    period: c.period.estimatedBytes,
    quota: c.quota.estimatedBytes,
    budget: c.budget.estimatedBytes,
    funds: c.funds.estimatedBytes,
  };
  const warm = c.requests.length;
  c.advance(1000);
  assert.equal(await scroll((width * (Date.now() - cold.to)) / length), null);
  c.advance(1000);
  assert.ok(await scroll(-width / 2));
  const usage = c.usage();
  t.diagnostic(JSON.stringify({retained, usage, warmReads: c.requests.length - warm}));
  assert.equal(c.requests.length, warm, 'cached return and repeat must start no requests');
  assert.equal(usage.reclaimed, 0, 'the monthly path did not need to evict any history');
  assert.ok(usage.total <= c.pool.budget, `admitted ${usage.total} B`);
  assert.ok(
    c.pool.budget - usage.foreground >= 1.5 * 1024 ** 2,
    `foreground ${usage.foreground} B`,
  );
}

// A displayed calendar participates in the shared pool, including its civil-day edges.
const originalZone = process.env.TZ;
before(() => {
  process.env.TZ = 'UTC';
});
after(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

// The regular gate exercises the densest eleven-tile phase. Select every offset for the cycle matrix.
const matrix = process.env.QUOTUM_TEST_HISTORY_CYCLE === '1';
for (const {name, now} of PHASES.filter(p => matrix || p.name === '11h55m'))
  test(`monthly history at ${name} in the tile cycle`, async t => {
    const seed = await seedCyclePhase(t, now);
    if (name === '11h55m')
      await t.test('immediate drawing replies', s => drawingCycle(s, now, 0, seed));
    await t.test('400 ms drawing replies', s => drawingCycle(s, now, 400, seed));
    await t.test('fixed Activity update', s => fixedActivityCycle(s, now, seed));
  });
