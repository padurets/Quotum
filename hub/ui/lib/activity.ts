import type {ActivityDimension, ActivityGroup, History, View} from './types';
import {CATEGORY_COLORS} from './providers';
import {colorOf} from './view';
import {num} from './format';

const MINUTE = 60_000;

/** The colour of projects and machines beyond the first few: a neutral of its own. */
export const OTHER_COLOR = 'var(--other)';

/**
 * The colour of each group of a stack: a subscription has its card's, as on the chart;
 * projects and machines take CATEGORY_COLORS by agent-hours, so a project may change
 * colour when the period does. Past as many as there are
 * colours told apart, the rest share a neutral: each is still a group of its own, named
 * in the tooltip and switched off and on in the legend.
 */
export function groupColors(groups: ActivityGroup[], by: ActivityDimension, view: View, providerOf: (source: string) => string): string[] {
  return groups.map((group, rank) => (by === 'source' ? colorOf(view, group.key, providerOf(group.key)) : (CATEGORY_COLORS[rank] ?? OTHER_COLOR)));
}

/**
 * The widget's vertical scale in agent-hours: up to the tallest stack, with three
 * marks or fewer above zero at round times. Parallel work can exceed a bar's length.
 */
export type ActivityScale = {max: number; ticks: number[]};

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 7200, 14400, 28800].map(minutes => minutes * MINUTE);

export function activityScale(busiest: number): ActivityScale {
  const step = STEPS.find(candidate => busiest / candidate <= 3) ?? Math.ceil(busiest / (3 * STEPS.at(-1)!)) * STEPS.at(-1)!;
  const max = Math.max(step, Math.ceil(busiest / step) * step);
  const ticks: number[] = [];
  for (let at = 0; at <= max; at += step) ticks.push(at);
  return {max, ticks};
}

/**
 * What the widget says instead of its stacks, if anything: no answer yet (`loading`), no
 * subscription shown on the board (`noSources`), how agents worked is not known in the
 * period, only from `at` (`knownFrom`), none of the agents the board shows worked in it
 * (`none`), or none since `at`, where what is known begins after the period does
 * (`noneSince`): the part before is not said to be idle.
 */
export type ActivityEmpty = {key: 'loading' | 'noSources' | 'none'} | {key: 'knownFrom' | 'noneSince'; at: number} | null;

export function activityEmpty(history: Pick<History, 'since' | 'activity'> | null, shownSources: number): ActivityEmpty {
  if (!history) return {key: 'loading'};
  if (!shownSources) return {key: 'noSources'};
  const {activity} = history;
  if (!activity.known) return {key: 'knownFrom', at: activity.since};
  if (activity.activeMs) return null;
  return activity.known.from > history.since ? {key: 'noneSince', at: activity.known.from} : {key: 'none'};
}

/**
 * Under which key a group switched off in the widget's legend is kept among the lines
 * switched off in the chart's (`Prefs.muted`): its own for each way of splitting, so
 * switching off a project leaves the machines as they are.
 */
export const mutedKey = (by: ActivityDimension, key: string) => `activity:${by}:${key}`;

/** Agent time still shown after switching groups off, in all and by bar. */
export function shownActivity(groups: readonly ActivityGroup[]) {
  const cells = new Map<number, number>();
  for (const group of groups) for (const [at, ms] of group.cells) cells.set(at, (cells.get(at) ?? 0) + ms);
  return {agentMs: groups.reduce((sum, group) => sum + group.agentMs, 0), cells};
}

/** The mean number of agents working while any worked, rounded only for display. */
export const atOnce = (agentMs: number, activeMs: number) => num(activeMs > 0 ? agentMs / activeMs : 0, 1);
