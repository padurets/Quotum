import {config} from '../config.js';
import {hash, type Provider} from './sources.js';
import type {Measurement, Win} from './quota.js';

type Obj = Record<string, any>;

const object = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {});

function date(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turn one vendor `/usage` payload into a measurement, or throw a fixed error code.
 * Anything unverifiable (unknown utilization, stale timestamp) is refused here rather
 * than stored as if it were observed.
 */
export function normalize(provider: Provider, payload: unknown, now: number): Measurement {
  if (!Array.isArray(payload)) throw new Error('invalid_response');
  const row = payload.map(object).find(entry => entry.provider === provider);
  if (!row) throw new Error('missing_provider');
  if (row.error) throw new Error('provider_unavailable');

  const usage = object(row.usage);
  const sourceAt = date(usage.updatedAt);
  if (sourceAt === null || sourceAt > now + 60_000 || now - sourceAt > config.retention.freshMs) {
    throw new Error('stale_source');
  }

  const identity = object(usage.identity);
  const account = identity.accountEmail || identity.accountId;
  const plan = typeof identity.loginMethod === 'string' ? identity.loginMethod.slice(0, 70) : '';
  const extras: Obj[] = Array.isArray(usage.extraRateWindows) ? usage.extraRateWindows.map(object) : [];

  const windows: Win[] = [];
  const add = (id: string, label: string, input: unknown) => {
    const w = object(input);
    const used = w.usedPercent;
    if (w.usageKnown === false || typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return;
    windows.push({
      id,
      label,
      used,
      remaining: 100 - used,
      resetAt: date(w.resetsAt),
      minutes: typeof w.windowMinutes === 'number' ? w.windowMinutes : null,
    });
  };

  // Antigravity repeats primary/secondary inside its quota summary; keep one copy.
  const summarised = provider === 'antigravity' && extras.some(x => String(x.id).includes('quota-summary'));
  if (!summarised) {
    add('session', provider === 'antigravity' ? 'Gemini' : '5 часов', usage.primary);
    add('weekly', provider === 'antigravity' ? 'Claude / GPT' : 'Неделя', usage.secondary);
  }
  for (const extra of extras) {
    if (typeof extra.id === 'string' && typeof extra.title === 'string') add(extra.id, extra.title, extra.window);
  }
  if (!windows.length) throw new Error('limits_unavailable');

  return {
    provider,
    sourceAt,
    plan,
    identity: typeof account === 'string' && account ? hash(`${provider}|${account.toLowerCase()}|${plan}`) : null,
    windows,
  };
}

export const COLLECTION_ERRORS = [
  'invalid_response',
  'missing_provider',
  'provider_unavailable',
  'stale_source',
  'limits_unavailable',
  'identity_changed',
] as const;
