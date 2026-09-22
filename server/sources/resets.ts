import {config, version} from '../config.js';
import {CLAUDE_RESETS, CODEX_RESETS, fromClaudeResets, fromCodexResets, type ResetProvider, type ResetStatus} from '../domain/resets.js';

export type TrackerHealth = {name: string; url: string; ok: boolean | null; detail: string; at: number | null};

/** Why a tracker could not be read, in terms the owner can act on. */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'challenge') return 'Cloudflare не пропускает сервер (проверка на бота)';
  if (/^HTTP \d+$/.test(message)) return message;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'нет ответа';
  if (message.startsWith('invalid_')) return 'неожиданный формат ответа';
  return 'сеть недоступна';
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {Accept: 'application/json', 'User-Agent': `agent-limits/${version}`},
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
 * part of claude-resets.com is the fallback for executed ones. Nothing on the
 * dashboard waits on this feed.
 */
export class ResetFeed {
  private resets: Partial<Record<ResetProvider, ResetStatus>> = {};
  private health: TrackerHealth[] = [CODEX_RESETS, CLAUDE_RESETS].map(t => ({...t, ok: null, detail: 'проверяем…', at: null}));
  private timer?: NodeJS.Timeout;
  private closing = false;

  constructor(private readonly log: (event: object) => void = event => console.log(JSON.stringify(event))) {}

  snapshot() {
    return {resets: this.resets, trackers: this.health};
  }

  start() {
    void this.poll();
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

    const report = (tracker: {name: string; url: string}, result: PromiseSettledResult<unknown>): TrackerHealth =>
      result.status === 'fulfilled'
        ? {...tracker, ok: true, detail: 'данные получены', at: now}
        : {...tracker, ok: false, detail: describeFailure(result.reason), at: now};
    this.health = [report(CODEX_RESETS, codex), report(CLAUDE_RESETS, catalogue)];
    this.log({event: 'resets', codex: codex.status, claude: catalogue.status});

    if (!this.closing) this.timer = setTimeout(() => void this.poll(), config.resets.intervalMs);
  }
}
