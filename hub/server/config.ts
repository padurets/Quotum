import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** A comma-separated environment list, or the default when unset. */
function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : fallback;
}

/** Every tunable the deployment owns, in one place. */
const here = path.dirname(fileURLToPath(import.meta.url));
/** The hub directory: two levels up from `dist/server` when built, one from `server` in source. */
export const appRoot = path.resolve(here, path.basename(path.dirname(here)) === 'dist' ? '../..' : '..');

export const config = {
  dataDir: process.env.QUOTUM_DATA_DIR || path.join(appRoot, 'data'),
  databaseFile: 'quotum.sqlite',
  clientRoot: path.join(appRoot, 'dist/client'),

  http: {
    host: process.env.QUOTUM_BIND || '127.0.0.1',
    port: Number(process.env.QUOTUM_PORT || 8080),
    /** The dashboard answers only to these host names (comma-separated); anything else is 403. */
    hosts: list(process.env.QUOTUM_ALLOWED_HOSTS, ['127.0.0.1', 'localhost']),
    /** Origins allowed to embed the dashboard in a frame, besides itself. */
    frameAncestors: list(process.env.QUOTUM_FRAME_ANCESTORS, []),
  },

  auth: {
    /** Who may sign up after the first user (who always may): `invite` (default) or `open`. */
    signup: process.env.QUOTUM_SIGNUP === 'open' ? ('open' as const) : ('invite' as const),
    sessionTtlMs: 30 * 86_400_000,
    inviteTtlMs: 7 * 86_400_000,
    /** Device codes: how long one is valid, and how often an agent may ask about it. */
    codeTtlMs: 10 * 60_000,
    codeIntervalS: 5,
    /** The address people open, for links shown to agents; derived from the request when unset. */
    publicUrl: process.env.QUOTUM_PUBLIC_URL?.replace(/\/+$/, '') || null,
  },

  /**
   * Agents push measurements (spec/ingest-v1.md) with a device or board token. These
   * static tokens (comma-separated) additionally deliver to the default board.
   */
  ingest: {
    tokens: (process.env.QUOTUM_INGEST_TOKENS ?? '')
      .split(',')
      .map(token => token.trim())
      .filter(token => token.length >= 16),
    bodyLimit: 1024 * 1024,
  },

  retention: {
    sampleDays: 90,
    /** How long a measurement stays current when its agent does not say (agents always do). */
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

  /** Community reset trackers (see domain/resets.ts); credited wherever shown. */
  resets: {
    codexApi: 'https://codex-resets.com/api/v1/status',
    claudeApi: 'https://claude-resets.com/api/resets',
    intervalMs: 10 * 60_000,
  },
} as const;

export const version = '0.1.0';
export const serviceName = 'Quotum';
