import type {Win} from './types';
import type {Line} from './lines';
import {PLAN_TOLERANCE, planAt, type WeeklyPlan} from './plan';

/**
 * Where the average pace over the period leads, as the table's last column says it:
 * nothing to say (`none`), too little measured to tell (`needData`), used up, runs out
 * in `inMs`, on pace to spend it all by the deadline, or `left` points left then.
 */
export type Outlook =
  | {key: 'none'}
  | {key: 'needData'}
  | {key: 'usedUp'}
  | {key: 'runsOut'; inMs: number; tone: 'v-crit' | 'v-warn'; rate: number}
  | {key: 'onPacePlan' | 'onPaceReset'; rate: number}
  | {key: 'leftPlan' | 'leftReset'; left: number; rate: number};

/**
 * Where the average pace over the period leads. Weekly windows are judged against the
 * end of their plan (everything should be spent by then); other windows, and a week past
 * the end of its plan, against their reset.
 */
export function outlook(line: Pick<Line, 'consumed' | 'coveredMs'>, live: Win | undefined, measuredAt: number | null, now: number, weekly: WeeklyPlan | null): Outlook {
  const plan = live ? planAt(live, measuredAt, now, weekly) : null;
  if (live && live.remaining <= 0) return {key: 'usedUp'};
  if (!live?.resetAt || live.resetAt <= now) return {key: 'none'};

  const hours = line.coveredMs / 3_600_000;
  if (hours < 0.5) return {key: 'needData'};
  const rate = line.consumed / hours;
  // Past the end of its plan a week has only its reset ahead.
  const planned = plan?.weekly && !plan.done;
  const deadline = planned ? plan.deadline : live.resetAt;

  if (rate > 0.01) {
    const untilEmpty = (live.remaining / rate) * 3_600_000;
    const untilDeadline = deadline - now;
    if (untilEmpty < untilDeadline) return {key: 'runsOut', inMs: untilEmpty, tone: untilEmpty < untilDeadline / 2 ? 'v-crit' : 'v-warn', rate};
  }
  const left = Math.max(0, live.remaining - (rate * (deadline - now)) / 3_600_000);
  if (left < 5) return {key: planned ? 'onPacePlan' : 'onPaceReset', rate};
  return {key: planned ? 'leftPlan' : 'leftReset', left, rate};
}

/** What a line spent over the period: points, nothing while measured (`unused`), or unknown. */
export type Spent = {key: 'points'; value: number} | {key: 'unused'} | {key: 'unknown'};

export const spentOf = (line: Pick<Line, 'consumed' | 'coveredMs'>): Spent =>
  line.consumed > 0 ? {key: 'points', value: line.consumed} : line.coveredMs ? {key: 'unused'} : {key: 'unknown'};

/**
 * The plan's column: what it expects to be left now, and how far the window is from
 * it (positive: behind the plan, a reserve), marked when it is `notable`. A limit used up
 * is past any plan.
 */
export type PlanCell = {remaining: number; delta: number; notable: boolean};

export function planCell(live: Win | undefined, measuredAt: number | null, now: number, weekly: WeeklyPlan | null): PlanCell | null {
  const plan = live ? planAt(live, measuredAt, now, weekly) : null;
  if (!plan || !live) return null;
  const delta = live.remaining > 0 ? live.remaining - plan.remaining : 0;
  return {remaining: plan.remaining, delta, notable: Math.abs(delta) >= PLAN_TOLERANCE};
}

/** A line of the table over a period up to now: spent, the plan, and where the pace leads. */
export type ForecastRow = {spent: Spent; plan: PlanCell | null; outlook: Outlook};

export const forecastRow = (line: Pick<Line, 'consumed' | 'coveredMs'>, live: Win | undefined, measuredAt: number | null, now: number, weekly: WeeklyPlan | null): ForecastRow => ({
  spent: spentOf(line),
  plan: planCell(live, measuredAt, now, weekly),
  outlook: outlook(line, live, measuredAt, now, weekly),
});
