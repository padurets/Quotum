import type {CredentialAbility} from '../store/credentials.js';
import type {ConnectorTransport} from './transport.js';
import type {MeterMeasurement} from '../domain/meters.js';
import {openRouter} from './openrouter.js';

export type ConnectorIdentity = {account: string; abilities: CredentialAbility[]; expiresAt: number | null; measurement?: MeterMeasurement};

export type Connector = {
  id: string;
  secretFormat(secret: string): boolean;
  abilities: readonly CredentialAbility[];
  transport: ConnectorTransport;
  map(answer: unknown): {abilities: CredentialAbility[]; expiresAt: number | null} | null;
  identify(secret: Buffer, signal?: AbortSignal): Promise<ConnectorIdentity>;
  measure(secret: Buffer, expected: Pick<ConnectorIdentity,'account'|'expiresAt'>, signal?: AbortSignal): Promise<ConnectorIdentity>;
};

/** Production destinations are code-owned. Tests and demos inject their own adapters. */
export const connectors: ReadonlyMap<string, Connector> = new Map([['openrouter',openRouter()]]);
