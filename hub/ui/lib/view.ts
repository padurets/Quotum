import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ApiError, call} from './http';
import {DEFAULT_PLAN, isValidPlan, type WeeklyPlan} from './plan';
import {type View} from './types';
import {FALLBACK_COLOR, PROVIDERS} from './providers';

/** Widget ids: the chart, the table of every limit, how agents worked, the list of running agents, and a card per source. */
export const HISTORY = 'history';
export const FORECAST = 'forecast';
export const ACTIVITY = 'activity';
export const AGENTS = 'agents';
import {cardId, windowKey} from '../../server/domain/presentation';
export {cardId, isWindowHidden, keyShown} from '../../server/domain/presentation';

/**
 * The analytics' widgets in the order a board has them until its owner moves them: how
 * agents worked first, over what is left and the table. A board arranged before one of
 * them existed gets it by its neighbour here (`ordered`).
 */
export const ANALYTICS = [ACTIVITY, HISTORY, FORECAST];

/** Widgets a board goes without until its owner turns them on: the cards already show the agents. */
const OFF_BY_DEFAULT = [AGENTS];
export const isOffByDefault = (id: string) => OFF_BY_DEFAULT.includes(id);

const EMPTY: View = {layout: {columns: 6, places: {}}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};

/** A card's own name; empty gives it back the automatic one. */
export const withName = (view: View, sourceId: string, name: string): View => {
  const names = {...view.names};
  const trimmed = name.trim().slice(0, 60);
  if (trimmed) names[sourceId] = trimmed;
  else delete names[sourceId];
  return {...view, names};
};
/** Changes in a burst (a drag, typing a plan) are saved once, this long after the last one. */
const SAVE_AFTER = 600;

export const isHidden = (view: View, id: string) => (isOffByDefault(id) ? !view.shown.includes(id) : view.hidden.includes(id));

export const withHidden = (view: View, id: string, hidden: boolean): View => ({
  ...(isOffByDefault(id)
    ? {...view, shown: hidden ? view.shown.filter(other => other !== id) : [...new Set([...view.shown, id])]}
    : {...view, hidden: hidden ? [...new Set([...view.hidden, id])] : view.hidden.filter(other => other !== id)}),
  enabledWhenEmpty: hidden ? (view.enabledWhenEmpty ?? []).filter(other => other !== id) : view.enabledWhenEmpty ?? [],
});

/**
 * Columns off until the owner turns them on: how long each agent has run, which tells less
 * than when it last worked and how long it worked; the table's share of spending during work, which does not fit a widget as wide as
 * the board beside the rest, nor do agent-hours (see FORECAST_WIDTHS).
 */
const OFF_BY_DEFAULT_COLUMNS: Record<string, string[]> = {[AGENTS]: ['running'], [FORECAST]: ['during', 'agenthours']};
const columnOffByDefault = (widget: string, column: string) => OFF_BY_DEFAULT_COLUMNS[widget]?.includes(column) ?? false;

/** Whether a column of a widget's table is shown. */
export const columnShown = (view: View, widget: string, column: string) =>
  columnOffByDefault(widget, column) ? (view.shownColumns[widget] ?? []).includes(column) : !(view.columns[widget] ?? []).includes(column);

export const withColumn = (view: View, widget: string, column: string, shown: boolean): View => {
  const off = columnOffByDefault(widget, column);
  const key = off ? 'shownColumns' : 'columns';
  const others = (view[key][widget] ?? []).filter(other => other !== column);
  const columns = {...view[key], [widget]: shown === off ? [...others, column] : others};
  if (!columns[widget].length) delete columns[widget];
  return {...view, [key]: columns};
};

/** Whether a window is hidden from its card and the chart on this board. */


/**
 * What a board shows: a word on getting started while it has no subscription, its
 * widgets, or a way to bring them back when every one of them is hidden.
 */
export function boardState(sources: {id: string}[], view: View): 'onboarding' | 'widgets' | 'allHidden' {
  if (!sources.length) return (view.enabledWhenEmpty ?? []).some(id => !isHidden(view, id)) ? 'widgets' : 'onboarding';
  const widgets = [...sources.map(source => cardId(source.id)), AGENTS, ...ANALYTICS];
  return widgets.every(id => isHidden(view, id)) ? 'allHidden' : 'widgets';
}

export const withWindowHidden = (view: View, key: string, hidden: boolean): View => ({
  ...view,
  windows: hidden ? [...new Set([...view.windows, key])] : view.windows.filter(other => other !== key),
});

/** Explicit key choices survive changes in the source's bounded default preview. */
export const withKeyShown = (view:View,source:string,id:string,on:boolean):View => {
  const key=windowKey(source,`key:${id}`);
  return {...withWindowHidden(view,key,!on),shown:on?[...new Set([...view.shown,key])]:view.shown.filter(other=>other!==key)};
};

/** The weekly plan set for one source: the board's if valid, otherwise the default. */
export const weeklyPlanOf = (view: View, sourceId: string): WeeklyPlan => {
  const plan = view.plans[sourceId];
  return isValidPlan(plan) ? plan : DEFAULT_PLAN;
};

/** The plan the board follows for one source; null when it is switched off there. */
export const planOf = (view: View, sourceId: string): WeeklyPlan | null =>
  view.unplanned.includes(sourceId) ? null : weeklyPlanOf(view, sourceId);

/**
 * The plan the board's owner chose for a source, while it is on: none when the source goes
 * by the default plan, which `withPlan` does not keep, not even when chosen as it is.
 */
export const chosenPlanOf = (view: View, sourceId: string): WeeklyPlan | null =>
  !view.unplanned.includes(sourceId) && isValidPlan(view.plans[sourceId]) ? view.plans[sourceId] : null;

/** Switching a source's plan off keeps the plan itself, so switching it on brings it back. */
export const withPlanned = (view: View, sourceId: string, planned: boolean): View => ({
  ...view,
  unplanned: planned ? view.unplanned.filter(id => id !== sourceId) : [...new Set([...view.unplanned, sourceId])],
});

/** A card's colour: the board's choice, otherwise its provider's. */
export const colorOf = (view: View, sourceId: string, provider: string): string =>
  view.colors[sourceId] ?? PROVIDERS[provider]?.color ?? FALLBACK_COLOR;

/** A colour for a card; null gives it back its provider's. */
export const withColor = (view: View, sourceId: string, color: string | null): View => {
  const colors = {...view.colors};
  if (color) colors[sourceId] = color;
  else delete colors[sourceId];
  return {...view, colors};
};

export const withPlan = (view: View, sourceId: string, plan: WeeklyPlan | null): View => {
  const plans = {...view.plans};
  if (plan && plan.join() !== DEFAULT_PLAN.join()) plans[sourceId] = plan;
  else delete plans[sourceId];
  return {...view, plans};
};

const same = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

export type Arrange = {
  view: View;
  owner: boolean;
  update: (change: (view: View) => View) => void;
  error?: unknown;
};

type PendingView = {view: View; revision: number};
type SavingView = {server: View; revision: number; draft?: View; pending?: PendingView; flight?: Promise<void>; error?: unknown};
const flushers = new Set<(board: string) => Promise<void>>();
/** Add waits for this person's pending layout before changing the same board. */
export async function flushView(board: string) {for (const flush of flushers) await flush(board);}

/** The shell owns serialized saves per board; a conflict returns the authoritative view. */
export function useView(board: string, told: View | null, owner: boolean, revision = 0): Arrange {
  const entries = useRef(new Map<string, SavingView>());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alive = useRef(true);
  const [, render] = useState(0);
  const redraw = () => {if (alive.current) render(value => value + 1);};
  let entry = entries.current.get(board);
  if (!entry) {entry = {server: told ?? EMPTY, revision}; entries.current.set(board, entry);}
  else if (told && revision >= entry.revision) {
    entry.server = told; entry.revision = revision;
    if (!entry.pending && !entry.flight && entry.draft && same(entry.draft, told)) entry.draft = undefined;
  }
  const view = entry.draft ?? entry.server;
  const flush = useCallback(async (id: string): Promise<void> => {
    const state = entries.current.get(id); if (!state) return;
    if (state.flight) {await state.flight; if (state.pending) await flush(id); return;}
    const pending = state.pending;
    if (!pending) return;
    state.pending = undefined;
    state.flight = (async () => {
      try {
        const saved = await call<{view: View; revision: number}>('POST', '/api/boards/' + encodeURIComponent(id) + '/view', pending.view, 12_000, undefined, {'If-Match': '"' + pending.revision + '"'});
        // Only our serial successor can use this revision; an external edit stays authoritative.
        if (state.revision <= saved.revision) {
          state.server = saved.view; state.revision = saved.revision;
          if (state.pending) state.pending.revision = saved.revision;
        }
        if (!state.pending) state.draft = undefined;
      } catch (error) {
        state.error = error; state.pending = undefined; state.draft = undefined;
        if (error instanceof ApiError && error.code === 'view_conflict') {
          const latest = error.data as {view?: View; revision?: number};
          if (latest.view && latest.revision !== undefined && latest.revision >= state.revision) {state.server = latest.view; state.revision = latest.revision;}
        }
        throw error;
      } finally {state.flight = undefined; redraw();}
    })();
    await state.flight;
    if (state.pending) await flush(id);
  }, []);
  useEffect(() => {
    alive.current = true; flushers.add(flush);
    const leaving = () => {
      for (const [id, state] of entries.current) {
        if (!state.pending || state.flight) continue;
        const pending = state.pending; state.pending = undefined;
        void fetch('/api/boards/' + encodeURIComponent(id) + '/view', {
          method: 'POST', keepalive: true,
          headers: {'content-type': 'application/json', 'If-Match': '"' + pending.revision + '"'},
          body: JSON.stringify(pending.view),
        }).catch(() => {});
      }
    };
    window.addEventListener('pagehide', leaving);
    return () => {alive.current = false; flushers.delete(flush); clearTimeout(timer.current); window.removeEventListener('pagehide', leaving);};
  }, [flush]);
  const previous = useRef(board);
  useEffect(() => {
    if (previous.current !== board) {void flush(previous.current).catch(() => {}); previous.current = board;}
  }, [board, flush]);
  const update = useCallback((change: (view: View) => View) => {
    const state = entries.current.get(board)!;
    const next = change(state.draft ?? state.server);
    state.error = undefined; state.draft = next;
    state.pending = {view: next, revision: state.pending?.revision ?? state.revision};
    redraw(); clearTimeout(timer.current);
    timer.current = setTimeout(() => {void flush(board).catch(() => {});}, SAVE_AFTER);
  }, [board, flush]);
  return useMemo(() => ({view, owner, update, error: entry.error}), [view, owner, update, entry.error]);
}
