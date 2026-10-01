import {useDeferredValue, useSyncExternalStore} from 'react';
import {CLOCK_TOLERANCE_MS, MAX_READ_TILES, cellStart, compose, targetOf, tileEnd, tileOf, tileStart, type Chunk, type HistoryAnswer, type HistoryMeta, type Target} from '../../server/domain/history';
import {page, useHistoryStart, type PageEvent, type PageState} from './board';
import {hubNow} from './clock';
import {HistoryTile} from './historyTiles';
import {ApiError, call} from './http';
import {periodOf} from './periods';
import {onPrefs, prefs} from './prefs';
import type {Store} from './store';
import {dropTimeRange, onTimeRange, timeRange, timeRangeKey, type TimeRange} from './timeRange';
import type {History} from './types';
import {pan, type Pan} from './pan';
import {plotOf, type Coverage, type PlotBuffer} from './historyPlot';

const SETTLE_MS = 300;
const RETRY_MS = 15_000;
const STORED_BYTES = 15 * 1024 * 1024;
// A pan merges one tile per flight so input never waits behind a whole frame's decode.
const PAN_READ_TILES = 1;

export type HistoryEnv = {
  read(board: string, cell: number, from: number, to: number, signal?: AbortSignal): Promise<HistoryAnswer>;
  now(): number;
  /** Elapsed time stays independent of corrections to the estimated hub clock. */
  elapsedNow?(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  dropTimeRange(): void;
  schedule?(run: () => void): void;
};
export type Shown = {history: History | null; loading: boolean};
type Flight = {seq: number; epoch: number; target: string; newsSeq: number; cell: number; from: number; to: number; touched: number; startedAt: number; controller: AbortController; role: 'visible' | 'ahead'};
export type PlotInterest = {token: number; length: number; from: number; to: number; direction: -1 | 0 | 1};

/** History belongs to the open board. Cells are read only when missing or touched. */
export class HistoryStore {
  private board: string | null = null;
  private ready = false;
  private run: string | null = null;
  private epoch = 0;
  private seq = 0;
  private metaSeq = 0;
  private newsSeq = 0;
  private lineupKey = '';
  private windowsKey = '';
  private windows = new Set<string>();
  private period = '24h';
  private selected: TimeRange | null = null;
  private shown: History | null = null;
  private meta: HistoryMeta | null = null;
  private metaAt: number | null = null;
  private cutTo: number | null = null;
  private readonly grids = new Map<number, Map<number, HistoryTile>>();
  private readonly flights = new Set<Flight>();
  private readonly timers = new Map<'settle' | 'retry', unknown>();
  private changedAt = -Infinity;
  private scheduled = false;
  private needsCompose = false;
  private readonly listeners = new Set<() => void>();
  private state: Shown = {history: null, loading: false};
  private interest: PlotInterest | null = null;
  private plotPending = false;
  private plot: PlotBuffer | null = null;
  private strip: Target | null = null;
  private version = 0;
  private plotVersion = -1;
  private plotIdentity = '';
  private aheadStopped = false;
  private readonly plotListeners = new Set<() => void>();
  private readonly plotChunks = new Map<string, {seq: number; from: number; to: number; chunk: Chunk}>();

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
    this.metaAt = null;
    this.metaSeq = 0;
    this.cutTo = null;
    this.grids.clear();
    this.abortFlights();
    this.interest = null;
    this.plotPending = false;
    this.strip = null;
    this.plotChunks.clear();
    this.setPlot(null);
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
    this.version++;
    this.schedule();
  }

  news(since: number) {
    this.newsSeq++;
    this.cutTo = null;
    this.aheadStopped = false;
    if (since === 0) this.invalidate();
    else {
      for (const [cell, tiles] of this.grids) for (const tile of tiles.values()) {
        if (tile.to > since) tile.validTo = Math.min(tile.validTo, Math.max(tile.readFrom, cellStart(since, cell)));
      }
      for (const flight of this.flights) if (flight.epoch === this.epoch && flight.to > since) flight.touched = Math.min(flight.touched, cellStart(since, flight.cell));
    }
    this.schedule();
  }

  choose(period: string, selected: TimeRange | null) {
    const key = selected ? timeRangeKey(selected) : period;
    if (key === (this.selected ? timeRangeKey(this.selected) : this.period)) return;
    this.period = period;
    this.selected = selected;
    this.needsCompose = true;
    this.clear('retry');
    const now = this.env.now();
    const quick = now - this.changedAt < SETTLE_MS;
    this.changedAt = now;
    this.clear('settle');
    if (quick) this.timers.set('settle', this.env.setTimeout(() => {this.clear('settle'); this.schedule();}, SETTLE_MS));
    this.schedule();
    this.publish();
  }

  get = () => this.state;
  getPlot = () => this.plot;
  subscribePlot = (listener: () => void) => {this.plotListeners.add(listener); return () => void this.plotListeners.delete(listener);};

  /** Geometry changes do not choose a committed target or compose its totals. */
  pan(interest: PlotInterest) {
    const previous = this.interest;
    this.interest = interest;
    this.plotPending = true;
    const next = this.plotTarget();
    const cell = next.cell;
    if (!previous || previous.token !== interest.token || previous.direction !== interest.direction || Math.floor(previous.from / cell) !== next.k0 || Math.ceil(previous.to / cell) - 1 !== next.k1) {
      this.aheadStopped = false;
      this.clear('settle');
      this.clear('retry');
      this.evict();
      this.schedule();
    }
  }

  endPan(commit: boolean) {
    this.interest = null;
    for (const flight of [...this.flights]) if (flight.role === 'ahead') this.abort(flight);
    if (!commit) {
      this.plotPending = false;
      this.strip = null;
      this.plotChunks.clear();
      this.setPlot(null);
    }
    this.clear('settle');
    this.clear('retry');
    this.schedule();
  }
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => void this.listeners.delete(listener);};
  get estimatedBytes() {return [...this.grids.values()].reduce((sum, tiles) => sum + [...tiles.values()].reduce((sum, tile) => sum + tile.bytes, 0), 0);}

  private invalidate() {
    this.epoch++;
    this.cutTo = null;
    this.metaAt = null;
    this.clear('retry');
    this.abortFlights();
    this.version++;
    this.aheadStopped = false;
    this.strip = null;
    this.plotChunks.clear();
    this.setPlot(null);
    for (const tiles of this.grids.values()) for (const tile of tiles.values()) tile.readFrom = tile.validTo = tile.readTo = tile.from;
    this.needsCompose = true;
  }

  private target(): Target {
    const length = this.selected ? this.selected.to - this.selected.from : periodOf(this.period).ms;
    const key = this.selected ? timeRangeKey(this.selected) : this.period;
    return targetOf(length, Math.max(this.env.now(), this.meta?.now ?? 0), key, this.selected);
  }

  private elapsedNow() {return this.env.elapsedNow?.() ?? performance.now();}

  private publish() {
    const history = this.shown;
    const loading = !this.plotPending && !!history && history.range !== this.target().key;
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
      const tile = this.grids.get(target.cell)?.get(tileOf(at, target.cell));
      if (!tile || at < tile.readFrom || at >= tile.readTo) return false;
    }
    return true;
  }

  private bad(target: Target): number[] {
    const bad: number[] = [];
    for (let k = target.k0; k <= target.k1; k++) {
      const at = k * target.cell;
      if (this.cutTo !== null && at >= this.cutTo) continue;
      const tile = this.grids.get(target.cell)?.get(tileOf(at, target.cell));
      if (tile && at >= tile.readFrom && at < tile.validTo) continue;
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
    if (this.interest) {
      this.publishPlot();
      this.pumpPan();
      this.publish();
      return;
    }
    if (target.k1 < target.k0) return this.env.dropTimeRange();
    if (this.selected && this.meta && this.metaAt !== null) {
      // The data cut stays empty as time moves; range admission follows the hub clock.
      const now = this.meta.now + Math.max(0, this.elapsedNow() - this.metaAt);
      if (target.k0 * target.cell >= cellStart(now + CLOCK_TOLERANCE_MS, target.cell) + target.cell) return this.env.dropTimeRange();
    }
    if (this.needsCompose && this.meta && this.full(target)) {
      const chunks = [...(this.grids.get(target.cell)?.values() ?? [])].filter(t => t.readTo > t.readFrom && t.readTo > target.k0 * target.cell && t.readFrom <= target.k1 * target.cell).sort((a, b) => a.from - b.from).map(tile => {tile.shownAt = this.env.now(); return tile.chunk(this.meta!.known);});
      this.shown = {...compose(chunks, this.meta, target, this.windows), board: this.board};
      this.needsCompose = false;
      if (this.plotPending) {
        this.plotPending = false;
        this.strip = null;
        this.plotChunks.clear();
        this.setPlot(null);
      }
      this.publish();
    }
    if (this.plotPending) this.publishPlot();
    if (this.plotPending) {
      for (const flight of [...this.flights]) {
        if (flight.cell !== target.cell || flight.to <= target.k0 * target.cell || flight.from > target.k1 * target.cell) this.abort(flight);
        else flight.role = 'visible';
      }
      this.readMissing(target, 'visible');
      return;
    }
    if (this.timers.has('settle') || this.timers.has('retry')) return;
    // News accumulates behind this target's pending read; another target can read now.
    if ([...this.flights].some(f => f.epoch === this.epoch && f.target === target.key && f.cell === target.cell)) return;
    const bad = this.bad(target);
    if (!bad.length) return;
    const first = this.tile(bad[0], target.cell);
    // Cold reads omit the unseen head. Entering a held tile's head fills it once.
    const from = first.readTo === first.readFrom ? bad[0] : bad[0] < first.readFrom ? first.from : first.validTo;
    const to = Math.min(tileEnd(tileOf(bad.at(-1)!, target.cell), target.cell), cellStart(this.env.now(), target.cell) + 2 * target.cell);
    this.read(target, from, to, 'visible');
  }

  private plotTarget(): Target {
    const interest = this.interest;
    return interest ? targetOf(interest.length, Math.max(this.env.now(), this.meta?.now ?? 0), 'plot', interest) : this.target();
  }

  private publishPlot() {
    if (!this.meta || !this.plotPending) return;
    const visible = this.plotTarget();
    const half = visible.length / 2;
    if (!this.strip || this.strip.cell !== visible.cell || this.plot?.token !== (this.interest?.token ?? this.plot?.token) || visible.k0 * visible.cell < this.strip.k0 * visible.cell + half / 2 || (visible.k1 + 1) * visible.cell > (this.strip.k1 + 1) * visible.cell - half / 2) {
      this.strip = {...visible, k0: Math.floor((visible.k0 * visible.cell - half) / visible.cell), k1: Math.ceil(((visible.k1 + 1) * visible.cell + half) / visible.cell) - 1};
      this.plotVersion = -1;
    }
    if (this.plotVersion === this.version) return;
    const strip = this.strip;
    const tiles = [...(this.grids.get(strip.cell)?.values() ?? [])].filter(t => t.readTo > t.readFrom && t.readTo > strip.k0 * strip.cell && t.readFrom <= strip.k1 * strip.cell).sort((a, b) => a.from - b.from);
    const identity = `${this.epoch}:${this.interest?.token ?? this.plot?.token}:${strip.cell}:${strip.k0}:${strip.k1}:${this.windowsKey}:${this.cutTo}:${JSON.stringify(this.meta.known)}:${tiles.map(tile => `${tile.from},${tile.writeSeq},${tile.readFrom},${tile.readTo}`).join(';')}`;
    this.plotVersion = this.version;
    if (identity === this.plotIdentity) return;
    this.plotIdentity = identity;
    const retained = new Set(tiles.map(tile => `${tile.cell}:${tile.from}`));
    for (const key of this.plotChunks.keys()) if (!retained.has(key)) this.plotChunks.delete(key);
    const chunks = tiles.map(tile => {
      const key = `${tile.cell}:${tile.from}`;
      let decoded = this.plotChunks.get(key);
      if (!decoded || decoded.seq !== tile.writeSeq || decoded.from !== tile.readFrom || decoded.to !== tile.readTo) {
        decoded = {seq: tile.writeSeq, from: tile.readFrom, to: tile.readTo, chunk: tile.chunk(this.meta!.known, true)};
        this.plotChunks.set(key, decoded);
      }
      return decoded.chunk;
    });
    const intervals: [number, number][] = [];
    for (const tile of tiles) {
      const a = Math.max(tile.readFrom, strip.k0 * strip.cell), b = Math.min(tile.readTo, (strip.k1 + 1) * strip.cell);
      const last = intervals.at(-1);
      if (last && last[1] === a) last[1] = b;
      else intervals.push([a, b]);
    }
    if (this.cutTo !== null && this.cutTo <= (strip.k1 + 1) * strip.cell) intervals.push([this.cutTo, (strip.k1 + 1) * strip.cell]);
    const coverage: Coverage = intervals.sort((a, b) => a[0] - b[0]);
    this.setPlot(plotOf(chunks, this.meta, strip, coverage, this.windows, this.interest?.token ?? this.plot?.token ?? 0, this.epoch, this.version));
  }

  private aheadTarget(visible: Target): Target {
    const direction = this.interest!.direction;
    const ahead = {...visible,
      k0: direction < 0 ? visible.k0 - Math.ceil(visible.length / visible.cell) : visible.k1 + 1,
      k1: direction < 0 ? visible.k0 - 1 : visible.k1 + Math.ceil(visible.length / visible.cell)};
    ahead.k0 = Math.max(ahead.k0, Math.floor(Math.max(this.meta?.historyStart ?? 0, this.env.now() - 90 * 86_400_000 + 3_600_000) / ahead.cell));
    ahead.k1 = Math.min(ahead.k1, Math.floor((Math.max(this.env.now(), this.meta?.now ?? 0) + CLOCK_TOLERANCE_MS) / ahead.cell));
    return ahead;
  }

  private pumpPan() {
    const visible = this.plotTarget();
    const direction = this.interest!.direction;
    const ahead = this.aheadTarget(visible);
    const overlaps = (f: Flight, t: Target) => f.cell === t.cell && f.to > t.k0 * t.cell && f.from <= t.k1 * t.cell;
    const flights = [...this.flights].sort((a, b) => {
      const span = (f: Flight) => f.cell === visible.cell ? Math.max(0, Math.min(f.to, (visible.k1 + 1) * visible.cell) - Math.max(f.from, visible.k0 * visible.cell)) : 0;
      return span(b) - span(a) || b.seq - a.seq;
    });
    const kept: Flight[] = [];
    for (const flight of flights) {
      const role = overlaps(flight, visible) ? 'visible' : 'ahead';
      const sameTile = (f: Flight) => f.cell === flight.cell && tileOf(f.from, f.cell) <= tileOf(flight.to - 1, flight.cell) && tileOf(flight.from, flight.cell) <= tileOf(f.to - 1, f.cell);
      // Ordinary navigation can have more pending reads. Entering pan gives those
      // reads the same slots and tile ownership as reads started by the gesture.
      if (flight.epoch !== this.epoch || (!overlaps(flight, visible) && (!direction || !overlaps(flight, ahead))) || kept.some(f => f.role === role || sameTile(f))) this.abort(flight);
      else {flight.role = role; kept.push(flight);}
    }
    this.readMissing(visible, 'visible');
    if (direction && !this.aheadStopped && this.estimatedBytes < this.budget) this.readMissing(ahead, 'ahead');
  }

  private readMissing(target: Target, role: Flight['role']) {
    if (target.k1 < target.k0 || this.flights.size >= 2 || [...this.flights].some(f => f.role === role)) return;
    if (role === 'visible' && this.timers.has('retry')) return;
    const bad = this.bad(target);
    // Serialize writes to a tile, including disjoint slices: writeSeq belongs to a tile.
    const blocked = (at: number) => [...this.flights].some(f => f.cell === target.cell && tileOf(at, target.cell) >= tileOf(f.from, f.cell) && tileOf(at, target.cell) <= tileOf(f.to - 1, f.cell));
    const at = bad.find(at => !blocked(at));
    if (at === undefined) return;
    const first = this.tile(at, target.cell);
    const from = first.readTo === first.readFrom ? at : at < first.readFrom ? first.from : first.validTo;
    let last = at;
    const maxTiles = this.plotPending ? PAN_READ_TILES : MAX_READ_TILES;
    for (const next of bad) {
      if (next <= at) continue;
      if (next > last + target.cell || tileOf(next, target.cell) - tileOf(from, target.cell) >= maxTiles || blocked(next)) break;
      last = next;
    }
    const to = Math.min(tileEnd(tileOf(last, target.cell), target.cell), cellStart(Math.max(this.env.now(), this.meta?.now ?? 0), target.cell) + 2 * target.cell);
    if (to > from) this.read(target, from, to, role);
  }

  private read(target: Target, from: number, to: number, role: Flight['role']) {
    const flight: Flight = {seq: ++this.seq, epoch: this.epoch, target: target.key, newsSeq: this.newsSeq, cell: target.cell, from, to, touched: Infinity, startedAt: this.elapsedNow(), controller: new AbortController(), role};
    this.flights.add(flight);
    this.env.read(this.board!, target.cell, from, to, flight.controller.signal).then(answer => this.merge(flight, answer), error => this.failed(flight, error));
  }

  private abort(flight: Flight) {this.flights.delete(flight); flight.controller.abort();}
  private abortFlights() {for (const flight of [...this.flights]) this.abort(flight);}
  private setPlot(plot: PlotBuffer | null) {
    if (this.plot === plot) return;
    this.plot = plot;
    for (const listener of this.plotListeners) listener();
  }

  private merge(flight: Flight, answer: HistoryAnswer) {
    this.flights.delete(flight);
    if (flight.controller.signal.aborted || flight.epoch !== this.epoch || answer.run !== this.run) return;
    for (const chunk of answer.chunks) {
      const tile = this.tile(chunk.from, flight.cell);
      if (tile.writeSeq > flight.seq) continue;
      tile.merge(chunk, answer.known);
      tile.writeSeq = flight.seq;
      const freshEnd = Math.max(chunk.from, Math.min(chunk.to, cellStart(flight.touched, flight.cell)));
      if (tile.readFrom === tile.readTo) {
        tile.readFrom = chunk.from;
        tile.readTo = chunk.to;
        tile.validTo = freshEnd;
      } else if (chunk.from <= tile.readTo && chunk.to >= tile.readFrom) {
        // A touched bridge in the new head breaks the fresh prefix of the old suffix.
        if (chunk.from < tile.readFrom && freshEnd < tile.readFrom) tile.validTo = freshEnd;
        else if (chunk.from <= tile.validTo) tile.validTo = Math.max(tile.validTo, freshEnd);
        tile.readFrom = Math.min(tile.readFrom, chunk.from);
        tile.readTo = Math.max(tile.readTo, chunk.to);
      }
    }
    if (flight.seq > this.metaSeq) {
      this.metaSeq = flight.seq;
      this.meta = {now: answer.now, historyStart: answer.historyStart, known: answer.known};
      // Count the whole flight so a late answer cannot falsely reject a valid range.
      this.metaAt = flight.startedAt;
      const to = answer.chunks.at(-1)?.to;
      // A later read on a coarser grid does not revoke the earlier empty suffix;
      // only history news or a new epoch can put data there.
      if (flight.newsSeq === this.newsSeq && to !== undefined && to > answer.now + CLOCK_TOLERANCE_MS) this.cutTo = Math.min(this.cutTo ?? to, to);
    }
    this.needsCompose = true;
    this.version++;
    if (!this.bad(this.interest ? this.plotTarget() : this.target()).length) this.clear('retry');
    this.evict();
    this.schedule();
  }

  private failed(flight: Flight, error: unknown) {
    this.flights.delete(flight);
    if (flight.controller.signal.aborted || flight.epoch !== this.epoch) return;
    if (this.interest) {
      const visible = this.plotTarget();
      const needed = flight.role === 'visible' && flight.cell === visible.cell && this.bad(visible).some(at => at >= flight.from && at < flight.to);
      if (needed) this.timers.set('retry', this.env.setTimeout(() => {this.clear('retry'); this.schedule();}, RETRY_MS));
      else this.aheadStopped = true;
      this.schedule();
      return;
    }
    const target = this.interest ? this.plotTarget() : this.target();
    if (flight.target !== target.key || flight.cell !== target.cell || !this.bad(target).some(at => at >= flight.from && at < flight.to)) {
      this.schedule();
      return;
    }
    // A necessary read of this selected target validates it, even in a partial
    // final batch. Obsolete and speculative failures were excluded above.
    if (error instanceof ApiError && error.status === 400 && this.selected) return this.env.dropTimeRange();
    this.clear('retry');
    this.timers.set('retry', this.env.setTimeout(() => {this.clear('retry'); this.schedule();}, RETRY_MS));
  }

  private evict() {
    const target = this.interest ? this.plotTarget() : this.target();
    const ahead = this.interest?.direction ? this.aheadTarget(target) : null;
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
      // This interest cannot retain its speculative coverage. Another response
      // must not restart it; movement or news can try a new interest instead.
      if (ahead && cell === ahead.cell && tile.readTo > tile.readFrom && tile.readTo > ahead.k0 * cell && tile.readFrom <= ahead.k1 * cell) this.aheadStopped = true;
    }
  }

  private clear(name: 'settle' | 'retry') {
    if (!this.timers.has(name)) return;
    this.env.clearTimeout(this.timers.get(name));
    this.timers.delete(name);
  }
}

const keyOf = (lineup: string[]) => JSON.stringify([...lineup].sort());
export const loader = new HistoryStore({
  read: (board, cell, from, to, signal) => call<HistoryAnswer>('GET', `/api/history?board=${encodeURIComponent(board)}&cell=${cell}&from=${from}&to=${to}`, undefined, 12_000, signal),
  now: hubNow,
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  dropTimeRange,
});

/** Connection, board and window changes drive history; widgets only read it. */
export function follow(loader: HistoryStore, store: Store<PageState, PageEvent>) {
  return store.listen((event, state) => {
    if (event.type === 'board-open') {pan.cancel(); loader.open(event.id);}
    else if (event.type === 'board-close') {pan.cancel(); loader.close();}
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

/** The plot follows the gesture; only its completion chooses exact quantities. */
export function followPan(loader: HistoryStore, gesture: Pick<Pan, 'get' | 'subscribe'>, selectedRange: () => TimeRange | null) {
  let origin: TimeRange | null = null;
  let token: number | null = null;
  return gesture.subscribe(() => {
    const frame = gesture.get();
    if (frame) {
      token = frame.token;
      origin = frame.origin;
      loader.pan({token: frame.token, length: frame.length, from: frame.from, to: Math.min(frame.now, frame.to + frame.lookAhead), direction: frame.direction});
    } else if (token !== null) {
      const selected = selectedRange();
      const committed = origin === null ? selected !== null : selected === null || selected.from !== origin.from || selected.to !== origin.to;
      token = null;
      loader.endPan(committed);
    }
  });
}

if (typeof window !== 'undefined') {
  followPan(loader, pan, timeRange);
  const chosen = () => loader.choose(prefs().range, timeRange());
  onPrefs(chosen);
  onTimeRange(chosen);
  chosen();
}
export function useHistory(): Shown {return useSyncExternalStore(loader.subscribe, loader.get, loader.get);}
export function useHistoryPlot(): PlotBuffer | null {
  const current = useSyncExternalStore(loader.subscribePlot, loader.getPlot, loader.getPlot);
  // Input can interrupt preparation of the replacing strip. Clear/cancel and a
  // complete answer still retire it immediately, together with committed quantities.
  const prepared = useDeferredValue(current);
  return current && prepared?.token === current.token && prepared.epoch === current.epoch ? prepared : null;
}
const answeredStart = () => loader.get().history?.historyStart ?? null;
export function useHistoryBegins(): number {
  const answered = useSyncExternalStore(loader.subscribe, answeredStart, answeredStart);
  const snapshot = useHistoryStart();
  return answered ?? snapshot ?? 0;
}
