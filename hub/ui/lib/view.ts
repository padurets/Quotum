import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {call} from './http';
import {DEFAULT_PLAN, isValidPlan, type WeeklyPlan} from './plan';
import {windowKey, type Overview, type View} from './types';
import {FALLBACK_COLOR, PROVIDERS} from './providers';

/** Widget ids: the chart, the table of every limit, the list of running agents, and a card per source. */
export const HISTORY = 'history';
export const FORECAST = 'forecast';
export const AGENTS = 'agents';
export const cardId = (sourceId: string) => `source:${sourceId}`;

/** Widgets a board goes without until its owner turns them on: the cards already show the agents. */
const OFF_BY_DEFAULT = [AGENTS];
export const isOffByDefault = (id: string) => OFF_BY_DEFAULT.includes(id);

const EMPTY: View = {order: [], sizes: {}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};

/**
 * The grid has twelve columns: a card takes half of it by default, so two stand side by
 * side, and a third at least, so three at most; the chart and the table take all of it.
 */
export const COLUMNS = 12;
export const MIN_SPAN = 4;
export const defaultSpan = (id: string) => (id.startsWith('source:') ? COLUMNS / 2 : COLUMNS);
const clamped = (span: number) => Math.max(MIN_SPAN, Math.min(COLUMNS, Math.round(span)));
export const spanOf = (view: View, id: string) => clamped(view.sizes[id] ?? defaultSpan(id));

export const withSpan = (view: View, id: string, span: number): View => {
  const sizes = {...view.sizes};
  if (clamped(span) === defaultSpan(id)) delete sizes[id];
  else sizes[id] = clamped(span);
  return {...view, sizes};
};

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

/**
 * The widgets in the board's order. One the order does not know yet (a new source's
 * card, a new kind of widget) goes right after its neighbour in `ids`, the natural
 * order, rather than to the end of the board.
 */
export function arranged(view: View, ids: string[]): string[] {
  const order = view.order.filter(id => ids.includes(id));
  ids.forEach((id, i) => {
    if (order.includes(id)) return;
    const before = ids.slice(0, i).reverse().find(other => order.includes(other));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
  });
  return order;
}

/** A new order of the shown widgets; hidden ones keep theirs after them. */
export const reordered = (view: View, shown: string[]): View => ({
  ...view,
  order: [...shown, ...view.order.filter(id => !shown.includes(id))],
});

export const isHidden = (view: View, id: string) => (isOffByDefault(id) ? !view.shown.includes(id) : view.hidden.includes(id));

export const withHidden = (view: View, id: string, hidden: boolean): View =>
  isOffByDefault(id)
    ? {...view, shown: hidden ? view.shown.filter(other => other !== id) : [...new Set([...view.shown, id])]}
    : {...view, hidden: hidden ? [...new Set([...view.hidden, id])] : view.hidden.filter(other => other !== id)};

/** Columns whose marks already tell the state; the owner can still ask for words. */
const OFF_BY_DEFAULT_COLUMNS: Record<string, string[]> = {[AGENTS]: ['state']};
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
export const isWindowHidden = (view: View, sourceId: string, windowId: string) => view.windows.includes(windowKey(sourceId, windowId));

/**
 * What a board shows: a word on getting started while it has no subscription, its
 * widgets, or a way to bring them back when every one of them is hidden.
 */
export function boardState(sources: {id: string}[], view: View): 'onboarding' | 'widgets' | 'allHidden' {
  if (!sources.length) return 'onboarding';
  const widgets = [...sources.map(source => cardId(source.id)), AGENTS, HISTORY, FORECAST];
  return widgets.every(id => isHidden(view, id)) ? 'allHidden' : 'widgets';
}

export const withWindowHidden = (view: View, key: string, hidden: boolean): View => ({
  ...view,
  windows: hidden ? [...new Set([...view.windows, key])] : view.windows.filter(other => other !== key),
});

/** The weekly plan set for one source: the board's if valid, otherwise the default. */
export const weeklyPlanOf = (view: View, sourceId: string): WeeklyPlan => {
  const plan = view.plans[sourceId];
  return isValidPlan(plan) ? plan : DEFAULT_PLAN;
};

/** The plan the board follows for one source; null when it is switched off there. */
export const planOf = (view: View, sourceId: string): WeeklyPlan | null =>
  view.unplanned.includes(sourceId) ? null : weeklyPlanOf(view, sourceId);

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
  /** Only the board's owner arranges it; everyone else sees it this way. */
  owner: boolean;
  update: (change: (view: View) => View) => void;
};

/**
 * The board's view. The owner's changes show at once and are saved shortly after; the
 * change stays on screen until the board reports back what was saved, so a poll in
 * between does not undo it. A save that fails puts the board's own view back.
 */
export function useView(overview: Overview | null, reload: () => void): Arrange {
  const board = overview?.board.id ?? '';
  const server = overview?.view ?? EMPTY;
  /** The owner's latest change; `saved` is how the hub stored it, once it has. */
  const [draft, setDraft] = useState<{board: string; view: View; saved: View | null} | null>(null);
  const pending = useRef<{board: string; view: View} | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const view = draft?.board === board ? draft.view : server;

  useEffect(() => {
    if (draft && (draft.board !== board || (draft.saved && same(draft.saved, server)))) setDraft(null);
  }, [draft, board, server]);

  const update = useCallback(
    (change: (view: View) => View) => {
      const next = {board, view: change(pending.current?.board === board ? pending.current.view : view)};
      pending.current = next;
      setDraft({...next, saved: null});
      clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        const saving = pending.current!;
        pending.current = null;
        try {
          const saved = await call<View>('POST', `/api/boards/${encodeURIComponent(saving.board)}/view`, saving.view);
          setDraft(current => (current?.view === saving.view ? {...current, saved} : current));
          reload();
        } catch {
          setDraft(current => (current?.view === saving.view ? null : current));
        }
      }, SAVE_AFTER);
    },
    [board, view, reload],
  );

  // Leaving the page with a change not sent yet: send it on the way out.
  useEffect(() => {
    const flush = () => {
      if (!pending.current) return;
      const {board, view} = pending.current;
      void fetch(`/api/boards/${encodeURIComponent(board)}/view`, {
        method: 'POST',
        keepalive: true,
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(view),
      }).catch(() => {});
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  const owner = overview?.board.role === 'owner';
  return useMemo(() => ({view, owner, update}), [view, owner, update]);
}
