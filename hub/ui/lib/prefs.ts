import {useSyncExternalStore} from 'react';
import {ANALYTICS_KINDS, type Kind} from './types';

/** How far the chart looks ahead: `auto` follows the period. */
export type Horizon = 'auto' | '1d' | '3d' | '7d';

/**
 * How this reader looks at the dashboard, whatever the board: the period and window type
 * of its analytics (the chart and the table), the chart's horizon, lines switched off in
 * its legend, reset announcements, and whether the widgets are locked in place. How a
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
  /** Show reset announcements from the community trackers. */
  showResets: boolean;
  /** The widgets stay where they are: no handles to move or resize them. */
  locked: boolean;
};

const KEY = 'quotum.prefs';
const RANGES = ['24h', '7d', '30d'];
export const HORIZONS: Horizon[] = ['auto', '1d', '3d', '7d'];
const DEFAULTS: Prefs = {muted: {}, range: '24h', kind: 'weekly', horizon: 'auto', showPlan: true, showResets: true, locked: false};

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    const stored = {...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<Prefs>) : {})};
    // Whatever the browser kept from another version must still be a valid choice.
    if (!RANGES.includes(stored.range)) stored.range = DEFAULTS.range;
    if (!ANALYTICS_KINDS.includes(stored.kind)) stored.kind = DEFAULTS.kind;
    if (!HORIZONS.includes(stored.horizon)) stored.horizon = DEFAULTS.horizon;
    const {muted, range, kind, horizon, showPlan, showResets, locked} = stored;
    return {muted, range, kind, horizon, showPlan, showResets, locked: locked === true};
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

export const setMuted = (key: string, muted: boolean) =>
  setPrefs(prefs => {
    const next = {...prefs.muted};
    if (muted) next[key] = true;
    else delete next[key];
    return {muted: next};
  });
