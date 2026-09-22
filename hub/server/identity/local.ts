import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {config} from '../config.js';
import {hash, type Provider} from '../domain/sources.js';
import type {JsonWebKey} from 'node:crypto';
import {googleSubject} from './google.js';

/**
 * Providers that do not report an account id force us to decide *locally* whether two
 * measurements belong to the same account. We only ever read metadata or verifiable
 * tokens — never credential contents — and prefer splitting history over merging two
 * accounts silently.
 */
export class LocalIdentity {
  private keys: JsonWebKey[] = [];
  private keysExpire = 0;

  constructor(private readonly home = config.home) {}

  /** File metadata only: no credential bytes enter the service or the database. */
  credentialSignature(provider: Provider): string | null {
    const files: Partial<Record<Provider, string>> = {
      antigravity: config.identityFiles.antigravityToken,
      claude: config.identityFiles.claudeCredentials,
    };
    const file = files[provider];
    if (!file) return null;
    try {
      const s = statSync(path.join(this.home, file));
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    } catch {
      return null;
    }
  }

  /** Claude: the stable account UUID from the read-only profile mount. */
  profileAccount(provider: Provider): string | null {
    if (provider !== 'claude') return null;
    try {
      const profile = JSON.parse(readFileSync(config.identityFiles.claudeProfile, 'utf8'));
      const id = profile?.oauthAccount?.accountUuid;
      return typeof id === 'string' && /^[a-f0-9-]{30,40}$/i.test(id) ? hash(`claude|${id}`) : null;
    } catch {
      return null;
    }
  }

  /** Antigravity: signature-verified Google subject of the local ID token. */
  async googleAccount(provider: Provider): Promise<string | null> {
    if (provider !== 'antigravity') return null;
    try {
      if (Date.now() > this.keysExpire) {
        const response = await fetch(config.googleJwksUrl, {signal: AbortSignal.timeout(5000)});
        if (!response.ok) throw new Error('jwks_unavailable');
        this.keys = ((await response.json()) as {keys: JsonWebKey[]}).keys;
        this.keysExpire = Date.now() + 3_600_000;
      }
      const token = JSON.parse(readFileSync(path.join(this.home, config.identityFiles.antigravityToken), 'utf8'));
      return googleSubject(token.id_token, this.keys, Date.now());
    } catch {
      return null;
    }
  }
}
