import {createHash, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions} from 'node:crypto';

/**
 * Secrets and passwords. Every secret handed out (session, machine token, device token,
 * device code, invite) is random and stored only as a SHA-256 hash; passwords are
 * stored as scrypt hashes.
 */

const SCRYPT = {N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024};
const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, options: ScryptOptions & {N: number}): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), {N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem});
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Prefixes make a leaked secret recognizable: session, machine token, device token, device code, invite. */
export type SecretKind = 'qt_s' | 'qt_m' | 'qt_d' | 'qt_c' | 'qt_i';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const newSecret = (kind: SecretKind) => `${kind}_${randomBytes(24).toString('base64url')}`;
/** Secrets are stored and looked up by this hash only. */
export const secretHash = sha256;
export const secretKind = (secret: string) => secret.slice(0, 4) as SecretKind;
/** The last characters of a secret, enough to recognise it in a list. */
export const secretHint = (secret: string) => `…${secret.slice(-4)}`;
export const newId = () => randomBytes(9).toString('base64url');

/** No vowels (no accidental words), no 0/O/1/I look-alikes. */
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

/** A code a person types in: eight characters shown as XXXX-XXXX. */
export function newUserCode(): string {
  const chars = Array.from({length: 8}, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** Accepts what people type (lower case, spaces, missing dash); null if it cannot be a code. */
export function normalizeUserCode(input: string): string | null {
  const chars = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (chars.length !== 8 || [...chars].some(c => !CODE_ALPHABET.includes(c))) return null;
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const validEmail = (email: string) => email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
export const validPassword = (password: string) => password.length >= 8 && password.length <= 200;
export const validName = (name: string) => name.trim().length >= 1 && name.trim().length <= 80;
