import {useEffect, useRef, useState} from 'react';
import type {History, Overview} from './types';
import {call} from './http';

/** A clock ticking every second, for freshness labels and countdowns. */
export function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The board's current state, read every 10 seconds (sooner when the tab comes back).
 * A single failed request is never shown: data stays on screen and only the age of the
 * last good answer decides whether the page looks disconnected.
 */
export function useOverview(board: string) {
  const [data, setData] = useState<Overview | null>(null);
  const [lastOk, setLastOk] = useState(0);
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
          setData(overview);
          setLastOk(Date.now());
        }
        failures = 0;
      } catch {
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

  return {data: data?.board?.id === board ? data : null, lastOk, reload: () => reload.current()};
}

/**
 * History of a board, read again when the range changes or the board's data does
 * (`revision`). While another range loads, the one on screen stays (`loading`), so the
 * page keeps its height and does not jump.
 */
export function useHistory(board: string, range: string, revision: number | null): {history: History | null; loading: boolean} {
  const [history, setHistory] = useState<History | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (revision === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    call<History>('GET', `/api/history?board=${encodeURIComponent(board)}&range=${range}`)
      .then(data => {
        if (!cancelled) setHistory({...data, board});
      })
      .catch(() => {
        if (!cancelled) timer = setTimeout(() => setRetry(n => n + 1), 15000);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [board, range, revision, retry]);

  const shown = history?.board === board ? history : null;
  return {history: shown, loading: !!shown && shown.range !== range};
}
