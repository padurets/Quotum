import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {connectors, type Connector} from '../connectors/index.js';
import {CredentialStore, credentialAnswer, type Credential, type CredentialRow} from '../store/credentials.js';
import {SecretError, type SecretKey} from './crypto.js';
import {checkpoint, type SecretKeyReport} from './start.js';

/** Trusted keys are write-only; raw errors stop inside this service. */
export class Credentials {
  #repository: CredentialStore;
  constructor(private readonly db: DatabaseSync, private readonly key: SecretKey | null, readonly report: SecretKeyReport, private readonly registry: ReadonlyMap<string, Connector> = connectors) {
    this.#repository = new CredentialStore(db);
  }
  private boundary<T>(work: () => T): T {
    try { return work(); } catch (error) { throw error instanceof SecretError ? error : new SecretError('credential_failed'); }
  }
  private mutation<T>(work: () => T, maintenance: boolean): T {
    return this.boundary(() => {
      this.db.exec('BEGIN IMMEDIATE');
      let result: T;
      try { result = work(); this.db.exec('COMMIT'); }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
      if (maintenance) checkpoint(this.db, 'credential_cleanup_pending');
      return result;
    });
  }
  private requireKey(): SecretKey {
    if (!this.key || this.report.outcome === 'missing') throw new SecretError('secret_key_missing');
    if (this.report.outcome === 'mismatch') throw new SecretError('secret_key_mismatch');
    return this.key;
  }
  private connector(provider: string): Connector {
    const connector = this.registry.get(provider);
    if (!connector) throw new SecretError('credential_provider_unknown');
    return connector;
  }
  private secret<T>(connector: Connector, value: unknown, use: (bytes: Buffer) => T): T {
    if (typeof value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value) || !connector.secretFormat(value)) throw new SecretError('credential_invalid');
    const bytes = Buffer.from(value, 'ascii');
    try { return use(bytes); } finally { bytes.fill(0); }
  }
  private generation(): number {
    const value = Number(this.db.prepare("SELECT value FROM meta WHERE key = 'secretKeyVersion'").get()?.value);
    if (!Number.isSafeInteger(value) || value < 1) throw new SecretError('credential_failed');
    return value;
  }
  list(owner: string): Credential[] { return this.boundary(() => this.#repository.list(owner)); }
  create(owner: string, provider: string, secret: unknown): Credential {
    return this.boundary(() => {
      const connector = this.connector(provider);
      const key = this.requireKey();
      const record = {id: randomUUID(), user_id: owner, provider};
      const row: CredentialRow = this.secret(connector, secret, bytes => ({...record, ...key.seal(record, bytes), source_id: null, key_version: this.generation(), hint: bytes.length > 4 ? bytes.subarray(-4).toString('ascii') : null, abilities: JSON.stringify(connector.abilities), created_at: Date.now(), expires_at: null, last_used_at: null, last_error: null, unreadable: 0}));
      return this.mutation(() => { this.#repository.add(row); return credentialAnswer(row); }, false);
    });
  }
  replace(owner: string, id: string, secret: unknown): Credential {
    return this.mutation(() => {
      const row = this.#repository.get(owner, id);
      if (!row) throw new SecretError('credential_not_found');
      const key = this.requireKey();
      return this.secret(this.connector(row.provider), secret, bytes => {
        if (!this.#repository.replace(owner, id, key.seal(row, bytes), this.generation(), bytes.length > 4 ? bytes.subarray(-4).toString('ascii') : null)) throw new SecretError('credential_not_found');
        return credentialAnswer(this.#repository.get(owner, id)!);
      });
    }, true);
  }
  remove(owner: string, id: string): void { this.mutation(() => this.#repository.remove(owner, id), true); }

  /** Connector code maps its reply before it leaves the boundary; no raw supplier fields. */
  async probe(owner: string, id: string, operation: string, signal?: AbortSignal): Promise<{abilities: readonly string[]; expiresAt: number | null}> {
    let record: CredentialRow | null = null;
    let decrypted = false;
    try {
      const row = record = this.#repository.get(owner, id);
      if (!row) throw new SecretError('credential_not_found');
      const key = this.requireKey();
      const connector = this.connector(row.provider);
      const reply = await key.use(row, secret => {
        // Only authenticated decryption can clear a previously unreadable flag.
        decrypted = true;
        return connector.transport.send(operation, secret, {}, signal);
      });
      const answer = connector.map(reply);
      if (!answer || answer.abilities.some(ability => !connector.abilities.includes(ability)) || answer.expiresAt !== null && (!Number.isSafeInteger(answer.expiresAt) || answer.expiresAt < 0)) throw new SecretError('connector_invalid_response');
      this.#repository.used(owner, id, row, answer.abilities, answer.expiresAt);
      return {abilities: answer.abilities, expiresAt: answer.expiresAt};
    } catch (error) {
      const safe = error instanceof SecretError ? error : new SecretError('credential_failed');
      try { if (record) this.#repository.error(owner, id, safe.code, safe.code === 'credential_unreadable' || !decrypted && !!record.unreadable, record); } catch { /* The original safe failure remains authoritative. */ }
      throw safe;
    }
  }
}
