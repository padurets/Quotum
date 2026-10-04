import type {CredentialAbility} from '../store/credentials.js';
import type {ConnectorTransport} from './transport.js';
import type {MeterMeasurement} from '../domain/meters.js';
import {zai} from './zai.js';
import type {QuotaObservation} from '../domain/meters.js';
import {openRouter} from './openrouter.js';

export type IdentityOrigin = 'supplier' | 'declared';
export type ExpiryKind = 'dated' | 'none' | 'unknown';
type ConnectorResult = {abilities: CredentialAbility[]; expiresAt: number | null; expiryKind?: ExpiryKind; measurement?: MeterMeasurement; retryAfterMs?: number; quotaObservation?: QuotaObservation};
export type ConnectorIdentity = ConnectorResult & ({identityOrigin?: 'supplier'; account: string} | {identityOrigin: 'declared'; account?: never});

export type Connector = {
  id: string;
  identityOrigin?: IdentityOrigin;
  secretFormat(secret: string): boolean;
  abilities: readonly CredentialAbility[];
  transport: ConnectorTransport;
  map(answer: unknown): {abilities: CredentialAbility[]; expiresAt: number | null} | null;
  identify(secret: Buffer, signal?: AbortSignal): Promise<ConnectorIdentity>;
  measure(secret: Buffer, expected: {account: string; expiresAt: number | null}, signal?: AbortSignal): Promise<ConnectorIdentity>;
};

/** Production destinations are code-owned. Tests and demos inject their own adapters. */
export const connectors: ReadonlyMap<string, Connector> = new Map([['openrouter',openRouter()],['zai',zai()]]);
