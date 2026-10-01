import {useSyncExternalStore} from 'react';
import {hubNow} from './clock';
import {KEPT_MS} from './periods';
import {onTimeRange, setTimeRange, type TimeRange} from './timeRange';
import {onPrefs, prefs} from './prefs';
import {SWIPE, swiped, WHEEL_END_MS, type Swipe} from './swipe';

export type PanFrame = TimeRange & {
  token: number;
  origin: TimeRange | null;
  originEnd: number;
  length: number;
  direction: -1 | 0 | 1;
  source: symbol;
  input: 'wheel' | 'pointer';
  lookAhead: number;
};
export type PanStart = {
  source: symbol;
  input: 'wheel' | 'pointer';
  selected: TimeRange | null;
  length: number;
  now: number;
  historyStart: number;
  /** Includes this chart's future and its actual CSS plot width. */
  span: number;
  width: number;
};
export type PanEnv = {
  now(): number;
  commit(range: TimeRange | null): void;
  requestFrame(run: () => void): unknown;
  cancelFrame(frame: unknown): void;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

/** One reversible time transaction, shared by the charts without rendering the board. */
export class Pan {
  private serial = 0;
  private draft: PanFrame | null = null;
  private state: PanFrame | null = null;
  private scale = 1;
  private minEnd = 0;
  private maxEnd = 0;
  private raf: unknown = null;
  private timer: unknown = null;
  private swipe: Swipe = SWIPE;
  private readonly listeners = new Set<() => void>();
  private readonly phaseListeners = new Set<() => void>();
  private readonly charts = new Map<symbol, () => {end: number; future: number}>();

  constructor(private readonly env: PanEnv) {}
  get = () => this.state;
  active = () => this.draft?.token ?? null;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => void this.listeners.delete(listener);};
  onPhase = (listener: () => void) => {this.phaseListeners.add(listener); return () => void this.phaseListeners.delete(listener);};
  get input() {return this.draft?.input ?? null;}
  get source() {return this.draft?.source ?? null;}
  register(source: symbol, geometry: () => {end: number; future: number}) {
    this.charts.set(source, geometry);
    return () => {if (this.source === source) this.cancel(); this.charts.delete(source);};
  }

  begin(start: PanStart): number | null {
    if (this.draft || start.width <= 0 || start.span <= 0) return null;
    const geometries = [...this.charts.values()].map(read => read());
    const now = Math.max(start.now, ...geometries.map(g => g.end));
    const end = start.selected?.to ?? now;
    this.scale = start.span / start.width;
    this.maxEnd = now;
    const oldest = Math.ceil(Math.max(start.historyStart, start.now - KEPT_MS + 3_600_000) / 60_000) * 60_000;
    // Short history still allows the live frame; it does not invent a past full frame.
    this.minEnd = Math.min(end, oldest + start.length);
    this.draft = {token: ++this.serial, source: start.source, input: start.input, origin: start.selected, originEnd: end, length: start.length, from: end - start.length, to: end, direction: 0, lookAhead: Math.max(0, ...geometries.map(g => g.future))};
    this.state = this.draft;
    this.notify();
    this.phase();
    return this.draft.token;
  }

  move(token: number, pixels: number) {
    const before = this.draft;
    if (!before || before.token !== token || !Number.isFinite(pixels)) return;
    const to = Math.max(this.minEnd, Math.min(this.maxEnd, before.to + pixels * this.scale));
    if (to === before.to) return;
    this.draft = {...before, from: to - before.length, to, direction: to > before.to ? 1 : -1};
    if (this.raf === null) this.raf = this.env.requestFrame(() => {
      if (this.draft?.token !== token) return;
      this.raf = null;
      this.state = this.draft;
      this.notify();
    });
  }

  wheel(start: Omit<PanStart, 'input'> | (() => Omit<PanStart, 'input'>), event: Parameters<typeof swiped>[1]): boolean {
    if (this.input === 'pointer') return false;
    const result = swiped(this.swipe, event);
    if (result.ended && this.draft) this.finish(this.draft.token);
    this.swipe = result.state;
    if (!result.own) return false;
    const token = this.draft?.token ?? this.begin({...typeof start === 'function' ? start() : start, input: 'wheel'});
    if (token === null) return false;
    this.move(token, result.delta);
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.timer = this.env.setTimeout(() => this.finish(token), WHEEL_END_MS);
    return true;
  }

  finish(token: number): TimeRange | 'live' | undefined {
    const draft = this.draft;
    if (!draft || draft.token !== token) return;
    // Compare before consulting a fresh clock: holding a still live drag is a no-op.
    const moved = Math.round(draft.to) !== Math.round(draft.originEnd);
    const now = Math.round(this.env.now());
    const end = Math.min(Math.round(draft.to), now);
    const result = !moved ? undefined : now - end <= 8 * this.scale ? 'live' : {from: end - draft.length, to: end};
    this.clear();
    if (result !== undefined && !sameRange(draft.origin, result === 'live' ? null : result)) this.env.commit(result === 'live' ? null : result);
    this.notify();
    this.phase();
    return result;
  }

  cancel(token = this.draft?.token) {
    if (!this.draft || token !== this.draft.token) return;
    this.clear();
    this.notify();
    this.phase();
  }

  private clear() {
    if (this.raf !== null) this.env.cancelFrame(this.raf);
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.raf = this.timer = null;
    this.draft = this.state = null;
    this.swipe = SWIPE;
  }
  private notify() {for (const listener of this.listeners) listener();}
  private phase() {for (const listener of this.phaseListeners) listener();}
}

const sameRange = (a: TimeRange | null, b: TimeRange | null) => a === b || !!a && !!b && a.from === b.from && a.to === b.to;
export const pan = new Pan({
  now: hubNow,
  commit: setTimeRange,
  requestFrame: run => requestAnimationFrame(run),
  cancelFrame: frame => cancelAnimationFrame(frame as number),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
/** Plot hooks hear the phase only; the small period label may read each drawn frame. */
export const usePanning = () => useSyncExternalStore(pan.onPhase, pan.active, pan.active);
export const usePanFrame = () => useSyncExternalStore(pan.subscribe, pan.get, pan.get);

if (typeof window !== 'undefined') {
  const cancel = () => pan.cancel();
  addEventListener('blur', cancel);
  addEventListener('popstate', cancel);
  addEventListener('keydown', event => {if (event.key === 'Escape') cancel();});
  document.addEventListener('visibilitychange', () => {if (document.hidden) cancel();});
  onTimeRange(cancel);
  let context = prefs();
  onPrefs(() => {
    const next = prefs();
    if (['range', 'kind', 'horizon', 'showPlan', 'showForecast', 'activityBy'].some(key => next[key as keyof typeof next] !== context[key as keyof typeof context])) cancel();
    context = next;
  });
}
