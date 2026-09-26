import type {Activity, ActivityDimension, ActivityGroup, View} from './types';
import {CATEGORY_COLORS} from './providers';
import {colorOf} from './view';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The colour of the groups beyond the first few: a neutral of its own. */
export const OTHER_COLOR = 'var(--other)';

/**
 * The colour of each group of a stack: a subscription has its card's, as on the chart;
 * projects and machines take CATEGORY_COLORS by their rank in the period, so a project
 * may change colour when the period does. The rest is neutral.
 */
export function groupColors(groups: ActivityGroup[], by: ActivityDimension, view: View, providerOf: (source: string) => string): string[] {
  let rank = 0;
  return groups.map(group =>
    group.other ? OTHER_COLOR : by === 'source' ? colorOf(view, group.key, providerOf(group.key)) : CATEGORY_COLORS[rank++ % CATEGORY_COLORS.length],
  );
}

/** How many agents worked at the same time on average while any did. */
export const atOnce = (agentMs: number, workMs: number) => (workMs > 0 ? agentMs / workMs : 0);

/**
 * The widget's vertical scale. Cells shorter than an hour (periods up to a week) are read
 * as the share of the cell agents worked (`share`, 0 to 1, marked 0, 50 and 100%): minutes
 * of work in a minute-long cell say little. Longer cells are read in hours of work, up to
 * the busiest cell of the period (never more than a cell), marked at round times.
 */
export type ActivityScale = {share: true; max: 1; ticks: number[]} | {share: false; max: number; ticks: number[]};

const STEPS = [5, 10, 15, 30, 60, 120, 180, 360].map(minutes => minutes * MINUTE);

export function activityScale(activity: Pick<Activity, 'cells'>, cellMs: number): ActivityScale {
  if (cellMs < HOUR) return {share: true, max: 1, ticks: [0, 0.5, 1]};
  const busiest = Math.max(0, ...activity.cells.map(([, work]) => work));
  // Three marks or fewer above zero, on a round step; the top one at or above the busiest cell.
  const step = STEPS.find(candidate => busiest / candidate <= 3) ?? STEPS.at(-1)!;
  const max = Math.min(cellMs, Math.max(step, Math.ceil(busiest / step) * step));
  const ticks: number[] = [];
  for (let at = 0; at <= max; at += step) ticks.push(at);
  return {share: false, max, ticks};
}
