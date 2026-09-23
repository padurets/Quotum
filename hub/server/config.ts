import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** A comma-separated environment list, or the default when unset. */
function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : fallback;
}

/**
 * Which proxies to believe about the client's address and protocol: unset (or `false`,
 * `0`) for none, `true` for any, a number of hops, or addresses and CIDR ranges
 * (comma-separated).
 */
function trustProxy(value: string | undefined): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return (_address, hop) => hop < Number(value);
  return list(value, []);
}

/** The hub's public address, checked at start: a typo here would break every sign-in later. */
function publicUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`QUOTUM_PUBLIC_URL must be a full address like https://quotum.example.com, not "${value}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`QUOTUM_PUBLIC_URL must start with https:// or http://, not "${value}"`);
  return url.origin;
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** The hub directory: two levels up from `dist/server` when built, one from `server` in source. */
export const appRoot = path.resolve(here, path.basename(path.dirname(here)) === 'dist' ? '../..' : '..');

/** Every tunable the deployment owns, in one place. */
export const config = {
  dataDir: process.env.QUOTUM_DATA_DIR || path.join(appRoot, 'data'),
  databaseFile: 'quotum.sqlite',
  clientRoot: path.join(appRoot, 'dist/client'),

  http: {
    host: process.env.QUOTUM_BIND || '127.0.0.1',
    port: Number(process.env.QUOTUM_PORT || 8080),
    /** The hub answers only to these host names (comma-separated), or to any with `*`; anything else is 403. */
    hosts: list(process.env.QUOTUM_ALLOWED_HOSTS, ['127.0.0.1', 'localhost']),
    /** Origins allowed to embed the dashboard in a frame, besides itself. */
    frameAncestors: list(process.env.QUOTUM_FRAME_ANCESTORS, []),
    trustProxy: trustProxy(process.env.QUOTUM_TRUST_PROXY),
  },

  auth: {
    /** Who may sign up after the first person (who always may): `invite` (default) or `open`. */
    signup: process.env.QUOTUM_SIGNUP === 'open' ? ('open' as const) : ('invite' as const),
    sessionTtlMs: 30 * 86_400_000,
    inviteTtlMs: 7 * 86_400_000,
    /** Device codes: how long one is valid, and how often an agent may ask about it. */
    codeTtlMs: 10 * 60_000,
    codeIntervalS: 5,
    /** The address people open, for links shown to agents; derived from the request when unset. */
    publicUrl: publicUrl(process.env.QUOTUM_PUBLIC_URL),
    /** The code the first account needs while the hub has none; a random one is printed at start when unset. */
    setupCode: process.env.QUOTUM_SETUP_CODE || null,
  },

  /** Agents push measurements (spec/ingest-v1.md) with a device or machine token. */
  ingest: {
    bodyLimit: 1024 * 1024,
  },

  retention: {
    sampleDays: 90,
  },

  history: {
    /**
     * Each range is drawn on one shared time grid: every series gets a value for the
     * same cells, so a hover always reads all of them at once. Totals still use every
     * raw sample.
     */
    ranges: {
      '24h': {durationMs: 86_400_000, cellMs: 5 * 60_000},
      '7d': {durationMs: 7 * 86_400_000, cellMs: 30 * 60_000},
      '30d': {durationMs: 30 * 86_400_000, cellMs: 2 * 3_600_000},
    } as Record<string, {durationMs: number; cellMs: number}>,
    /**
     * A period selected on the chart gets the finest of these cells that keeps it
     * within `maxCells`, the same density as the fixed ranges. Shorter than
     * `minSpanMs` it would show a handful of measurements.
     */
    cells: [1, 5, 15, 30, 60, 120, 360, 720].map(minutes => minutes * 60_000),
    maxCells: 360,
    minSpanMs: 15 * 60_000,
  },

  /** Community reset trackers (see domain/resets.ts); credited wherever shown. `QUOTUM_RESETS=off` turns them off. */
  resets: {
    enabled: process.env.QUOTUM_RESETS !== 'off',
    codexApi: 'https://codex-resets.com/api/v1/status',
    claudeApi: 'https://claude-resets.com/api/resets',
    intervalMs: 10 * 60_000,
  },
} as const;

export const version: string = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
export const serviceName = 'Quotum';
