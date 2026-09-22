import type {FastifyReply, FastifyRequest} from 'fastify';
import {config} from './config.js';
import type {Directory, User} from './store/directory.js';

const COOKIE = 'quotum_session';

function readCookie(request: FastifyRequest, name: string): string | null {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The address people open this hub at: the configured public URL, else what the
 * request says (through a proxy only when `QUOTUM_TRUST_PROXY` allows it).
 */
export function publicOrigin(request: FastifyRequest): string {
  return new URL(config.auth.publicUrl ?? `${request.protocol}://${request.host}`).origin;
}

export function sessionSecret(request: FastifyRequest): string | null {
  return readCookie(request, COOKIE);
}

export function setSession(request: FastifyRequest, reply: FastifyReply, secret: string | null) {
  const maxAge = secret ? Math.floor(config.auth.sessionTtlMs / 1000) : 0;
  const parts = [`${COOKIE}=${secret ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (publicOrigin(request).startsWith('https:')) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

export function currentUser(request: FastifyRequest, directory: Directory): User | null {
  const secret = sessionSecret(request);
  return secret ? directory.sessionUser(secret, Date.now()) : null;
}

/** Counts attempts per key in a sliding window; used against password and code guessing. */
export class Limiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records an attempt; false once the key has used up its window. */
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter(at => now - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.forget(now);
    return true;
  }

  /** Drops keys with no attempt left in the window. */
  private forget(now: number) {
    for (const [key, times] of this.hits) if (!times.some(at => now - at < this.windowMs)) this.hits.delete(key);
  }
}
