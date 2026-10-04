import {useSyncExternalStore} from 'react';
import {readAgentsBy, readAgentsSort, type AgentsBy, type AgentsSort} from './agents';
import {ANALYTICS_KINDS, type ActivityDimension, type Kind} from './types';
import {DEFAULT_PERIOD, periodOf} from './periods';

/** How far the chart looks ahead: `auto` follows the period. */
export type Horizon = 'auto' | '1d' | '3d' | '7d';

/**
 * How this reader looks at the dashboard, whatever the board: the period and window type
 * of its analytics (agent activity, the chart and the table), the chart's horizon, lines
 * and groups switched off in either chart's legend, whether it draws the plan and the
 * forecast, what the list of agents gathers by and how it sorts, what the activity widget
 * stacks by, reset announcements, and whether the
 * widgets are locked in place. How a
 * board is arranged is the board's own (lib/view.ts).
 */
export type Prefs = {
  /** Series switched off in the chart legend. */
  muted: Record<string, true>;
  range: string;
  kind: Kind;
  horizon: Horizon;
  /** Draw the spending plan on the weekly chart. */
  showPlan: boolean;
  /** Draw where each window's pace leads on the chart. */
  showForecast: boolean;
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
};

const KEY = 'quotum.prefs';
export const HORIZONS: Horizon[] = ['auto', '1d', '3d', '7d'];
export const ACTIVITY_BY: ActivityDimension[] = ['source', 'project', 'device'];
const DEFAULTS: Prefs = {muted: {}, range: DEFAULT_PERIOD, kind: 'weekly', horizon: 'auto', showPlan: true, showForecast: true, showResets: true, locked: false, agentsSort: null, agentsBy: 'project', activityBy: 'project'};

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    const stored = {...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<Prefs>) : {})};
    // Whatever the browser kept from another version must still be a valid choice.
    stored.range = periodOf(String(stored.range)).id;
    if (!ANALYTICS_KINDS.includes(stored.kind)) stored.kind = DEFAULTS.kind;
    if (!HORIZONS.includes(stored.horizon)) stored.horizon = DEFAULTS.horizon;
    if (!ACTIVITY_BY.includes(stored.activityBy)) stored.activityBy = DEFAULTS.activityBy;
    const {muted, range, kind, horizon, showPlan, showForecast, showResets, locked, activityBy} = stored;
    return {muted, range, kind, horizon, showPlan, showForecast, showResets, locked: locked === true, agentsSort: readAgentsSort(stored.agentsSort), agentsBy: readAgentsBy(stored.agentsBy), activityBy};
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
export function usePref<K extends keyof Prefs>(key: K): Prefs[K] {
  return useSyncExternalStore(subscribe, () => current[key], () => current[key]);
}

export const setMuted = (key: string, muted: boolean) =>
  setPrefs(prefs => {
    const next = {...prefs.muted};
    if (muted) next[key] = true;
    else delete next[key];
    return {muted: next};
  });
