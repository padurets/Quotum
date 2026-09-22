import {useEffect, useState} from 'react';
import type {History, Overview} from './types';

async function getJson<T>(url: string, timeoutMs = 12000): Promise<T> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {signal: controller.signal, cache: 'no-store'});
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as T;
  } finally {
    clearTimeout(deadline);
  }
}

/** A ticking clock for countdowns and freshness labels. */
export function useNow(stepMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(timer);
  }, [stepMs]);
  return now;
}

/**
 * Values change once per collection, so a calm 10 s poll is enough. A single failed
 * request is normal through the proxy and is never shown: data stays on screen and
 * only the age of the last good answer decides whether we look disconnected.
 */
export function useOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [lastOk, setLastOk] = useState(0);

  useEffect(() => {
    let done = false;
    let busy = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (busy) return;
      clearTimeout(timer);
      busy = true;
      try {
        const overview = await getJson<Overview>('/api/overview');
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
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    void poll();
    return () => {
      done = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, []);

  return {data, lastOk};
}

/** History is re-read when the range changes or a collection cycle completes. */
export function useHistory(range: string, cycleKey: string) {
  const [history, setHistory] = useState<History | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    getJson<History>(`/api/history?range=${range}`)
      .then(data => {
        if (!cancelled) setHistory(data);
      })
      .catch(() => {
        if (!cancelled) timer = setTimeout(() => setRetry(n => n + 1), 15000);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [range, cycleKey, retry]);

  return history?.range === range ? history : null;
}
