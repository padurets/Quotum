import {t} from '../i18n';
import type {Horizon} from './prefs';
import type {TimeRange} from './timeRange';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A period of the analytics, ending now: how long it is, and how much future the chart keeps on its right when its horizon is `auto`. */
export type Period = {id: string; ms: number; future: number};

/**
 * The periods the analytics offer, shortest first, named as the hub names them
 * (config.history.ranges); a test keeps the two lists the same.
 */
export const PERIODS: Period[] = [
  {id: '1h', ms: HOUR, future: 10 * MINUTE},
  {id: '3h', ms: 3 * HOUR, future: 30 * MINUTE},
  {id: '6h', ms: 6 * HOUR, future: HOUR},
  {id: '12h', ms: 12 * HOUR, future: 2 * HOUR},
  {id: '24h', ms: DAY, future: 4 * HOUR},
  {id: '3d', ms: 3 * DAY, future: 12 * HOUR},
  {id: '7d', ms: 7 * DAY, future: DAY},
  {id: '14d', ms: 14 * DAY, future: 2 * DAY},
  {id: '30d', ms: 30 * DAY, future: 3 * DAY},
];

export const DEFAULT_PERIOD = '24h';

/** A period by its name; one this page does not know (kept by an older version, say) is the default. */
export const periodOf = (id: string): Period => PERIODS.find(period => period.id === id) ?? PERIODS.find(period => period.id === DEFAULT_PERIOD)!;

/** "6h", "24h", "3 days". */
export const periodLabel = ({ms}: Period) => (ms < 2 * DAY ? t('history.hours', {count: ms / HOUR}) : t('history.days', {count: ms / DAY}));

/**
 * What the chart and the table look at: the chosen period, ending now (`live`), or a time
 * range in the past, dragged across the chart or moved to. `from` starts no earlier than
 * the history does; `length` is the period's own, as asked for. `future` is how much of it
 * the chart may keep on its right: none for a range.
 */
export type Frame = {from: number; to: number; length: number; future: number; live: boolean};

/** How far the chart looks ahead for a horizon chosen by hand (prefs.ts); never further than the period is long. */
const HORIZON: Record<Exclude<Horizon, 'auto'>, number> = {'1d': DAY, '3d': 3 * DAY, '7d': 7 * DAY};

/**
 * The frame of the analytics now: the time range in the address, else the chosen period.
 * It follows what is asked for at once, not the answer on screen, so the chart moves with
 * every step while the next answer loads.
 */
export function frameOf(selected: TimeRange | null, prefs: {range: string; horizon: Horizon}, now: number, historyStart: number): Frame {
  if (selected) return {from: Math.max(selected.from, historyStart), to: Math.min(selected.to, now), length: selected.to - selected.from, future: 0, live: false};
  const period = periodOf(prefs.range);
  const future = prefs.horizon === 'auto' ? period.future : Math.min(HORIZON[prefs.horizon], period.ms);
  return {from: Math.max(now - period.ms, historyStart), to: now, length: period.ms, future, live: true};
}

/** How long the hub keeps samples (config.retention.sampleDays; a test keeps them the same); a range starts an hour inside it, so it is still read a while later. */
export const KEPT_MS = 90 * DAY;

const floorMinute = (at: number) => Math.floor(at / MINUTE) * MINUTE;
const ceilMinute = (at: number) => Math.ceil(at / MINUTE) * MINUTE;

/**
 * Where ‹ (-1) or › (1) takes the analytics: half the period back or forward, on whole
 * minutes, keeping its length. Back stops where the history starts (or the hub stops
 * keeping it); forward, once within half a step of now, it is the chosen period again
 * (`live`). Null when there is nowhere to go: back from the start of history, forward from
 * a period that ends now.
 */
export function step(selected: TimeRange | null, range: string, direction: -1 | 1, now: number, historyStart: number): TimeRange | 'live' | null {
  const length = Math.max(MINUTE, Math.round((selected ? selected.to - selected.from : periodOf(range).ms) / MINUTE) * MINUTE);
  const from = selected ? floorMinute(selected.from) : floorMinute(now - length);
  const by = Math.max(MINUTE, floorMinute(length / 2));
  if (direction > 0) {
    if (!selected) return null;
    return from + length + by >= now - by / 2 ? 'live' : {from: from + by, to: from + by + length};
  }
  const limit = ceilMinute(Math.max(historyStart, now - KEPT_MS + HOUR));
  if (from <= limit) return null;
  const start = Math.max(floorMinute(from - by), limit);
  return {from: start, to: start + length};
}
