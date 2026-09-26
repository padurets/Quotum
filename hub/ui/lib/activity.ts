import type {ActivityDimension, ActivityGroup, View} from './types';
import {CATEGORY_COLORS} from './providers';
import {colorOf} from './view';

const MINUTE = 60_000;

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

/**
 * The widget's vertical scale, in time worked: up to the tallest stack drawn (`busiest`,
 * never more than a bar `barMs` long), with three marks or fewer above zero at round times.
 */
export type ActivityScale = {max: number; ticks: number[]};

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360].map(minutes => minutes * MINUTE);

export function activityScale(busiest: number, barMs: number): ActivityScale {
  const step = STEPS.find(candidate => busiest / candidate <= 3) ?? STEPS.at(-1)!;
  const max = Math.min(barMs, Math.max(step, Math.ceil(busiest / step) * step));
  const ticks: number[] = [];
  for (let at = 0; at <= max; at += step) ticks.push(at);
  return {max, ticks};
}

/**
 * Under which key a group switched off in the widget's legend is kept among the lines
 * switched off in the chart's (`Prefs.muted`): its own for each way of splitting, so
 * switching off a project leaves the machines as they are.
 */
export const mutedKey = (by: ActivityDimension, key: string) => `activity:${by}:${key}`;
