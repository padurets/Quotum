import type {DatabaseSync} from 'node:sqlite';
import type {RecordIdentity, Sealed} from '../secrets/index.js';

export const CREDENTIAL_ABILITIES = ['balance', 'usage', 'manage_keys'] as const;
export type CredentialAbility = (typeof CREDENTIAL_ABILITIES)[number];
export type CredentialRow = RecordIdentity & Sealed & {
  source_id: string | null; key_version: number; hint: string | null; abilities: string;
  created_at: number; expires_at: number | null; last_used_at: number | null; last_error: string | null; unreadable: number;
};
export type Credential = {
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
  return {id: row.id, provider: row.provider, sourceId: row.source_id, hint: row.hint, abilities, createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, lastError: row.last_error && /^(credential|connector)_[a-z_]+$/.test(row.last_error) ? row.last_error : null, unreadable: !!row.unreadable};
}

/** Only ciphertext reaches this repository. Ownership is in every mutation predicate. */
export class CredentialStore {
  constructor(private readonly db: DatabaseSync) {}
  list(owner: string): Credential[] {
    return (this.db.prepare('SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at, id').all(owner) as CredentialRow[]).map(credentialAnswer);
  }
  get(owner: string, id: string): CredentialRow | null {
    return this.db.prepare('SELECT * FROM credentials WHERE user_id = ? AND id = ?').get(owner, id) as CredentialRow | undefined ?? null;
  }
  add(row: CredentialRow): void {
    this.db.prepare('INSERT INTO credentials (id, user_id, provider, source_id, cipher, nonce, key_version, hint, abilities, created_at, expires_at, last_used_at, last_error, unreadable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.user_id, row.provider, row.source_id, row.cipher, row.nonce, row.key_version, row.hint, row.abilities, row.created_at, row.expires_at, row.last_used_at, row.last_error, row.unreadable);
  }
  replace(owner: string, id: string, sealed: Sealed, generation: number, hint: string | null): boolean {
    return this.db.prepare('UPDATE credentials SET cipher = ?, nonce = ?, key_version = ?, hint = ?, unreadable = 0, last_error = NULL WHERE user_id = ? AND id = ?').run(sealed.cipher, sealed.nonce, generation, hint, owner, id).changes !== 0;
  }
  remove(owner: string, id: string): void {
    this.db.prepare('DELETE FROM credentials WHERE user_id = ? AND id = ?').run(owner, id);
  }
  error(owner: string, id: string, code: string, unreadable = false): void {
    this.db.prepare('UPDATE credentials SET last_error = ?, unreadable = ? WHERE user_id = ? AND id = ?').run(code, unreadable ? 1 : 0, owner, id);
  }
}
