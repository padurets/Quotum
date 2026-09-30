import type {FastifyInstance} from 'fastify';
import type {Guards} from '../api.js';
import {Limiter, sameSite} from '../session.js';
import {SecretError, type Credentials} from '../secrets/index.js';

export async function credentialRoutes(app: FastifyInstance, credentials: Credentials, guards: Guards) {
  const attempts = new Limiter(10, 60_000);
  app.setErrorHandler((error: {statusCode?: number}, _request, reply) => {
    const code = error instanceof SecretError ? error.code : error.statusCode === 413 ? 'credential_invalid' : error.statusCode && error.statusCode < 500 ? 'credential_invalid' : 'credential_failed';
    const status = code === 'credential_not_found' ? 404 : code === 'credential_cleanup_pending' ? 503 : code === 'secret_key_missing' || code === 'secret_key_mismatch' ? 409 : code === 'credential_invalid' || code === 'credential_provider_unknown' ? 400 : 500;
    return reply.code(status).send({error: code});
  });
  app.addHook('onRequest', async (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    if (request.method === 'GET') return;
    const origin = request.headers.origin;
    if (!origin || !sameSite(origin, request)) return reply.code(403).send({error: 'forbidden_origin'});
    const keys = [`user:${user.id}`, `ip:${request.ip}`];
    if (keys.some(key => attempts.blocked(key))) return reply.header('Retry-After', '60').code(429).send({error: 'too_many_attempts'});
    for (const key of keys) attempts.record(key);
  });
  const body = (value: unknown, names: readonly string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || !names.every(name => Object.hasOwn(value, name))) throw new SecretError('credential_invalid');
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
  app.post('/api/credentials', {bodyLimit: 32 * 1024}, (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const input = body(request.body, ['provider', 'secret']);
    if (typeof input.provider !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.provider)) throw new SecretError('credential_invalid');
    return reply.code(201).send(credentials.create(user.id, input.provider, input.secret));
  });
  app.post<{Params: {id: string}}>('/api/credentials/:id', {bodyLimit: 32 * 1024}, (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const input = body(request.body, ['secret']);
    return credentials.replace(user.id, id(request.params.id), input.secret);
  });
  app.delete<{Params: {id: string}}>('/api/credentials/:id', (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    credentials.remove(user.id, id(request.params.id));
    return reply.code(204).send();
  });
}
