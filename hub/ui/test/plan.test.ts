import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PLAN, isValidPlan, planAt, weeklyPlanLine, weeklyPlanRemaining} from '../lib/plan';
import type {Win} from '../lib/types';

const DAY = 86_400_000;
const start = Date.UTC(2026, 8, 21);
const weekly = (change: Partial<Win> = {}): Win => ({id: 'weekly', label: 'Weekly', used: 0, remaining: 100, resetAt: start + 7 * DAY, minutes: 10080, ...change});

test('the default weekly plan is whole percents, front-loaded, with a rest day', () => {
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

test('the rest days follow the plan: a custom plan moves the deadline', () => {
  assert.equal(planAt(weekly(), start + DAY)!.remaining, 70);
  const rest = planAt(weekly(), start + 6.5 * DAY)!;
  assert.deepEqual([rest.remaining, rest.restDay, rest.deadline], [0, true, start + 6 * DAY]);
  const fiveDays = [40, 30, 15, 10, 5, 0, 0];
  assert.equal(planAt(weekly(), start + 5.5 * DAY, fiveDays)!.restDay, true);
  assert.equal(planAt(weekly(), start + 5.5 * DAY, fiveDays)!.deadline, start + 5 * DAY);
  const everyDay = [15, 15, 15, 15, 15, 15, 10];
  assert.equal(planAt(weekly(), start + 6.5 * DAY, everyDay)!.restDay, false);
  assert.equal(planAt(weekly(), start + 6.5 * DAY, everyDay)!.remaining, 5);
});

test('short windows are planned linearly to their reset; idle rolling windows have no plan', () => {
  const session: Win = {id: 'session', label: '5 hours', used: 0, remaining: 100, resetAt: start + 5 * 3_600_000, minutes: 300};
  assert.ok(Math.abs(planAt(session, start + 2.5 * 3_600_000)!.remaining - 50) < 1e-6);
  assert.equal(planAt(weekly(), start + 1000), null, 'a window that has not really started');
  assert.equal(planAt(weekly({resetAt: null}), start + DAY), null);
});

test('the plan line repeats weekly and restarts at every reset inside the range', () => {
  const resetAt = start + 7 * DAY;
  const runs = weeklyPlanLine(resetAt, start - 2 * DAY, start + 3 * DAY);
  assert.equal(runs.length, 2, 'previous week tail + current week');
  assert.deepEqual(runs[0][0], [start - 2 * DAY, 5], 'day six of the previous week');
  assert.deepEqual(runs[1].map(([t, v]) => [(t - start) / DAY, v]), [[0, 100], [1, 70], [2, 45], [3, 30]]);
  const custom = weeklyPlanLine(resetAt, start, start + 2 * DAY, [50, 50, 0, 0, 0, 0, 0]);
  assert.deepEqual(custom[0].map(([, v]) => v), [100, 50, 0]);
});
