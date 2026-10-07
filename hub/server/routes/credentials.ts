import type {FastifyInstance} from 'fastify';
import type {Guards} from '../api.js';
import {Limiter, sameSite} from '../session.js';
import {UUID,type AccountTarget} from '../store/sourceAccounts.js';
import {SecretError, type Credentials} from '../secrets/index.js';
import {AdditionError, type BoardAdditions} from '../additions.js';
import {randomUUID} from 'node:crypto';
import {currentUser} from '../session.js';
import type {Directory} from '../store/directory.js';

export async function credentialRoutes(app: FastifyInstance, credentials: Credentials, guards: Guards, attempts: Limiter, additions?: BoardAdditions, directory?: Directory) {
  app.setErrorHandler((error: {statusCode?: number}, request, reply) => {
    const code = error instanceof AdditionError ? error.code==='addition_not_found'?'credential_not_found':error.code==='addition_conflict'?'credential_conflict':error.code==='addition_permission'?'credential_permission':'credential_failed' : error instanceof SecretError ? error.code : error.statusCode === 413 ? 'credential_invalid' : error.statusCode && error.statusCode < 500 ? 'credential_invalid' : 'credential_failed';
    const status = code === 'declared_account_not_found'?404:code === 'credential_not_found' ? request.method==='POST' && request.routeOptions.url==='/api/credentials' ? 409 : 404 : code === 'credential_cleanup_pending' ? 503 : ['secret_key_missing','secret_key_mismatch','credential_expiry_confirmation','credential_account_mismatch','credential_conflict','credential_account_confirmation','declared_account_name_conflict'].includes(code) ? 409 : ['credential_invalid','credential_provider_unknown','credential_expired','credential_revoked','credential_wrong_type','credential_permission','credential_rejected','credential_auth_rejected'].includes(code) ? 400 : 500;
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
    if(['allowNoExpiry','allowUnknownExpiry','sameAccount'].some(k=>input[k]!==undefined&&typeof input[k]!=='boolean')||input.requestId!==undefined&&(typeof input.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId)))throw new SecretError('credential_invalid');
    return value as Record<string, unknown>;
  };
  const id = (value: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new SecretError('credential_invalid');
    return value;
  };
  app.get<{Querystring:{provider?:string;limit?:string;after?:string}}>('/api/source-accounts',(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    const q=request.query;
    if(Object.keys(q).some(k=>!['provider','limit','after'].includes(k))||q.limit!==undefined&&!/^[1-9][0-9]?$/.test(q.limit)||q.after!==undefined&&!UUID.test(q.after))throw new SecretError('credential_invalid');
    return credentials.listAccounts(user.id,q.provider??'',q.limit===undefined?undefined:Number(q.limit),q.after);
  });
  app.get('/api/credentials', (request, reply) => {
    const user = guards.user(request, reply);
    return user ? {credentials: credentials.details(user.id)} : reply;
  });
  app.get<{Params:{id:string}}>('/api/credentials/:id/placements',(request,reply)=>{
    const user=guards.user(request,reply);if(!user)return reply;
    return {placements:additions?.placements(user.id,id(request.params.id))??[]};
  });
  app.post('/api/credentials', {bodyLimit: 32 * 1024}, async (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const provider=(request.body as {provider?:unknown}|null)?.provider;
    const input = body(request.body, ['provider', 'secret'],provider==='deepseek'?['account','allowUnknownExpiry','sameAccount','requestId']:['allowNoExpiry','allowUnknownExpiry','requestId']);
    if (typeof input.provider !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.provider) || typeof input.secret !== 'string') throw new SecretError('credential_invalid');
    return reply.code(201).send(await credentials.create(user.id, input.provider, input.secret,{allowNoExpiry:input.allowNoExpiry as boolean|undefined,requestId:input.requestId as string|undefined,account:input.account as AccountTarget|undefined,allowUnknownExpiry:input.allowUnknownExpiry as boolean|undefined,sameAccount:input.sameAccount as boolean|undefined}));
  });
  app.post<{Params: {id: string}}>('/api/credentials/:id', {bodyLimit: 32 * 1024}, async (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const input = body(request.body, ['secret'],['allowNoExpiry','allowUnknownExpiry','sameAccount','requestId']);
    if (typeof input.secret !== 'string') throw new SecretError('credential_invalid');
    const credentialId=id(request.params.id);
    if(!additions)return credentials.replace(user.id,credentialId,input.secret,{allowNoExpiry:input.allowNoExpiry as boolean|undefined,allowUnknownExpiry:input.allowUnknownExpiry as boolean|undefined,sameAccount:input.sameAccount as boolean|undefined});
    const operation=additions.reserve(user.id,input.requestId as string|undefined??randomUUID(),null,{kind:'replace',credentialId});
    const result=await additions.run(user.id,operation.id,input.secret,()=>!!directory&&currentUser(request,directory)?.id===user.id,{allowUnknownExpiry:input.allowUnknownExpiry as boolean|undefined,sameAccount:input.sameAccount as boolean|undefined});
    if(result.state!=='complete')throw new SecretError(result.error as import('../secrets/crypto.js').SecretCode??'credential_failed');
    if(result.warning)return reply.code(503).send({error:result.warning,operationId:result.id,committed:true});
    const record=credentials.list(user.id).find(record=>record.id===credentialId);
    if(!record)return reply.code(404).send({error:'credential_not_found',operationId:result.id,committed:true});
    return {...record,operationId:result.id};
  });
  app.delete<{Params: {id: string}}>('/api/credentials/:id', {bodyLimit: 32 * 1024}, (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    if (request.body !== undefined) throw new SecretError('credential_invalid');
    credentials.remove(user.id, id(request.params.id));
    return reply.code(204).send();
  });
}
