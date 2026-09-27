import {useSyncExternalStore} from 'react';
import {page, useHistoryStart, type PageEvent, type PageState} from './board';
import {ApiError, call} from './http';
import {onPrefs, prefs} from './prefs';
import type {Store} from './store';
import {dropTimeRange, onTimeRange, timeRange, timeRangeKey, type TimeRange} from './timeRange';
import type {History} from './types';

/**
 * The history the chart and the table show, read when the board's data changes rather
 * than on a clock: the board's first snapshot reads it, a `history` event (measurements
 * the chart has not shown) reads the period ending now again, at most every
 * `LIVE_MIN_MS`. A time range in the past stays as read, unless late measurements fall
 * into it. A run of quick changes of the period (steps back through time) reads only
 * where it stops; the latest few ranges read whole are kept on the page, for the board's
 * sources as they are. While another answer loads, the one on screen stays (`loading`).
 *
 * It is a service of its own: it hears the page's events, the chosen period and the
 * selected range, and components read what it has (`useHistory`).
 */

/** The period ending now is read again no more often than this, however much news comes. */
export const LIVE_MIN_MS = 10_000;
/** Changes of the period this close together are a run of steps: only the last is read, once they stop. */
const SETTLE_MS = 300;
/** How many answers of past ranges the page keeps per board, so stepping back and forth over them asks the hub nothing. */
const KEPT_RANGES = 8;
/** A read that failed is tried again after this. */
const RETRY_MS = 15_000;

/**
 * Whether an answer is all there is of a range: nothing newer is on its way
 * (`refreshInMs`), and its end was not cut to the hub's now, so later data cannot change it.
 */
export const complete = (history: History, selected: TimeRange) => history.refreshInMs === null && history.to === Math.ceil(selected.to / history.cellMs) * history.cellMs;

export type HistoryEnv = {
  read(board: string, query: string): Promise<History>;
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  dropTimeRange(): void;
};

type Target = {board: string; sources: string; selected: TimeRange | null; key: string; query: string};
export type Shown = {history: History | null; loading: boolean};

export class HistoryLoader {
  private board: string | null = null;
  /** The board's sources, as its snapshot told them; null until it came. */
  private sources: string | null = null;
  private period = '24h';
  private selected: TimeRange | null = null;
  private shown: History | null = null;
  private readonly kept = new Map<string, History>();
  /** The read whose answer goes on screen, and whether news came meanwhile. */
  private reading: {slot: string; again: boolean} | null = null;
  /** Every read under way, with the earliest time of the news that came meanwhile (a snapshot: all of it) that its answer may miss. */
  private readonly underway = new Set<{since: number}>();
  private lastRead: {slot: string; at: number} | null = null;
  private changedAt = 0;
  private readonly timers = new Map<'settle' | 'later' | 'retry', unknown>();
  private readonly listeners = new Set<() => void>();
  private state: Shown = {history: null, loading: false};

  constructor(private readonly env: HistoryEnv) {}

  // ---------- what it hears ----------

  /** The page left the board (signed out, the board gone): nothing is read until another opens. */
  close() {
    this.board = null;
    this.sources = null;
    this.cancel();
    this.publish();
  }

  /** Another board is open: nothing of it is read until its snapshot comes. */
  open(board: string) {
    if (board === this.board) return;
    this.board = board;
    this.sources = null;
    this.cancel();
    this.publish();
  }

  /** The board as it is (every connection): whatever came meanwhile is not in the ranges kept, and the period ending now is read again. */
  snapshot(lineup: string[]) {
    this.forget(-Infinity);
    const sources = keyOf(lineup);
    const moved = sources !== this.sources;
    this.sources = sources;
    this.want(moved && this.lastRead !== null ? 'change' : 'news');
  }

  /** The board's sources changed: a range kept for the ones it had is not this one. */
  lineup(lineup: string[]) {
    if (this.sources === null || keyOf(lineup) === this.sources) return;
    this.sources = keyOf(lineup);
    this.want('change');
  }

  /** Measurements at `since` or later reached the hub: what was read of that time is read again. */
  news(since: number) {
    this.forget(since);
    this.want('news');
  }

  /** The chosen period or the selected range changed. */
  choose(period: string, selected: TimeRange | null) {
    if (period === this.period && (selected === this.selected || (selected && this.selected && timeRangeKey(selected) === timeRangeKey(this.selected)))) return;
    this.period = period;
    this.selected = selected;
    this.want('change');
  }

  // ---------- what it shows ----------

  get = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private publish() {
    const target = this.target();
    const history = this.shown && this.shown.board === this.board ? this.shown : null;
    const state = {history, loading: !!history && !!target && history.range !== target.key};
    if (state.history === this.state.history && state.loading === this.state.loading) return;
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }

  // ---------- reading ----------

  private target(): Target | null {
    if (!this.board || this.sources === null) return null;
    const {selected} = this;
    const key = selected ? timeRangeKey(selected) : this.period;
    return {board: this.board, sources: this.sources, selected, key, query: selected ? `from=${selected.from}&to=${selected.to}` : `range=${key}`};
  }

  private slotOf = (target: Target) => `${target.board} ${target.sources} ${target.key}`;

  /** What is wanted now, because it changed (read at once, but for a run of quick steps) or because news came (the period ending now: at most every LIVE_MIN_MS). */
  private want(why: 'change' | 'news') {
    const target = this.target();
    if (!target) return this.publish();
    const slot = this.slotOf(target);
    const kept = target.selected ? this.kept.get(slot) : undefined;
    if (kept) {
      this.cancel();
      this.shown = kept;
      return this.publish();
    }
    if (why === 'change') {
      // Whatever is read of the range left is no longer the one on screen.
      this.reading = null;
      this.clear('later');
      const now = this.env.now();
      const quick = now - this.changedAt < SETTLE_MS;
      this.changedAt = now;
      this.clear('settle');
      if (quick) this.timers.set('settle', this.env.setTimeout(() => this.read(), SETTLE_MS));
      else this.read();
      return this.publish();
    }
    if (this.reading?.slot === slot) {
      this.reading.again = true;
      return;
    }
    const wait = this.lastRead?.slot === slot ? this.lastRead.at + LIVE_MIN_MS - this.env.now() : 0;
    if (wait <= 0) return this.read();
    if (!this.timers.has('later')) this.timers.set('later', this.env.setTimeout(() => this.read(), wait));
  }

  private read() {
    for (const name of ['settle', 'later', 'retry'] as const) this.clear(name);
    const target = this.target();
    if (!target) return;
    const slot = this.slotOf(target);
    const reading = {slot, again: false};
    const flight = {since: Infinity};
    this.reading = reading;
    this.underway.add(flight);
    this.lastRead = {slot, at: this.env.now()};
    this.env.read(target.board, target.query).then(
      answer => {
        this.underway.delete(flight);
        const data = {...answer, board: target.board};
        // One stepped past on the way is kept all the same: it may be stepped back to. Not
        // one that news of its time came for on its way: it is read again when wanted.
        const touched = flight.since <= data.to;
        if (target.selected && !touched && complete(data, target.selected)) this.keep(slot, target.board, data);
        if (this.reading !== reading) return;
        this.reading = null;
        this.shown = data;
        this.publish();
        // A costly history is put together again a while after new data came: read then.
        if (data.refreshInMs !== null) this.timers.set('later', this.env.setTimeout(() => this.read(), data.refreshInMs + 1_000));
        // News came meanwhile: read again, unless the answer is kept (the news was of a later time).
        else if (reading.again) this.want('news');
      },
      error => {
        this.underway.delete(flight);
        if (this.reading !== reading) return;
        this.reading = null;
        // A selected range the hub will not read (say, a link older than the history it keeps)
        // cannot succeed later: the chosen period comes back instead.
        if (target.selected && error instanceof ApiError && error.status === 400) return this.env.dropTimeRange();
        this.timers.set('retry', this.env.setTimeout(() => this.read(), RETRY_MS));
      },
    );
  }

  private keep(slot: string, board: string, data: History) {
    // Map order is insertion order: the one read last goes to the end, the board's oldest is dropped.
    this.kept.delete(slot);
    this.kept.set(slot, data);
    const ofBoard = [...this.kept.keys()].filter(key => key.startsWith(`${board} `));
    if (ofBoard.length > KEPT_RANGES) this.kept.delete(ofBoard[0]);
  }

  /** News of measurements at `since` or later: the ranges kept of the open board that hold that time go, and answers on their way are told. */
  private forget(since: number) {
    for (const [slot, answer] of this.kept) if (answer.board === this.board && since <= answer.to) this.kept.delete(slot);
    for (const flight of this.underway) flight.since = Math.min(flight.since, since);
  }

  private cancel() {
    this.reading = null;
    for (const name of ['settle', 'later', 'retry'] as const) this.clear(name);
  }

  private clear(name: 'settle' | 'later' | 'retry') {
    if (!this.timers.has(name)) return;
    this.env.clearTimeout(this.timers.get(name));
    this.timers.delete(name);
  }
}

const keyOf = (lineup: string[]) => [...lineup].sort().join(',');

export const loader = new HistoryLoader({
  read: (board, query) => call<History>('GET', `/api/history?board=${encodeURIComponent(board)}&${query}`),
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  dropTimeRange,
});

/** What the loader hears of the page's events: its board opened or left, the board's snapshot, lineup and news of measurements. */
export function follow(loader: HistoryLoader, store: Store<PageState, PageEvent>) {
  return store.listen((event, state) => {
    if (event.type === 'board-open') loader.open(event.id);
    else if (event.type === 'board-close') loader.close();
    else if (event.type === 'hub' && event.event.type === 'snapshot') loader.snapshot(state.board?.lineup ?? []);
    else if (event.type === 'hub' && event.event.type === 'lineup') loader.lineup(state.board?.lineup ?? []);
    else if (event.type === 'hub' && event.event.type === 'history') loader.news(event.event.data.since);
  });
}

// The page's events, its period and its selection drive the loader; nothing on screen does.
follow(loader, page);
if (typeof window !== 'undefined') {
  const chosen = () => loader.choose(prefs().range, timeRange());
  onPrefs(chosen);
  onTimeRange(chosen);
  chosen();
}

/** The history on screen, and whether another is loading in its place. */
export function useHistory(): Shown {
  return useSyncExternalStore(loader.subscribe, loader.get, loader.get);
}

const answeredStart = () => loader.get().history?.historyStart ?? null;

/** Where the board's history begins: as the answer on screen says, else as the board's snapshot did (spec: `historyStart`). */
export function useHistoryBegins(): number {
  const answered = useSyncExternalStore(loader.subscribe, answeredStart, answeredStart);
  const snapshot = useHistoryStart();
  return answered ?? snapshot ?? 0;
}
