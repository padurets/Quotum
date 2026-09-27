import {useSyncExternalStore} from 'react';
import {clock, day, stamp} from './format';

/** A period selected on the chart, in milliseconds. */
export type TimeRange = {from: number; to: number};

/** The shortest and longest periods the hub reads (config.history.minSpanMs, maxSpanMs). */
export const MIN_TIME_RANGE = 15 * 60_000;
const MAX_TIME_RANGE = 31 * 86_400_000;
const DAY = 86_400_000;

/**
 * Whether history on screen is of a selected range (the hub names it `<from>-<to>`), not a
 * period ending now: what the chart and the table show follows the data they have, so the
 * headings of a range never stand over a period's numbers while the next answer loads.
 */
export const ofTimeRange = (history: {range: string} | null) => !!history && history.range.includes('-');

/**
 * The selection lives in the address (`?from=…&to=…`, with the board it was selected on):
 * a reload keeps it, a link to a burst of work can be shared with the others on the
 * board, and Back undoes a selection. Only its form and length are checked here: its end
 * may be past the page's clock, which the hub's may be ahead of. The hub cuts it at its
 * own now, and refuses one too short then; the chosen period comes back (`dropTimeRange`).
 */
export function parseTimeRange(search: string): TimeRange | null {
  const params = new URLSearchParams(search);
  const [from, to] = [params.get('from'), params.get('to')].map(value => (value && /^\d{1,15}$/.test(value) ? Number(value) : NaN));
  return to - from >= MIN_TIME_RANGE && to - from <= MAX_TIME_RANGE ? {from, to} : null;
}

// Tests import the helpers below without a page.
const page = typeof location !== 'undefined';
let current = page ? parseTimeRange(location.search) : null;
let search = page ? location.search : '';
let board = '';
const listeners = new Set<() => void>();

function changed() {
  if (location.search === search) return;
  search = location.search;
  current = parseTimeRange(search);
  for (const listener of listeners) listener();
}

function go(params: URLSearchParams, push: boolean) {
  const query = params.toString();
  const url = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  changed();
}

export function setTimeRange(selected: TimeRange | null) {
  const params = new URLSearchParams(location.search);
  if (selected) {
    params.set('from', String(selected.from));
    params.set('to', String(selected.to));
    if (board) params.set('board', board);
  } else {
    params.delete('from');
    params.delete('to');
  }
  go(params, true);
}

/** Goes where a step through time takes the analytics (periods.ts): a range, or the chosen period again. */
export function goTo(next: TimeRange | 'live' | null) {
  if (next) setTimeRange(next === 'live' ? null : next);
}

/** Forgets a selection the hub will not read (older than it keeps history), without a step back to it. */
export function dropTimeRange() {
  const params = new URLSearchParams(location.search);
  params.delete('from');
  params.delete('to');
  go(params, false);
}

/**
 * The board on screen. A selected range is shared together with it, and an address that
 * names a board follows another one chosen, so a reload does not go back to the first.
 */
export function showBoard(id: string) {
  board = id;
  const params = new URLSearchParams(location.search);
  if (id && params.has('board') && params.get('board') !== id) {
    params.set('board', id);
    go(params, false);
  }
}

/** Back and Forward may bring back the address of another board than the one on screen: it follows the screen. */
function popped() {
  changed();
  if (board) showBoard(board);
}

/** Hears of every change of the selection, as the page's history loader does; the page's components use `useTimeRange`. */
export function onTimeRange(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener('popstate', popped);
    // The address may have changed while nothing was listening.
    changed();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('popstate', popped);
  };
}

/** The selection now: none when the chosen period is shown. */
export const timeRange = () => current;

export function useTimeRange(): TimeRange | null {
  return useSyncExternalStore(onTimeRange, timeRange, timeRange);
}

/** How the hub names the history of a selected time range (its `range`). */
export const timeRangeKey = (selected: TimeRange) => `${selected.from}-${selected.to}`;

/** "23 September 12:40–15:10"; across days "22 September 22:10 – 23 September 01:30"; days alone from three days on. */
export function timeRangeLabel({from, to}: TimeRange) {
  if (to - from >= 3 * DAY) return `${day(from)} – ${day(to)}`;
  if (new Date(from).toDateString() === new Date(to).toDateString()) return `${day(from)} ${clock(from)}–${clock(to)}`;
  return `${stamp(from)} – ${stamp(to)}`;
}

/**
 * The time range between two moments dragged across the chart: only measurements, so
 * the future is cut off; one too short to read grows around its middle; minutes are
 * precise enough. None when it is all in the future.
 */
export function draggedRange(a: number, b: number, now: number): TimeRange | null {
  let start = Math.min(a, b);
  let end = Math.min(now, Math.max(a, b));
  if (start >= now) return null;
  if (end - start < MIN_TIME_RANGE) {
    end = Math.min(now, (start + end) / 2 + MIN_TIME_RANGE / 2);
    start = end - MIN_TIME_RANGE;
  }
  return {from: Math.floor(start / 60_000) * 60_000, to: Math.ceil(end / 60_000) * 60_000};
}
