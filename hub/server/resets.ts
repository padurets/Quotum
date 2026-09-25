import {config, version} from './config.js';
import {CLAUDE_RESETS, CODEX_RESETS, fromClaudeResets, fromCodexResets, type ResetEvent, type ResetProvider, type ResetStatus} from './domain/resets.js';

export type TrackerHealth = {name: string; url: string; ok: boolean | null; detail: string; at: number | null};

/**
 * How a tracker is doing, as a code the dashboard translates: `checking`, `ok`, or why
 * it could not be read — `challenge` (Cloudflare's bot check stops the server),
 * `timeout`, `format`, `network`, or the HTTP status as is ("HTTP 503").
 */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'challenge') return 'challenge';
  if (/^HTTP \d+$/.test(message)) return message;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (message.startsWith('invalid_')) return 'format';
  return 'network';
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: {Accept: 'application/json', 'User-Agent': `quotum/${version}`},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.headers.get('cf-mitigated') === 'challenge') throw new Error('challenge');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('json')) throw new Error('invalid_content_type');
  return response.json();
}

/** Where the feed reads the trackers, whether it does, and how long it waits for one. */
export type Trackers = {enabled: boolean; codexApi: string; claudeApi: string; timeoutMs: number};

/**
 * Polls both trackers in the background and keeps the last good status per provider.
 * Codex Resets is preferred for Codex (it knows about *scheduled* resets); the Codex
 * part of Claude Resets is the fallback for executed ones. Every reset reported as
 * done is handed to `remember`: the trackers only tell the latest one. Nothing on the
 * dashboard waits on this feed.
 */
export class ResetFeed {
  private resets: Partial<Record<ResetProvider, ResetStatus>> = {};
  private health: TrackerHealth[];
  private timer?: NodeJS.Timeout;
  private closing = false;

  constructor(
    private readonly remember: (provider: ResetProvider, reset: ResetEvent) => void = () => {},
    private readonly log: (event: object) => void = event => console.log(JSON.stringify(event)),
    private readonly trackers: Trackers = config.resets,
  ) {
    this.health = trackers.enabled ? [CODEX_RESETS, CLAUDE_RESETS].map(t => ({...t, ok: null, detail: 'checking', at: null})) : [];
  }

  snapshot() {
    return {resets: this.resets, trackers: this.health};
  }

  /** Starts polling, unless the trackers are turned off (`QUOTUM_RESETS=off`). */
  start() {
    if (this.trackers.enabled) void this.poll();
  }

  stop() {
    this.closing = true;
    clearTimeout(this.timer);
  }

  /** One round of both trackers. Nothing here may stop the next round or the hub: the feed is optional. */
  private async poll() {
    try {
      await this.round();
    } catch (error) {
      this.log({event: 'resets', error: String((error as Error)?.message ?? error)});
    } finally {
      if (!this.closing) this.timer = setTimeout(() => void this.poll(), config.resets.intervalMs);
    }
  }

  /** One round of both trackers, now; `start` repeats it every interval. */
  async round() {
    const now = Date.now();
    const {codexApi, claudeApi, timeoutMs} = this.trackers;
    const [codex, catalogue] = await Promise.allSettled([
      getJson(codexApi, timeoutMs).then(payload => fromCodexResets(payload, now)),
      getJson(claudeApi, timeoutMs).then(payload => ({claude: fromClaudeResets(payload, 'claude'), codex: fromClaudeResets(payload, 'codex')})),
    ]);

    const next = {...this.resets};
    if (catalogue.status === 'fulfilled') Object.assign(next, catalogue.value);
    if (codex.status === 'fulfilled') next.codex = codex.value;
    this.resets = next;
    for (const [provider, status] of Object.entries(next) as [ResetProvider, ResetStatus][]) {
      if (status.latest) this.remember(provider, {at: status.latest.at, url: status.latest.url, text: status.latest.text});
    }

    const report = (tracker: {name: string; url: string}, result: PromiseSettledResult<unknown>): TrackerHealth =>
      result.status === 'fulfilled'
        ? {...tracker, ok: true, detail: 'ok', at: now}
        : {...tracker, ok: false, detail: describeFailure(result.reason), at: now};
    this.health = [report(CODEX_RESETS, codex), report(CLAUDE_RESETS, catalogue)];
    // The address read, not the tracker's: a mirror may be the one failing. Without its query, which may hold a key.
    const failed = (url: string, result: PromiseSettledResult<unknown>) =>
      result.status === 'rejected' ? [{url: new URL(url).origin + new URL(url).pathname, detail: describeFailure(result.reason)}] : [];
    const failures = [...failed(codexApi, codex), ...failed(claudeApi, catalogue)];
    this.log({event: 'resets', codex: codex.status, claude: catalogue.status, ...(failures.length ? {failures} : {})});
  }
}
