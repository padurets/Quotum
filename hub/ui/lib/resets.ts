import {useEffect, useState} from 'react';
import {call} from './http';

/**
 * Reset announcements as collected by the service from the community trackers
 * (server/domain/resets.ts). The browser only talks to this service.
 */
export type ResetEvent = {url: string; text: string; at: number};

export type ResetStatus = {
  scheduled: (ResetEvent & {scheduledFor: number | null; kind: 'regular' | 'banked' | null}) | null;
  watch: (ResetEvent & {expiresAt: number | null; chance: number | null; window: string}) | null;
  latest: (ResetEvent & {scope: string}) | null;
  policy: ResetEvent | null;
  credit: {name: string; url: string};
};

export type Resets = Partial<Record<'claude' | 'codex', ResetStatus>>;
/** Resets for everyone the trackers reported over the last month, by provider, oldest first. */
export type PastResets = Partial<Record<'claude' | 'codex', ResetEvent[]>>;
export type TrackerHealth = {name: string; url: string; ok: boolean | null; detail: string; at: number | null};

const POLL_MS = 60_000;

type Answer = {resets: Resets; trackers: TrackerHealth[]; past: PastResets};

/** Reads `/api/resets` every minute while announcements are enabled in this browser. */
export function useResets(enabled: boolean): {resets: Resets; past: PastResets; health: TrackerHealth[]} {
  const [state, setState] = useState<Answer>({resets: {}, trackers: [], past: {}});
  useEffect(() => {
    if (!enabled) return;
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const answer = await call<Answer>('GET', '/api/resets', undefined, 10_000);
        if (!done) setState(answer);
      } catch {
        /* keep the last answer */
      }
      if (!done) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [enabled]);
  return enabled ? {resets: state.resets, past: state.past, health: state.trackers} : {resets: {}, past: {}, health: []};
}
