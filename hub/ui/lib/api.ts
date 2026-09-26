import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import type {History, Overview} from './types';
import {ApiError, call, unlessSame} from './http';
import {dropTimeRange, timeRangeKey, type TimeRange} from './timeRange';

/**
 * The page's clock, for what shows how long ago or how soon: nothing else changes with
 * time alone. Every part that reads it asks for a step and moves when the step passes,
 * all at once, on one timer per step for the whole page; the board itself reads no
 * clock, so a tick renders only what shows time. Labels count minutes and the freshness
 * dot changes every half a minute, so no step is finer than `TICK`.
 */
export const TICK = 15_000;
export const MINUTE = 60_000;

type Clock = {now: number; listeners: Set<() => void>; timer?: ReturnType<typeof setTimeout>};
const clocks = new Map<number, Clock>();

function clock(step: number): Clock {
  let found = clocks.get(step);
  if (!found) clocks.set(step, (found = {now: Date.now(), listeners: new Set()}));
  return found;
}

function subscribe(step: number, listener: () => void) {
  const c = clock(step);
  if (!c.listeners.size) {
    // Ticks fall on multiples of the step, so clocks of different steps agree when they meet.
    const tick = () => {
      c.now = Date.now();
      c.listeners.forEach(notify => notify());
      c.timer = setTimeout(tick, step - (Date.now() % step));
    };
    c.now = Date.now();
    c.timer = setTimeout(tick, step - (c.now % step));
  }
  c.listeners.add(listener);
  return () => {
    c.listeners.delete(listener);
    if (!c.listeners.size) clearTimeout(c.timer);
  };
}

export function useNow(step = TICK) {
  const listen = useCallback((listener: () => void) => subscribe(step, listener), [step]);
  return useSyncExternalStore(listen, () => clock(step).now);
}

/**
 * The board's current state, read every 10 seconds (sooner when the tab comes back).
 * An answer the same as the one before changes nothing. A single failed request is never shown: data stays on screen and only the age
 * of the last good answer decides whether the page looks disconnected. That age is read
 * by `lastOk()` when the clock ticks, not kept in state: a good answer alone renders
 * nothing.
 */
export function useOverview(board: string, onGone: () => void) {
  const gone = useRef(onGone);
  gone.current = onGone;
  const [data, setData] = useState<Overview | null>(null);
  const okAt = useRef(0);
  const lastOk = useCallback(() => okAt.current, []);
  const reload = useRef(() => {});

  useEffect(() => {
    setData(null);
    let done = false;
    let busy = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (busy) return;
      clearTimeout(timer);
      busy = true;
      try {
        const overview = await call<Overview>('GET', `/api/overview?board=${encodeURIComponent(board)}`);
        if (!done) {
          setData(unlessSame<Overview | null>(overview));
          okAt.current = Date.now();
        }
        failures = 0;
      } catch (error) {
        // Not a lost connection: the board is gone, or the reader is no longer on it.
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
          busy = false;
          if (!done) gone.current();
          return;
        }
        failures++;
      }
      busy = false;
      if (!done) timer = setTimeout(poll, failures ? Math.min(30000, 5000 * failures) : 10000);
    };

    const wake = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    reload.current = () => void poll();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    void poll();
    return () => {
      done = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [board]);

  const again = useCallback(() => reload.current(), []);
  return {data: data?.board?.id === board ? data : null, lastOk, reload: again};
}

/** Changes of the period this close together are a run of steps: only the last is asked for, once they stop. */
const SETTLE_MS = 300;
/** How many answers of past ranges the page keeps per board, so stepping back and forth over them asks the hub nothing. */
const KEPT_RANGES = 8;

/**
 * Whether an answer is all there is of a range: nothing newer is on its way
 * (`refreshInMs`), and its end was not cut to the hub's now, so later data cannot change it.
 */
export const complete = (history: History, selected: TimeRange) => history.refreshInMs === null && history.to === Math.ceil(selected.to / history.cellMs) * history.cellMs;

/**
 * History of a board over a period ending now ('24h', …) or a time range in the past,
 * read again when that changes or, for a period, when the board's data does (`revision`);
 * a range is in the past and stays as read. While another one loads, the one on screen
 * stays (`loading`), so the page keeps its height and does not jump. A run of quick
 * changes (steps back through time) asks only for where it stops, and the latest few
 * ranges read whole are kept on the page, for the board's sources as they are
 * (`sources`): one added to the board has its lines in the range read again.
 */
export function useHistory(board: string, period: string | TimeRange, revision: number | null, sources: string): {history: History | null; loading: boolean} {
  const [history, setHistory] = useState<History | null>(null);
  const [retry, setRetry] = useState(0);
  const kept = useRef(new Map<string, History>());
  const changed = useRef({key: '', at: 0});
  const selected = typeof period === 'string' ? null : period;
  const key = selected ? timeRangeKey(selected) : (period as string);
  const query = selected ? `from=${selected.from}&to=${selected.to}` : `range=${key}`;
  const version = selected && revision !== null ? 0 : revision;
  const store = `${board} ${sources} ${key}`;
  const cached = selected ? kept.current.get(store) : undefined;

  useEffect(() => {
    if (version === null) return;
    const slot = `${board} ${key}`;
    const now = Date.now();
    const quick = changed.current.key !== slot && now - changed.current.at < SETTLE_MS;
    if (changed.current.key !== slot) changed.current = {key: slot, at: now};
    if (cached) return setHistory(cached);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const keep = (data: History) => {
      if (!selected || !complete(data, selected)) return;
      // Map order is insertion order: the one read last goes to the end, the board's oldest is dropped.
      kept.current.delete(store);
      kept.current.set(store, data);
      const ofBoard = [...kept.current.keys()].filter(stored => stored.startsWith(`${board} `));
      if (ofBoard.length > KEPT_RANGES) kept.current.delete(ofBoard[0]);
    };
    const read = () => {
      // An answer stepped past on the way may have come meanwhile: it is not asked for again.
      const came = kept.current.get(store);
      if (came) return setHistory(came);
      return call<History>('GET', `/api/history?board=${encodeURIComponent(board)}&${query}`)
        .then(answer => {
          const data = {...answer, board};
          // One stepped past on the way is kept all the same: it may be stepped back to.
          keep(data);
          if (cancelled) return;
          setHistory(data);
          // A costly history is put together again a while after new data came: asked for then.
          if (data.refreshInMs !== null) timer = setTimeout(() => setRetry(n => n + 1), data.refreshInMs + 1_000);
        })
        .catch(error => {
          if (cancelled) return;
          // A selected range the hub will not read (say, a link older than the history it keeps)
          // cannot succeed later: the chosen period comes back instead.
          if (selected && error instanceof ApiError && error.status === 400) return dropTimeRange();
          timer = setTimeout(() => setRetry(n => n + 1), 15000);
        });
    };
    if (quick) timer = setTimeout(read, SETTLE_MS);
    else void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [board, query, version, retry, cached, store]);

  const shown = cached ?? (history?.board === board ? history : null);
  return {history: shown, loading: !!shown && shown.range !== key};
}
