import {useSyncExternalStore} from 'react';
import {CLOCK_TOLERANCE_MS, cellStart, compose, targetOf, tileEnd, tileOf, tileStart, type HistoryAnswer, type HistoryMeta, type Target} from '../../server/domain/history';
import {page, useHistoryStart, type PageEvent, type PageState} from './board';
import {hubNow} from './clock';
import {HistoryTile} from './historyTiles';
import {ApiError, call} from './http';
import {periodOf} from './periods';
import {onPrefs, prefs} from './prefs';
import type {Store} from './store';
import {dropTimeRange, onTimeRange, timeRange, timeRangeKey, type TimeRange} from './timeRange';
import type {History} from './types';

const SETTLE_MS = 300;
const RETRY_MS = 15_000;
const STORED_BYTES = 15 * 1024 * 1024;

export type HistoryEnv = {
  read(board: string, cell: number, from: number, to: number): Promise<HistoryAnswer>;
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  dropTimeRange(): void;
  schedule?(run: () => void): void;
};
export type Shown = {history: History | null; loading: boolean};
type Flight = {seq: number; epoch: number; cell: number; from: number; to: number; touched: number};

/** History belongs to the open board. Cells are read only when missing or touched. */
export class HistoryStore {
  private board: string | null = null;
  private ready = false;
  private run: string | null = null;
  private epoch = 0;
  private seq = 0;
  private metaSeq = 0;
  private lineupKey = '';
  private windowsKey = '';
  private windows = new Set<string>();
  private period = '24h';
  private selected: TimeRange | null = null;
  private shown: History | null = null;
  private meta: HistoryMeta | null = null;
  private cutTo: number | null = null;
  private readonly grids = new Map<number, Map<number, HistoryTile>>();
  private readonly flights = new Set<Flight>();
  private readonly timers = new Map<'settle' | 'retry', unknown>();
  private changedAt = -Infinity;
  private scheduled = false;
  private needsCompose = false;
  private readonly listeners = new Set<() => void>();
  private state: Shown = {history: null, loading: false};

  constructor(private readonly env: HistoryEnv, private readonly budget = STORED_BYTES) {}

  open(board: string) {
    if (board === this.board) return;
    this.close();
    this.board = board;
  }

  close() {
    this.epoch++;
    this.board = null;
    this.ready = false;
    this.run = null;
    this.shown = this.meta = null;
    this.metaSeq = 0;
    this.cutTo = null;
    this.grids.clear();
    this.flights.clear();
    this.clear('settle');
    this.clear('retry');
    this.changedAt = -Infinity;
    this.publish();
  }

  hello(run: string) {
    if (run === this.run) return;
    this.run = run;
    this.invalidate();
    this.ready = false;
  }

  snapshot(lineup: string[], windows: Iterable<string> = this.windows) {
    this.lineupKey = keyOf(lineup);
    this.setWindows(windows);
    this.invalidate();
    this.ready = true;
    this.schedule();
  }

  lineup(lineup: string[]) {
    if (keyOf(lineup) === this.lineupKey) return;
    this.lineupKey = keyOf(lineup);
    this.invalidate();
    this.schedule();
  }

  setWindows(windows: Iterable<string>) {
    const next = new Set(windows);
    const key = keyOf([...next]);
    if (key === this.windowsKey) return;
    this.windowsKey = key;
    this.windows = next;
    this.needsCompose = true;
    this.schedule();
  }

  news(since: number) {
    this.cutTo = null;
    if (since === 0) this.invalidate();
    else {
      for (const [cell, tiles] of this.grids) for (const tile of tiles.values()) {
        if (tile.to > since) tile.validTo = Math.min(tile.validTo, Math.max(tile.from, cellStart(since, cell)));
      }
      for (const flight of this.flights) if (flight.epoch === this.epoch && flight.to > since) flight.touched = Math.min(flight.touched, since);
    }
    this.schedule();
  }

  choose(period: string, selected: TimeRange | null) {
    const key = selected ? timeRangeKey(selected) : period;
    if (key === (this.selected ? timeRangeKey(this.selected) : this.period)) return;
    this.period = period;
    this.selected = selected;
    this.needsCompose = true;
    const now = this.env.now();
    const quick = now - this.changedAt < SETTLE_MS;
    this.changedAt = now;
    this.clear('settle');
    if (quick) this.timers.set('settle', this.env.setTimeout(() => {this.clear('settle'); this.schedule();}, SETTLE_MS));
    this.schedule();
    this.publish();
  }

  get = () => this.state;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => void this.listeners.delete(listener);};
  get estimatedBytes() {return [...this.grids.values()].reduce((sum, tiles) => sum + [...tiles.values()].reduce((sum, tile) => sum + tile.bytes, 0), 0);}

  private invalidate() {
    this.epoch++;
    this.cutTo = null;
    this.clear('retry');
    for (const tiles of this.grids.values()) for (const tile of tiles.values()) tile.validTo = tile.readTo = tile.from;
    this.needsCompose = true;
  }

  private target(): Target {
    const length = this.selected ? this.selected.to - this.selected.from : periodOf(this.period).ms;
    const key = this.selected ? timeRangeKey(this.selected) : this.period;
    return targetOf(length, Math.max(this.env.now(), this.meta?.now ?? 0), key, this.selected);
  }

  private publish() {
    const history = this.shown;
    const loading = !!history && history.range !== this.target().key;
    if (history === this.state.history && loading === this.state.loading) return;
    this.state = {history, loading};
    for (const listener of this.listeners) listener();
  }

  private tiles(cell: number) {
    if (!this.grids.has(cell)) this.grids.set(cell, new Map());
    return this.grids.get(cell)!;
  }

  private tile(at: number, cell: number) {
    const tiles = this.tiles(cell);
    const n = tileOf(at, cell);
    if (!tiles.has(n)) tiles.set(n, new HistoryTile(tileStart(n, cell), cell));
    return tiles.get(n)!;
  }

  private full(target: Target) {
    for (let k = target.k0; k <= target.k1; k++) {
      const at = k * target.cell;
      if (this.cutTo !== null && at >= this.cutTo) continue;
      if (at >= (this.grids.get(target.cell)?.get(tileOf(at, target.cell))?.readTo ?? -Infinity)) return false;
    }
    return true;
  }

  private bad(target: Target): number[] {
    const bad: number[] = [];
    for (let k = target.k0; k <= target.k1; k++) {
      const at = k * target.cell;
      if (this.cutTo !== null && at >= this.cutTo) continue;
      if (at < (this.grids.get(target.cell)?.get(tileOf(at, target.cell))?.validTo ?? -Infinity)) continue;
      if ([...this.flights].some(f => f.epoch === this.epoch && f.cell === target.cell && f.from <= at && f.to > at && f.touched > at)) continue;
      bad.push(at);
    }
    return bad;
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    (this.env.schedule ?? queueMicrotask)(() => {this.scheduled = false; this.pump();});
  }

  private pump() {
    if (!this.board || !this.ready || !this.run) return;
    const target = this.target();
    if (target.k1 < target.k0) return this.env.dropTimeRange();
    if (this.needsCompose && this.meta && this.full(target)) {
      const chunks = [...(this.grids.get(target.cell)?.values() ?? [])].filter(t => t.to > target.k0 * target.cell && t.from <= target.k1 * target.cell).sort((a, b) => a.from - b.from).map(tile => {tile.shownAt = this.env.now(); return tile.chunk(this.meta!.known);});
      this.shown = {...compose(chunks, this.meta, target, this.windows), board: this.board};
      this.needsCompose = false;
      this.publish();
    }
    if (this.timers.has('settle') || this.timers.has('retry')) return;
    const bad = this.bad(target);
    if (!bad.length) return;
    const from = this.tile(bad[0], target.cell).validTo;
    const to = Math.min(tileEnd(tileOf(bad.at(-1)!, target.cell), target.cell), cellStart(this.env.now(), target.cell) + 2 * target.cell);
    const flight: Flight = {seq: ++this.seq, epoch: this.epoch, cell: target.cell, from, to, touched: Infinity};
    this.flights.add(flight);
    this.env.read(this.board, target.cell, from, to).then(answer => this.merge(flight, answer), error => this.failed(flight, error));
  }

  private merge(flight: Flight, answer: HistoryAnswer) {
    this.flights.delete(flight);
    if (flight.epoch !== this.epoch || answer.run !== this.run) return;
    for (const chunk of answer.chunks) {
      const tile = this.tile(chunk.from, flight.cell);
      if (tile.writeSeq > flight.seq) continue;
      tile.merge(chunk, answer.known);
      tile.writeSeq = flight.seq;
      if (chunk.from <= tile.validTo) tile.validTo = Math.max(tile.validTo, Math.min(chunk.to, cellStart(flight.touched, flight.cell)));
      if (chunk.from <= tile.readTo) tile.readTo = Math.max(tile.readTo, chunk.to);
    }
    if (flight.seq > this.metaSeq) {
      this.metaSeq = flight.seq;
      this.meta = {now: answer.now, historyStart: answer.historyStart, known: answer.known};
      const to = answer.chunks.at(-1)?.to;
      if (to !== undefined && to > answer.now + CLOCK_TOLERANCE_MS) this.cutTo = to;
    }
    this.needsCompose = true;
    this.evict();
    this.schedule();
  }

  private failed(flight: Flight, error: unknown) {
    this.flights.delete(flight);
    if (flight.epoch !== this.epoch) return;
    const target = this.target();
    if (error instanceof ApiError && error.status === 400 && this.selected && target.cell === flight.cell && flight.from <= target.k0 * target.cell && flight.to > target.k1 * target.cell) return this.env.dropTimeRange();
    this.clear('retry');
    this.timers.set('retry', this.env.setTimeout(() => {this.clear('retry'); this.schedule();}, RETRY_MS));
  }

  private evict() {
    const target = this.target();
    const candidates: {cell: number; n: number; tile: HistoryTile}[] = [];
    for (const [cell, tiles] of this.grids) for (const [n, tile] of tiles) {
      if (cell === target.cell && tile.to > target.k0 * cell && tile.from <= target.k1 * cell) continue;
      candidates.push({cell, n, tile});
    }
    let bytes = this.estimatedBytes;
    for (const {cell, n, tile} of candidates.sort((a, b) => a.tile.shownAt - b.tile.shownAt)) {
      if (bytes <= this.budget) break;
      this.grids.get(cell)!.delete(n);
      bytes -= tile.bytes;
    }
  }

  private clear(name: 'settle' | 'retry') {
    if (!this.timers.has(name)) return;
    this.env.clearTimeout(this.timers.get(name));
    this.timers.delete(name);
  }
}

const keyOf = (lineup: string[]) => [...lineup].sort().join('\n');
export const loader = new HistoryStore({
  read: (board, cell, from, to) => call<HistoryAnswer>('GET', `/api/history?board=${encodeURIComponent(board)}&cell=${cell}&from=${from}&to=${to}`),
  now: hubNow,
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  dropTimeRange,
});

/** Connection, board and window changes drive history; widgets only read it. */
export function follow(loader: HistoryStore, store: Store<PageState, PageEvent>) {
  return store.listen((event, state) => {
    if (event.type === 'board-open') loader.open(event.id);
    else if (event.type === 'board-close') loader.close();
    else if (event.type === 'hub') {
      const hub = event.event;
      if (hub.type === 'hello') loader.hello(hub.data.epoch);
      else if (hub.type === 'snapshot') loader.snapshot(state.board?.lineup ?? [], windowsOf(state));
      else if (hub.type === 'lineup') {loader.lineup(state.board?.lineup ?? []); loader.setWindows(windowsOf(state));}
      else if (hub.type === 'card') loader.setWindows(windowsOf(state));
      else if (hub.type === 'history') loader.news(hub.data.since);
    }
  });
}
const windowsOf = (state: PageState) => Object.values(state.board?.cards ?? {}).flatMap(card => card.windows.map(window => `${card.id} ${window.id}`));
follow(loader, page);
if (typeof window !== 'undefined') {
  const chosen = () => loader.choose(prefs().range, timeRange());
  onPrefs(chosen);
  onTimeRange(chosen);
  chosen();
}
export function useHistory(): Shown {return useSyncExternalStore(loader.subscribe, loader.get, loader.get);}
const answeredStart = () => loader.get().history?.historyStart ?? null;
export function useHistoryBegins(): number {
  const answered = useSyncExternalStore(loader.subscribe, answeredStart, answeredStart);
  const snapshot = useHistoryStart();
  return answered ?? snapshot ?? 0;
}
