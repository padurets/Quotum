import type {Prefs} from './prefs';
import type {Kind,ActivityDimension} from './types';
import {timeRangeKey, type TimeRange} from './timeRange';

/** User navigation owns presentation independently of arriving data or clock samples. */
export type AxisNavigation = {context: string; range: string};

export function axisNavigation(board: string | null, range: TimeRange | null, prefs: Pick<Prefs, 'range' | 'horizon'> & {kind?:Kind;showPlan?:boolean;showForecast?:boolean;activityBy?:ActivityDimension}): AxisNavigation {
  return {context: JSON.stringify([board, prefs.range, prefs.kind, prefs.horizon, prefs.showPlan, prefs.showForecast, prefs.activityBy]), range: range ? timeRangeKey(range) : 'live'};
}

export const navigationKey = (navigation: AxisNavigation) => `${navigation.context}:${navigation.range}`;
export const navigationAt = (navigation: AxisNavigation, range: TimeRange | null): AxisNavigation => ({context: navigation.context, range: range ? timeRangeKey(range) : 'live'});
