import {useCallback, useEffect, useRef, useState} from 'react';
import {call} from './http';
import {DEFAULT_PLAN, isValidPlan, type WeeklyPlan} from './plan';
import type {Overview, View} from './types';

/** Widget ids: the chart, the table of every limit, and a card per source. */
export const HISTORY = 'history';
export const FORECAST = 'forecast';
export const cardId = (sourceId: string) => `source:${sourceId}`;

const EMPTY: View = {order: [], sizes: {}, names: {}, hidden: [], windows: [], plans: {}};

/** The grid has twelve columns: a card takes a third by default, the chart and the table all of it. */
export const COLUMNS = 12;
export const MIN_SPAN = 3;
export const defaultSpan = (id: string) => (id.startsWith('source:') ? 4 : COLUMNS);
export const spanOf = (view: View, id: string) => view.sizes[id] ?? defaultSpan(id);

export const withSpan = (view: View, id: string, span: number): View => {
  const sizes = {...view.sizes};
  if (span === defaultSpan(id)) delete sizes[id];
  else sizes[id] = Math.max(MIN_SPAN, Math.min(COLUMNS, Math.round(span)));
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

export const withHidden = (view: View, id: string, hidden: boolean): View => ({
  ...view,
  hidden: hidden ? [...new Set([...view.hidden, id])] : view.hidden.filter(other => other !== id),
});

export const withWindowHidden = (view: View, key: string, hidden: boolean): View => ({
  ...view,
  windows: hidden ? [...new Set([...view.windows, key])] : view.windows.filter(other => other !== key),
});

/** The weekly plan of one source: the board's if valid, otherwise the default. */
export const planOf = (view: View, sourceId: string): WeeklyPlan => {
  const plan = view.plans[sourceId];
  return isValidPlan(plan) ? plan : DEFAULT_PLAN;
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

  return {view, owner: overview?.board.role === 'owner', update};
}
