import type {ActivityDimension, ActivityGroup, History, View} from './types';
import {CATEGORY_COLORS} from './providers';
import {colorOf} from './view';
import {num,stamp} from './format';
import {sourceLabel} from './quota';
import type {Title} from './board';
import {t} from '../i18n';
import {OTHER_COLOR,resolveProjectColors} from './projectColors';
import type {ProjectColorPins} from '../../server/domain/projectColors';

/** Chart and comparison table name the same authorized group. */
export function activityGroupName(group:Pick<ActivityGroup,'key'|'name'>,by:ActivityDimension,titles:Record<string,Title>){
  if(by==='source')return group.key==='unknown'?t('agents.unknownSource'):group.key==='notProvided'?t('agents.notProvided'):titles[group.key]?sourceLabel(titles[group.key]):group.key;
  return group.name??(by==='project'?t('activity.noProject'):group.key);
}

/** Compare coverage and selection at the same instant, including a frozen replacement. */
export function activityCoverage(activity:History['activity']|null,from:number){
  return !activity?null:activity.available===false?t('activity.noSessions'):!activity.known?t('activity.knownFrom',{time:stamp(activity.since)}):activity.since>from?t('activity.notKnown',{time:stamp(activity.since)}):null;
}

const MINUTE = 60_000;

/** The colour of projects and machines beyond the first few: a neutral of its own. */
export {OTHER_COLOR} from './projectColors';

/**
 * The colour of each group of a stack: a subscription has its card's, as on the chart;
 * projects and machines take CATEGORY_COLORS by agent-hours, so a project may change
 * colour when the period does. Past the palette, the rest share a neutral: each is
 * still a group of its own, named in the tooltip and switched off and on in the legend.
 */
export function groupColors(groups: ActivityGroup[], by: ActivityDimension, view: View, providerOf: (source: string) => string,pins:ProjectColorPins=[]): string[] {
  if(by==='project')return resolveProjectColors(groups,pins).map(group=>group.color);
  return groups.map((group, rank) => (by === 'source' ? group.key==='unknown'||group.key==='notProvided'?OTHER_COLOR : colorOf(view, group.key, providerOf(group.key)) : (CATEGORY_COLORS[rank] ?? OTHER_COLOR)));
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
 * admitted device sessions unavailable (`noSessions`), how agents worked is not known in the
 * period, only from `at` (`knownFrom`), none of the agents the board shows worked in it
 * (`none`), or none since `at`, where what is known begins after the period does
 * (`noneSince`): the part before is not said to be idle.
 */
export type ActivityEmpty = {key: 'loading' | 'noSources'|'noSessions'|'none'} | {key: 'knownFrom' | 'noneSince'; at: number} | null;

export function activityEmpty(history: Pick<History, 'since' | 'activity'> | null, _shownSources:number,_personal=false): ActivityEmpty {
  if (!history) return {key: 'loading'};

  const {activity} = history;
  if(activity.available===false)return {key:'noSessions'};
  if (!activity.known) return {key: 'knownFrom', at: activity.since};
  if (activity.activeMs) return null;
  return activity.known.from > history.since ? {key: 'noneSince', at: activity.known.from} : {key: 'none'};
}

/** A legend and every plot layer share an identity within their grouping dimension. */
export const activitySeriesKey = (by: ActivityDimension, key: string) => `activity:${by}:${key}`;

/** The mean number of agents working while any worked, rounded only for display. */
export const atOnce = (agentMs: number, activeMs: number) => num(activeMs > 0 ? agentMs / activeMs : 0, 1);
