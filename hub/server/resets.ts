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

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {Accept: 'application/json', 'User-Agent': `quotum/${version}`},
    signal: AbortSignal.timeout(10_000),
  });
  if (response.headers.get('cf-mitigated') === 'challenge') throw new Error('challenge');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('json')) throw new Error('invalid_content_type');
  return response.json();
}

/**
 * Polls both trackers in the background and keeps the last good status per provider.
 * Codex Resets is preferred for Codex (it knows about *scheduled* resets); the Codex
 * part of Claude Resets is the fallback for executed ones. Every reset reported as
 * done is handed to `remember`: the trackers only tell the latest one. Nothing on the
 * dashboard waits on this feed.
 */
export class ResetFeed {
  private resets: Partial<Record<ResetProvider, ResetStatus>> = {};
  private health: TrackerHealth[] = config.resets.enabled ? [CODEX_RESETS, CLAUDE_RESETS].map(t => ({...t, ok: null, detail: 'checking', at: null})) : [];
  private timer?: NodeJS.Timeout;
  private closing = false;

  constructor(
    private readonly remember: (provider: ResetProvider, reset: ResetEvent) => void = () => {},
    private readonly log: (event: object) => void = event => console.log(JSON.stringify(event)),
  ) {}

  snapshot() {
    return {resets: this.resets, trackers: this.health};
  }

  /** Starts polling, unless the trackers are turned off (`QUOTUM_RESETS=off`). */
  start() {
    if (config.resets.enabled) void this.poll();
  }

  stop() {
    this.closing = true;
    clearTimeout(this.timer);
  }

  private async poll() {
    const now = Date.now();
    const [codex, catalogue] = await Promise.allSettled([
      getJson(config.resets.codexApi).then(payload => fromCodexResets(payload, now)),
      getJson(config.resets.claudeApi).then(payload => ({claude: fromClaudeResets(payload, 'claude'), codex: fromClaudeResets(payload, 'codex')})),
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
    this.log({event: 'resets', codex: codex.status, claude: catalogue.status});

    if (!this.closing) this.timer = setTimeout(() => void this.poll(), config.resets.intervalMs);
  }
}
