import {createPublicKey, verify, type JsonWebKey} from 'node:crypto';
import {hash} from '../domain/sources.js';

const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * Verify a Google ID token locally and return a one-way subject hash. The token is
 * never sent anywhere; only its RS256 signature is checked against public JWKs.
 */
export function googleSubject(token: unknown, keys: JsonWebKey[], now: number): string | null {
  if (typeof token !== 'string' || token.length > 16384) return null;
  try {
    const [head, body, signature, ...rest] = token.split('.');
    if (rest.length || !head || !body || !signature) return null;
    const header = JSON.parse(Buffer.from(head, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      !ISSUERS.includes(claims.iss) ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      typeof claims.aud !== 'string' ||
      typeof claims.exp !== 'number' ||
      claims.exp * 1000 <= now ||
      typeof claims.iat !== 'number' ||
      claims.iat * 1000 > now + 60_000
    ) {
      return null;
    }
    const key = keys.find(k => k.kid === header.kid && k.kty === 'RSA');
    if (!key) return null;
    const signed = Buffer.from(`${head}.${body}`);
    if (!verify('RSA-SHA256', signed, createPublicKey({key, format: 'jwk'}), Buffer.from(signature, 'base64url'))) return null;
    return hash(`antigravity|google|${claims.sub}`);
  } catch {
    return null;
  }
}
