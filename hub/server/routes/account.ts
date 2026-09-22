import type {FastifyInstance, FastifyReply} from 'fastify';
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
import type {Board} from '../store/directory.js';
import {parseView} from '../domain/view.js';
import {currentUser, Limiter, publicOrigin, sessionSecret, setSession} from '../session.js';

type Body = Record<string, unknown>;
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const isOwner = (board: Board) => board.role === 'owner';
const forbidden = (reply: FastifyReply) => reply.code(403).send({error: 'forbidden'});
const notFound = (reply: FastifyReply) => reply.code(404).send({error: 'not_found'});

/**
 * Signing up and in, boards and their members, invites, tokens and devices, approving
 * device codes. On a board every member sees everything and manages their own tokens
 * and devices; the owner manages everything, invites people and removes sources.
 */
export function accountRoutes(app: FastifyInstance, hub: Hub, guards: Guards) {
  const {directory, store, pairing, setup} = hub;
  const logins = new Limiter(10, 15 * 60_000);
  const signups = new Limiter(10, 60 * 60_000);
  const lookups = new Limiter(30, 60_000);

  const signIn = (request: Parameters<typeof setSession>[0], reply: Parameters<typeof setSession>[1], userId: string) => {
    const secret = newSecret('qt_s');
    directory.createSession(secret, userId, Date.now(), config.auth.sessionTtlMs);
    setSession(request, reply, secret);
  };

  app.get('/api/session', request => {
    const user = currentUser(request, directory);
    const first = directory.userCount() === 0;
    return {user, boards: user ? directory.boards(user.id) : [], signup: {first, open: first || config.auth.signup === 'open'}};
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
    if (first && !setup.matches(request.body?.setupCode)) return reply.code(403).send({error: 'invalid_setup_code'});
    if (!first && config.auth.signup !== 'open' && !board) return reply.code(403).send({error: 'signup_closed'});
    if (directory.credentials(email)) return reply.code(409).send({error: 'email_taken'});

    const user = directory.createUser(email, name, await hashPassword(password), now);
    if (first) setup.done();
    if (board) directory.addMember(board.id, user.id, now);
    signIn(request, reply, user.id);
    return {user, boards: directory.boards(user.id), joined: board?.id ?? null};
  });

  app.post<{Body: Body}>('/api/auth/login', async (request, reply) => {
    const email = normalizeEmail(str(request.body?.email));
    if (!logins.allow(`ip:${request.ip}`) || !logins.allow(`email:${email}`)) return reply.code(429).send({error: 'too_many_attempts'});
    const found = directory.credentials(email);
    const valid = found ? await verifyPassword(str(request.body?.password), found.password) : false;
    if (!found || !valid) return reply.code(401).send({error: 'invalid_credentials'});
    // Signing in from an invite link joins the board at once.
    const now = Date.now();
    const board = str(request.body?.invite) ? directory.inviteBoard(str(request.body?.invite), now) : null;
    if (board) directory.addMember(board.id, found.user.id, now);
    signIn(request, reply, found.user.id);
    return {user: found.user, boards: directory.boards(found.user.id), joined: board?.id ?? null};
  });

  /** Changing one's name needs nothing more; a new email or password needs the current password. */
  app.post<{Body: Body}>('/api/account', async (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    if (!logins.allow(`account:${user.id}`)) return reply.code(429).send({error: 'too_many_attempts'});
    const body = request.body ?? {};
    const change: {name?: string; email?: string; passwordHash?: string} = {};
    if (body.name !== undefined) {
      const name = str(body.name).trim();
      if (!validName(name)) return reply.code(400).send({error: 'invalid_input'});
      change.name = name;
    }
    const email = body.email !== undefined ? normalizeEmail(str(body.email)) : undefined;
    const password = body.password !== undefined ? str(body.password) : undefined;
    if ((email !== undefined && email !== user.email) || password !== undefined) {
      const stored = directory.credentials(user.email)!;
      if (!(await verifyPassword(str(body.currentPassword), stored.password))) return reply.code(403).send({error: 'invalid_credentials'});
      if (email !== undefined && email !== user.email) {
        if (!validEmail(email)) return reply.code(400).send({error: 'invalid_input'});
        if (directory.credentials(email)) return reply.code(409).send({error: 'email_taken'});
        change.email = email;
      }
      if (password !== undefined) {
        if (!validPassword(password)) return reply.code(400).send({error: 'invalid_input'});
        change.passwordHash = await hashPassword(password);
      }
    }
    directory.updateUser(user.id, change, sessionSecret(request));
    return {user: directory.user(user.id)};
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
    if (!validName(name)) return reply.code(400).send({error: 'invalid_name'});
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
    if (!isOwner(access.board) || access.board.personal) return forbidden(reply);
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

  app.post<{Params: {board: string}; Body: Body}>('/api/boards/:board', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    if (!isOwner(access.board)) return forbidden(reply);
    // A personal board may go back to its default name (in the reader's language); a shared one needs a name.
    const name = str(request.body?.name).trim();
    if (!(name ? validName(name) : access.board.personal)) return reply.code(400).send({error: 'invalid_name'});
    directory.renameBoard(access.board.id, name);
    return {...access.board, name};
  });

  // ---------- views ----------

  // The owner arranges a board for everyone on it, as a dashboard is in Grafana.
  app.post<{Params: {board: string}}>('/api/boards/:board/view', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    if (!isOwner(access.board)) return forbidden(reply);
    const view = parseView(request.body);
    if (!view) return reply.code(400).send({error: 'invalid_request'});
    directory.saveView(access.board.id, view, access.user.id, Date.now());
    return view;
  });

  // ---------- board tokens ----------

  app.get<{Params: {board: string}}>('/api/boards/:board/tokens', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    return directory
      .tokens(access.board.id)
      .map(({createdBy, boardId, ...token}) => ({...token, mine: createdBy === access.user.id}));
  });

  app.post<{Params: {board: string}; Body: Body}>('/api/boards/:board/tokens', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    // A token without a name is shown under a default one in the reader's language.
    const name = str(request.body?.name).trim();
    if (name && !validName(name)) return reply.code(400).send({error: 'invalid_name'});
    const secret = newSecret('qt_b');
    const {createdBy, boardId, ...token} = directory.createToken(secret, secretHint(secret), access.board.id, name, access.user.id, Date.now());
    // The secret is shown once; only its hash is kept.
    return {...token, createdByName: access.user.name, mine: true, secret};
  });

  app.delete<{Params: {board: string; token: string}}>('/api/boards/:board/tokens/:token', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    const token = directory.tokens(access.board.id).find(t => t.id === request.params.token);
    if (!token) return notFound(reply);
    if (!isOwner(access.board) && token.createdBy !== access.user.id) return forbidden(reply);
    directory.revokeToken(access.board.id, token.id, Date.now());
    return {ok: true};
  });

  // ---------- devices ----------

  app.get<{Params: {board: string}}>('/api/boards/:board/devices', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    const delivered = store.deviceSources(access.board.id);
    const failures = store.deviceFailures(access.board.id);
    return directory.devices(access.board.id).map(device => ({
      id: device.id,
      name: device.name,
      os: device.os,
      arch: device.arch,
      agent: device.agent,
      owner: device.owner,
      via: device.byCode ? 'code' : 'token',
      lastSeenAt: device.lastSeenAt,
      mine: device.ownerUserId === access.user.id,
      sources: delivered.filter(d => d.device === device.id).map(({provider, source, seenAt}) => ({provider, source, seenAt})),
      failures: failures.filter(f => f.device === device.id).map(({provider, error, detail, at}) => ({provider, error, detail, at})),
    }));
  });

  app.delete<{Params: {board: string; device: string}}>('/api/boards/:board/devices/:device', (request, reply) => {
    const access = guards.board(request, reply, request.params.board);
    if (!access) return reply;
    const device = directory.devices(access.board.id).find(d => d.id === request.params.device);
    if (!device) return notFound(reply);
    if (!isOwner(access.board) && device.ownerUserId !== access.user.id) return forbidden(reply);
    directory.revokeDevice(access.board.id, device.id, Date.now());
    return {ok: true};
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

  app.post<{Body: Body}>('/api/device/:decision', (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const decision = (request.params as {decision: string}).decision;
    if (decision !== 'approve' && decision !== 'deny') return notFound(reply);
    if (!lookups.allow(`user:${user.id}`)) return reply.code(429).send({error: 'too_many_attempts'});
    const approve = decision === 'approve';
    const ok = pairing.decide(request.body?.code, approve, user.id, approve ? str(request.body?.board) || null : null);
    return ok ? {ok: true} : reply.code(400).send({error: 'invalid_code'});
  });
}
