import {createCipheriv, createDecipheriv, createHmac, createSecretKey, hkdfSync, randomBytes, timingSafeEqual, type KeyObject} from 'node:crypto';
import {inspect} from 'node:util';

export const SECRET_CODE = Object.freeze({
  INVALID: 'secret_key_invalid', CONFIGURATION_INVALID: 'secret_key_configuration_invalid', FILE_IN_DATA: 'secret_key_file_in_data', FILE_UNAVAILABLE: 'secret_key_file_unavailable',
  METADATA_INVALID: 'secret_key_metadata_invalid', RESET_INVALID: 'secret_key_reset_invalid', RESET_CONFLICT: 'secret_key_reset_conflict', START_FAILED: 'secret_key_start_failed', CHECKPOINT_PENDING: 'secret_key_checkpoint_pending', MISSING: 'secret_key_missing', MISMATCH: 'secret_key_mismatch',
  CREDENTIAL_INVALID: 'credential_invalid', CREDENTIAL_NOT_FOUND: 'credential_not_found', CREDENTIAL_PROVIDER_UNKNOWN: 'credential_provider_unknown', CREDENTIAL_FAILED: 'credential_failed', CREDENTIAL_UNREADABLE: 'credential_unreadable', CREDENTIAL_CLEANUP_PENDING: 'credential_cleanup_pending',
  CREDENTIAL_EXPIRED: 'credential_expired', CREDENTIAL_REVOKED: 'credential_revoked', CREDENTIAL_WRONG_TYPE: 'credential_wrong_type', CREDENTIAL_PERMISSION: 'credential_permission', CREDENTIAL_ACCOUNT_MISMATCH: 'credential_account_mismatch', CREDENTIAL_EXPIRY_CONFIRMATION: 'credential_expiry_confirmation', CREDENTIAL_CONFLICT: 'credential_conflict',
  CREDENTIAL_REJECTED: 'credential_rejected', ACCOUNT_CONFIRMATION: 'credential_account_confirmation', ACCOUNT_NOT_FOUND: 'declared_account_not_found', ACCOUNT_NAME_CONFLICT: 'declared_account_name_conflict', BALANCE_UNAVAILABLE: 'connector_balance_unavailable',
  INVENTORY_PARTIAL: 'connector_inventory_partial', ROUND_LIMIT: 'connector_round_limit',
  DESTINATION_INVALID: 'connector_destination_invalid', CANCELLED: 'connector_cancelled', REDIRECT: 'connector_redirect', STATUS: 'connector_status', RESPONSE_TOO_LARGE: 'connector_response_too_large', INVALID_RESPONSE: 'connector_invalid_response', CONNECTOR_FAILED: 'connector_failed', TIMEOUT: 'connector_timeout',
} as const);
export type SecretCode = (typeof SECRET_CODE)[keyof typeof SECRET_CODE];
const codes = new Set<unknown>(Object.values(SECRET_CODE));
export const secretCode = (value: unknown): SecretCode | null => codes.has(value) ? value as SecretCode : null;

/** Only fixed codes may cross the boundary around keys. Never attach a raw cause. */
export class SecretError extends Error {
  readonly code: SecretCode;
  constructor(code: SecretCode,readonly expiryKind?:'unknown'|'none') {
    const safe = secretCode(code) ?? SECRET_CODE.CREDENTIAL_FAILED;
    super(safe);
    this.code = safe;
    this.name = 'SecretError';
  }
}

export type RecordIdentity = {id: string; user_id: string; provider: string};
export type Sealed = {cipher: Uint8Array; nonce: Uint8Array};

/** Opaque key material: neither JSON nor inspection can expose its derived keys. */
export class SecretKey {
  #enc: KeyObject;
  #kcv: Buffer;

  private constructor(bytes: Buffer) {
    const derive = (info: string) => {
      const derived = Buffer.from(hkdfSync('sha256', bytes, 'quotum/kek/v1', info, 32));
      try { return createSecretKey(derived); } finally { derived.fill(0); }
    };
    this.#enc = derive('enc');
    this.#kcv = createHmac('sha256', derive('check')).update('quotum/kek-check/v1').digest();
  }

  static parse(value: Uint8Array): SecretKey {
    if (value.length !== 43 || !value.every(byte => byte >= 0x21 && byte <= 0x7e)) throw new SecretError('secret_key_invalid');
    const text = Buffer.from(value).toString('ascii');
    if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw new SecretError('secret_key_invalid');
    const bytes = Buffer.from(text, 'base64url');
    try {
      if (bytes.length !== 32 || bytes.toString('base64url') !== text) throw new SecretError('secret_key_invalid');
      return new SecretKey(bytes);
    } finally { bytes.fill(0); }
  }

  get fingerprint(): string { return this.#kcv.subarray(0, 8).toString('hex'); }
  get checkValue(): string { return this.#kcv.toString('hex'); }
  matches(checkValue: string): boolean {
    return /^[0-9a-f]{64}$/.test(checkValue) && timingSafeEqual(this.#kcv, Buffer.from(checkValue, 'hex'));
  }
  toJSON(): null { return null; }
  [inspect.custom](): string { return '[SecretKey]'; }

  seal(record: RecordIdentity, plaintext: Uint8Array): Sealed {
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.#enc, nonce, {authTagLength: 16});
      cipher.setAAD(aad(record));
      return {nonce, cipher: Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])};
    } catch { throw new SecretError('credential_failed'); }
  }

  /** Plaintext stays inside the callback and is wiped after use or failure. */
  use<T>(record: RecordIdentity & Sealed, consume: (plaintext: Buffer) => T): T {
    let partial: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      if (!(record.nonce instanceof Uint8Array) || record.nonce.length !== 12 || !(record.cipher instanceof Uint8Array) || record.cipher.length < 16) throw new SecretError('credential_unreadable');
      const cipher = Buffer.from(record.cipher);
      const decipher = createDecipheriv('aes-256-gcm', this.#enc, record.nonce, {authTagLength: 16});
      decipher.setAAD(aad(record));
      decipher.setAuthTag(cipher.subarray(-16));
      partial = decipher.update(cipher.subarray(0, -16));
      plaintext = Buffer.concat([partial, decipher.final()]);
    } catch {
      partial?.fill(0);
      throw new SecretError('credential_unreadable');
    }
    const wipe = () => {partial?.fill(0);plaintext.fill(0);};
    try {
      const result=consume(plaintext);
      if(result instanceof Promise)return result.finally(wipe) as T;
      wipe();return result;
    } catch(error){wipe();throw error;}
  }
}

function aad(record: RecordIdentity): Buffer {
  // Ids are generated by the hub; provider ids are fixed by connector code.
  if ([record.id, record.user_id, record.provider].some(value => typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new SecretError('credential_unreadable');
  return Buffer.from(`quotum/credential/v1\n${record.id}\n${record.user_id}\n${record.provider}`);
}
