import {useSyncExternalStore} from 'react';
import {readAgentsBy, readAgentsSort, type AgentsBy, type AgentsSort} from './agents';
import {type ActivityDimension} from './types';
import {DEFAULT_PERIOD, periodOf} from './periods';
import {readForecastSort,type ForecastSort} from './forecastSort';
import {DEFAULT_MONEY,readMoney,type MoneyPrefs} from './moneySelection';
import {readMoneySort, type MoneySort} from './moneyTable';

/** How far the chart looks ahead: `auto` follows the period. */
export type Horizon = 'auto' | '1d' | '3d' | '7d';

/**
 * How this reader looks at the dashboard, whatever the board: the period
 * of its analytics, the chart's horizon, whether it draws the plan and the
 * forecast, what the list of agents gathers by and how it sorts, what the activity widget
 * stacks by, reset announcements, and whether the
 * widgets are locked in place. How a
 * board is arranged is the board's own (lib/view.ts).
 */
export type Prefs = {
  forecastSort:ForecastSort;
  sessionSort:ForecastSort;
  moneySort: MoneySort;
  money:MoneyPrefs;
  funds:MoneyPrefs;
  range: string;
  horizon: Horizon;
  /** Keep the shared filter row open beneath the header. */
  filtersVisible: boolean;
  /** Draw the spending plan on the weekly chart. */
  showPlan: boolean;
  /** Draw where each window's pace leads on the chart. */
  showForecast: boolean;
  showSessionForecast:boolean;
  /** Show reset announcements from the community trackers. */
  showResets: boolean;
  /** The widgets stay where they are: no handles to move or resize them. */
  locked: boolean;
  /** How this viewer orders agents, shared by all boards. */
  agentsSort: AgentsSort;
  /** What this viewer gathers the list of agents by. */
  agentsBy: AgentsBy;
  /** What the activity widget stacks its hours by. */
  activityBy: ActivityDimension;
  heatmapView:'matrix'|'calendar';
};

const KEY = 'quotum.prefs';
export const HORIZONS: Horizon[] = ['auto', '1d', '3d', '7d'];
export const ACTIVITY_BY: ActivityDimension[] = ['project', 'device', 'source'];
const DEFAULTS: Prefs = {forecastSort:null,sessionSort:null,moneySort:null,funds:DEFAULT_MONEY,money:DEFAULT_MONEY,range: DEFAULT_PERIOD, horizon: 'auto', filtersVisible: false, showPlan: true, showForecast: true, showSessionForecast:true, showResets: true, locked: false, agentsSort: null, agentsBy: 'project', activityBy: 'project',heatmapView:'matrix'};

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed:Partial<Prefs> = raw ? JSON.parse(raw) : {};
    const stored = {...DEFAULTS, ...parsed};
    // Whatever the browser kept from another version must still be a valid choice.
    stored.range = periodOf(String(stored.range)).id;
    if (!HORIZONS.includes(stored.horizon)) stored.horizon = DEFAULTS.horizon;
    if (!ACTIVITY_BY.includes(stored.activityBy)) stored.activityBy = DEFAULTS.activityBy;
    const {range, horizon, filtersVisible, showPlan, showForecast, showResets, locked, activityBy} = stored;
    return {forecastSort:readForecastSort(stored.forecastSort),sessionSort:readForecastSort(Object.hasOwn(parsed,'sessionSort')?parsed.sessionSort:stored.forecastSort),
      moneySort:readMoneySort(stored.moneySort),
      funds:readMoney(stored.funds,'funds'),money:readMoney(stored.money),range,horizon,filtersVisible:filtersVisible===true,
      showPlan:showPlan!==false,showForecast:showForecast!==false,showSessionForecast:Object.hasOwn(parsed,'showSessionForecast')?parsed.showSessionForecast!==false:showForecast!==false,
      showResets:showResets!==false,locked:locked===true,agentsSort:readAgentsSort(stored.agentsSort),agentsBy:readAgentsBy(stored.agentsBy),activityBy,heatmapView:stored.heatmapView==='calendar'?'calendar':'matrix'};
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const listeners = new Set<() => void>();

/** Preferences live in this tab and in localStorage; they never reach the server. */
export function setPrefs(update: Partial<Prefs> | ((prefs: Prefs) => Partial<Prefs>)) {
  current = {...current, ...(typeof update === 'function' ? update(current) : update)};
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode: preferences stay in memory */
  }
  for (const listener of listeners) listener();
}

/** Hears of every change of preferences; components read them with `usePrefs` or `usePref`. */
export const onPrefs = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const subscribe = onPrefs;

/** The preferences now. */
export const prefs = () => current;

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** One preference: whoever reads it renders when it changes, not when another one does. */
export function usePref<K extends keyof Prefs>(key: K, active=true): Prefs[K] {
  return useSyncExternalStore(subscribe, () => active?current[key]:DEFAULTS[key], () => active?current[key]:DEFAULTS[key]);
}
