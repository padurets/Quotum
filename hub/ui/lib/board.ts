import {matchesSource,matchesSelection,type DataFilters,type FilterEnvelope} from '../../server/domain/dataFilters';
import {budgetVisible} from './money';
import {defaultCurrencyContext,DEFAULT_CURRENCY,type CurrencyContext} from '../../server/domain/currency';
import {useMemo} from 'react';
import type {AppState} from './app';
import {usePref} from './prefs';
import {titled} from './quota';
import type {PastResets, Resets, TrackerHealth} from './resets';
import type {Board} from './session';
import {createStore, sameJson, shallowEqual, useSelect} from './store';
import type {Card, LiveSession, Pace, Refresh, SourceForecast, View} from './types';
import type {SourceAccess} from '../../server/secrets/credentials';
import {providerOf,moneyFamily,supportsQuota,quotaMeter,type MoneyFamily} from '../../server/domain/providers';
import {quotaPeriods} from './subscription';
import {parseProjectColorEnvelope,type ProjectColorEnvelope,type ProjectColorPins} from '../../server/domain/projectColors';

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
  deviceContacts?: Record<string,number|null>;
  currencies?:CurrencyContext;
  sourceAccess?:Record<string,SourceAccess>;
  board: BoardMeta;
  view: View;
  viewRevision?: number;
  filtersRevision?:number;filtersAuthority?:string;filters?:FilterEnvelope;
  projectColorsRevision?:number;projectColorsAuthority?:string;projectColors?:ProjectColorEnvelope;
  connectionsRevision?: number;
  historyStart: number;
  workAuthority?: string;
  sources: Card[];
  unattributedSessions?: LiveSession[];
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
  | {type: 'deviceContacts'; data: {devices: {deviceId:string;lastSeenAt:number}[]}}
  | {type: 'devices'; data: Record<string, never>}
  | {type: 'hello'; data: {epoch: string}}
  | {type: 'snapshot'; data: Snapshot}
  | {type: 'board'; data: {board?: BoardMeta;projectColorsRevision?:number;projectColorsAuthority?:string}}
  | {type:'projectColors';data:ProjectColorEnvelope}
  | {type:'filters';data:FilterEnvelope}
  | {type: 'view'; data: {view: View; revision?: number}}
  | {type: 'connections'; data: {revision: number}}
  | {type: 'lineup'; data: {sources: string[]}}
  | {type: 'card'; data: Card}
  | {type: 'unattributedSessions'; data: {sessions: LiveSession[]}}
  | {type: 'sessions'; data: {id: string; sessions: LiveSession[]}}
  | {type: 'cadence'; data: {id: string; cadence: Pace}}
  | {type: 'refresh'; data: {id: string; refresh: Refresh}}
  | {type: 'forecast'; data: {id: string; forecast: SourceForecast}}
  | {type: 'mine'; data: {sources: string[]}}
  | {type:'sourceAccess';data:Record<string,SourceAccess>}
  | {type:'currencies';data:CurrencyContext}
  | {type: 'boards'; data: {boards: Board[]}}
  | {type: 'history'; data: {sources: string[]; since: number; workSince?: number; workAuthority?: string; changes?: import('../../server/domain/history').HistoryChange[]}}
  | {type: 'resets'; data: HubResets};

export type ConnectionStatus = 'connecting' | 'live' | 'polling' | 'retrying' | 'paused';

export type BoardState = {
  /** A snapshot confirms stream presence until this connection loses continuity. */
  presenceConfirmed?: boolean;
  currencies?:CurrencyContext;
  sourceAccess?:Record<string,SourceAccess>;
  id: string;
  meta: BoardMeta;
  view: View;
  viewRevision?: number;
  filtersRevision?:number;filtersAuthority?:string;filters?:FilterEnvelope;
  projectColorsRevision?:number;projectColorsAuthority?:string;projectColors?:ProjectColorEnvelope;
  /** A matching configuration has confirmed this connection's baseline. Deltas keep its paint until replacement. */
  projectColorsBaselineReady?:boolean;
  connectionsRevision?: number;
  historyStart: number;
  workAuthority?: string;
  lineup: string[];
  cards: Record<string, Card>;
  unattributedSessions?: LiveSession[];
  sessions: Record<string, LiveSession[]>;
  cadence: Record<string, Pace>;
  refresh: Record<string, Refresh>;
  forecast: Record<string, SourceForecast>;
  mine: string[];
};

export type PageState = {
  /** The current hub run is known before any widget mounts or receives a reconnect. */
  hubEpoch?: string;
  projectColorsGeneration?:number;
  deviceContacts?: Record<string,number|null>;
  /** Owner-device invalidation; snapshots also refresh a disclosure after reconnecting. */
  devicesRevision?: number;
  connection: {status: ConnectionStatus; lostAt: number | null};
  /** The reader's boards with their role on each; null until a session is taken. */
  boards: Board[] | null;
  board: BoardState | null;
  resets: HubResets | null;
  /** The desktop app's state, in its order: a later one has a larger `seq`. */
  app: AppState | null;
};

export type PageEvent =
  | {type:'project-colors-response';board:string;generation:number;workAuthority:string|undefined;expected:{revision:number;authority:string};colors:ProjectColorEnvelope}
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

/** Displayed amounts use the period index, not the wire's calendar spending summary. */
function displayCard(card:Card):Card {
  if(!Object.hasOwn(card,'spending'))return card;
  const {spending:_spending,...shown}=card;
  return shown;
}

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

function keepCurrencyContext(old:CurrencyContext|undefined,next:CurrencyContext):CurrencyContext {
  const target=keep(old?.target,next.target),definitions=keep(old?.definitions,next.definitions),sources=keepEach(old?.sources,next.sources);
  return old&&target===old.target&&definitions===old.definitions&&sources===old.sources&&next.revision===old.revision&&next.registryRevision===old.registryRevision?old:{target,definitions,sources,revision:next.revision,registryRevision:next.registryRevision};
}

/** A closed Devices view keeps only recent own contacts, without a heartbeat journal. */
function boundedContacts(contacts:Record<string,number|null>) {
  const entries=Object.entries(contacts);
  return entries.length<=1024?contacts:Object.fromEntries(entries.sort((a,b)=>(b[1]??0)-(a[1]??0)).slice(0,1024));
}
function snapshot(state: PageState, data: Snapshot): PageState {
  const old = state.board?.id === data.board.id ? state.board : null;
  const sameWork=typeof data.workAuthority==='string'&&old?.workAuthority===data.workAuthority;
  const newerColors=sameWork&&Number.isSafeInteger(data.projectColorsRevision)&&(old?.projectColorsRevision??0)>Number(data.projectColorsRevision);
  const board: BoardState = {
    presenceConfirmed: true,
    id: data.board.id,
    meta: keep(old?.meta, data.board),
    view: old && (old.viewRevision ?? 0) > (data.viewRevision ?? 0) ? old.view : keep(old?.view, data.view),
    viewRevision: Math.max(old?.viewRevision ?? 0, data.viewRevision ?? 0),
    connectionsRevision: Math.max(old?.connectionsRevision ?? 0, data.connectionsRevision ?? 0),
    historyStart: data.historyStart,
    filtersRevision:data.filtersRevision,filtersAuthority:data.filtersAuthority,filters:old?.filters&&old.filters.revision===data.filtersRevision&&old.filters.authority===data.filtersAuthority?old.filters:undefined,
    projectColorsRevision:newerColors?old?.projectColorsRevision:data.projectColorsRevision,projectColorsAuthority:newerColors?old?.projectColorsAuthority:data.projectColorsAuthority,
    projectColors:sameWork?old?.projectColors:undefined,
    workAuthority: typeof data.workAuthority === 'string' && data.workAuthority ? data.workAuthority : undefined,
    lineup: keep(
      old?.lineup,
      data.sources.map(card => card.id),
    ),
    cards: keepEach(old?.cards, Object.fromEntries(data.sources.map(card => [card.id, displayCard(card)]))),
    sessions: keepEach(old?.sessions, Object.fromEntries(Object.entries(data.sessions).map(([id, sessions]) => [id, normalizedSessions(sessions)]))),
    unattributedSessions: keep(old?.unattributedSessions, normalizedSessions(data.unattributedSessions??[])),
    cadence: keepEach(old?.cadence, data.cadence),
    refresh: keepEach(old?.refresh, data.refresh),
    forecast: keepEach(old?.forecast, data.forecast),
    mine: keep(old?.mine, data.mine),
    sourceAccess:keepEach(old?.sourceAccess,data.sourceAccess??{}),
    currencies:keepCurrencyContext(old?.currencies,data.currencies??defaultCurrencyContext),
  };
  if(!newerColors&&data.projectColors&&data.projectColors.revision===data.projectColorsRevision&&data.projectColors.authority===data.projectColorsAuthority)board.projectColors=parseProjectColorEnvelope(data.projectColors)??undefined;
  if(data.projectColorsRevision===undefined&&data.projectColorsAuthority===undefined)board.projectColors=undefined;
  const matching=board.projectColors?.revision===board.projectColorsRevision&&board.projectColors?.authority===board.projectColorsAuthority;
  board.projectColorsBaselineReady=!!board.projectColors&&matching&&(!!old?.projectColorsBaselineReady||board.projectColors!==old?.projectColors);
  return {
    ...state,
    devicesRevision: (state.devicesRevision ?? 0)+1,
    deviceContacts: boundedContacts(data.deviceContacts ?? {}),
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
    case 'deviceContacts': {
      const contacts = {...state.deviceContacts};
      let changed = false;
      for (const {deviceId,lastSeenAt} of event.data.devices) if (lastSeenAt > (contacts[deviceId] ?? 0)) {contacts[deviceId]=lastSeenAt;changed=true;}
      return changed ? {...state,deviceContacts:boundedContacts(contacts)} : state;
    }
    case 'hello':
      return {...patch(state, board => ({...board,presenceConfirmed:false,projectColorsBaselineReady:false})),hubEpoch:event.data.epoch,projectColorsGeneration:(state.projectColorsGeneration??0)+1};
    case 'devices':
      return {...state, devicesRevision: (state.devicesRevision ?? 0)+1};
    case 'snapshot':
      return snapshot(state, event.data);
    case 'board':
      return patch(state, board => {
        const next={...board,...(event.data.board?{meta:keep(board.meta,event.data.board)}:{})};
        if('projectColorsRevision' in event.data||'projectColorsAuthority' in event.data){
          if((event.data.projectColorsRevision??-1)<(board.projectColorsRevision??-1))return board;
          next.projectColorsRevision=event.data.projectColorsRevision;next.projectColorsAuthority=event.data.projectColorsAuthority;
        }
        return shallowEqual(next,board)?board:next;
      });
    case 'projectColors':
      return patch(state,board=>{
        const colors=parseProjectColorEnvelope(event.data);
        if(!colors||colors.revision!==board.projectColorsRevision||colors.authority!==board.projectColorsAuthority||colors.revision<(board.projectColors?.revision??0))return board;
        const saved=keep(board.projectColors,colors);return saved===board.projectColors&&board.projectColorsBaselineReady?board:{...board,projectColors:saved,projectColorsBaselineReady:true};
      });
    case 'view':
      return patch(state, board => {
        const revision = event.data.revision ?? 0;
        if (revision < (board.viewRevision ?? 0) || revision === (board.viewRevision ?? 0) && sameJson(board.view, event.data.view)) return board;
        return {...board, view: event.data.view, viewRevision: revision};
      });
    case 'connections':
      return patch(state, board => event.data.revision <= (board.connectionsRevision ?? 0) ? board : {...board, connectionsRevision: event.data.revision});
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
      return patch(state, board => set(board, 'cards', event.data.id, displayCard(event.data)));
    case 'unattributedSessions':
      return patch(state, board => {
        const unattributedSessions = keep(board.unattributedSessions, normalizedSessions(event.data.sessions));
        return unattributedSessions === board.unattributedSessions ? board : {...board, unattributedSessions};
      });
    case 'sessions':
      return patch(state, board => set(board, 'sessions', event.data.id, normalizedSessions(event.data.sessions)));
    case 'cadence':
      return patch(state, board => set(board, 'cadence', event.data.id, event.data.cadence));
    case 'refresh':
      return patch(state, board => set(board, 'refresh', event.data.id, event.data.refresh));
    case 'filters':
      return patch(state,board=>{if(board.filters&&board.filters.revision>event.data.revision)return board;return {...board,filters:keep(board.filters,event.data),filtersRevision:event.data.revision,filtersAuthority:event.data.authority};});
    case 'forecast':
      return patch(state, board => set(board, 'forecast', event.data.id, event.data.forecast));
    case 'mine':
      return patch(state, board => (sameJson(board.mine, event.data.sources) ? board : {...board, mine: event.data.sources}));
    case 'currencies':
      return patch(state,board=>{const next=keepCurrencyContext(board.currencies,event.data);return next===board.currencies?board:{...board,currencies:next};});
    case 'sourceAccess':
      return patch(state,board=>{const next=keepEach(board.sourceAccess,event.data);return next===board.sourceAccess?board:{...board,sourceAccess:next};});
    case 'boards': {
      const boards = keep(state.boards ?? undefined, event.data.boards);
      return boards === state.boards ? state : {...state, boards};
    }
    case 'resets':
      return {...state, resets: withResets(state.resets, event.data)};
    case 'history':
      return patch(state, board => event.data.workAuthority && event.data.workAuthority !== board.workAuthority ? {...board, workAuthority: event.data.workAuthority,projectColors:undefined,projectColorsAuthority:undefined,projectColorsBaselineReady:false} : board);
  }
}

export function reduce(state: PageState, event: PageEvent): PageState {
  switch (event.type) {
    case 'project-colors-response': {
      const board=state.board,colors=parseProjectColorEnvelope(event.colors);
      if(!board||board.id!==event.board||(state.projectColorsGeneration??0)!==event.generation||board.workAuthority!==event.workAuthority||!colors||colors.revision<(board.projectColorsRevision??0))return state;
      const unchanged=board.projectColorsRevision===event.expected.revision&&board.projectColorsAuthority===event.expected.authority;
      const matching=board.projectColorsRevision===colors.revision&&board.projectColorsAuthority===colors.authority;
      if(!unchanged&&!matching)return state;
      return patch(state,current=>({...current,projectColorsRevision:colors.revision,projectColorsAuthority:colors.authority,projectColors:keep(current.projectColors,colors),projectColorsBaselineReady:true}));
    }
    case 'hub':
      return hub(state, event.event);
    case 'connection': {
      const next = event.status === 'live' || event.status === 'polling' ? state : patch(state, board => board.presenceConfirmed ? {...board, presenceConfirmed: false} : board);
      return next.connection.status === event.status && next.connection.lostAt === event.lostAt
        ? next
        : {...next, connection: {status: event.status, lostAt: event.lostAt}};
    }
    case 'session-boards': {
      const boards = keep(state.boards ?? undefined, event.boards);
      return boards === state.boards ? state : {...state, boards};
    }
    case 'board-open':
      return {...state,board:null,projectColorsGeneration:(state.projectColorsGeneration??0)+1};
    case 'board-close':
      return state.board === null && state.connection === INITIAL.connection ? state : {...state, board: null, connection: INITIAL.connection,projectColorsGeneration:(state.projectColorsGeneration??0)+1};
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

/** Contacts and app state need no snapshot checks in components reading only the board. */
const boardStore = (() => {
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  return {
    get: () => page.get().board,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!stop) {
        let previous = page.get().board;
        stop = page.subscribe(() => {
          const next = page.get().board;
          if (next === previous) return;
          previous = next;
          for (const listener of [...listeners]) listener();
        });
      }
      return () => {listeners.delete(listener);if (!listeners.size) {stop?.();stop = null;}};
    },
  };
})();
const useBoard = <T>(select: (board: BoardState | null) => T, equal?: (a: T, b: T) => boolean) => useSelect(boardStore, select, equal);

export const useBoardId = () => useBoard(board => board?.id ?? null);
/** The open board's name and kind, once the hub told it: nothing of another board still in the store before this one opens. */
const boardMetaOf = (current: BoardState | null, board: string) => current?.id === board ? current.meta : null;
export const metaOf = (state: PageState, board: string) => boardMetaOf(state.board, board);
export const useBoardMeta = (board: string) => useBoard(current => boardMetaOf(current, board));
/** The reader's role on the open board: their own, from their list of boards. */
export const useRole = () => usePage(s => s.boards?.find(b => b.id === s.board?.id)?.role ?? null);
export const useServerView = () => useBoard(board => board?.view ?? null);
export const useViewRevision = () => useBoard(board => board?.viewRevision ?? 0);
const NO_PROJECT_PINS:ProjectColorPins=[];
export const useProjectColorPins=()=>usePage(s=>s.board?.projectColors?.pins??NO_PROJECT_PINS);
export const useProjectColorEnvelope=()=>usePage(s=>s.board?.projectColors??null);
export const useWorkAuthority=()=>usePage(s=>s.board?.workAuthority);
export const useProjectColorGeneration=()=>usePage(s=>s.projectColorsGeneration??0);
export const projectColorsReady=(board:BoardState|null)=>!!board&&(board.projectColorsRevision===undefined&&board.projectColorsAuthority===undefined||
  Number.isSafeInteger(board.projectColorsRevision)&&Number(board.projectColorsRevision)>=0&&typeof board.projectColorsAuthority==='string'&&/^[A-Za-z0-9_-]{43}$/.test(board.projectColorsAuthority)&&!!board.projectColors&&board.projectColorsBaselineReady===true);
export const useProjectColorsReady=()=>usePage(s=>projectColorsReady(s.board));
export const useConnectionsRevision = () => useBoard(board => board?.connectionsRevision ?? 0);
export const useDevicesRevision = () => usePage(s => s.devicesRevision ?? 0);
export const useDeviceContact = (device: string, baseline: number | null) => usePage(s => Math.max(s.deviceContacts?.[device] ?? 0,baseline ?? 0) || null);
export const useHistoryStart = () => useBoard(board => board?.historyStart ?? null);
/** Membership only: changing a figure never re-renders the compact list itself. */
export const useVisibleLimits = (filters:DataFilters|null) => usePage(s => {
  const b = s.board;
  if (!b||!filters) return NONE;
  return b.lineup.filter(id => {
    const card=b.cards[id],periods=card?quotaPeriods(card):[];
    return matchesSource(filters,id)&&!b.view.hidden.includes(`source:${id}`)&&(!!card&&budgetVisible(card)||!periods.length||periods.some(w=>!b.view.windows.includes(`${id}/${w.id}`)&&matchesSelection(filters.windows,[id,w.id])));
  });
}, shallowEqual);
export const useLineup = () => useBoard(board => board?.lineup ?? NONE);
export const useCard = (id: string) => useBoard(board => board?.cards[id]);
export const useSourceAccess=(id:string)=>useBoard(board=>board?.sourceAccess?.[id]??null);
const NO_ACCESS:Record<string,SourceAccess>={};
export const useSourceAccesses=()=>useBoard(board=>board?.sourceAccess??NO_ACCESS);
const NO_CURRENCY_BINDINGS:CurrencyContext['sources'][string]=[];
const boardCurrencyContext=(board:BoardState|null)=>board?.currencies??defaultCurrencyContext;
export const currencyContextOf=(state:PageState)=>boardCurrencyContext(state.board);
export const useCurrencyRegistryRevision=()=>useBoard(board=>boardCurrencyContext(board).registryRevision);
export function useCurrencyContext(source?:string):CurrencyContext {
  const target=useBoard(board=>boardCurrencyContext(board).target),definitions=useBoard(board=>boardCurrencyContext(board).definitions);
  const bindings=useBoard(board=>source?boardCurrencyContext(board).sources[source]??NO_CURRENCY_BINDINGS:NO_CURRENCY_BINDINGS);
  const revision=useBoard(board=>source?undefined:boardCurrencyContext(board).revision);
  return useMemo(()=>({target,definitions,sources:source?{[source]:bindings}:{},...(revision?{revision}:{})}),[target,definitions,source,bindings,revision]);
}
export const useMoneyUnits=()=>useBoard(board=>[...new Set(Object.values(board?.cards??{}).filter(budgetVisible).flatMap(c=>c.meters?.map(m=>/^[A-Z]{3}$/.test(m.unit)||m.unit==='credits:codex'?DEFAULT_CURRENCY:m.unit)??[]))].sort(),shallowEqual);
/** The cards of these sources, in their order; the same list while each card is. */
export const useCards = (ids: string[]) => useBoard(board => ids.flatMap(id => board?.cards[id] ?? []), shallowEqual);
export const useSessions = (id: string) => useBoard(board => board?.sessions[id] ?? NONE);
/** The agents of several sources at once, for a list of them all: not a hook per source. */
export const useSessionsOf = (ids: string[]) => useBoard(board => ids.map(id => board?.sessions[id] ?? NONE), shallowEqual);
export const useRefresh = (id: string) => useBoard(board => board?.refresh[id] ?? null);
export const useCanRefreshSources = (ids: string[]) => useBoard(board => !!board && ids.some(id => board.refresh[id]?.by !== 'hub' || board.sourceAccess?.[id]?.canRefresh === true));
export const useCadence = (id: string) => useBoard(board => board?.cadence[id] ?? null);
/** The hub's forecasts of several sources' weekly windows at once, for the table and the chart: not a hook per source. */
export const useForecastsOf = (ids: string[]) => useBoard(board => ids.map(id => board?.forecast[id] ?? NO_FORECAST), shallowEqual);
/** Whether the reader's devices measure this source: theirs to take off a shared board. */
export const useMine = (id: string) => useBoard(board => !!board?.mine.includes(id));
export const useBoards = () => usePage(s => s.boards);
export const useConnection = () => usePage(s => s.connection);
export const useApp = () => usePage(s => s.app);
export const useMainNavigation = () => usePage(s => s.app?.mainNavigation,sameJson);

/** A card's name and provider on the board: what the chart, the table and the list of agents call it. */
export type Title = {title: string; provider: string};

/** The names worked out lately, by what they were worked out of: the same object for the same names, whoever asks. */
const titles = new Map<string, Record<string, Title>>();
const titleFingerprints = new WeakMap<BoardState, string>();
const savedTitles = new WeakMap<BoardState, Record<string, Title>>();
const titleSourcesOf = (board: BoardState | null) => (board?.lineup ?? []).flatMap(id => {
  const card = board!.cards[id];
  return card ? [{id, provider: card.provider, owners: card.owners}] : [];
});

/**
 * Every source of the open board named (`titled`): by the owners when that tells them
 * apart, or as the board's owner named it, by the view on screen (`names`: the owner's
 * changes before they are saved) or else the one the hub told. The same object while no
 * name changes.
 */
export function titlesOf(board: BoardState | null, names: Record<string, string> = board?.view.names ?? {}): Record<string, Title> {
  // The saved names share the board's lifetime; explicit drafts can mutate in place.
  const saved=board&&names===board.view.names?savedTitles.get(board):undefined;
  if(saved)return saved;
  let named: ReturnType<typeof titleSourcesOf> | undefined;
  let fingerprint = board ? titleFingerprints.get(board) : '[]';
  if (fingerprint === undefined) {
    named = titleSourcesOf(board);
    fingerprint = JSON.stringify(named);
    if (board) titleFingerprints.set(board, fingerprint);
  }
  const key = `[${fingerprint},${JSON.stringify(names)}]`;
  let value = titles.get(key);
  if (!value) {
    value = Object.fromEntries(titled(named ?? titleSourcesOf(board), names).map(s => [s.id, {title: s.title, provider: s.provider}]));
    // A few: the saved view and the owner's changes to it are asked for side by side.
    if (titles.size >= 4) titles.delete(titles.keys().next().value!);
    titles.set(key, value);
  }
  if(board&&names===board.view.names)savedTitles.set(board,value);
  return value;
}

/** The names of the board's cards (`titlesOf`), by the view on screen when given. */
export const useTitles = (names?: Record<string, string>) => useBoard(board => titlesOf(board, names));
/** One card's name on the board (`titlesOf`). */
export const useTitle = (id: string, names?: Record<string, string>) => useBoard(board => titlesOf(board, names)[id]?.title ?? '');

export type Named = Card & {title?: string};

const namedCards = new WeakMap<BoardState, Map<'quota'|MoneyFamily|undefined, Card[]>>();

/** Financial heartbeats of a subscription cannot change its quota drawing inputs. */
export function namedCardsOf(state:PageState,scope?:'quota'|MoneyFamily):Card[] {
  return namedBoardCardsOf(state.board,scope);
}
function namedBoardCardsOf(board:BoardState|null,scope?:'quota'|MoneyFamily):Card[] {
  if(!board)return NONE;
  let cached=namedCards.get(board);
  const prior=cached?.get(scope);if(prior)return prior;
  // Contacts retain the board; they need no new projection or quota JSON comparison.
  const cards=board.lineup.flatMap(id=>{
    const card=board.cards[id];
    if(!card||scope&&(scope==='quota'?!supportsQuota(providerOf(card.provider)):moneyFamily(providerOf(card.provider))!==scope))return [];
    if(scope!=='quota')return [card];
    return [{id:card.id,provider:card.provider,plan:card.plan,successAt:card.successAt,error:card.error,stale:card.stale,
      windows:card.windows,resets:card.resets,owners:card.owners,staleAfterMs:card.staleAfterMs,measureIntervalMs:card.measureIntervalMs,
      ...(card.quota?{quota:card.quota}:{}),...(card.resources?{resources:card.resources}:{}),
      meters:card.meters?.filter(m=>quotaMeter(providerOf(card.provider),m.id))??[]}];
  });
  if(!cached)namedCards.set(board,cached=new Map());
  cached.set(scope,cards);return cards;
}

/** The board's cards in its order, each with its name: what the chart and the table draw. Not their agents or pace. */
export function useNamed(names?: Record<string, string>, scope?: 'quota'|MoneyFamily): Named[] {
  const cards = useBoard(board=>namedBoardCardsOf(board,scope),scope==='quota'?sameJson:shallowEqual);
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

export const useUnattributedSessions = () => useBoard(board => board?.unattributedSessions ?? NONE);
export const usePersonalBoard = () => useBoard(board => board?.meta.personal ?? false);
