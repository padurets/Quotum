import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cycleProgress} from '../components/TimerRing';

test('the ring progress is continuous across the end of a collection', () => {
  const interval = 120_000;
  const scheduled = 1_800_000_000_000;
  const ended = scheduled + 18_000;
  const during = cycleProgress({collecting: true, nextAt: scheduled, intervalMs: interval}, ended - 1);
  const after = cycleProgress({collecting: false, nextAt: scheduled + interval, intervalMs: interval}, ended);
  assert.ok(Math.abs(during - after) < 0.001, `${during} vs ${after}`);
  assert.equal(cycleProgress({collecting: false, nextAt: scheduled + interval, intervalMs: interval}, scheduled + interval), 1);
  assert.equal(cycleProgress({collecting: true, nextAt: scheduled, intervalMs: interval}, scheduled), 0);
});
