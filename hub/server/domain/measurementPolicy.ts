import {clientProviders, type ClientProvider} from './providers.js';

export type CollectorPolicy = {enabled: boolean; epoch: number; requiresEpoch: boolean; changedAt: number | null};
export type MeasurementPolicy = {
  version: 1;
  authority: string;
  revision: number;
  enabled: boolean;
  collectors: Record<ClientProvider, CollectorPolicy>;
};
export type Participation = {enabled: boolean; collectors: Record<ClientProvider, boolean>};
export type AttemptContext = {
  version: 1;
  authority: string;
  collectorEpoch: number;
  target: {kind: 'verified'; accountKey: string} | {kind: 'unknown'};
  commandId?: string;
};
export type Admission = 'accepted' | 'disabled' | 'epoch_required' | 'epoch_mismatch';
export type SourcePreference = {revision: number; device: string | null};
export const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Supplemental evidence is never trusted partly, nor substituted from delivery-time state. */
export function attemptContext(value: unknown): AttemptContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>, target = input.target as Record<string, unknown> | undefined;
  if (input.version !== 1 || typeof input.authority !== 'string' || !OPERATION_ID.test(input.authority) ||
    !Number.isSafeInteger(input.collectorEpoch) || (input.collectorEpoch as number) < 0 ||
    !target || (target.kind !== 'unknown' && (target.kind !== 'verified' || typeof target.accountKey !== 'string' ||
      !target.accountKey.length || target.accountKey.length > 256 || /[\u0000-\u001f\u007f]/.test(target.accountKey))) ||
    input.commandId !== undefined && (typeof input.commandId !== 'string' || !OPERATION_ID.test(input.commandId))) return null;
  return {version: 1, authority: input.authority, collectorEpoch: input.collectorEpoch as number,
    target: target.kind === 'verified' ? {kind: 'verified', accountKey: target.accountKey as string} : {kind: 'unknown'},
    ...(input.commandId !== undefined ? {commandId: input.commandId as string} : {})};
}

export function admitMeasurement(policy: MeasurementPolicy, collector: ClientProvider, context: AttemptContext | null): Admission {
  const gate = policy.collectors[collector];
  if (!policy.enabled || !gate.enabled) return 'disabled';
  if (context && (context.authority !== policy.authority || context.collectorEpoch !== gate.epoch)) return 'epoch_mismatch';
  if (gate.requiresEpoch && !context) return 'epoch_required';
  return 'accepted';
}

export function participation(value: unknown): Participation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Partial<Participation>;
  if (typeof input.enabled !== 'boolean' || !input.collectors || typeof input.collectors !== 'object' ||
    Object.keys(input.collectors).length !== clientProviders.length ||
    !clientProviders.every(id => typeof input.collectors?.[id] === 'boolean')) return null;
  return {enabled: input.enabled, collectors: Object.fromEntries(clientProviders.map(id => [id, input.collectors![id]])) as Participation['collectors']};
}
