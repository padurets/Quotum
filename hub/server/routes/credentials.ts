import type {FastifyInstance} from 'fastify';
import type {Guards} from '../api.js';
import {Limiter, sameSite} from '../session.js';
import {SecretError, type Credentials} from '../secrets/index.js';

export async function credentialRoutes(app: FastifyInstance, credentials: Credentials, guards: Guards) {
  const attempts = new Limiter(10, 60_000);
  app.setErrorHandler((error: {statusCode?: number}, request, reply) => {
    const code = error instanceof SecretError ? error.code : error.statusCode === 413 ? 'credential_invalid' : error.statusCode && error.statusCode < 500 ? 'credential_invalid' : 'credential_failed';
    const status = code === 'credential_not_found' ? request.method==='POST' && request.routeOptions.url==='/api/credentials' ? 409 : 404 : code === 'credential_cleanup_pending' ? 503 : ['secret_key_missing','secret_key_mismatch','credential_expiry_confirmation','credential_account_confirmation','credential_account_mismatch','credential_conflict'].includes(code) ? 409 : ['credential_auth_rejected','credential_invalid','credential_provider_unknown','credential_expired','credential_revoked','credential_wrong_type','credential_permission'].includes(code) ? 400 : 500;
    return reply.code(status).send({error: code,...(code==='credential_expiry_confirmation'?{expiresAt:null,expiryKind:error instanceof SecretError?error.expiryKind??'none':'none'}:{})});
  });
  app.addHook('onRequest', async (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    if (request.method === 'GET') return;
    const origin = request.headers.origin;
    let valid = false;
    try { const parsed = new URL(origin ?? ''); valid = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin && !parsed.username && !parsed.password; } catch { /* Invalid Origin. */ }
    if (!valid || !sameSite(origin!, request)) return reply.code(403).send({error: 'forbidden_origin'});
    const keys = [`user:${user.id}`, `ip:${request.ip}`];
    if (keys.some(key => attempts.blocked(key))) return reply.header('Retry-After', '60').code(429).send({error: 'too_many_attempts'});
    for (const key of keys) attempts.record(key);
  });
  const body = (value: unknown, names: readonly string[], optional:readonly string[]=[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).every(name=>names.includes(name)||optional.includes(name)) || !names.every(name => Object.hasOwn(value, name))) throw new SecretError('credential_invalid');
    const input=value as Record<string,unknown>;
    if(['allowNoExpiry','allowUnknownExpiry','sameAccount'].some(name=>input[name]!==undefined&&typeof input[name]!=='boolean')||input.requestId!==undefined&&(typeof input.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId)))throw new SecretError('credential_invalid');
    return value as Record<string, unknown>;
  };
  const id = (value: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new SecretError('credential_invalid');
    return value;
  };
  app.get('/api/credentials', (request, reply) => {
    const user = guards.user(request, reply);
    return user ? {credentials: credentials.list(user.id)} : reply;
  });
  app.post('/api/credentials', {bodyLimit: 32 * 1024}, async (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const input = body(request.body, ['provider', 'secret'],['allowNoExpiry','allowUnknownExpiry','requestId']);
    if (typeof input.provider !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.provider) || typeof input.secret !== 'string') throw new SecretError('credential_invalid');
    return reply.code(201).send(await credentials.create(user.id, input.provider, input.secret,{allowNoExpiry:input.allowNoExpiry as boolean|undefined,allowUnknownExpiry:input.allowUnknownExpiry as boolean|undefined,requestId:input.requestId as string|undefined}));
  });
  app.post<{Params: {id: string}}>('/api/credentials/:id', {bodyLimit: 32 * 1024}, (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const input = body(request.body, ['secret'],['allowNoExpiry','allowUnknownExpiry','sameAccount']);
    if (typeof input.secret !== 'string') throw new SecretError('credential_invalid');
    return credentials.replace(user.id, id(request.params.id), input.secret,{allowNoExpiry:input.allowNoExpiry as boolean|undefined,allowUnknownExpiry:input.allowUnknownExpiry as boolean|undefined,sameAccount:input.sameAccount as boolean|undefined});
  });
  app.delete<{Params: {id: string}}>('/api/credentials/:id', {bodyLimit: 32 * 1024}, (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    if (request.body !== undefined) throw new SecretError('credential_invalid');
    credentials.remove(user.id, id(request.params.id));
    return reply.code(204).send();
  });
}
