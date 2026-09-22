import {useEffect, useState} from 'react';

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
  /** Set only for the `?preview=reset` sample. */
  preview?: boolean;
};

export type Resets = Partial<Record<'claude' | 'codex', ResetStatus>>;
export type TrackerHealth = {name: string; url: string; ok: boolean | null; detail: string; at: number | null};

const POLL_MS = 60_000;

/**
 * `?preview=reset` shows what an announced Codex reset looks like (card and chart)
 * without a real announcement. Nothing else changes and it is clearly marked.
 */
const PREVIEW = typeof location !== 'undefined' && new URLSearchParams(location.search).get('preview') === 'reset';

function withPreview(resets: Resets): Resets {
  if (!PREVIEW) return resets;
  const now = Date.now();
  return {
    ...resets,
    codex: {
      scheduled: {
        url: 'https://codex-resets.com/',
        text: 'Пример объявления: так будет выглядеть анонс внепланового сброса.',
        at: now - 3 * 3_600_000,
        scheduledFor: Math.ceil((now + 15 * 3_600_000) / 1_800_000) * 1_800_000,
        kind: 'regular',
      },
      watch: null,
      latest: resets.codex?.latest ?? null,
      policy: null,
      credit: {name: 'Codex Resets', url: 'https://codex-resets.com/'},
      preview: true,
    },
  };
}

/** Reads `/api/resets` every minute while announcements are enabled in this browser. */
export function useResets(enabled: boolean): {resets: Resets; health: TrackerHealth[]} {
  const [state, setState] = useState<{resets: Resets; trackers: TrackerHealth[]}>({resets: {}, trackers: []});
  useEffect(() => {
    if (!enabled) return;
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch('/api/resets', {cache: 'no-store', signal: AbortSignal.timeout(10_000)});
        if (response.ok && !done) setState(await response.json());
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
  return enabled ? {resets: withPreview(state.resets), health: state.trackers} : {resets: {}, health: []};
}
