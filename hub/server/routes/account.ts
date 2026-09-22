import type {FastifyInstance} from 'fastify';
import {config} from '../config.js';
import {
  hashPassword,
  newSecret,
  normalizeEmail,
  secretHint,
  validEmail,
  validName,
  validPassword,
  verifyPassword,
} from '../domain/auth.js';
import type {Guards, Hub} from '../api.js';
import {Limiter, publicOrigin, sessionSecret, setSession} from '../session.js';

type Body = Record<string, unknown>;
const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** Signing up and in, boards and their members, invites, tokens and devices, approving device codes. */
export function accountRoutes(app: FastifyInstance, hub: Hub, guards: Guards) {
  const {directory, store, pairing} = hub;
  const logins = new Limiter(10, 15 * 60_000);
  const signups = new Limiter(10, 60 * 60_000);
  const lookups = new Limiter(30, 60_000);

  const signIn = (request: Parameters<typeof setSession>[0], reply: Parameters<typeof setSession>[1], userId: string) => {
    const secret = newSecret('qt_s');
    directory.createSession(secret, userId, Date.now(), config.auth.sessionTtlMs);
    setSession(request, reply, secret);
  };

  app.get('/api/session', request => {
    const secret = sessionSecret(request);
    const user = secret ? directory.sessionUser(secret, Date.now()) : null;
    const first = directory.userCount() === 0;
    return {
      user,
      boards: user ? directory.boards(user.id) : [],
      signup: {first, open: first || config.auth.signup === 'open'},
    };
  });

  app.post<{Body: Body}>('/api/auth/signup', async (request, reply) => {
    if (!signups.allow(request.ip)) return reply.code(429).send({error: 'too_many_attempts'});
    const email = normalizeEmail(str(request.body?.email));
    const name = str(request.body?.name).trim();
    const password = str(request.body?.password);
    const invite = str(request.body?.invite);
    if (!validEmail(email) || !validName(name) || !validPassword(password)) return reply.code(400).send({error: 'invalid_input'});
    const now = Date.now();
    const board = invite ? directory.inviteBoard(invite, now) : null;
    if (invite && !board) return reply.code(400).send({error: 'invalid_invite'});
    const first = directory.userCount() === 0;
    if (!first && config.auth.signup !== 'open' && !board) return reply.code(403).send({error: 'signup_closed'});
    if (directory.credentials(email)) return reply.code(409).send({error: 'email_taken'});

    const user = directory.createUser(email, name, await hashPassword(password), now);
    if (board) directory.addMember(board.id, user.id, now);
    signIn(request, reply, user.id);
    return {user, boards: directory.boards(user.id)};
  });

  app.post<{Body: Body}>('/api/auth/login', async (request, reply) => {
    const email = normalizeEmail(str(request.body?.email));
    if (!logins.allow(`ip:${request.ip}`) || !logins.allow(`email:${email}`)) return reply.code(429).send({error: 'too_many_attempts'});
    const found = directory.credentials(email);
    const valid = found ? await verifyPassword(str(request.body?.password), found.password) : false;
    if (!found || !valid) return reply.code(401).send({error: 'invalid_credentials'});
    signIn(request, reply, found.user.id);
    return {user: found.user, boards: directory.boards(found.user.id)};
  });

  app.post('/api/auth/logout', (request, reply) => {
    const secret = sessionSecret(request);
    if (secret) directory.deleteSession(secret);
    setSession(request, reply, null);
    return {ok: true};
  });

  // ---------- boards and invites ----------

  app.post<{Body: Body}>('/api/boards', (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const name = str(request.body?.name).trim();
    if (!validName(name)) return reply.code(400).send({error: 'invalid_input'});
    return directory.createBoard(name, user.id, Date.now());
  });

  app.get<{Params: {board: string}}>('/api/boards/:board/members', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    return directory.members(access.board.id).map(({id, name, email, boardRole}) => ({id, name, email, role: boardRole}));
  });

  app.post<{Params: {board: string}}>('/api/boards/:board/invites', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    const secret = newSecret('qt_i');
    const now = Date.now();
    directory.createInvite(secret, access.board.id, access.user.id, now, config.auth.inviteTtlMs);
    return {url: `${publicOrigin(request)}/invite/${secret}`, expiresAt: now + config.auth.inviteTtlMs};
  });

  app.get<{Params: {invite: string}}>('/api/invites/:invite', (request, reply) => {
    if (!lookups.allow(request.ip)) return reply.code(429).send({error: 'too_many_attempts'});
    const board = directory.inviteBoard(request.params.invite, Date.now());
    return board ? {board: {name: board.name}} : reply.code(404).send({error: 'invalid_invite'});
  });

  app.post<{Params: {invite: string}}>('/api/invites/:invite/accept', (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const now = Date.now();
    const board = directory.inviteBoard(request.params.invite, now);
    if (!board) return reply.code(404).send({error: 'invalid_invite'});
    directory.addMember(board.id, user.id, now);
    return {board: directory.boards(user.id).find(b => b.id === board.id)};
  });

  // ---------- board tokens ----------

  app.get<{Params: {board: string}}>('/api/boards/:board/tokens', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    return directory.tokens(access.board.id);
  });

  app.post<{Params: {board: string}; Body: Body}>('/api/boards/:board/tokens', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    const name = str(request.body?.name).trim() || 'Token';
    if (!validName(name)) return reply.code(400).send({error: 'invalid_input'});
    const secret = newSecret('qt_b');
    const token = directory.createToken(secret, secretHint(secret), access.board.id, name, access.user.id, Date.now());
    // The secret is shown once; only its hash is kept.
    return {...token, createdByName: access.user.name, secret};
  });

  app.delete<{Params: {board: string; token: string}}>('/api/boards/:board/tokens/:token', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    return directory.revokeToken(access.board.id, request.params.token, Date.now()) ? {ok: true} : reply.code(404).send({error: 'not_found'});
  });

  // ---------- devices ----------

  app.get<{Params: {board: string}}>('/api/boards/:board/devices', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    const delivered = store.deviceSources(access.board.id);
    return directory.devices(access.board.id).map(device => ({
      ...device,
      via: device.tokenId ? 'token' : 'code',
      sources: delivered.filter(d => d.device === device.id).map(({provider, source, seenAt}) => ({provider, source, seenAt})),
    }));
  });

  app.delete<{Params: {board: string; device: string}}>('/api/boards/:board/devices/:device', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    return directory.revokeDevice(access.board.id, request.params.device, Date.now()) ? {ok: true} : reply.code(404).send({error: 'not_found'});
  });

  // ---------- approving a device code ----------

  app.get<{Querystring: {code?: string}}>('/api/device', (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    if (!lookups.allow(`user:${user.id}`)) return reply.code(429).send({error: 'too_many_attempts'});
    const pending = pairing.pending(request.query.code);
    if (!pending) return reply.code(404).send({error: 'invalid_code'});
    return {userCode: pending.userCode, machine: pending.machine, expiresAt: pending.expiresAt, boards: directory.boards(user.id)};
  });

  app.post<{Body: Body}>('/api/device/approve', (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const ok = pairing.decide(request.body?.code, true, user.id, str(request.body?.board) || null);
    return ok ? {ok: true} : reply.code(400).send({error: 'invalid_code'});
  });

  app.post<{Body: Body}>('/api/device/deny', (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    return pairing.decide(request.body?.code, false, user.id, null) ? {ok: true} : reply.code(400).send({error: 'invalid_code'});
  });
}
