import {useMemo} from 'react';
import type {AppState} from './app';
import {usePref} from './prefs';
import {titled} from './quota';
import type {PastResets, Resets, TrackerHealth} from './resets';
import type {Board} from './session';
import {createStore, sameJson, shallowEqual, useSelect} from './store';
import type {Card, LiveSession, Pace, View} from './types';

/**
 * The page's state, and the one way it changes: events. What the hub pushes
 * (spec/dashboard-v1.md), the state of the connection, the sessions the page takes, the
 * boards it makes and the desktop app's state all go through `page.dispatch` into
 * `reduce`; each part of the page reads its own slice with a hook below and renders only
 * when that slice changes. A slice equal to the one before stays the same object, a
 * snapshot's too: a board read again renders nothing that did not change.
 */

export type BoardMeta = {id: string; name: string; personal: boolean};

export type HubResets = {resets: Resets; trackers: TrackerHealth[]; past: PastResets};

/** The board as the hub gives it to its reader (spec: `snapshot`). */
export type Snapshot = {
  board: BoardMeta;
  view: View;
  historyStart: number;
  sources: Card[];
  sessions: Record<string, LiveSession[]>;
  cadence: Record<string, Pace>;
  mine: string[];
  boards: Board[];
  resets: HubResets;
};

/** What the hub tells, as the page applies it; `hello`, `ping` and `bye` are the connection's own (live.ts). */
export type HubEvent =
  | {type: 'snapshot'; data: Snapshot}
  | {type: 'board'; data: {board: BoardMeta}}
  | {type: 'view'; data: {view: View}}
  | {type: 'lineup'; data: {sources: string[]}}
  | {type: 'card'; data: Card}
  | {type: 'sessions'; data: {id: string; sessions: LiveSession[]}}
  | {type: 'cadence'; data: {id: string; cadence: Pace}}
  | {type: 'mine'; data: {sources: string[]}}
  | {type: 'boards'; data: {boards: Board[]}}
  | {type: 'history'; data: {sources: string[]; since: number}}
  | {type: 'resets'; data: HubResets};

export type ConnectionStatus = 'connecting' | 'live' | 'polling' | 'retrying' | 'paused';

/** The desktop app's state, with its order: a later state has a larger `seq`. */
export type AppSnapshot = AppState & {seq: number};

export type BoardState = {
  id: string;
  meta: BoardMeta;
  view: View;
  historyStart: number;
  lineup: string[];
  cards: Record<string, Card>;
  sessions: Record<string, LiveSession[]>;
  cadence: Record<string, Pace>;
  mine: string[];
};

export type PageState = {
  connection: {status: ConnectionStatus; lostAt: number | null};
  /** The reader's boards with their role on each; null until a session is taken. */
  boards: Board[] | null;
  board: BoardState | null;
  resets: HubResets | null;
  app: AppSnapshot | null;
};

export type PageEvent =
  | {type: 'hub'; event: HubEvent}
  | {type: 'connection'; status: ConnectionStatus; lostAt: number | null}
  /** Every session the page takes: its boards. */
  | {type: 'session-boards'; boards: Board[]}
  /** Another board is opened: what the page had of the last one goes. */
  | {type: 'board-open'; id: string}
  /** A board is gone, or the reader is off it. */
  | {type: 'board-gone'; id: string}
  | {type: 'board-created'; board: Board}
  | {type: 'app'; state: AppSnapshot};

export const INITIAL: PageState = {connection: {status: 'connecting', lostAt: null}, boards: null, board: null, resets: null, app: null};

/** The value that was there when it is the same, so whatever reads it renders nothing. */
const keep = <T>(old: T | undefined, next: T): T => (old !== undefined && sameJson(old, next) ? old : next);

/** A record whose entries each stay as they were when the same; the record itself too when all are. */
function keepEach<T>(old: Record<string, T> | undefined, next: Record<string, T>): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [id, value] of Object.entries(next)) kept[id] = keep(old?.[id], value);
  return old && shallowEqual(old, kept) ? old : kept;
}

/** Only the entries of these ids; the same record when none goes. */
function only<T>(record: Record<string, T>, ids: string[]): Record<string, T> {
  const gone = Object.keys(record).filter(id => !ids.includes(id));
  if (!gone.length) return record;
  const left = {...record};
  for (const id of gone) delete left[id];
  return left;
}

function withResets(old: HubResets | null, next: HubResets): HubResets {
  // When the trackers were asked changes every round: it is taken, and nothing else is new because of it.
  return {resets: keep(old?.resets, next.resets), trackers: next.trackers, past: keep(old?.past, next.past)};
}

function snapshot(state: PageState, data: Snapshot): PageState {
  const old = state.board?.id === data.board.id ? state.board : null;
  const board: BoardState = {
    id: data.board.id,
    meta: keep(old?.meta, data.board),
    view: keep(old?.view, data.view),
    historyStart: data.historyStart,
    lineup: keep(
      old?.lineup,
      data.sources.map(card => card.id),
    ),
    cards: keepEach(old?.cards, Object.fromEntries(data.sources.map(card => [card.id, card]))),
    sessions: keepEach(old?.sessions, data.sessions),
    cadence: keepEach(old?.cadence, data.cadence),
    mine: keep(old?.mine, data.mine),
  };
  return {
    ...state,
    board: old && shallowEqual(old, board) ? old : board,
    boards: keep(state.boards ?? undefined, data.boards),
    resets: withResets(state.resets, data.resets),
  };
}

/** One slice of the open board replaced; the state stays the same when the slice does. */
function patch(state: PageState, change: (board: BoardState) => BoardState): PageState {
  if (!state.board) return state;
  const board = change(state.board);
  return board === state.board ? state : {...state, board};
}

function set<K extends 'cards' | 'sessions' | 'cadence'>(board: BoardState, key: K, id: string, value: BoardState[K][string]): BoardState {
  const old = board[key][id];
  const next = keep(old, value);
  return next === old ? board : {...board, [key]: {...board[key], [id]: next}};
}

function hub(state: PageState, event: HubEvent): PageState {
  switch (event.type) {
    case 'snapshot':
      return snapshot(state, event.data);
    case 'board':
      return patch(state, board => (sameJson(board.meta, event.data.board) ? board : {...board, meta: event.data.board}));
    case 'view':
      return patch(state, board => (sameJson(board.view, event.data.view) ? board : {...board, view: event.data.view}));
    case 'lineup':
      return patch(state, board => {
        const lineup = keep(board.lineup, event.data.sources);
        const next = {...board, lineup, cards: only(board.cards, lineup), sessions: only(board.sessions, lineup), cadence: only(board.cadence, lineup)};
        return shallowEqual(next, board) ? board : next;
      });
    case 'card':
      return patch(state, board => set(board, 'cards', event.data.id, event.data));
    case 'sessions':
      return patch(state, board => set(board, 'sessions', event.data.id, event.data.sessions));
    case 'cadence':
      return patch(state, board => set(board, 'cadence', event.data.id, event.data.cadence));
    case 'mine':
      return patch(state, board => (sameJson(board.mine, event.data.sources) ? board : {...board, mine: event.data.sources}));
    case 'boards': {
      const boards = keep(state.boards ?? undefined, event.data.boards);
      return boards === state.boards ? state : {...state, boards};
    }
    case 'resets':
      return {...state, resets: withResets(state.resets, event.data)};
    case 'history':
      // Nothing to keep: the history loader hears of it (lib/history.ts).
      return state;
  }
}

export function reduce(state: PageState, event: PageEvent): PageState {
  switch (event.type) {
    case 'hub':
      return hub(state, event.event);
    case 'connection':
      return state.connection.status === event.status && state.connection.lostAt === event.lostAt
        ? state
        : {...state, connection: {status: event.status, lostAt: event.lostAt}};
    case 'session-boards': {
      const boards = keep(state.boards ?? undefined, event.boards);
      return boards === state.boards ? state : {...state, boards};
    }
    case 'board-open':
      return state.board === null ? state : {...state, board: null};
    case 'board-gone':
      return {...state, boards: state.boards?.filter(b => b.id !== event.id) ?? null, board: state.board?.id === event.id ? null : state.board};
    case 'board-created':
      if (state.boards?.some(b => b.id === event.board.id)) return state;
      return {...state, boards: [...(state.boards ?? []), event.board]};
    case 'app':
      // An older state never undoes one the app already told.
      return state.app && event.state.seq <= state.app.seq ? state : {...state, app: event.state};
  }
}

export const page = createStore(reduce, INITIAL);

const NONE: never[] = [];
const NO_PAST: PastResets = {};

const usePage = <T>(select: (state: PageState) => T, equal?: (a: T, b: T) => boolean) => useSelect(page, select, equal);

export const useBoardId = () => usePage(s => s.board?.id ?? null);
export const useBoardMeta = () => usePage(s => s.board?.meta ?? null);
/** The reader's role on the open board: their own, from their list of boards. */
export const useRole = () => usePage(s => s.boards?.find(b => b.id === s.board?.id)?.role ?? null);
export const useServerView = () => usePage(s => s.board?.view ?? null);
export const useHistoryStart = () => usePage(s => s.board?.historyStart ?? null);
export const useLineup = () => usePage(s => s.board?.lineup ?? NONE);
export const useCard = (id: string) => usePage(s => s.board?.cards[id]);
/** The cards of these sources, in their order; the same list while each card is. */
export const useCards = (ids: string[]) => usePage(s => ids.flatMap(id => s.board?.cards[id] ?? []), shallowEqual);
export const useSessions = (id: string) => usePage(s => s.board?.sessions[id] ?? NONE);
/** The agents of several sources at once, for a list of them all: not a hook per source. */
export const useSessionsOf = (ids: string[]) => usePage(s => ids.map(id => s.board?.sessions[id] ?? NONE), shallowEqual);
export const useCadence = (id: string) => usePage(s => s.board?.cadence[id] ?? null);
/** Whether the reader's devices measure this source: theirs to take off a shared board. */
export const useMine = (id: string) => usePage(s => !!s.board?.mine.includes(id));
export const useBoards = () => usePage(s => s.boards);
export const useConnection = () => usePage(s => s.connection);
export const useApp = () => usePage(s => s.app);

/** A card's name and provider on the board: what the chart, the table and the list of agents call it. */
export type Title = {title: string; provider: string};

let titles: {key: string; value: Record<string, Title>} = {key: '', value: {}};

/**
 * Every source of the open board named (`titled`): by the owners when that tells them
 * apart, or as the board's owner named it. The same object while no name changes.
 */
export function titlesOf(board: BoardState | null): Record<string, Title> {
  const named = (board?.lineup ?? []).flatMap(id => {
    const card = board!.cards[id];
    return card ? [{id, provider: card.provider, owners: card.owners}] : [];
  });
  const key = JSON.stringify([named, board?.view.names ?? {}]);
  if (key !== titles.key) titles = {key, value: Object.fromEntries(titled(named, board?.view.names).map(s => [s.id, {title: s.title, provider: s.provider}]))};
  return titles.value;
}

export const useTitles = () => usePage(s => titlesOf(s.board));
/** One card's name on the board (`titlesOf`). */
export const useTitle = (id: string) => usePage(s => titlesOf(s.board)[id]?.title ?? '');

export type Named = Card & {title?: string};

/** The board's cards in its order, each with its name: what the chart and the table draw. Not their agents or pace. */
export function useNamed(): Named[] {
  const cards = useCards(useLineup());
  const titles = useTitles();
  return useMemo(() => cards.map(card => ({...card, title: titles[card.id]?.title})), [cards, titles]);
}

/** The trackers' news about a provider, while this browser shows it. */
export function useResetsFor(provider: string) {
  const shown = usePref('showResets');
  const status = usePage(s => (provider === 'claude' || provider === 'codex' ? s.resets?.resets[provider] : undefined));
  return shown ? status : undefined;
}

/** Resets for everyone over the history kept, for the chart, while this browser shows them. */
export function usePastResets(): PastResets {
  const shown = usePref('showResets');
  const past = usePage(s => s.resets?.past ?? NO_PAST);
  return shown ? past : NO_PAST;
}
