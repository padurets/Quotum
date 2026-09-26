import {useEffect, useState} from 'react';
import {call, unlessSame} from './http';
import type {Expiring, FreeResets} from './types';

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
/** Resets for everyone the trackers reported over the history the hub keeps, by provider, oldest first. */
export type PastResets = Partial<Record<'claude' | 'codex', ResetEvent[]>>;
export type TrackerHealth = {name: string; url: string; ok: boolean | null; detail: string; at: number | null};

/** A reset is news on a card for a day, a change of limits for three; the chart keeps marking them. */
const RECENT_RESET_MS = 24 * 3_600_000;
const RECENT_POLICY_MS = 72 * 3_600_000;

/**
 * What a card says about resets for everyone, the most pressing first: a mark in its tray.
 * An announced reset is in the accent colour (`in`, `bankedIn`, `announced` without a
 * time, `awaiting` once its time has passed); a possible one (`possible`, with a chance
 * when one is given), a reset that just happened (`done`, with its scope unless it was for
 * everyone) and a recent change of limits (`policy`) are quiet. `link` is the tracker's
 * own post, or null when it is the tracker's page the credit links to anyway.
 */
export type ResetLabel = {event: ResetEvent; link: string | null} & (
  | {key: 'in' | 'bankedIn' | 'awaiting'; tone: 'accent'; at: number}
  | {key: 'announced'; tone: 'accent'; at: null}
  | {key: 'possible'; tone: 'quiet'; at: number | null; chance: number | null}
  | {key: 'done'; tone: 'quiet'; scope: string}
  | {key: 'policy'; tone: 'quiet'}
);

export function resetLabel(status: ResetStatus | undefined, now: number): ResetLabel | null {
  if (!status) return null;
  const {scheduled, latest, policy, credit} = status;
  // A watch that has run out is no news, as the service drops it when it reads the tracker.
  const watch = status.watch && (status.watch.expiresAt === null || status.watch.expiresAt > now) ? status.watch : null;
  const of = (event: ResetEvent) => ({event, link: event.url !== credit.url ? event.url : null});
  if (scheduled) {
    const at = scheduled.scheduledFor;
    if (at === null) return {...of(scheduled), key: 'announced', tone: 'accent', at};
    return {...of(scheduled), key: at > now ? (scheduled.kind === 'banked' ? 'bankedIn' : 'in') : 'awaiting', tone: 'accent', at};
  }
  if (watch) return {...of(watch), key: 'possible', tone: 'quiet', at: watch.expiresAt, chance: watch.chance};
  if (latest && now - latest.at < RECENT_RESET_MS) return {...of(latest), key: 'done', tone: 'quiet', scope: latest.scope !== 'all' ? latest.scope : ''};
  if (policy && now - policy.at < RECENT_POLICY_MS) return {...of(policy), key: 'policy', tone: 'quiet'};
  return null;
}

/**
 * When a card's free resets expire: how many when, soonest first, and those the client
 * gives no time for (or that no group tells of) in one group last.
 */
export function freeResetExpiry(resets: FreeResets): Expiring[] {
  const groups = resets.expiring ?? [];
  const rest = resets.available - groups.reduce((sum, group) => sum + group.count, 0);
  if (rest <= 0) return groups;
  const last = groups.at(-1);
  return last?.expiresAt === null ? [...groups.slice(0, -1), {count: last.count + rest, expiresAt: null}] : [...groups, {count: rest, expiresAt: null}];
}

const POLL_MS = 60_000;

/** Announcements turned off: always these, so what is given them is not rendered again. */
const NONE = {resets: {}, past: {}, health: []};

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
        if (!done) setState(unlessSame(answer));
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
  return enabled ? {resets: state.resets, past: state.past, health: state.trackers} : NONE;
}
