import {useSyncExternalStore} from 'react';
import type {Kind} from './types';
import {DEFAULT_PLAN, isValidPlan, type WeeklyPlan} from './plan';

export type Prefs = {
  /** Windows the owner removed from their dashboard: hidden in cards, chart and table. */
  hidden: Record<string, true>;
  /** Series switched off in the chart legend only. */
  muted: Record<string, true>;
  range: string;
  kind: Kind;
  /** Draw the spending plan on the weekly chart. */
  showPlan: boolean;
  /** Show reset announcements from the community trackers. */
  showResets: boolean;
  /** Per-source weekly spending plans (percent per day); absent means the default. */
  plans: Record<string, WeeklyPlan>;
};

const KEY = 'quotum.prefs';
/** Where preferences were kept before the project was renamed; read once, until 0.2. */
const LEGACY_KEY = 'agent-limits.prefs';
const DEFAULTS: Prefs = {hidden: {}, muted: {}, range: '24h', kind: 'weekly', showPlan: true, showResets: true, plans: {}};

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    return raw ? {...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>)} : DEFAULTS;
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

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
}

const toggle = (map: Record<string, true>, key: string, on: boolean) => {
  const next = {...map};
  if (on) next[key] = true;
  else delete next[key];
  return next;
};

export const setHidden = (key: string, hidden: boolean) => setPrefs(prefs => ({hidden: toggle(prefs.hidden, key, hidden)}));
export const setMuted = (key: string, muted: boolean) => setPrefs(prefs => ({muted: toggle(prefs.muted, key, muted)}));

/** The weekly plan of one source: its own if valid, otherwise the default. */
export const planOf = (prefs: Prefs, sourceId: string): WeeklyPlan => {
  const plan = prefs.plans[sourceId];
  return isValidPlan(plan) ? plan : DEFAULT_PLAN;
};

export const setPlan = (sourceId: string, plan: WeeklyPlan | null) =>
  setPrefs(prefs => {
    const plans = {...prefs.plans};
    if (plan) plans[sourceId] = plan;
    else delete plans[sourceId];
    return {plans};
  });
