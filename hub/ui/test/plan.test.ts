import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PLAN, isValidPlan, planAt, weeklyPlanLine, weeklyPlanRemaining} from '../lib/plan';
import type {Win} from '../lib/types';

const DAY = 86_400_000;
const start = Date.UTC(2026, 8, 21);
const weekly = (change: Partial<Win> = {}): Win => ({id: 'weekly', kind: 'weekly', label: null, used: 0, remaining: 100, resetAt: start + 7 * DAY, minutes: 10080, ...change});

test('the default weekly plan is whole percents, front-loaded, ending a day before the reset', () => {
  assert.deepEqual(DEFAULT_PLAN, [30, 25, 15, 15, 10, 5, 0]);
  assert.ok(isValidPlan(DEFAULT_PLAN));
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(day => weeklyPlanRemaining(day * DAY)), [70, 45, 30, 15, 5, 0, 0]);
  assert.equal(weeklyPlanRemaining(1.5 * DAY), 57.5);
});

test('only seven whole days summing to 100 are accepted as a plan', () => {
  assert.ok(isValidPlan([15, 15, 15, 15, 15, 15, 10]));
  assert.ok(!isValidPlan([30, 25, 15, 15, 10, 5]), 'six days');
  assert.ok(!isValidPlan([30, 25, 15, 15, 10, 4, 0]), 'sums to 99');
  assert.ok(!isValidPlan([30.5, 24.5, 15, 15, 10, 5, 0]), 'fractions');
  assert.ok(!isValidPlan([-5, 35, 15, 15, 10, 5, 0]));
});

test('the plan ends with its last non-zero day: a custom plan moves the deadline', () => {
  assert.equal(planAt(weekly(), start + DAY, start + DAY)!.remaining, 70);
  const ended = planAt(weekly(), start + 6.5 * DAY, start + 6.5 * DAY)!;
  assert.deepEqual([ended.remaining, ended.done, ended.deadline], [0, true, start + 6 * DAY]);
  const fiveDays = [40, 30, 15, 10, 5, 0, 0];
  assert.equal(planAt(weekly(), start + 5.5 * DAY, start + 5.5 * DAY, fiveDays)!.done, true);
  assert.equal(planAt(weekly(), start + 5.5 * DAY, start + 5.5 * DAY, fiveDays)!.deadline, start + 5 * DAY);
  const everyDay = [15, 15, 15, 15, 15, 15, 10];
  assert.equal(planAt(weekly(), start + 6.5 * DAY, start + 6.5 * DAY, everyDay)!.done, false);
  assert.equal(planAt(weekly(), start + 6.5 * DAY, start + 6.5 * DAY, everyDay)!.remaining, 5);
});

test('a day at 0 can be anywhere: nothing is spent that day, and the plan goes on after it', () => {
  const gaps = [40, 0, 30, 0, 30, 0, 0];
  assert.ok(isValidPlan(gaps));
  const dayOff = planAt(weekly(), start + 1.5 * DAY, start + 1.5 * DAY, gaps)!;
  assert.deepEqual([dayOff.remaining, dayOff.done, dayOff.deadline], [60, false, start + 5 * DAY]);
  assert.equal(planAt(weekly(), start + 3.5 * DAY, start + 3.5 * DAY, gaps)!.remaining, 30);
  assert.equal(planAt(weekly(), start + 5.5 * DAY, start + 5.5 * DAY, gaps)!.done, true);
});

test('short windows are planned linearly to their reset', () => {
  const session: Win = {id: 'session', kind: 'session', label: null, used: 0, remaining: 100, resetAt: start + 5 * 3_600_000, minutes: 300};
  assert.ok(Math.abs(planAt(session, start + 2.5 * 3_600_000, start + 2.5 * 3_600_000)!.remaining - 50) < 1e-6);
  assert.equal(planAt(weekly({resetAt: null}), start + DAY, start + DAY), null);
  assert.equal(planAt(weekly(), null, start + DAY), null, 'never measured');
});

test('an idle rolling window has no plan: its start is the moment it was measured', () => {
  // Measured at `start`, it reports "now + a week", however long ago that was.
  assert.equal(planAt(weekly(), start, start + 1000), null);
  assert.equal(planAt(weekly(), start, start + DAY), null, 'still idle when measured, a day later');
  // The provider's clock or a slow client put the start a little off the measurement.
  assert.equal(planAt(weekly({resetAt: start + 7 * DAY - 90_000}), start, start + 60_000), null);
  assert.equal(planAt(weekly({resetAt: start + 7 * DAY + 30_000}), start, start + 60_000), null);
  const session: Win = {id: 'session', kind: 'session', label: null, used: 0, remaining: 100, resetAt: start + 5 * 3_600_000, minutes: 300};
  assert.equal(planAt(session, start, start + 60_000), null);
});

test('the plan starts with the window, right after a reset', () => {
  // A window that started five minutes before it was measured has started.
  const fresh = planAt(weekly(), start + 5 * 60_000, start + 6 * 60_000)!;
  assert.ok(fresh.remaining > 99.8 && fresh.remaining < 100);
  assert.equal(fresh.deadline, start + 6 * DAY);
  // An early reset: the new week started an hour ago, when it was first used.
  const early = weekly({used: 3, remaining: 97, resetAt: start + 7 * DAY});
  assert.equal(planAt(early, start + 3_600_000, start + 3_600_000)!.remaining, 100 - 30 / 24);
  // The same for a five-hour window.
  const session: Win = {id: 'session', kind: 'session', label: null, used: 2, remaining: 98, resetAt: start + 5 * 3_600_000, minutes: 300};
  assert.equal(planAt(session, start + 10 * 60_000, start + 15 * 60_000)!.remaining, 95);
});

test('a window past its reset has no plan until it is measured again', () => {
  assert.equal(planAt(weekly(), start + 6 * DAY, start + 7 * DAY), null);
  assert.equal(planAt(weekly(), start + 6 * DAY, start + 7 * DAY + 60_000), null);
});

test('the plan line starts with the current week and restarts at its reset', () => {
  const resetAt = start + 7 * DAY;
  const runs = weeklyPlanLine(resetAt, start - 2 * DAY, start + 3 * DAY);
  assert.equal(runs.length, 1, 'no plan for the week before');
  assert.deepEqual(runs[0].map(([t, v]) => [(t - start) / DAY, v]), [[0, 100], [1, 70], [2, 45], [3, 30]]);
  // An early reset an hour ago: the old week's plan is gone, the new one starts at 100%.
  const early = weeklyPlanLine(start + 3_600_000 + 7 * DAY, start - DAY, start + 2 * 3_600_000);
  assert.deepEqual(early.map(run => run[0]), [[start + 3_600_000, 100]]);
  // Past the reset the next week starts over.
  const next = weeklyPlanLine(resetAt, start + 6 * DAY, start + 8 * DAY);
  assert.deepEqual(next.map(run => run[0]), [[start + 6 * DAY, 0], [resetAt, 100]]);
  const custom = weeklyPlanLine(resetAt, start, start + 2 * DAY, [50, 50, 0, 0, 0, 0, 0]);
  assert.deepEqual(custom[0].map(([, v]) => v), [100, 50, 0]);
});
