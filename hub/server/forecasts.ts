import {forecastOf, planSince, READ_MS, started, subscriptionWeekly, uncounted, type Memory, type PlanChange, type SeriesForecast, type SeriesSample} from './domain/forecast.js';
import type {SourceState, Win} from './domain/quota.js';
import type {Store} from './store/store.js';
import {trouble} from './touches.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Reset times this close are one window (domain/quota.ts, `edge`). */
const TOLERANCE = 60_000;
/** A window whose start is at most this before a sample had not started yet (`started`). */
const STARTED_AFTER = 2 * MINUTE;
/** A drop of the used share by this much in one window is a reset or a correction the forecast did not know. */
const DROP = 5;

/**
 * A window's forecast as the hub tells it (spec/dashboard-v1.md, `forecast`): the model's,
 * with its moments in whole milliseconds (rounded up, so the board's countdowns change when
 * they should) and its line as [minutes from the anchor, what is left to a tenth]. A series
 * whose working out failed is `none`, `failed`.
 */
export type WindowForecast = Omit<SeriesForecast, 'points'> & {points: [number, number][] | null; failed?: true};

/** Why a series was worked out: first, a late sample, a sample that contradicts it, or a new hour. */
export type Why = 'first' | 'late' | 'silent' | 'revived' | 'newWindow' | 'drop' | 'refuted' | 'gap' | 'hour';

/** What a series' forecast was worked out on (`asOf`, with `memoryIn`), and the card's last measurement it saw (`seen`). */
type Entry = {asOf: number; seen: number; memoryIn: Memory | null; memoryOut: Memory | null; forecast: WindowForecast; failed: boolean};

/** What a series keeps in the database to go on after a restart of the hub. */
type Kept = {asOf: number; memoryIn: Memory | null; memoryOut: Memory | null};

const keyOf = (source: string, window: string) => `forecast:${source}:${window}`;

/**
 * How long after each whole hour a subscription's forecasts are worked out again: up to
 * ten minutes, the same for it every hour, from its id. Weeks of samples take about ten
 * milliseconds a window to read, and a hub's windows all at once would hold it up for
 * half a second. A forecast is still of the whole hour, whenever it is worked out.
 */
export function hourShift(source: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 0x01000193);
  return ((hash >>> 0) % 600) * 1000;
}
const up = (at: number | null) => (at === null ? null : Math.ceil(at));

/** A model's forecast as the hub tells it (`WindowForecast`). */
export function told(f: SeriesForecast): WindowForecast {
  const anchor = f.anchor;
  const basis = f.basis && 'burst' in f.basis && f.basis.burst ? {...f.basis, burst: {...f.basis.burst, zero: Math.ceil(f.basis.burst.zero)}} : f.basis;
  return {
    ...f,
    zero: up(f.zero),
    shownZero: up(f.shownZero),
    basis,
    points: f.points && anchor ? f.points.map(([at, left]) => [Math.round((at - anchor.at) / 60) / 1000, Math.round(left * 10) / 10]) : null,
  };
}

const failed = (asOf: number): WindowForecast => ({
  state: 'none',
  failed: true,
  asOf,
  resetAt: null,
  anchor: null,
  F: null,
  zero: null,
  shownZero: null,
  shownLeft: null,
  comfy: false,
  points: null,
  basis: null,
});

/**
 * The forecasts of the subscriptions' weekly windows (domain/forecast.ts), one per series
 * for the whole hub: every board and `/api/overview` read the same. A series is worked
 * out again only when the forecast would change: at the next whole hour after a new
 * sample, or at once when a new sample contradicts what it stands on. Nothing but each
 * series' last result is kept, and its memory (the verdict's hysteresis and dead bands)
 * also goes to the database with the next `save`, so a restarted hub goes on where it was.
 * Five-hour windows are the board's to foresee.
 */
export class Forecasts {
  private readonly series = new Map<string, Entry>();
  private readonly unsaved = new Map<string, Kept>();

  private readonly shift: (source: string) => number;
  private readonly observe?: (worked: {source: string; window: string; asOf: number; why: Why}) => void;

  /** `shift`, when after the hour a source's forecasts are worked out (`hourShift`); `observe` hears of every series worked out (tests). */
  constructor(
    private readonly store: Store,
    options: {shift?: (source: string) => number; observe?: (worked: {source: string; window: string; asOf: number; why: Why}) => void} = {},
  ) {
    this.shift = options.shift ?? hourShift;
    this.observe = options.observe;
  }

  /**
   * The forecasts of a source's weekly windows at `now`, by window id, and when they may
   * change with no new sample: when the next whole hour after one they have not taken in
   * is worked out.
   */
  of(source: string, now: number): {value: Record<string, WindowForecast>; changesAt: number | null} {
    const state = this.store.state(source);
    const value: Record<string, WindowForecast> = {};
    if (state.successAt === null) return {value, changesAt: null};
    const shift = this.shift(source);
    // The last whole hour this source's forecasts are worked out on by now.
    const hour = Math.floor((now - shift) / HOUR) * HOUR;
    const reads = new Reads(this.store, source, state);
    let changesAt: number | null = null;
    for (const window of state.windows) {
      if (window.kind !== 'weekly') continue;
      const entry = this.refresh(source, state, window, hour, reads);
      value[window.id] = entry.forecast;
      if (state.successAt > entry.asOf) changesAt = Math.min(changesAt ?? Infinity, Math.floor(entry.asOf / HOUR) * HOUR + HOUR + shift);
    }
    return {value, changesAt};
  }

  /** Writes what the series worked out since the last time keep, in one transaction; trouble writing is logged, and the forecasts stand. */
  save() {
    if (!this.unsaved.size) return;
    const entries = [...this.unsaved].map(([key, kept]): [string, string] => [key, JSON.stringify(kept)]);
    this.unsaved.clear();
    try {
      this.store.keep(entries);
    } catch (error) {
      trouble(error);
    }
  }

  private refresh(source: string, state: SourceState, window: Win, hour: number, reads: Reads): Entry {
    const key = keyOf(source, window.id);
    const successAt = state.successAt!;
    let entry = this.series.get(key);
    if (!entry) {
      // The first since the hub started: from where it was, if that took in the latest
      // sample, else on the latest sample, as of this hour when it came before it. Never as
      // of an hour before it: that would be worked out again at the next, with no sample
      // new to a board that stands still.
      const kept = this.read(key);
      const asOf = kept && kept.asOf >= successAt ? kept.asOf : Math.max(hour, successAt);
      entry = this.work(key, source, window, asOf, kept ? (kept.asOf === asOf ? kept.memoryIn : kept.memoryOut) : null, successAt, reads, 'first');
    }
    // A sample of the time a forecast stands on, come late (another device's): the same moment worked out again.
    if (!entry.failed && entry.seen < entry.asOf && successAt > entry.seen && this.store.sampled(source, window.id, entry.seen, entry.asOf)) {
      entry = this.work(key, source, window, entry.asOf, entry.memoryIn, successAt, reads, 'late');
    }
    const why = successAt > entry.asOf ? this.contradiction(source, state, window, entry) : null;
    if (why) return this.work(key, source, window, Math.max(hour, successAt), entry.memoryOut, successAt, reads, why);
    if (entry.asOf < hour && successAt > entry.asOf) {
      entry = this.work(key, source, window, hour, entry.memoryOut, successAt, reads, 'hour');
      // The hour's forecast may stand on a sample the latest contradicts: one before a gap nobody read through.
      const again = successAt > entry.asOf ? this.contradiction(source, state, window, entry) : null;
      if (again) entry = this.work(key, source, window, Math.max(hour, successAt), entry.memoryOut, successAt, reads, again);
      return entry;
    }
    entry.seen = Math.max(entry.seen, successAt);
    return entry;
  }

  /**
   * Why the card's latest sample contradicts what a forecast stands on, so that waiting for
   * the hour would show what is known to be wrong; null when it does not. A series whose
   * answer the card gives at once (none without a reset time, waiting for a sample after
   * one, needing data while its window is not started or cannot count) waits for the hour:
   * else it would be worked out at every sample.
   */
  private contradiction(source: string, state: SourceState, window: Win, entry: Entry): Why | null {
    if (entry.failed) return null;
    const f = entry.forecast;
    const at = state.successAt!;
    const left = 100 - window.used;
    const begun = window.used > 0 || started(window, at);
    // Silent: it speaks at the first sample that brings an hour of history, whatever the minute.
    if (f.state === 'needData' && begun && uncounted(state.windows, window) === null) return 'silent';
    if (f.state === 'none' && window.resetAt !== null && window.minutes !== null) return 'silent';
    // Back from zero, before its reset time: a reset, or the provider correcting itself.
    if ((f.state === 'usedUp' || f.state === 'awaiting') && left > 0 && window.resetAt !== null && window.resetAt > at) return 'revived';
    // A new window started. A rolling one not started yet moves its reset with every sample and is no news.
    if (begun && f.resetAt !== null && window.resetAt !== null && Math.abs(window.resetAt - f.resetAt) > TOLERANCE) return 'newWindow';
    // The forecast stands on a sample of a window that had not started (by the tolerance), and now it has.
    if (begun && f.anchor && f.resetAt !== null && window.minutes !== null && f.anchor.left === 100 && f.resetAt - window.minutes * MINUTE >= f.anchor.at - STARTED_AFTER)
      return 'newWindow';
    if (f.anchor && f.resetAt !== null && window.resetAt !== null && Math.abs(window.resetAt - f.resetAt) <= TOLERANCE && window.used <= 100 - f.anchor.left - DROP) return 'drop';
    // The moment it showed has come with something left: the board would read it as past already.
    if (f.shownZero !== null && at >= f.shownZero && left > 0) return 'refuted';
    // The first sample after the anchor came an hour or more later (a laptop asleep, the app started in the morning).
    if (f.anchor) {
      const [anchor, next] = this.store.sampleAndNext(source, window.id, f.anchor.at);
      if (anchor && next && next.at - anchor.at > Math.max(HOUR, anchor.staleAfterMs)) return 'gap';
    }
    return null;
  }

  private work(key: string, source: string, window: Win, asOf: number, memoryIn: Memory | null, successAt: number, reads: Reads, why: Why): Entry {
    this.observe?.({source, window: window.id, asOf, why});
    const before = this.series.get(key);
    let entry: Entry;
    try {
      const {forecast, memory} = forecastOf({samples: reads.samples(window.id, asOf), plan: reads.weekly(window, asOf), since: planSince(reads.plans(), asOf)}, asOf, memoryIn);
      entry = {asOf, seen: successAt, memoryIn, memoryOut: memory, forecast: told(forecast), failed: false};
      this.unsaved.set(key, {asOf, memoryIn, memoryOut: memory});
    } catch (error) {
      // One series failing fails no other, nor the board; it is tried again on the next hour.
      if (!(before?.failed && before.asOf === asOf)) trouble(error);
      entry = {asOf, seen: successAt, memoryIn, memoryOut: memoryIn, forecast: failed(asOf), failed: true};
    }
    this.series.set(key, entry);
    return entry;
  }

  /** What a series kept in the database; nothing when it cannot be read. */
  private read(key: string): Kept | null {
    try {
      const value = this.store.kept(key);
      if (value === null) return null;
      const kept = JSON.parse(value) as Kept;
      return Number.isFinite(kept.asOf) ? kept : null;
    } catch {
      return null;
    }
  }
}

/**
 * What the series of one source read, once for all of them: a model's window reads its
 * subscription's weekly window as well, which is itself a series, most often worked out
 * at the same moment. Reading weeks of samples is most of the cost of a forecast.
 */
class Reads {
  private planRows: PlanChange[] | null = null;
  private readonly read = new Map<string, SeriesSample[]>();

  constructor(
    private readonly store: Store,
    private readonly source: string,
    private readonly state: SourceState,
  ) {}

  /** The source's plan changes up to its last measurement. */
  plans(): PlanChange[] {
    return (this.planRows ??= this.store.planChanges(this.source, this.state.successAt!));
  }

  /** What a forecast of a window at `asOf` reads of it. */
  samples(window: string, asOf: number): SeriesSample[] {
    const key = `${window}\n${asOf}`;
    let samples = this.read.get(key);
    if (!samples) this.read.set(key, (samples = this.store.seriesSamples(this.source, window, asOf - READ_MS, asOf)));
    return samples;
  }

  /** For a model's window, the samples of its subscription's weekly window over the same time; null for any other. */
  weekly(window: Win, asOf: number): SeriesSample[] | null {
    const weekly = subscriptionWeekly(this.state.windows);
    return weekly && weekly.id !== window.id ? this.samples(weekly.id, asOf) : null;
  }
}
