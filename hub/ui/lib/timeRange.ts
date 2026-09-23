import {useSyncExternalStore} from 'react';
import {clock, shortDay} from './format';

/** A period selected on the chart, in milliseconds. */
export type TimeRange = {from: number; to: number};

/** The shortest period the hub reads (config.history.minSpanMs). */
export const MIN_TIME_RANGE = 15 * 60_000;
const DAY = 86_400_000;

/**
 * The selection lives in the address (`?from=…&to=…`): a reload keeps it, and a link to
 * a burst of work can be shared with the others on the board. Back undoes a selection.
 */
function read(): TimeRange | null {
  const params = new URLSearchParams(location.search);
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from > 0 && to - from >= MIN_TIME_RANGE ? {from, to} : null;
}

// Tests import the helpers below without a page.
const page = typeof location !== 'undefined';
let current = page ? read() : null;
let search = page ? location.search : '';
const listeners = new Set<() => void>();

function changed() {
  if (location.search === search) return;
  search = location.search;
  current = read();
  for (const listener of listeners) listener();
}

export function setTimeRange(selected: TimeRange | null) {
  const params = new URLSearchParams(location.search);
  if (selected) {
    params.set('from', String(selected.from));
    params.set('to', String(selected.to));
  } else {
    params.delete('from');
    params.delete('to');
  }
  const query = params.toString();
  history.pushState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  changed();
}

export function useTimeRange(): TimeRange | null {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      if (listeners.size === 1) window.addEventListener('popstate', changed);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) window.removeEventListener('popstate', changed);
      };
    },
    () => current,
    () => current,
  );
}

/** How the hub names the history of a selected time range (its `range`). */
export const timeRangeKey = (selected: TimeRange) => `${selected.from}-${selected.to}`;

/** "23 Sept, 12:40–15:10"; across days "22 Sept 22:10 – 23 Sept 01:30"; days alone from three days on. */
export function timeRangeLabel({from, to}: TimeRange) {
  if (to - from >= 3 * DAY) return `${shortDay(from)} – ${shortDay(to)}`;
  if (new Date(from).toDateString() === new Date(to).toDateString()) return `${shortDay(from)}, ${clock(from)}–${clock(to)}`;
  return `${shortDay(from)} ${clock(from)} – ${shortDay(to)} ${clock(to)}`;
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
