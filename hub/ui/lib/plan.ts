import type {Win} from './types';

const DAY = 86_400_000;
const WEEK_MINUTES = 10080;

/**
 * How a weekly quota is meant to be spent: whole percent per day of the window
 * (providers report whole percents, so finer targets would be false precision).
 * A day at 0 has no spending planned, wherever it is in the week; the plan ends with
 * its last non-zero day. The board's owner sets it per source in the card settings.
 */
export type WeeklyPlan = number[];
export const DEFAULT_PLAN: WeeklyPlan = [30, 25, 15, 15, 10, 5, 0];
export const PLAN_DAYS = 7;
/** Gap (in percentage points) between actual and planned remaining that the table marks. */
export const PLAN_TOLERANCE = 3;
/** A gap this wide or wider is worth a word under a card's limit; a smaller one is noise there. */
export const PLAN_NOTE_FROM = 10;

export const planTotal = (plan: WeeklyPlan) => plan.reduce((sum, share) => sum + share, 0);

/** A usable plan: seven whole, non-negative days summing to exactly 100. */
export function isValidPlan(plan: unknown): plan is WeeklyPlan {
  return (
    Array.isArray(plan) &&
    plan.length === PLAN_DAYS &&
    plan.every(share => Number.isInteger(share) && share >= 0 && share <= 100) &&
    planTotal(plan) === 100
  );
}

/** Days until the plan ends (the end of its last day with a non-zero share). */
const activeDays = (plan: WeeklyPlan) => plan.reduce((last, share, day) => (share > 0 ? day + 1 : last), 0);

export type PlanPoint = {
  /** Remaining percent the plan expects at that moment. */
  remaining: number;
  /** When the plan expects the window to be spent: the end of the plan for weekly windows, else the reset. */
  deadline: number;
  /** The plan has ended: it expects nothing to be left and nothing more to be spent. */
  done: boolean;
  weekly: boolean;
};

/** Planned remaining percent `elapsed` ms into a weekly window. */
export function weeklyPlanRemaining(elapsed: number, plan: WeeklyPlan = DEFAULT_PLAN): number {
  const days = Math.max(0, elapsed / DAY);
  const full = Math.min(plan.length, Math.floor(days));
  let used = plan.slice(0, full).reduce((sum, share) => sum + share, 0);
  if (full < plan.length) used += (days - full) * plan[full];
  return Math.max(0, 100 - used);
}

/**
 * How far a window's start may be from the moment it was measured and still be that
 * moment: the client's clock, the provider's and the time a measurement takes.
 */
const IDLE_TOLERANCE = 2 * 60_000;

/**
 * Whether a window has started. An idle rolling window reports "now + length" as its
 * reset, so it has not started when its start is the moment it was measured
 * (`measuredAt`); a window that has started keeps its start, right after a reset too.
 */
export function started(w: Win, measuredAt: number | null): boolean {
  return !!w.resetAt && !!w.minutes && measuredAt !== null && w.resetAt - w.minutes * 60_000 < measuredAt - IDLE_TOLERANCE;
}

/**
 * The planned remaining share of a window at `now`. Weekly windows follow the per-day
 * plan; other windows are spent linearly until their reset. Returns null while the
 * window has not `started` or its timing is unknown, and for a source whose plan is
 * switched off (`plan` null), for any window.
 */
export function planAt(w: Win, measuredAt: number | null, now: number, plan: WeeklyPlan | null = DEFAULT_PLAN): PlanPoint | null {
  if (!plan || !w.resetAt || !w.minutes || !started(w, measuredAt)) return null;
  const length = w.minutes * 60_000;
  const start = w.resetAt - length;
  const elapsed = now - start;
  if (elapsed >= length) return null;

  if (w.kind !== 'weekly') {
    return {remaining: 100 * (1 - elapsed / length), deadline: w.resetAt, done: false, weekly: false};
  }
  const deadline = start + activeDays(plan) * DAY;
  return {remaining: weeklyPlanRemaining(elapsed, plan), deadline, done: now >= deadline, weekly: true};
}

/** What a card says under a limit about the plan: how many points ahead of it or behind it. */
export type PlanNote = {key: 'ahead' | 'behind'; value: number; weekly: boolean};

/**
 * The note under a limit, when the gap to the plan is worth a word: ahead of it (spent
 * more) for any window, behind it (a reserve) only for a weekly one. A limit used up is
 * past any plan: how far ahead of it says nothing more.
 */
export function planNote(w: Win, measuredAt: number | null, now: number, plan: WeeklyPlan | null = DEFAULT_PLAN): PlanNote | null {
  const point = planAt(w, measuredAt, now, plan);
  if (!point || point.done || w.remaining <= 0) return null;
  const delta = w.remaining - point.remaining;
  if (Math.round(-delta) >= PLAN_NOTE_FROM) return {key: 'ahead', value: -delta, weekly: point.weekly};
  if (point.weekly && Math.round(delta) >= PLAN_NOTE_FROM) return {key: 'behind', value: delta, weekly: true};
  return null;
}

/**
 * The plan as a line over [from, to] for a weekly window that resets at `resetAt`. It
 * starts with the current window: earlier weeks may have been cut short by an early
 * reset or started late after idle time, so a plan drawn for them would be made up.
 * Past the reset the next week is assumed to start right away, and the line jumps back
 * to 100%. Returns runs of [time, remaining]; a new run starts at every reset.
 */
export function weeklyPlanLine(resetAt: number, from: number, to: number, plan: WeeklyPlan = DEFAULT_PLAN): [number, number][][] {
  const week = WEEK_MINUTES * 60_000;
  const runs: [number, number][][] = [];
  for (let start = resetAt - week; start < to; start += week) {
    const begin = Math.max(from, start);
    const end = Math.min(to, start + week);
    if (end <= begin) continue;
    const run: [number, number][] = [];
    const push = (t: number) => run.push([t, weeklyPlanRemaining(t - start, plan)]);
    // Plan corners (day boundaries) must be exact; in between the plan is linear.
    const corners = Array.from({length: PLAN_DAYS + 1}, (_, day) => start + day * DAY).filter(t => t > begin && t < end);
    push(begin);
    for (const corner of corners) push(corner);
    push(end - (end === start + week ? 1 : 0));
    runs.push(run);
  }
  return runs;
}
