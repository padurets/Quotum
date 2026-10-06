import {useMemo} from 'react';
import type {AppState} from './app';
import {usePref} from './prefs';
import {titled} from './quota';
import type {PastResets, Resets, TrackerHealth} from './resets';
import type {Board} from './session';
import {createStore, sameJson, shallowEqual, useSelect} from './store';
import type {Card, LiveSession, Pace, Refresh, SourceForecast, View} from './types';
import type {SourceAccess} from '../../server/secrets/credentials';
import {providerOf} from '../../server/domain/providers';
import {quotaPeriods} from './subscription';

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
  sourceAccess?:Record<string,SourceAccess>;
  board: BoardMeta;
  view: View;
  historyStart: number;
  sources: Card[];
  sessions: Record<string, LiveSession[]>;
  cadence: Record<string, Pace>;
  refresh: Record<string, Refresh>;
  forecast: Record<string, SourceForecast>;
  mine: string[];
  boards: Board[];
  resets: HubResets;
};

/** What the hub tells, as the page applies it; `hello` also tells history the hub's run; `ping` and `bye` are the connection's own (live.ts). */
export type HubEvent =
  | {type: 'hello'; data: {epoch: string}}
  | {type: 'snapshot'; data: Snapshot}
  | {type: 'board'; data: {board: BoardMeta}}
  | {type: 'view'; data: {view: View}}
  | {type: 'lineup'; data: {sources: string[]}}
  | {type: 'card'; data: Card}
  | {type: 'sessions'; data: {id: string; sessions: LiveSession[]}}
  | {type: 'cadence'; data: {id: string; cadence: Pace}}
  | {type: 'refresh'; data: {id: string; refresh: Refresh}}
  | {type: 'forecast'; data: {id: string; forecast: SourceForecast}}
  | {type: 'mine'; data: {sources: string[]}}
  | {type:'sourceAccess';data:Record<string,SourceAccess>}
  | {type: 'boards'; data: {boards: Board[]}}
  | {type: 'history'; data: {sources: string[]; since: number}}
  | {type: 'resets'; data: HubResets};

export type ConnectionStatus = 'connecting' | 'live' | 'polling' | 'retrying' | 'paused';

export type BoardState = {
  sourceAccess?:Record<string,SourceAccess>;
  id: string;
  meta: BoardMeta;
  view: View;
  historyStart: number;
  lineup: string[];
  cards: Record<string, Card>;
  sessions: Record<string, LiveSession[]>;
  cadence: Record<string, Pace>;
  refresh: Record<string, Refresh>;
  forecast: Record<string, SourceForecast>;
  mine: string[];
};

export type PageState = {
  connection: {status: ConnectionStatus; lostAt: number | null};
  /** The reader's boards with their role on each; null until a session is taken. */
  boards: Board[] | null;
  board: BoardState | null;
  resets: HubResets | null;
  /** The desktop app's state, in its order: a later one has a larger `seq`. */
  app: AppState | null;
};

export type PageEvent =
  | {type: 'hub'; event: HubEvent}
  | {type: 'connection'; status: ConnectionStatus; lostAt: number | null}
  /** Every session the page takes: its boards. */
  | {type: 'session-boards'; boards: Board[]}
  /** Another board is opened: what the page had of the last one goes. */
  | {type: 'board-open'; id: string}
  /** The page leaves the board (signed out, its board gone): nothing of it, nor of its connection, is kept. */
  | {type: 'board-close'}
  /** A board is gone, or the reader is off it. */
  | {type: 'board-gone'; id: string}
  | {type: 'board-created'; board: Board}
  | {type: 'app'; state: AppState};

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
  // Each provider's news stays the same object while it says the same: a card reads only its own.
  return {resets: keepEach(old?.resets, next.resets), trackers: next.trackers, past: keep(old?.past, next.past)};
}

/** Older hubs omit credit, and malformed values never become a known zero. */
function normalizedSessions(sessions: LiveSession[]): LiveSession[] {
  return sessions.map(session => {
    const value = session.workedMs;
    const workedMs = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    return value === workedMs ? session : {...session, workedMs};
  });
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
    sessions: keepEach(old?.sessions, Object.fromEntries(Object.entries(data.sessions).map(([id, sessions]) => [id, normalizedSessions(sessions)]))),
    cadence: keepEach(old?.cadence, data.cadence),
    refresh: keepEach(old?.refresh, data.refresh),
    forecast: keepEach(old?.forecast, data.forecast),
    mine: keep(old?.mine, data.mine),
    sourceAccess:keepEach(old?.sourceAccess,data.sourceAccess??{}),
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

function set<K extends 'cards' | 'sessions' | 'cadence' | 'refresh' | 'forecast'>(board: BoardState, key: K, id: string, value: BoardState[K][string]): BoardState {
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
        const next = {
          ...board,
          lineup,
          cards: only(board.cards, lineup),
          sessions: only(board.sessions, lineup),
          cadence: only(board.cadence, lineup),
          refresh: only(board.refresh, lineup),
          forecast: only(board.forecast, lineup),
          ...(board.sourceAccess?{sourceAccess:only(board.sourceAccess,lineup)}:{}),
        };
        return shallowEqual(next, board) ? board : next;
      });
    case 'card':
      return patch(state, board => set(board, 'cards', event.data.id, event.data));
    case 'sessions':
      return patch(state, board => set(board, 'sessions', event.data.id, normalizedSessions(event.data.sessions)));
    case 'cadence':
      return patch(state, board => set(board, 'cadence', event.data.id, event.data.cadence));
    case 'refresh':
      return patch(state, board => set(board, 'refresh', event.data.id, event.data.refresh));
    case 'forecast':
      return patch(state, board => set(board, 'forecast', event.data.id, event.data.forecast));
    case 'mine':
      return patch(state, board => (sameJson(board.mine, event.data.sources) ? board : {...board, mine: event.data.sources}));
    case 'sourceAccess':
      return patch(state,board=>{const next=keepEach(board.sourceAccess,event.data);return next===board.sourceAccess?board:{...board,sourceAccess:next};});
    case 'boards': {
      const boards = keep(state.boards ?? undefined, event.data.boards);
      return boards === state.boards ? state : {...state, boards};
    }
    case 'resets':
      return {...state, resets: withResets(state.resets, event.data)};
    case 'hello':
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
    case 'board-close':
      return state.board === null && state.connection === INITIAL.connection ? state : {...state, board: null, connection: INITIAL.connection};
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
const NO_FORECAST: SourceForecast = {};

const usePage = <T>(select: (state: PageState) => T, equal?: (a: T, b: T) => boolean) => useSelect(page, select, equal);

export const useBoardId = () => usePage(s => s.board?.id ?? null);
/** The open board's name and kind, once the hub told it: nothing of another board still in the store before this one opens. */
export const metaOf = (state: PageState, board: string) => (state.board?.id === board ? state.board.meta : null);
export const useBoardMeta = (board: string) => usePage(s => metaOf(s, board));
/** The reader's role on the open board: their own, from their list of boards. */
export const useRole = () => usePage(s => s.boards?.find(b => b.id === s.board?.id)?.role ?? null);
export const useServerView = () => usePage(s => s.board?.view ?? null);
export const useHistoryStart = () => usePage(s => s.board?.historyStart ?? null);
/** Membership only: changing a figure never re-renders the compact list itself. */
export const useVisibleLimits = () => usePage(s => {
  const b = s.board;
  if (!b) return NONE;
  return b.lineup.filter(id => {
    const card=b.cards[id],periods=card?quotaPeriods(card):[];
    return !b.view.hidden.includes(`source:${id}`)&&(!periods.length||periods.some(w=>!b.view.windows.includes(`${id}/${w.id}`)));
  });
}, shallowEqual);
export const useLineup = () => usePage(s => s.board?.lineup ?? NONE);
export const useCard = (id: string) => usePage(s => s.board?.cards[id]);
export const useSourceAccess=(id:string)=>usePage(s=>s.board?.sourceAccess?.[id]??null);
const NO_ACCESS:Record<string,SourceAccess>={};
export const useSourceAccesses=()=>usePage(s=>s.board?.sourceAccess??NO_ACCESS);
export const useMoneyUnits=()=>usePage(s=>[...new Set(Object.values(s.board?.cards??{}).filter(c=>providerOf(c.provider)?.funding==='wallet').flatMap(c=>c.meters?.map(m=>m.unit)??[]))].sort(),shallowEqual);
/** The cards of these sources, in their order; the same list while each card is. */
export const useCards = (ids: string[]) => usePage(s => ids.flatMap(id => s.board?.cards[id] ?? []), shallowEqual);
export const useSessions = (id: string) => usePage(s => s.board?.sessions[id] ?? NONE);
/** The agents of several sources at once, for a list of them all: not a hook per source. */
export const useSessionsOf = (ids: string[]) => usePage(s => ids.map(id => s.board?.sessions[id] ?? NONE), shallowEqual);
export const useRefresh = (id: string) => usePage(s => s.board?.refresh[id] ?? null);
export const useCadence = (id: string) => usePage(s => s.board?.cadence[id] ?? null);
/** The hub's forecasts of several sources' weekly windows at once, for the table and the chart: not a hook per source. */
export const useForecastsOf = (ids: string[]) => usePage(s => ids.map(id => s.board?.forecast[id] ?? NO_FORECAST), shallowEqual);
/** Whether the reader's devices measure this source: theirs to take off a shared board. */
export const useMine = (id: string) => usePage(s => !!s.board?.mine.includes(id));
export const useBoards = () => usePage(s => s.boards);
export const useConnection = () => usePage(s => s.connection);
export const useApp = () => usePage(s => s.app);

/** A card's name and provider on the board: what the chart, the table and the list of agents call it. */
export type Title = {title: string; provider: string};

/** The names worked out lately, by what they were worked out of: the same object for the same names, whoever asks. */
const titles = new Map<string, Record<string, Title>>();

/**
 * Every source of the open board named (`titled`): by the owners when that tells them
 * apart, or as the board's owner named it, by the view on screen (`names`: the owner's
 * changes before they are saved) or else the one the hub told. The same object while no
 * name changes.
 */
export function titlesOf(board: BoardState | null, names: Record<string, string> = board?.view.names ?? {}): Record<string, Title> {
  const named = (board?.lineup ?? []).flatMap(id => {
    const card = board!.cards[id];
    return card ? [{id, provider: card.provider, owners: card.owners}] : [];
  });
  const key = JSON.stringify([named, names]);
  let value = titles.get(key);
  if (!value) {
    value = Object.fromEntries(titled(named, names).map(s => [s.id, {title: s.title, provider: s.provider}]));
    // A few: the saved view and the owner's changes to it are asked for side by side.
    if (titles.size >= 4) titles.delete(titles.keys().next().value!);
    titles.set(key, value);
  }
  return value;
}

/** The names of the board's cards (`titlesOf`), by the view on screen when given. */
export const useTitles = (names?: Record<string, string>) => usePage(s => titlesOf(s.board, names));
/** One card's name on the board (`titlesOf`). */
export const useTitle = (id: string, names?: Record<string, string>) => usePage(s => titlesOf(s.board, names)[id]?.title ?? '');

export type Named = Card & {title?: string};

/** The board's cards in its order, each with its name: what the chart and the table draw. Not their agents or pace. */
export function useNamed(names?: Record<string, string>): Named[] {
  const cards = useCards(useLineup());
  const titles = useTitles(names);
  return useMemo(() => cards.map(card => ({...card, title: titles[card.id]?.title})), [cards, titles]);
}

/** The trackers' news about a provider, while this browser shows it. */
export function useResetsFor(provider: string) {
  const shown = usePref('showResets');
  const status = usePage(s => (provider === 'claude' || provider === 'codex' ? s.resets?.resets[provider] : undefined));
  return shown ? status : undefined;
}

/**
 * The trackers' news as the hub tells it, whatever this browser shows of it: a reset for
 * everyone announced caps a forecast's tone the same on every board (`announcedOf`).
 */
export const useResetNews = () => usePage(s => s.resets?.resets ?? null);

/** Resets for everyone over the history kept, for the chart, while this browser shows them. */
export function usePastResets(): PastResets {
  const shown = usePref('showResets');
  const past = usePage(s => s.resets?.past ?? NO_PAST);
  return shown ? past : NO_PAST;
}
