import {decimal} from '../domain/amount.js';
import {QUOTA_IDS, type Meter, type QuotaIssue, type QuotaObservation} from '../domain/meters.js';
import {SecretError} from '../secrets/crypto.js';
import {ConnectorStatus, ConnectorTransport} from './transport.js';
import type {Connector, ConnectorIdentity} from './registry.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const AMOUNTS = new Set(['usage', 'currentValue', 'remaining']);

/** Preserve original numeric tokens; supplier strings never become amounts. */
export function decodeZai(json: string): unknown {
  return JSON.parse(json, ((name: string, value: unknown, context?: {source?: string}) => {
    if (AMOUNTS.has(name)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || !context?.source || name !== 'remaining' && value < 0) return null;
      try { return decimal(context.source).toString(); } catch { return null; }
    }
    return value;
  }) as Parameters<typeof JSON.parse>[1]);
}

const numeric = (value: unknown): value is string => typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value);
const quotaId = (raw: Obj) => raw.type !== 'CREDIT_LIMIT' ? null : raw.unit === 3 && raw.number === 5 ? QUOTA_IDS[0] : raw.unit === 6 && raw.number === 1 ? QUOTA_IDS[1] : null;

/** Only the two observed personal credit tuples have a supported meaning. */
export function mapZai(answer: unknown, observedAt: number): ConnectorIdentity {
  if (object(answer) && answer.code === 401) throw new SecretError('credential_auth_rejected');
  if (object(answer) && answer.code === 403) throw new SecretError('credential_permission');
  if (!object(answer) || answer.code !== 200 || answer.success !== true || !object(answer.data) || !Array.isArray(answer.data.limits) || answer.data.limits.length > 32) throw new SecretError('connector_invalid_response');
  const limits = answer.data.limits;
  const plan = typeof answer.data.level === 'string' && ['lite', 'pro', 'max'].includes(answer.data.level) ? answer.data.level : '';
  const counts = new Map<string, number>();
  for (const raw of limits) if (object(raw)) {
    const id = quotaId(raw);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const meters: Meter[] = [];
  let invalid = false, unsupported = false;
  for (const raw of limits) {
    if (!object(raw)) { invalid = true; continue; }
    const id = quotaId(raw);
    if (!id) { unsupported = true; continue; }
    if (counts.get(id) !== 1 || !numeric(raw.usage) || !numeric(raw.currentValue)) { invalid = true; continue; }
    const allowance = BigInt(raw.usage), used = BigInt(raw.currentValue), remaining = allowance - used;
    if (allowance < 0n || used < 0n) { invalid = true; continue; }
    if (Object.hasOwn(raw, 'remaining') && (!numeric(raw.remaining) || (BigInt(raw.remaining) - remaining > 1n || remaining - BigInt(raw.remaining) > 1n))) { invalid = true; continue; }
    if (Object.hasOwn(raw, 'percentage')) {
      const ratio = allowance === 0n ? used === 0n ? 0 : Infinity : Number(used) / Number(allowance) * 100;
      if (typeof raw.percentage !== 'number' || !Number.isFinite(raw.percentage) || raw.percentage < 0 || Math.min(Math.abs(raw.percentage - ratio), Math.abs(raw.percentage - Math.min(ratio, 100))) > 1) { invalid = true; continue; }
    }
    let resetAt: number | null = null;
    if (raw.nextResetTime !== undefined && raw.nextResetTime !== null) {
      if (typeof raw.nextResetTime === 'number' && Number.isSafeInteger(raw.nextResetTime) && raw.nextResetTime >= 1_000_000_000_000 && raw.nextResetTime <= 8_640_000_000_000_000) resetAt = raw.nextResetTime;
      else invalid = true;
    }
    meters.push({id, kind: 'cap', unit: 'credits:zai', amount: used.toString(), limit: allowance.toString(), at: observedAt, staleAfterMs: 204_000, stale: false, resetAt, minutes: id === QUOTA_IDS[0] ? 300 : 10080, scope: id === QUOTA_IDS[0] ? 'five_hour' : 'weekly', label: null});
  }
  meters.sort((a, b) => QUOTA_IDS.indexOf(a.id as typeof QUOTA_IDS[number]) - QUOTA_IDS.indexOf(b.id as typeof QUOTA_IDS[number]));
  const issue: QuotaIssue | null = invalid ? 'invalid' : unsupported ? 'unsupported' : !limits.length ? 'empty' : meters.length < 2 ? 'missing' : null;
  const quota = {observedAt, generation: meters.length ? 'credit' as const : null, complete: issue === null, issue};
  const quotaObservation: QuotaObservation = {observedAt, receivedIds: meters.map(m => m.id), quota, plan};
  return {identityOrigin: 'declared', abilities: ['quota'], expiresAt: null, expiryKind: 'unknown', quotaObservation,
    ...(meters.length ? {measurement: {type: 'meters', observedAt, staleAfterMs: 204_000, meters, keys: [], inventoryComplete: true, inventoryError: null, quota, plan}} : {})};
}

export function zai(transport = new ConnectorTransport({host: 'api.z.ai', port: 443, auth: 'raw', operations: {quota: {path: '/api/monitor/usage/quota/limit'}}}, {decode: decodeZai}), now = Date.now): Connector {
  const read = async (secret: Buffer, signal?: AbortSignal) => {
    try { return mapZai(await transport.send('quota', secret, {}, signal), now()); }
    catch (error) {
      if (error instanceof ConnectorStatus && error.status === 401) throw new SecretError('credential_auth_rejected');
      if (error instanceof ConnectorStatus && error.status === 403) throw new SecretError('credential_permission');
      throw error;
    }
  };
  return {id: 'zai', identityOrigin: 'declared', abilities: ['quota'], secretFormat: value => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) && value.length <= 4096, transport, map: () => null, identify: read, measure: (secret, _expected, signal) => read(secret, signal)};
}
