import {HistoryPool,historyPool} from './historyPool';
import {boardPeriod,followPeriod} from './period';
import type {HistoryScope} from '../../server/domain/history';
import {widgetVisible, QUOTA_WIDGETS, BUDGET_WIDGETS, ACTIVITY} from '../../server/domain/widgets';
import {useMemo,useRef,useSyncExternalStore} from 'react';
import {CLOCK_TOLERANCE_MS, MAX_READ_TILES, TILE_CELLS, cellStart, composePrepared, expandHistory, targetOf, tileEnd, tileOf, tileStart, type Chunk, type HistoryAnswer, type HistoryBasis, type Target} from '../../server/domain/history';
import {page, type PageEvent, type PageState} from './board';
import {hubNow} from './clock';
import {HistoryTile} from './historyTiles';
import {ApiError, UNAUTHORIZED} from './http';
import {periodOf} from './periods';
import {onPrefs, prefs} from './prefs';
import type {Store} from './store';
import {dropTimeRange, onTimeRange, timeRange, timeRangeKey, type TimeRange} from './timeRange';
import type {History} from './types';
import type {MeterSelection} from '../../server/domain/meterHistory';
import {moneySelection} from './moneySelection';
import {subscriptionSelection} from './subscription';
import {pan, type Pan} from './pan';
import {plotPrepared, type Coverage, type PlotBuffer} from './historyPlot';

import {prepare, preparations, type Preparation, type Preparations} from './prepare';

const SETTLE_MS = 300;
const RETRY_MS = 15_000;
const STORED_BYTES = 15 * 1024 * 1024;

export type HistoryEnv = {
  read(board: string, cell: number, from: number, to: number, signal?: AbortSignal, meters?: MeterSelection, meta?: HistoryBasis): Promise<HistoryAnswer>;
  now(): number;
  /** Elapsed time stays independent of corrections to the estimated hub clock. */
  elapsedNow?(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  dropTimeRange(): void;
  accessLost?(): void;
  schedule?(run: () => void): void;
  preparations?: Preparations | null;
};
export type Shown = {history: History | null; loading: boolean;error?:'history_limit'|'history_failed'};
type HistoryBoundary = {board: string; at: number; start: number};
type Flight = {seq: number; epoch: number; target: string; newsSeq: number; cell: number; from: number; to: number; touched: number; startedAt: number; controller: AbortController; role: 'visible' | 'ahead'};
type ResponseOwner = {answer: HistoryAnswer; keys: string[]; started: boolean; limited?: boolean};
type TilePin = {tile: HistoryTile; seq: number; from: number; to: number};
export type PlotInterest = {token: number; length: number; from: number; to: number; direction: -1 | 0 | 1};

/** History belongs to the open board. Cells are read only when missing or touched. */
export class HistoryStore {
  private board: string | null = null;
  private active = true;
  private ready = false;
  private run: string | null = null;
  private epoch = 0;
  private seq = 0;
  private metaSeq = 0;
  private newsSeq = 0;
  private lineupKey = '';
  private windowsKey = '';
  private windows = new Set<string>();
  private meters: MeterSelection | undefined;
  private period = '24h';
  private selected: TimeRange | null = null;
  private shown: History | null = null;
  private meta: HistoryBasis | null = null;
  private metaAt: number | null = null;
  private historyStart = 0;
  private boundary: HistoryBoundary | null = null;
  private readonly boundaryListeners = new Set<() => void>();
  getBoundary = () => this.boundary;
  subscribeBoundary = (listener: () => void) => {this.boundaryListeners.add(listener); return () => void this.boundaryListeners.delete(listener);};
  private setBoundary(value: HistoryBoundary | null) {
    this.boundary = value;
    for (const listener of this.boundaryListeners) listener();
  }
  private cutTo: number | null = null;
  private readonly grids = new Map<number, Map<number, HistoryTile>>();
  private readonly flights = new Set<Flight>();
  private readonly timers = new Map<'settle' | 'retry', unknown>();
  private changedAt = -Infinity;
  private scheduled = false;
  private needsCompose = false;
  private readonly listeners = new Set<() => void>();
  private state: Shown = {history: null, loading: false};
  private historyLimit=false;
  private readError=false;
  private interest: PlotInterest | null = null;
  private panReads = false;
  private cohort = '';
  // Only unvisited optional cells live here; aborting transport does not refund them.
  private readonly optional = new Set<number>();
  private inheritedExtra = false;
  private plotPending = false;
  private plot: PlotBuffer | null = null;
  private strip: Target | null = null;
  private stripToken = 0;
  private version = 0;
  private plotVersion = -1;
  private plotIdentity = '';
  private aheadStopped = false;
  private readonly plotListeners = new Set<() => void>();
  private readonly plotOwner = {};
  private readonly composeOwner = {};
  private composeIdentity = '';
  private readonly responses = new Map<Flight, ResponseOwner>();
  private readonly reservations = new Map<string, Flight>();
  private readonly plotChunks = new Map<string, {tile: HistoryTile; seq: number; from: number; to: number; chunk: Chunk}>();

  constructor(private readonly env: HistoryEnv, private readonly budget = STORED_BYTES, readonly scope?: HistoryScope, private readonly pool?: HistoryPool) {pool?.register(this);}

  /** Settings keep the board's live context without reading or preparing its charts. */
  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    if (active) this.schedule();
    else {
      this.cancelProjection();
      this.abortFlights();
      this.clear('settle');
      this.clear('retry');
    }
  }

  open(board: string) {
    if (board === this.board) return;
    this.close();
    this.board = board;
  }

  private get preparations() {return this.env.preparations === undefined ? preparations() : this.env.preparations;}

  private cancelProjection() {
    this.preparations?.cancel(this.plotOwner);
    this.preparations?.cancel(this.composeOwner);
    this.plotIdentity = this.composeIdentity = '';
  }

  close() {
    this.cancelProjection();
    this.epoch++;
    this.board = null;
    this.setBoundary(null);
    this.ready = false;
    this.historyLimit=false;this.readError=false;
    this.run = null;
    this.shown = this.meta = null;
    this.metaAt = null;
    this.metaSeq = 0;
    this.cutTo = null;
    this.grids.clear();
    this.abortFlights();
    this.interest = null;
    this.panReads = false;
    this.cohort = '';
    this.optional.clear();
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
    this.setBoundary(null);
    this.invalidate();
    this.ready = false;
  }

  snapshot(lineup: string[], windows: Iterable<string> = this.windows, historyStart = 0) {
    this.historyStart=historyStart;
    this.setBoundary(null);
    if(this.removesSource(lineup)){this.shown=null;this.grids.clear();}
    this.lineupKey = keyOf(lineup);
    this.setWindows(windows);
    this.invalidate();
    this.ready = true;
    this.publish();this.schedule();
  }

  lineup(lineup: string[]) {
    if (keyOf(lineup) === this.lineupKey) return;
    if(this.removesSource(lineup)){this.shown=null;this.grids.clear();}
    this.lineupKey = keyOf(lineup);
    this.invalidate();this.publish();
    this.schedule();
  }

  private removesSource(lineup: string[]) {
    return this.lineupKey !== '' && (JSON.parse(this.lineupKey) as string[]).some(id => !lineup.includes(id));
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

  setMeters(meters: MeterSelection | undefined) {
    if(JSON.stringify(meters)===JSON.stringify(this.meters))return;
    this.meters=meters;
    this.historyLimit=false;this.readError=false;this.meta=null;this.metaAt=null;
    this.grids.clear();
    this.shown=null;
    this.invalidate();
    this.schedule();
    this.publish();
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
    this.historyLimit=false;this.readError=false;
    this.selected = selected;
    if (!this.interest) this.panReads = false;
    this.needsCompose = true;
    this.reconsiderResponses();
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
    this.panReads = true;
    this.plotPending = true;
    const next = this.plotTarget();
    const cell = next.cell;
    if(this.meters&&this.plot?.cell===cell)this.setPlot(this.plot);
    const cohort = `${interest.token}:${this.epoch}:${cell}`;
    if (this.cohort !== cohort) {
      this.cohort = cohort;
      this.optional.clear();
      this.inheritedExtra = [...this.flights].some(f => f.cell === cell && (f.from < next.k0 * cell || f.to > (next.k1 + 1) * cell));
    }
    for (const at of this.optional) if (at >= next.k0 * cell && at <= next.k1 * cell) this.optional.delete(at);
    this.reconsiderResponses();
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
    this.panReads = commit;
    this.cohort = '';
    this.optional.clear();
    this.reconsiderResponses();
    const target = this.target();
    let retained=false;
    for (const flight of [...this.flights]) {
      if (flight.epoch !== this.epoch || flight.cell !== target.cell || flight.to <= target.k0 * target.cell || flight.from > target.k1 * target.cell) this.abort(flight);
      else if(this.pool&&retained)this.abort(flight);
      else {flight.role = 'visible';retained=true;}
    }
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
    this.cancelProjection();
    this.epoch++;
    this.cohort = this.interest ? `${this.interest.token}:${this.epoch}:${this.plotTarget().cell}` : '';
    this.optional.clear();
    this.inheritedExtra = false;
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
    const loading = !this.historyLimit && !this.readError && (!history && this.ready || !this.plotPending && !!history && history.range !== this.target().key);
    const error=this.historyLimit?'history_limit' as const:this.readError?'history_failed' as const:undefined;
    if (history === this.state.history && loading === this.state.loading&&error===this.state.error) return;
    this.state = {history, loading,...(error?{error}:{})};
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
    if (!this.active) return;
    this.startResponses();
    if (!this.board || !this.ready || !this.run || this.historyLimit) return;
    if(this.meters||this.pool){this.evict();if(this.historyLimit)return;}
    const target = this.target();
    if(this.scope==='budget'&&this.meters?.ids.length===0){
      this.meta??={run:this.run,now:this.env.now(),historyStart:this.historyStart,known:{work:0,sources:{}}};
      this.prepareCompose(target);return;
    }
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
    if (this.needsCompose && this.meta && this.full(target)) this.prepareCompose(target);
    if (this.plotPending) this.publishPlot();
    if (this.panReads) {
      for (const flight of [...this.flights]) {
        if (flight.cell !== target.cell || flight.to <= target.k0 * target.cell || flight.from > target.k1 * target.cell) this.abort(flight);
        else flight.role = 'visible';
      }
      this.readMissing(target, 'visible');
      if (!this.bad(target).length && !this.flights.size) this.panReads = false;
      return;
    }
    if (this.timers.has('settle') || this.timers.has('retry')) return;
    // News accumulates behind this target's pending read; another target can read now.
    if ([...this.flights].some(f => f.epoch === this.epoch && f.target === target.key && f.cell === target.cell)) return;
    const bad = this.bad(target);
    if (!bad.length) return;
    const first = this.grids.get(target.cell)?.get(tileOf(bad[0], target.cell));
    // Cold reads omit the unseen head. Entering a held tile's head fills it once.
    const from = !first || first.readTo === first.readFrom ? bad[0] : bad[0] < first.readFrom ? first.from : first.validTo;
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
    if (!this.strip || this.strip.cell !== visible.cell || this.stripToken !== (this.interest?.token ?? this.stripToken) || visible.k0 * visible.cell < this.strip.k0 * visible.cell + half / 2 || (visible.k1 + 1) * visible.cell > (this.strip.k1 + 1) * visible.cell - half / 2) {
      this.stripToken = this.interest?.token ?? this.stripToken;
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
    const intervals: [number, number][] = [];
    for (const tile of tiles) {
      const a = Math.max(tile.readFrom, strip.k0 * strip.cell), b = Math.min(tile.readTo, (strip.k1 + 1) * strip.cell);
      const last = intervals.at(-1);
      if (last && last[1] === a) last[1] = b;
      else intervals.push([a, b]);
    }
    if (this.cutTo !== null && this.cutTo <= (strip.k1 + 1) * strip.cell) intervals.push([this.cutTo, (strip.k1 + 1) * strip.cell]);
    const coverage: Coverage = intervals.sort((a, b) => a[0] - b[0]);
    const pins = this.pins(tiles), meta = this.meta, windows = this.windows;
    const token = this.interest?.token ?? this.plot?.token ?? 0, epoch = this.epoch, version = this.version;
    const valid = () => this.plotIdentity === identity && this.epoch === epoch && this.plotPending && this.windows === windows && this.pinsValid(pins);
    const work = function* (store: HistoryStore): Preparation<PlotBuffer> {
      const chunks: Chunk[] = [];
      for (const {tile, seq, from, to} of pins) {
        const key = `${tile.cell}:${tile.from}`;
        let saved = store.plotChunks.get(key);
        if (!saved || saved.tile !== tile || saved.seq !== seq || saved.from !== from || saved.to !== to) {
          const chunk = yield* tile.chunkPrepared(meta.known, true);
          saved = {tile, seq, from, to, chunk};
          if (valid()) store.plotChunks.set(key, saved);
        }
        chunks.push(saved.chunk); yield;
      }
      return yield* plotPrepared(chunks, meta, strip, coverage, windows, token, epoch, version);
    };
    prepare(this.plotOwner, work(this), valid, plot => this.setPlot(plot), this.preparations);
  }

  private pins(tiles: HistoryTile[]): TilePin[] {return tiles.map(tile => ({tile, seq: tile.writeSeq, from: tile.readFrom, to: tile.readTo}));}
  private pinsValid(pins: TilePin[]) {
    return pins.every(({tile, seq, from, to}) => this.grids.get(tile.cell)?.get(tileOf(tile.from, tile.cell)) === tile && tile.writeSeq === seq && tile.readFrom === from && tile.readTo === to);
  }

  private prepareCompose(target: Target) {
    const meta = this.meta!, board = this.board!, epoch = this.epoch, version = this.version, windows = this.windows;
    const identity = `${epoch}:${version}:${target.key}:${target.k0}:${target.k1}`;
    if (identity === this.composeIdentity) return;
    this.composeIdentity = identity;
    const tiles = [...(this.grids.get(target.cell)?.values() ?? [])].filter(t => t.readTo > t.readFrom && t.readTo > target.k0 * target.cell && t.readFrom <= target.k1 * target.cell).sort((a, b) => a.from - b.from);
    const pins = this.pins(tiles);
    const valid = () => !this.interest && this.board === board && this.epoch === epoch && this.version === version && this.windows === windows && this.composeIdentity === identity && this.target().key === target.key && this.pinsValid(pins);
    const work = function* (): Preparation<History> {
      const chunks: Chunk[] = [];
      for (const {tile} of pins) {chunks.push(yield* tile.chunkPrepared(meta.known)); yield;}
      return {...yield* composePrepared(chunks, meta, target, windows), board};
    };
    prepare(this.composeOwner, work(), valid, history => {
      for (const {tile} of pins) tile.shownAt = this.env.now();
      this.shown = history;
      this.needsCompose = false;
      if (this.plotPending) {this.plotPending = false; this.strip = null; this.plotChunks.clear(); this.preparations?.cancel(this.plotOwner); this.setPlot(null);}
      this.publish();
    }, this.preparations);
  }

  private aheadTarget(visible: Target): Target {
    const direction = this.interest!.direction;
    const cells = this.bufferCells(visible);
    const ahead = {...visible,
      k0: direction < 0 ? visible.k0 - cells : visible.k1 + 1,
      k1: direction < 0 ? visible.k0 - 1 : visible.k1 + cells};
    ahead.k0 = Math.max(ahead.k0, Math.floor(Math.max(this.meta?.historyStart ?? 0, this.env.now() - 90 * 86_400_000 + 3_600_000) / ahead.cell));
    ahead.k1 = Math.min(ahead.k1, Math.floor((Math.max(this.env.now(), this.meta?.now ?? 0) + CLOCK_TOLERANCE_MS) / ahead.cell));
    return ahead;
  }

  private bufferCells(target: Target) {return Math.min(TILE_CELLS, Math.ceil(target.length / target.cell / 4));}

  private optionalOverlap(flight: Flight, visible: Target) {
    if (!this.interest?.direction || this.aheadStopped || flight.cell !== visible.cell) return false;
    const ahead = this.aheadTarget(visible);
    return [...this.optional].some(at => at >= ahead.k0 * ahead.cell && at <= ahead.k1 * ahead.cell && at >= flight.from && at < flight.to);
  }

  private pumpPan() {
    const visible = this.plotTarget();
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
      if (flight.epoch !== this.epoch || (!overlaps(flight, visible) && !this.optionalOverlap(flight, visible)) || kept.some(f => f.role === role || sameTile(f))) this.abort(flight);
      else {flight.role = role; kept.push(flight);}
    }
    this.readMissing(visible, 'visible');
  }

  private readMissing(target: Target, role: Flight['role']) {
    if (target.k1 < target.k0 || this.flights.size >= 2 || [...this.flights].some(f => f.role === role)) return;
    if (role === 'visible' && this.timers.has('retry')) return;
    const bad = this.bad(target);
    // Serialize writes to a tile, including disjoint slices: writeSeq belongs to a tile.
    const blocked = (at: number) => [...this.flights].some(f => f.cell === target.cell && tileOf(at, target.cell) >= tileOf(f.from, f.cell) && tileOf(at, target.cell) <= tileOf(f.to - 1, f.cell));
    const backwards = this.interest?.direction === -1;
    if (backwards) bad.reverse();
    const at = bad.find(at => !blocked(at));
    if (at === undefined) return;
    let from = at, to = at + target.cell, last = at;
    for (const next of bad) {
      if (backwards ? next >= at : next <= at) continue;
      if (Math.abs(next - last) !== target.cell || Math.abs(tileOf(next, target.cell) - tileOf(at, target.cell)) >= MAX_READ_TILES || blocked(next)) break;
      from = Math.min(from, next); to = Math.max(to, next + target.cell);
      last = next;
    }
    const tiles = this.grids.get(target.cell), first = tiles?.get(tileOf(from, target.cell)), end = tiles?.get(tileOf(to - target.cell, target.cell));
    // A skipped part of a held tile must connect to its existing fresh prefix.
    // Empty tiles have no unseen head to fill, and fresh cells are never crossed.
    if (first && first.readTo > first.readFrom && from >= first.readFrom) from = Math.min(from, first.validTo);
    if (end && end.readTo > end.readFrom && to < end.readFrom) to = end.readFrom;
    if (this.interest?.direction && !this.aheadStopped && !this.inheritedExtra && this.estimatedBytes < this.budget) {
      const direction = this.interest.direction;
      const buffer = this.bufferCells(target);
      const requiredFrom = Math.min(from, target.k0 * target.cell);
      const requiredTo = Math.max(to, (target.k1 + 1) * target.cell);
      const added: number[] = [];
      const lower = Math.floor(Math.max(this.meta?.historyStart ?? 0, this.env.now() - 90 * 86_400_000 + 3_600_000) / target.cell) * target.cell;
      const upper = this.cutTo ?? (Math.floor((Math.max(this.env.now(), this.meta?.now ?? 0) + CLOCK_TOLERANCE_MS) / target.cell) + 1) * target.cell;
      for (let n = 0; n < buffer; n++) {
        const extra = direction < 0 ? from - target.cell : to;
        if (extra < lower || extra >= upper || blocked(extra) || tileOf(Math.max(to, extra + target.cell) - 1, target.cell) - tileOf(Math.min(from, extra), target.cell) >= MAX_READ_TILES) break;
        const tile = this.grids.get(target.cell)?.get(tileOf(extra, target.cell));
        if (tile && tile.readTo > tile.readFrom && (extra >= tile.readFrom && extra < tile.validTo || Math.min(tile.to, Math.max(to, extra + target.cell)) < tile.readFrom || Math.max(tile.from, Math.min(from, extra)) > tile.readTo)) break;
        // A large foreground run may end before the viewport edge. Its extension
        // is still necessary; only cells outside that viewport consume the buffer.
        if (extra < target.k0 * target.cell || extra > target.k1 * target.cell) {
          if (!this.optional.has(extra) && this.optional.size >= buffer) break;
          if (!this.optional.has(extra)) {this.optional.add(extra); added.push(extra);}
        }
        from = Math.min(from, extra); to = Math.max(to, extra + target.cell);
      }
      // Stop the optional tail at a tile edge without shrinking below one tile.
      // Splitting the same tile across replies repeats its series and activity metadata.
      const span = target.cell * TILE_CELLS;
      if (direction < 0) {
        const aligned = Math.ceil(from / span) * span;
        if (aligned <= requiredFrom && to - aligned >= span) from = aligned;
      } else {
        const aligned = Math.floor(to / span) * span;
        if (aligned >= requiredTo && aligned - from >= span) to = aligned;
      }
      // These cells were never requested. Earlier attempts retain their charges.
      for (const extra of added) if (extra < from || extra >= to) this.optional.delete(extra);
    }
    if (to > from) this.read(target, from, to, role);
  }

  private read(target: Target, from: number, to: number, role: Flight['role']) {
    if(this.pool)for(const waiting of [...this.flights])if(!this.pool.isActive(waiting)&&waiting.role===role)this.abort(waiting);
    const flight: Flight = {seq: ++this.seq, epoch: this.epoch, target: target.key, newsSeq: this.newsSeq, cell: target.cell, from, to, touched: Infinity, startedAt: this.elapsedNow(), controller: new AbortController(), role};
    this.flights.add(flight);
    const meta = this.meta?.run === this.run ? this.meta : undefined;
    const board=this.board!,meters=this.meters;
    const start=()=>{
      if(flight.controller.signal.aborted||flight.epoch!==this.epoch){this.abort(flight);return;}
      flight.startedAt=this.elapsedNow();
      this.env.read(board, target.cell, from, to, flight.controller.signal, meters, meta).then(answer => this.merge(flight, answer), error => this.failed(flight, error));
    };
    if(this.pool)this.pool.request(this,flight,start,()=>this.abort(flight));else start();
  }

  private abort(flight: Flight) {this.preparations?.cancel(flight); this.releaseResponse(flight); flight.controller.abort();}
  private abortFlights() {for (const flight of [...this.flights]) this.abort(flight);}
  private setPlot(plot: PlotBuffer | null) {
    if(plot&&this.meters&&this.meta) {
      const target=this.plotTarget(),from=target.k0*target.cell,to=Math.min((target.k1+1)*target.cell,this.meta.now);
      if(plot.meterFrame?.from!==from||plot.meterFrame.to!==to)plot={...plot,meterFrame:{from,to}};
    }
    if (this.plot === plot) return;
    this.plot = plot;
    for (const listener of this.plotListeners) listener();
  }

  private responsePriority(flight: Flight) {
    if (flight.controller.signal.aborted || flight.epoch !== this.epoch) return -1;
    const target = this.interest ? this.plotTarget() : this.target();
    if (flight.cell === target.cell && flight.to > target.k0 * target.cell && flight.from <= target.k1 * target.cell) return 2;
    if (this.optionalOverlap(flight, target)) return 1;
    return 0;
  }

  private reconsiderResponses() {
    for (const flight of this.responses.keys()) if (this.responsePriority(flight) < 1) this.abort(flight);
    this.startResponses();
  }

  private merge(flight: Flight, answer: HistoryAnswer) {
    if (!this.flights.has(flight) || flight.controller.signal.aborted || flight.epoch !== this.epoch || answer.run !== this.run) {this.abort(flight); return;}
    if (this.responses.size >= 2) {
      const incoming = this.responsePriority(flight);
      const victim = [...this.responses.keys()].sort((a, b) => this.responsePriority(a) - this.responsePriority(b) || a.seq - b.seq)[0];
      const priority = this.responsePriority(victim);
      if (incoming > priority || incoming === priority && flight.seq > victim.seq) {if (priority < 2) this.aheadStopped = true; this.abort(victim);}
      else {if (incoming < 2) this.aheadStopped = true; this.abort(flight); this.schedule(); return;}
    }
    const keys = [...new Set(answer.chunks.map(chunk => `${flight.cell}:${tileOf(chunk.from, flight.cell)}`))];
    this.responses.set(flight, {answer, keys, started: false});
    this.startResponses();
  }

  private startResponses() {
    for (const [flight, response] of this.responses) {
      if (response.started || response.keys.some(key => this.reservations.has(key))) continue;
      // A late inherited slice cannot create a bounding interval across an unread
      // gap. Discard the whole answer and let the planner connect the current base.
      if (response.answer.chunks.some(chunk => {
        const base = this.grids.get(flight.cell)?.get(tileOf(chunk.from, flight.cell));
        return base && base.writeSeq <= flight.seq && base.readTo > base.readFrom && (chunk.to < base.readFrom || chunk.from > base.readTo);
      })) {this.abort(flight); this.schedule(); continue;}
      for (const key of response.keys) this.reservations.set(key, flight);
      response.started = true;
      const pins = new Map<HistoryTile, {seq: number; from: number; to: number; staged: HistoryTile; chunks: Chunk[]}>();
      const valid = () => this.responses.get(flight) === response && this.flights.has(flight) && !flight.controller.signal.aborted && flight.epoch === this.epoch && response.answer.run === this.run && response.keys.every(key => this.reservations.get(key) === flight) && [...pins].every(([base, pin]) => this.grids.get(base.cell)?.get(tileOf(base.from, base.cell)) === base && base.writeSeq === pin.seq && base.readFrom === pin.from && base.readTo === pin.to);
      const work = function* (store: HistoryStore): Preparation<void> {
        let completed = false;
        try {
        for (const chunk of response.answer.chunks) {
          const base = store.tile(chunk.from, flight.cell);
          if (base.writeSeq > flight.seq) continue;
          let pin = pins.get(base);
          if (!pin) {pin = {seq: base.writeSeq, from: base.readFrom, to: base.readTo, staged: base, chunks: []}; pins.set(base, pin);}
          const otherGrowth = [...pins].reduce((sum, [other, value]) => sum + (other === base ? 0 : Math.max(0, value.staged.bytes - other.bytes)), 0);
          const admit = (bytes: number) => !store.pool || store.pool.reserve(flight, otherGrowth + Math.max(0, bytes - base.bytes));
          // Include new empty tile headers before preparation can yield, too.
          if (!admit(pin.staged.bytes)) {response.limited = true; completed = true; return;}
          const staged = yield* pin.staged.staged(chunk, response.answer.known, admit);
          if (!staged) {response.limited = true; completed = true; return;}
          pin.staged = staged;
          pin.chunks.push(chunk);
          if(store.pool&&!store.pool.reserve(flight,[...pins].reduce((sum,[base,pin])=>sum+Math.max(0,pin.staged.bytes-base.bytes),0))) {
            response.limited=true;completed=true;return;
          }
          yield;
        }
        completed = true;
        } finally {
          if (!completed && store.responses.get(flight) === response) {store.releaseResponse(flight); store.schedule();}
        }
      };
      prepare(flight, work(this), valid, () => {
        if(response.limited){if(flight.role==='ahead'){this.aheadStopped=true;this.abort(flight);this.schedule();}else this.limit();return;}
        // No yield between the last ownership check and the entire response's publication.
        for (const [base, {staged, chunks}] of pins) {
          staged.readFrom = base.readFrom; staged.readTo = base.readTo; staged.validTo = base.validTo;
          staged.writeSeq = flight.seq;
          for (const chunk of chunks) {
            const freshEnd = Math.max(chunk.from, Math.min(chunk.to, cellStart(flight.touched, flight.cell)));
            if (staged.readFrom === staged.readTo) {staged.readFrom = chunk.from; staged.readTo = chunk.to; staged.validTo = freshEnd;}
            else if (chunk.from <= staged.readTo && chunk.to >= staged.readFrom) {
              if (chunk.from < staged.readFrom && freshEnd < staged.readFrom) staged.validTo = freshEnd;
              else if (chunk.from <= staged.validTo) staged.validTo = Math.max(staged.validTo, freshEnd);
              staged.readFrom = Math.min(staged.readFrom, chunk.from); staged.readTo = Math.max(staged.readTo, chunk.to);
            }
          }
          this.grids.get(base.cell)!.set(tileOf(base.from, base.cell), staged);
        }
        const answer = response.answer;
        this.readError=false;
        if (flight.seq > this.metaSeq) {
          this.metaSeq = flight.seq;
          this.meta = {run: answer.run, now: answer.now, historyStart: answer.historyStart, known: answer.known, ...(answer.meta ? {meta: answer.meta} : {})};
          this.metaAt = flight.startedAt;
          this.setBoundary({board: this.board!, at: answer.now, start: answer.historyStart});
          const to = answer.chunks.at(-1)?.to;
          if (flight.newsSeq === this.newsSeq && to !== undefined && to > answer.now + CLOCK_TOLERANCE_MS) this.cutTo = Math.min(this.cutTo ?? to, to);
        }
        this.releaseResponse(flight);
        this.needsCompose = true;
        this.version++;
        if (!this.bad(this.interest ? this.plotTarget() : this.target()).length) this.clear('retry');
        this.evict(); this.startResponses(); this.schedule();
      }, this.preparations);
    }
  }

  private releaseResponse(flight: Flight) {
    this.responses.delete(flight); this.flights.delete(flight); this.pool?.release(flight);
    for (const [key, owner] of this.reservations) if (owner === flight) {
      this.reservations.delete(key);
      const [cell, n] = key.split(':').map(Number), tiles = this.grids.get(cell);
      if (tiles?.get(n)?.writeSeq === 0) tiles.delete(n);
    }
  }

  private failed(flight: Flight, error: unknown) {
    this.flights.delete(flight);this.pool?.release(flight);
    if (flight.controller.signal.aborted || flight.epoch !== this.epoch) return;
    if(error instanceof ApiError&&(error.status===401||error.status===403||error.code==='board_not_found')) {
      this.close();this.env.accessLost?.();return;
    }
    if(error instanceof ApiError&&error.code==='not_found') {
      this.cancelProjection();this.abortFlights();this.grids.clear();this.plotChunks.clear();this.shown=null;this.setPlot(null);
      this.readError=true;this.publish();return;
    }
    const target = this.interest ? this.plotTarget() : this.target();
    const needed = flight.cell === target.cell && this.bad(target).some(at => at >= flight.from && at < flight.to);
    if(!needed){this.aheadStopped=true;this.schedule();return;}
    if(error instanceof ApiError&&error.code==='history_limit') {this.limit();return;}
    if (this.interest) {
      const visible = this.plotTarget();
      const needed = flight.cell === visible.cell && this.bad(visible).some(at => at >= flight.from && at < flight.to);
      if(needed){this.readError=true;this.publish();}
      if (needed) this.timers.set('retry', this.env.setTimeout(() => {this.clear('retry'); this.schedule();}, RETRY_MS));
      else this.aheadStopped = true;
      this.schedule();
      return;
    }
    if (flight.target !== target.key || flight.cell !== target.cell || !this.bad(target).some(at => at >= flight.from && at < flight.to)) {
      this.schedule();
      return;
    }
    // A necessary read of this selected target validates it, even in a partial
    // final batch. Obsolete and speculative failures were excluded above.
    if (error instanceof ApiError && (this.scope ? error.code === 'history_range_invalid' : error.status === 400) && this.selected) return this.env.dropTimeRange();
    this.readError=true;this.publish();
    this.clear('retry');
    this.timers.set('retry', this.env.setTimeout(() => {this.clear('retry'); this.schedule();}, RETRY_MS));
  }

  private limit() {
    this.historyLimit=true;
    this.cancelProjection();this.abortFlights();
    this.grids.clear();this.plotChunks.clear();this.strip=null;
    this.shown=null;this.setPlot(null);this.clear('retry');this.publish();
  }

  evictionCandidates() {
    const target=this.interest?this.plotTarget():this.target(),shown=this.shown;
    const candidates:{bytes:number;shownAt:number;drop:()=>void}[]=[];
    for(const [cell,tiles] of this.grids)for(const [n,tile] of tiles){
      if(this.reservations.has(`${cell}:${n}`))continue;
      if(this.active&&cell===target.cell&&tile.to>target.k0*cell&&tile.from<=(target.k1)*cell)continue;
      if(this.active&&shown&&cell===shown.cellMs&&tile.to>shown.since&&tile.from<shown.to)continue;
      candidates.push({bytes:tile.bytes,shownAt:tile.shownAt,drop:()=>{
        tiles.delete(n);this.plotChunks.delete(`${cell}:${tile.from}`);this.version++;this.aheadStopped=true;
        // Another reader can evict this tile while our final projection is yielding.
        this.schedule();
      }});
    }
    return candidates;
  }

  retry = () => {this.readError=false;this.historyLimit=false;this.clear('retry');this.publish();this.schedule();};

  private evict() {
    if(this.pool){if(!this.pool.trim())this.limit();return;}
    let bytes = this.estimatedBytes;
    if (bytes <= this.budget) return;
    const target = this.interest ? this.plotTarget() : this.target();
    const ahead = this.interest?.direction ? this.aheadTarget(target) : null;
    const candidates: {cell: number; n: number; tile: HistoryTile}[] = [];
    for (const [cell, tiles] of this.grids) for (const [n, tile] of tiles) {
      if (this.reservations.has(`${cell}:${n}`)) continue;
      if (cell === target.cell && tile.to > target.k0 * cell && tile.from <= target.k1 * cell) continue;
      candidates.push({cell, n, tile});
    }
    for (const {cell, n, tile} of candidates.sort((a, b) => a.tile.shownAt - b.tile.shownAt)) {
      if (bytes <= this.budget) break;
      this.grids.get(cell)!.delete(n);
      this.version++;
      bytes -= tile.bytes;
      // This interest cannot retain its speculative coverage. Another response
      // must not restart it; movement or news can try a new interest instead.
      if (ahead && cell === ahead.cell && tile.readTo > tile.readFrom && tile.readTo > ahead.k0 * cell && tile.readFrom <= ahead.k1 * cell) this.aheadStopped = true;
    }
    if(this.meters&&bytes>this.budget) {
      let visible=0;
      for(const tile of this.grids.get(target.cell)?.values()??[])if(tile.readTo>tile.readFrom&&tile.to>target.k0*target.cell&&tile.from<=target.k1*target.cell)visible+=tile.bytes;
      if(visible>this.budget)this.limit();
    }
  }

  private clear(name: 'settle' | 'retry') {
    if (!this.timers.has(name)) return;
    this.env.clearTimeout(this.timers.get(name));
    this.timers.delete(name);
  }
}

const keyOf = (lineup: string[]) => JSON.stringify([...lineup].sort());
export {historyPool} from './historyPool';
function reader(scope: HistoryScope) {
  const value=new HistoryStore({
    read: (_board, cell, from, to, signal, meters, meta) => boardPeriod.transport.read(scope,{cell:String(cell),from:String(from),to:String(to),...(pan.get()?{evidence:'skip'}:{}),meta:meta?.meta??'',...(meters?{unit:meters.unit,meters:JSON.stringify(meters.ids),...(meters.displayCurrency?{currency:meters.displayCurrency}:{})}:{})},signal).then(reply=>expandHistory(reply,meta)),
    now: hubNow,
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    dropTimeRange: () => {if(timeRange())dropTimeRange();},
    accessLost: () => {page.dispatch({type:'board-close'});window.dispatchEvent(new Event(UNAUTHORIZED));},
  }, STORED_BYTES, scope, historyPool);
  value.setActive(false);return value;
}
export const quotaHistory = reader('quota'), budgetHistory = reader('budget');
export const loader = quotaHistory;
let shellActive = false;
const selectedMeters = (state: PageState, scope: HistoryScope) => {
  const board=state.board;if(!board)return undefined;
  const cards=board.lineup.flatMap(id=>board.cards[id]??[]);
  return scope==='budget'?moneySelection(cards,board.view.hidden,prefs().money,board.currencies).selection:subscriptionSelection(cards,board.view);
};
function activeReaders(state=page.get()) {
  const board=state.board;
  quotaHistory.setActive(shellActive&&!!board&&[ACTIVITY,...QUOTA_WIDGETS].some(id=>widgetVisible(board.view,id,board.lineup.length)));
  budgetHistory.setActive(shellActive&&!!board&&BUDGET_WIDGETS.some(id=>widgetVisible(board.view,id,board.lineup.length)));
}
export const historyReaders = {setActive(active: boolean) {shellActive=active;boardPeriod.activate(active);activeReaders();}};

/** Event changes identify resources; a reader's choices never mutate another board's selections. */
export function follow(loader: HistoryStore, store: Store<PageState, PageEvent>) {
  const scope=loader.scope??'quota';
  return store.listen((event, state) => {
    if (event.type === 'board-open') {pan.cancel(); loader.open(event.id);}
    else if (event.type === 'board-close') {pan.cancel(); loader.close();}
    else if (event.type === 'hub') {
      const hub = event.event;
      if (hub.type === 'hello') loader.hello(hub.data.epoch);
      else if (hub.type === 'snapshot') loader.snapshot(state.board?.lineup ?? [], scope==='quota'?windowsOf(state):[], state.board?.historyStart);
      else if (hub.type === 'lineup') {loader.lineup(state.board?.lineup ?? []); if(scope==='quota')loader.setWindows(windowsOf(state));}
      else if (hub.type === 'card'&&scope==='quota') loader.setWindows(windowsOf(state));
      else if (hub.type === 'history') {
        const selected=scope==='budget'?new Set(selectedMeters(state,scope)?.ids.map(([source])=>source)):new Set(state.board?.lineup??[]);
        const changes=hub.data.changes?.filter(change=>change.scope===scope&&selected.has(change.source));
        if(changes?.length)loader.news(Math.min(...changes.map(change=>change.since)));
        else if(!hub.data.changes&&hub.data.sources.some(source=>selected.has(source)))loader.news(hub.data.since);
      }
    }
    if(state.board)loader.setMeters(selectedMeters(state,scope));
  });
}
const windowsOf = (state: PageState) => Object.values(state.board?.cards ?? {}).flatMap(card => card.windows.map(window => `${card.id} ${window.id}`));
follow(quotaHistory,page);follow(budgetHistory,page);
if(typeof window!=='undefined')followPeriod();
page.listen((_event,state)=>activeReaders(state));

/** The plot follows the gesture; only its completion chooses exact quantities. */
export function followPan(loader: HistoryStore, gesture: Pick<Pan, 'get' | 'subscribe'>, selectedRange: () => TimeRange | null) {
  let origin: TimeRange | null = null;
  let token: number | null = null;
  return gesture.subscribe(() => {
    const frame = gesture.get();
    if (frame) {
      token = frame.token;
      origin = frame.origin;
      loader.pan({token: frame.token, length: frame.length, from: frame.from, to: Math.min(frame.now, frame.to + (loader.scope==='budget'?0:frame.lookAhead)), direction: frame.direction});
    } else if (token !== null) {
      const selected = selectedRange();
      const committed = origin === null ? selected !== null : selected === null || selected.from !== origin.from || selected.to !== origin.to;
      token = null;
      loader.endPan(committed);
    }
  });
}

if (typeof window !== 'undefined') {
  followPan(quotaHistory, pan, timeRange);
  followPan(budgetHistory, pan, timeRange);
  const chosen = () => {
    for(const reader of [quotaHistory,budgetHistory]) {
      reader.choose(prefs().range,timeRange());
      if(page.get().board)reader.setMeters(selectedMeters(page.get(),reader.scope!));
    }
  };
  onPrefs(chosen);onTimeRange(chosen);chosen();
}
function usePeriodHistory(loader:HistoryStore):Shown {
  const shown=useSyncExternalStore(loader.subscribe,loader.get,loader.get);
  const revision=useSyncExternalStore(listener=>boardPeriod.subscribeProjection(loader.scope??'quota',listener),()=>boardPeriod.getProjectionRevision(loader.scope??'quota'));
  const retained=useRef<{board:string;history:History}|null>(null);
  return useMemo(()=>{
    const board=page.get().board?.id??'';if(retained.current?.board!==board)retained.current=null;
    if(!shown.history)return shown;
    const scope=loader.scope??'quota',state=boardPeriod.projectionState(shown.history,scope);
    if(!state.ready)return {...shown,history:retained.current?.history??null,loading:!state.error&&!shown.error,error:state.error??shown.error};
    const history=boardPeriod.project(shown.history,scope);retained.current={board,history};return {...shown,history};
  },[shown,revision,loader]);
}
export function useHistory(): Shown {return usePeriodHistory(quotaHistory);}
export function useBudgetHistory(): Shown {return usePeriodHistory(budgetHistory);}
export function useHistoryPlot(): PlotBuffer | null {return useSyncExternalStore(quotaHistory.subscribePlot, quotaHistory.getPlot, quotaHistory.getPlot);}
export function useBudgetHistoryPlot(): PlotBuffer | null {return useSyncExternalStore(budgetHistory.subscribePlot, budgetHistory.getPlot, budgetHistory.getPlot);}
/** A fresh answer from either resource family supersedes the board's initial snapshot. */
export function historyBegins(board: string | null, snapshot: number | null, answers: readonly (HistoryBoundary | null)[]): number {
  const current = answers.filter((answer): answer is HistoryBoundary => !!answer && answer.board === board);
  const newest = Math.max(...current.map(answer => answer.at));
  return current.length ? Math.min(...current.filter(answer => answer.at === newest).map(answer => answer.start)) : snapshot ?? 0;
}
const subscribeHistoryBegins = (listener: () => void) => {
  const stops = [page.subscribe(listener), quotaHistory.subscribeBoundary(listener), budgetHistory.subscribeBoundary(listener)];
  return () => stops.forEach(stop => stop());
};
const readHistoryBegins = () => {
  const board = page.get().board;
  return historyBegins(board?.id ?? null, board?.historyStart ?? null, [quotaHistory.getBoundary(), budgetHistory.getBoundary()]);
};
/** Reading fresh metadata only renders navigation when its numeric boundary changes. */
export function useHistoryBegins(): number {return useSyncExternalStore(subscribeHistoryBegins, readHistoryBegins, readHistoryBegins);}
