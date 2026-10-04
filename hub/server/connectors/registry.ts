import type {CredentialAbility} from '../store/credentials.js';
import type {ConnectorTransport} from './transport.js';
import type {MeterMeasurement} from '../domain/meters.js';
import {deepSeek} from './deepseek.js';
import {openRouter} from './openrouter.js';

export type ConnectorIdentity = {account: string; abilities: CredentialAbility[]; expiresAt: number | null; measurement?: MeterMeasurement; retryAfterMs?: number};

export type ConnectorAnswer = (ConnectorIdentity & {identityKind?:'provider'}) | (Omit<ConnectorIdentity,'account'> & {identityKind:'declared';account:null});

export type Connector<Answer extends ConnectorAnswer=ConnectorAnswer> = {
  identityKind?: 'provider'|'declared';
  id: string;
  secretFormat(secret: string): boolean;
  abilities: readonly CredentialAbility[];
  transport: ConnectorTransport;
  map(answer: unknown): {abilities: CredentialAbility[]; expiresAt: number | null} | null;
  identify(secret: Buffer, signal?: AbortSignal): Promise<Answer>;
  measure(secret: Buffer, expected: Pick<ConnectorIdentity,'account'|'expiresAt'>, signal?: AbortSignal): Promise<Answer>;
};

/** Production destinations are code-owned. Tests and demos inject their own adapters. */
export const connectors: ReadonlyMap<string, Connector> = new Map<string,Connector>([['openrouter',openRouter()],['deepseek',deepSeek()]]);
