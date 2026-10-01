import type {CredentialAbility} from '../store/credentials.js';
import type {ConnectorTransport} from './transport.js';

export type Connector = {
  id: string;
  secretFormat(secret: string): boolean;
  abilities: readonly CredentialAbility[];
  transport: ConnectorTransport;
  map(answer: unknown): {abilities: CredentialAbility[]; expiresAt: number | null} | null;
};

/** A1 has no production provider. Tests and demos supply their adapter explicitly. */
export const connectors: ReadonlyMap<string, Connector> = new Map();
