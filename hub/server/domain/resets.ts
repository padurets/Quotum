/**
 * Out-of-schedule limit resets, normalised from two community trackers (structured
 * JSON only, never scraped pages):
 *
 * - Codex Resets — https://codex-resets.com/api/v1/status: executed, *scheduled* and
 *   possible Codex resets. Free, keyless; credit with a link wherever shown.
 * - Claude Resets — https://claude-resets.com/api/resets: executed Claude resets
 *   and limit-policy changes, plus the Codex catalogue mirrored from Codex Resets.
 *
 * Both are classified catalogues of public posts, not vendor commitments.
 */
export const CODEX_RESETS = {name: 'Codex Resets', url: 'https://codex-resets.com/'};
export const CLAUDE_RESETS = {name: 'Claude Resets', url: 'https://claude-resets.com/'};

export type ResetProvider = 'claude' | 'codex';
export type ResetEvent = {url: string; text: string; at: number};

export type ResetStatus = {
  /** An explicit announcement awaiting execution. A passed date does not mean it happened. */
  scheduled: (ResetEvent & {scheduledFor: number | null; kind: 'regular' | 'banked' | null}) | null;
  /** A classified hint that a reset may come. */
  watch: (ResetEvent & {expiresAt: number | null; chance: number | null; window: string}) | null;
  /** The most recent executed reset. */
  latest: (ResetEvent & {scope: string}) | null;
  /** The most recent change of limits that did not reset counters. */
  policy: ResetEvent | null;
  /** Whom to credit, with a link, wherever this is shown. */
  credit: {name: string; url: string};
};

const TRUSTED_LINK = /^https:\/\/(x\.com|twitter\.com|codex-resets\.com|claude-resets\.com)\//;

const safeUrl = (value: unknown, fallback: string) => (typeof value === 'string' && TRUSTED_LINK.test(value) ? value : fallback);
const clip = (value: unknown) =>
  typeof value === 'string' ? value.replace(/https:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 400) : '';
const time = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Codex Resets `StatusResponse` (v1) → ResetStatus; throws on any other shape. */
export function fromCodexResets(payload: unknown, now: number): ResetStatus {
  const data = (payload as any)?.data;
  if (!data || typeof data !== 'object' || (payload as any)?.meta?.api_version !== 'v1') throw new Error('invalid_reset_status');
  const event = (item: any, stamp: unknown): ResetEvent | null => {
    const at = time(stamp);
    return item && at !== null ? {url: safeUrl(item.source?.url, CODEX_RESETS.url), text: clip(item.text), at} : null;
  };
  const scheduled = event(data.scheduled_reset, data.scheduled_reset?.announced_at);
  const watch = event(data.active_watch, data.active_watch?.observed_at);
  const latest = event(data.latest_reset, data.latest_reset?.announced_at);
  const expiresAt = time(data.active_watch?.expires_at);
  const chance = data.active_watch?.reset_chance_percent;
  const kind = data.scheduled_reset?.reset_type;
  return {
    scheduled: scheduled && {...scheduled, scheduledFor: time(data.scheduled_reset.scheduled_for), kind: kind === 'regular' || kind === 'banked' ? kind : null},
    watch:
      watch && (expiresAt === null || expiresAt > now)
        ? {...watch, expiresAt, chance: Number.isInteger(chance) ? chance : null, window: clip(data.active_watch.forecast_window)}
        : null,
    latest: latest && {...latest, scope: ''},
    policy: null,
    credit: CODEX_RESETS,
  };
}

/** One provider of Claude Resets' catalogue → ResetStatus (executed events only). */
export function fromClaudeResets(payload: unknown, provider: ResetProvider): ResetStatus {
  const events = (payload as any)?.providers?.[provider]?.events;
  if (!Array.isArray(events)) throw new Error('invalid_reset_catalogue');
  const parsed = events
    .map((e: any) => ({kind: e?.kind, at: time(e?.date), url: safeUrl(e?.url, CLAUDE_RESETS.url), text: clip(e?.note), scope: clip(e?.scope)}))
    .filter((e): e is typeof e & {at: number} => e.at !== null && (e.kind === 'reset' || e.kind === 'policy'))
    .sort((a, b) => a.at - b.at);
  const reset = parsed.filter(e => e.kind === 'reset').at(-1);
  const policy = parsed.filter(e => e.kind === 'policy').at(-1);
  return {
    scheduled: null,
    watch: null,
    latest: reset ? {url: reset.url, text: reset.text, at: reset.at, scope: reset.scope} : null,
    policy: policy ? {url: policy.url, text: policy.text, at: policy.at} : null,
    // The Codex part of that catalogue originates from Codex Resets.
    credit: provider === 'codex' ? CODEX_RESETS : CLAUDE_RESETS,
  };
}
