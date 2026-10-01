import {t} from '../i18n';
import {clock, day, stamp} from './format';
import type {Horizon} from './prefs';
import {timeRangeKey, type TimeRange} from './timeRange';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A period of the analytics, ending now: how long it is, and how much future the chart keeps on its right when its horizon is `auto`. */
export type Period = {id: string; ms: number; future: number};

/**
 * The periods the analytics offer, shortest first; history cells use their length.
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
 * What the analytics look at: the chosen period, ending now (`live`), or a time range in
 * the past, dragged across a chart or moved to. `from` starts no earlier than
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

/**
 * Where measurements end on a chart of the frame: at the page's clock, or at the hub's
 * when that is ahead and `history` answers this very period (`range` chosen, or the time
 * range `selected`): a browser a few minutes behind still draws the latest ones, up to the
 * end of a range dragged to the edge of a period ending now.
 */
export function measuredTo(frame: Frame, history: {range: string; to: number} | null, selected: TimeRange | null, range: string): number {
  const answered = history && history.range === (selected ? timeRangeKey(selected) : range) ? history : null;
  return answered ? Math.max(frame.to, selected ? Math.min(answered.to, selected.to) : answered.to) : frame.to;
}

/** The times along a chart's axis from `from` to `to`, about `count` of them on round local times, and whether they fall on days. */
export function niceTicks(from: number, to: number, count: number) {
  const span = to - from;
  const steps = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map(minutes => minutes * 60_000);
  const step = steps.find(candidate => span / candidate <= count) ?? steps.at(-1)!;
  const offset = new Date().getTimezoneOffset() * 60_000;
  const ticks: number[] = [];
  for (let t = Math.ceil((from - offset) / step) * step + offset; t <= to; t += step) ticks.push(t);
  return {ticks, daily: step >= 86_400_000};
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * A cell's times under its day. Cells are laid on UTC, so one may cross midnight here, and
 * then each end names its day; a time within a cell, shorter than a day, then reads as one
 * moment, save for the hour the clocks go back.
 */
export function cellLabel(at: number, cellMs: number) {
  if (!cellMs) return stamp(at);
  const end = at + cellMs;
  return sameDay(at, end - 1) ? `${day(at)} ${clock(at)}–${clock(end)}` : `${stamp(at)} – ${stamp(end)}`;
}

/**
 * When the frame moves on (`frameOf`): at the next cell of the history's grid while it
 * ends now, or reaches past now. A minute more of a day is less than a pixel of the chart;
 * a range wholly in the past never moves.
 */
export const frameChangesAt = (selected: TimeRange | null, cellMs: number, now: number) =>
  selected && selected.to <= now ? null : Math.floor(now / cellMs) * cellMs + cellMs;

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

/**
 * When ‹ turns on or off by itself (`step` back): a period ending now once the history is
 * longer than it, a range once it falls out of what the hub keeps. Either happens once, so
 * the first moment it does is found by halving.
 */
export function stepChangesAt(selected: TimeRange | null, range: string, now: number, historyStart: number): number | null {
  const can = (at: number) => step(selected, range, -1, at, historyStart) !== null;
  const seen = can(now);
  let [same, other] = [now, now + KEPT_MS];
  if (can(other) === seen) return null;
  while (other - same > 1) {
    const middle = Math.floor((same + other) / 2);
    if (can(middle) === seen) same = middle;
    else other = middle;
  }
  return other;
}
