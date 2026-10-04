import type {ExpiryKind, IdentityOrigin} from '../connectors/registry.js';
import type {DatabaseSync} from 'node:sqlite';
import type {RecordIdentity, Sealed} from '../secrets/index.js';
import {secretCode, type SecretCode} from '../secrets/crypto.js';

export const CREDENTIAL_ABILITIES = ['balance', 'usage', 'manage_keys', 'quota'] as const;
export type CredentialAbility = (typeof CREDENTIAL_ABILITIES)[number];
export type CredentialRow = RecordIdentity & Sealed & {
  expiry_kind?: ExpiryKind; identity_origin?: IdentityOrigin;
  source_id: string | null; key_version: number; hint: string | null; abilities: string;
  created_at: number; expires_at: number | null; last_used_at: number | null; last_error: string | null; unreadable: number;
};
export type Credential = {
  expiryKind?: ExpiryKind; identityOrigin?: IdentityOrigin;
  id: string; provider: string; sourceId: string | null; hint: string | null; abilities: CredentialAbility[];
  createdAt: number; expiresAt: number | null; lastUsedAt: number | null; lastError: string | null; unreadable: boolean;
};

/** Explicit owner projection; encrypted bytes never become an API or board payload. */
export function credentialAnswer(row: CredentialRow): Credential {
  let abilities: CredentialAbility[] = [];
  try {
    const parsed: unknown = JSON.parse(row.abilities);
    if (Array.isArray(parsed)) abilities = CREDENTIAL_ABILITIES.filter(ability => parsed.includes(ability));
  } catch { /* A damaged metadata field grants no abilities. */ }
  return {expiryKind: row.expiry_kind ?? (row.expires_at === null ? 'none' : 'dated'), ...(row.identity_origin ? {identityOrigin: row.identity_origin} : {}), id: row.id, provider: row.provider, sourceId: row.source_id, hint: row.hint, abilities, createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, lastError: secretCode(row.last_error), unreadable: !!row.unreadable};
}

/** Only ciphertext reaches this repository. Ownership is in every mutation predicate. */
export class CredentialStore {
  constructor(private readonly db: DatabaseSync) {}
  list(owner: string): Credential[] {
    return (this.db.prepare('SELECT c.*, (SELECT kind FROM source_identity WHERE source_id=c.source_id) AS identity_origin FROM credentials c WHERE user_id = ? ORDER BY created_at, id').all(owner) as CredentialRow[]).map(credentialAnswer);
  }
  get(owner: string, id: string): CredentialRow | null {
    return this.db.prepare('SELECT c.*, (SELECT kind FROM source_identity WHERE source_id=c.source_id) AS identity_origin FROM credentials c WHERE user_id = ? AND id = ?').get(owner, id) as CredentialRow | undefined ?? null;
  }
  current(row: CredentialRow): boolean {
    return !!this.db.prepare('SELECT 1 FROM credentials WHERE id=? AND user_id=? AND source_id IS ? AND nonce=? AND cipher=?').get(row.id,row.user_id,row.source_id,row.nonce,row.cipher);
  }
  bound(source:string):CredentialRow[] {
    return this.db.prepare('SELECT * FROM credentials WHERE source_id=? ORDER BY CASE WHEN last_error IS NULL AND unreadable=0 THEN 0 ELSE 1 END,created_at,id').all(source) as CredentialRow[];
  }
  add(row: CredentialRow): void {
    this.db.prepare('INSERT INTO credentials (id, user_id, provider, source_id, cipher, nonce, key_version, hint, abilities, created_at, expires_at, last_used_at, last_error, unreadable, expiry_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.user_id, row.provider, row.source_id, row.cipher, row.nonce, row.key_version, row.hint, row.abilities, row.created_at, row.expires_at, row.last_used_at, row.last_error, row.unreadable, row.expiry_kind ?? (row.expires_at === null ? 'none' : 'dated'));
  }
  replace(owner: string, id: string, sealed: Sealed, generation: number, hint: string | null, previous?: Sealed): boolean {
    return this.db.prepare('UPDATE credentials SET cipher = ?, nonce = ?, key_version = ?, hint = ?, unreadable = 0, last_error = NULL WHERE user_id = ? AND id = ?'+(previous?' AND nonce=? AND cipher=?':''))
      .run(sealed.cipher, sealed.nonce, generation, hint, owner, id,...(previous?[previous.nonce,previous.cipher]:[])).changes !== 0;
  }
  remove(owner: string, id: string): void {
    this.db.prepare('DELETE FROM credentials WHERE user_id = ? AND id = ?').run(owner, id);
  }
  used(owner: string, id: string, record: Sealed, abilities: readonly CredentialAbility[], expiresAt: number | null, expiryKind: ExpiryKind = expiresAt === null ? 'none' : 'dated'): void {
    this.db.prepare('UPDATE credentials SET abilities = ?, expires_at = ?, expiry_kind = ?, last_used_at = ?, last_error = NULL, unreadable = 0 WHERE user_id = ? AND id = ? AND nonce = ? AND cipher = ?').run(JSON.stringify(abilities), expiresAt, expiryKind, Date.now(), owner, id, record.nonce, record.cipher);
  }
  error(owner: string, id: string, code: SecretCode, unreadable: boolean, record: Sealed): void {
    this.db.prepare('UPDATE credentials SET last_error = ?, unreadable = ? WHERE user_id = ? AND id = ? AND nonce = ? AND cipher = ?').run(code, unreadable ? 1 : 0, owner, id, record.nonce, record.cipher);
  }
}
