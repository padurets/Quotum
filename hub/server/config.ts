import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** A comma-separated environment list, or the default when unset. */
function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : fallback;
}

/** Every tunable the deployment owns, in one place. */
export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const config = {
  dataDir: process.env.AGENT_LIMITS_DATA_DIR || path.join(appRoot, 'data'),
  databaseFile: 'agent-limits.sqlite',
  clientRoot: path.join(appRoot, 'dist/client'),
  home: os.homedir(),

  http: {
    host: process.env.AGENT_LIMITS_BIND || '127.0.0.1',
    port: Number(process.env.AGENT_LIMITS_PORT || 8080),
    /** The dashboard answers only to these host names (comma-separated); anything else is 403. */
    hosts: list(process.env.AGENT_LIMITS_ALLOWED_HOSTS, ['127.0.0.1', 'localhost']),
    /** Origins allowed to embed the dashboard in a frame, besides itself. */
    frameAncestors: list(process.env.AGENT_LIMITS_FRAME_ANCESTORS, []),
  },

  vendor: {
    baseUrl: 'http://127.0.0.1:18081',
    token: process.env.AGENT_LIMITS_VENDOR_TOKEN,
  },

  collection: {
    intervalMs: 120_000,
    /** One cycle may never outlive the interval it belongs to. */
    timeoutMs: 105_000,
    /** Backoff multipliers applied after consecutive fully failed cycles. */
    maxBackoff: 4,
  },

  retention: {
    sampleDays: 90,
    /** Data older than this is "not a measurement of now" for the UI and for edges. */
    freshMs: 330_000,
  },

  history: {
    /**
     * Each range is drawn on one shared time grid: every series gets a value for the
     * same buckets, so a hover always reads all of them at once. Totals still use
     * every raw sample.
     */
    ranges: {
      '24h': {durationMs: 86_400_000, bucketMs: 5 * 60_000},
      '7d': {durationMs: 7 * 86_400_000, bucketMs: 30 * 60_000},
      '30d': {durationMs: 30 * 86_400_000, bucketMs: 2 * 3_600_000},
    } as Record<string, {durationMs: number; bucketMs: number}>,
  },

  /** Read-only mounts Agent Limits may inspect for account identity (metadata only). */
  identityFiles: {
    claudeProfile: process.env.AGENT_LIMITS_CLAUDE_PROFILE || path.join(os.homedir(), '.claude.json'),
    antigravityToken: '.gemini/antigravity-cli/antigravity-oauth-token',
    claudeCredentials: '.claude/.credentials.json',
  },

  googleJwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',

  /** Community reset trackers (see domain/resets.ts); credited wherever shown. */
  resets: {
    codexApi: 'https://codex-resets.com/api/v1/status',
    claudeApi: 'https://claude-resets.com/api/resets',
    intervalMs: 10 * 60_000,
  },
} as const;

export const version = '2.1.0';
export const serviceName = 'Agent Limits';
