import {useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react';

/**
 * The page's one clock: the hub's time as the page reckons it, and one timer for the
 * whole page that wakes a part showing time only when what it shows changes. A part says
 * when that is (`changesAt`, from lib/format.ts and its kind); between those moments the
 * clock does nothing, and on a hidden tab it has no timer at all.
 *
 * It is a store of its own rather than an event of the board's: a tick changes no data,
 * and wakes only what shows time.
 */

/** A part of the page that shows time: when it is due again, and how to wake it. */
type Watch = {due: number | null; wakes: number; listener: (() => void) | null};

/** A due moment that is not after now is a mistake: taken as a minute on, so it never spins. */
const MISSED = 60_000;
/** The timer is never set nearer than this, nor further than an hour (it is set again then). */
const NEAREST = 250;
const FURTHEST = 3_600_000;

export type ClockEnv = {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  visible(): boolean;
};

export class PageClock {
  /** How far the hub's clock is ahead of the page's (behind, when negative). */
  private skew = 0;
  private readonly watches = new Set<Watch>();
  private timer: {handle: unknown; at: number} | null = null;

  constructor(private readonly env: ClockEnv) {}

  /** The hub's clock as the page reckons it, now or at the page's `at`. */
  hubNow = (at = this.env.now()) => at + this.skew;

  /**
   * Notes the hub's clock (`now` of a small answer: hello, ping, a poll) as heard at the
   * page's `at`. A change of more than a second wakes everything that shows time.
   */
  heard(now: number, at = this.env.now()) {
    const next = now - at;
    const moved = Math.abs(next - this.skew) > 1000;
    this.skew = next;
    if (moved) this.wake(() => true);
  }

  /** Starts watching a part; it is woken by `listener` when due. */
  watch(): Watch {
    return {due: null, wakes: 0, listener: null};
  }

  subscribe(watch: Watch, listener: () => void) {
    watch.listener = listener;
    this.watches.add(watch);
    this.arm();
    return () => {
      watch.listener = null;
      this.watches.delete(watch);
      this.arm();
    };
  }

  /** What a part shows now changes at `at` (hub time), or never by itself (null). */
  due(watch: Watch, at: number | null, now: number) {
    watch.due = at === null ? null : at > now ? at : now + MISSED;
    this.arm();
  }

  /** Wakes every part whose moment has come, and sets the timer again: after a sleep, a hidden tab shown again. */
  wakeDue() {
    const now = this.hubNow();
    this.wake(watch => watch.due !== null && watch.due <= now);
  }

  private wake(which: (watch: Watch) => boolean) {
    const woken = [...this.watches].filter(which);
    for (const watch of woken) {
      watch.due = null;
      watch.wakes++;
    }
    for (const watch of woken) watch.listener?.();
    this.arm();
  }

  /** One timer, for the nearest moment any part changes; none on a hidden tab. */
  private arm() {
    let nearest = Infinity;
    if (this.env.visible()) for (const watch of this.watches) {
      if (watch.due !== null && watch.due < nearest) nearest = watch.due;
    }
    const now = this.env.now();
    const at = Number.isFinite(nearest) ? now + Math.min(Math.max(nearest - this.hubNow(now), NEAREST), FURTHEST) : null;
    // A commit updates many labels; their unchanged nearest deadline needs no new timer.
    if (this.timer?.at === at) return;
    if (this.timer) this.env.clearTimeout(this.timer.handle);
    this.timer = null;
    if (at === null) return;
    this.timer = {
      at,
      // Late or not (a sleep holds timers up), whatever is due by then is woken.
      handle: this.env.setTimeout(() => {
        this.timer = null;
        this.wakeDue();
      }, at - now),
    };
  }
}

const hasDocument = typeof document !== 'undefined';

export const clock = new PageClock({
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  visible: () => !hasDocument || document.visibilityState === 'visible',
});

if (hasDocument) {
  const wake = () => clock.wakeDue();
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('online', wake);
}

export const hubNow = clock.hubNow;
export const heardHub = (now: number, at?: number) => clock.heard(now, at);
export const wakeDue = () => clock.wakeDue();

/**
 * The hub's time as of this render, for a part that shows time; the part renders again at
 * the moment `changesAt` gives for that time (null: time no longer changes what it shows).
 * Rendered by its data at any other moment, it shows it with the time then. A
 * preparation context keeps that timestamp through its own completion renders.
 */
export function useClock(changesAt: (now: number) => number | null, context?: readonly unknown[]): number {
  const [watch] = useState(() => clock.watch());
  const [subscribe] = useState(() => (listener: () => void) => clock.subscribe(watch, listener));
  const wakes = useSyncExternalStore(subscribe, () => watch.wakes);
  // A preparation completion is a render, not new time or data. Keep its intent
  // clock until this watch wakes or its captured data/UI context changes.
  const snapshot = useRef<{wakes: number; context: readonly unknown[]; now: number} | null>(null);
  if (context && (!snapshot.current || snapshot.current.wakes !== wakes || snapshot.current.context.length !== context.length || context.some((value, i) => !Object.is(value, snapshot.current!.context[i])))) snapshot.current = {wakes, context: [...context], now: hubNow()};
  const now = context ? snapshot.current!.now : hubNow();
  const latest = useRef(changesAt);
  latest.current = changesAt;
  useLayoutEffect(() => clock.due(watch, latest.current(now), now));
  return now;
}
