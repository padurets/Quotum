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
 * Signing up and in; each person's machines (devices, machine tokens, approving device
 * codes); boards, their members and invites, and what is shared with them. Measurements
 * are their people's: a person's devices fill their personal board, and they share
 * subscriptions with the shared boards they are on. The owner of a shared board
 * arranges and names it, invites and removes people, takes things off it, deletes it.
 */
export function accountRoutes(app: FastifyInstance, hub: Hub, guards: Guards) {
  const {directory, store, pairing, setup, local} = hub;
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
    const first = !local && directory.userCount() === 0;
    const signup = {first, open: !local && (first || config.auth.signup === 'open')};
    return {user, boards: user ? directory.boards(user.id) : [], signup, local: !!local};
  });

  // The desktop app's hub has one person who never signs in, one board and nobody to
  // share it with: signing up and in, boards of several people, their invites and what is
  // shared are not there.
  if (!local) {
    // Only refused sign-ups and sign-ins count against the limits: a team behind one address signs in freely.
    app.post<{Body: Body}>('/api/auth/signup', async (request, reply) => {
      if (signups.blocked(request.ip)) return reply.code(429).send({error: 'too_many_attempts'});
      const refuse = (status: number, error: string) => (signups.record(request.ip), reply.code(status).send({error}));
      const email = normalizeEmail(str(request.body?.email));
      const name = str(request.body?.name).trim();
      const password = str(request.body?.password);
      const invite = str(request.body?.invite);
      if (!validEmail(email) || !validName(name) || !validPassword(password)) return reply.code(400).send({error: 'invalid_input'});
      const now = Date.now();
      const board = invite ? directory.inviteBoard(invite, now) : null;
      if (invite && !board) return refuse(400, 'invalid_invite');
      const first = directory.userCount() === 0;
      if (first && !setup.matches(request.body?.setupCode)) return refuse(403, 'invalid_setup_code');
      if (!first && config.auth.signup !== 'open' && !board) return refuse(403, 'signup_closed');
      if (directory.credentials(email)) return refuse(409, 'email_taken');

      const user = directory.createUser(email, name, await hashPassword(password), now);
      if (first) setup.done();
      if (board) directory.addMember(board.id, user.id, now);
      signIn(request, reply, user.id);
      return {user, boards: directory.boards(user.id), joined: board?.id ?? null};
    });

    app.post<{Body: Body}>('/api/auth/login', async (request, reply) => {
      const email = normalizeEmail(str(request.body?.email));
      const keys = [`ip:${request.ip}`, `email:${email}`];
      if (keys.some(key => logins.blocked(key))) return reply.code(429).send({error: 'too_many_attempts'});
      const found = directory.credentials(email);
      const valid = found ? await verifyPassword(str(request.body?.password), found.password) : false;
      if (!found || !valid) {
        for (const key of keys) logins.record(key);
        return reply.code(401).send({error: 'invalid_credentials'});
      }
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
      if (logins.blocked(`account:${user.id}`)) return reply.code(429).send({error: 'too_many_attempts'});
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
        if (!(await verifyPassword(str(body.currentPassword), stored.password))) {
          logins.record(`account:${user.id}`);
          return reply.code(403).send({error: 'wrong_password'});
        }
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

    // ---------- boards, members, invites ----------

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

    // Someone leaves (a member) or is removed (by the owner); what they shared goes with them.
    const removeMember = (board: string, userId: string) =>
      directory.transaction(() => {
        directory.removeMember(board, userId);
        store.unshareOrphans(board);
      });

    app.delete<{Params: {board: string; user: string}}>('/api/boards/:board/members/:user', (request, reply) => {
      const access = guards.board(request, reply, request.params.board);
      if (!access) return reply;
      if (!isOwner(access.board) || access.board.personal) return forbidden(reply);
      if (request.params.user === access.user.id || !directory.membership(access.board.id, request.params.user)) return notFound(reply);
      removeMember(access.board.id, request.params.user);
      return {ok: true};
    });

    app.post<{Params: {board: string}}>('/api/boards/:board/leave', (request, reply) => {
      const access = guards.board(request, reply, request.params.board);
      if (!access) return reply;
      if (isOwner(access.board) || access.board.personal) return forbidden(reply);
      removeMember(access.board.id, access.user.id);
      return {ok: true};
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

    // Every link given out so far stops working: for a link that went further than meant.
    app.delete<{Params: {board: string}}>('/api/boards/:board/invites', (request, reply) => {
      const access = guards.board(request, reply, request.params.board);
      if (!access) return reply;
      if (!isOwner(access.board) || access.board.personal) return forbidden(reply);
      return {revoked: directory.revokeInvites(access.board.id)};
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

    // Everyone has a personal board, so only a shared one can go, by its owner's hand.
    app.delete<{Params: {board: string}}>('/api/boards/:board', (request, reply) => {
      const access = guards.board(request, reply, request.params.board);
      if (!access) return reply;
      if (!isOwner(access.board) || access.board.personal) return forbidden(reply);
      const id = access.board.id;
      directory.transaction(() => {
        store.removeBoard(id);
        directory.deleteBoard(id);
      });
      return {ok: true};
    });
  }

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

  // ---------- sharing ----------

  if (!local) {
    /**
     * What is shared with a board, and what the reader could share: every subscription
     * their devices measure. Personal boards show all of their person's by themselves.
     */
    app.get<{Params: {board: string}}>('/api/boards/:board/shares', (request, reply) => {
      const access = guards.board(request, reply, request.params.board);
      if (!access) return reply;
      if (access.board.personal) return forbidden(reply);
      const names = new Map(directory.members(access.board.id).map(m => [m.id, m.name]));
      const shared = store.sources(access.board.id);
      const ids = new Set(shared.map(s => s.id));
      return {
        shared: shared.map(s => ({
          source: s.id,
          provider: s.provider,
          sharedBy: s.sharedBy ? (names.get(s.sharedBy) ?? '') : '',
          mine: s.holders.includes(access.user.id),
        })),
        // With the reader's devices that measure each: two accounts of one provider are told apart by them.
        mine: store.held(access.user.id).map(s => ({
          source: s.id,
          provider: s.provider,
          shared: ids.has(s.id),
          devices: store
            .deviceSources(access.user.id)
            .filter(d => d.source === s.id)
            .flatMap(d => {
              const device = directory.deviceById(d.device);
              return device ? [device.label ?? device.name] : [];
            }),
        })),
      };
    });

    // Those whose devices measure a subscription share it with the shared boards they are on.
    app.post<{Params: {board: string}; Body: Body}>('/api/boards/:board/shares', (request, reply) => {
      const access = guards.board(request, reply, request.params.board);
      if (!access) return reply;
      if (access.board.personal) return forbidden(reply);
      const source = str(request.body?.source);
      if (!store.holds(access.user.id, source)) return notFound(reply);
      store.share(access.board.id, source, access.user.id, Date.now());
      return {ok: true};
    });

    // Taken off a board by those who measure it, or by the board's owner.
    app.delete<{Params: {board: string; source: string}}>('/api/boards/:board/shares/:source', (request, reply) => {
      const access = guards.board(request, reply, request.params.board);
      if (!access) return reply;
      if (access.board.personal) return forbidden(reply);
      const {source} = request.params;
      if (!isOwner(access.board) && !store.holds(access.user.id, source)) return forbidden(reply);
      return store.unshare(access.board.id, source) ? {ok: true} : notFound(reply);
    });
  }

  // ---------- one's machines: devices and machine tokens ----------

  app.get('/api/devices', (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const delivered = store.deviceSources(user.id);
    const failures = store.deviceFailures(user.id);
    return directory.devices(user.id).map(device => ({
      id: device.id,
      name: device.label ?? device.name,
      reported: device.name,
      os: device.os,
      arch: device.arch,
      agent: device.agent,
      via: device.byCode ? 'code' : 'token',
      lastSeenAt: device.lastSeenAt,
      sources: delivered.filter(d => d.device === device.id).map(({provider, source, seenAt}) => ({provider, source, seenAt})),
      failures: failures.filter(f => f.device === device.id).map(({provider, error, detail, at}) => ({provider, error, detail, at})),
    }));
  });

  // A device is named on the hub; an empty name gives it back the one its machine reports.
  app.post<{Params: {device: string}; Body: Body}>('/api/devices/:device', (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    const name = str(request.body?.name).trim();
    if (name && !validName(name)) return reply.code(400).send({error: 'invalid_name'});
    return directory.renameDevice(user.id, request.params.device, name) ? {ok: true} : notFound(reply);
  });

  // Nor are, on it, disconnecting its one machine (the app's own agent), machine tokens and
  // approving device codes: no other machine connects to it.
  if (!local) {
    app.delete<{Params: {device: string}}>('/api/devices/:device', (request, reply) => {
      const user = guards.user(request, reply);
      if (!user) return reply;
      const revoked = directory.transaction(() => directory.revokeDevice(user.id, request.params.device, Date.now()) && (store.releaseRevoked(user.id), true));
      if (revoked) hub.ingest.live.forget([request.params.device]);
      return revoked ? {ok: true} : notFound(reply);
    });

    app.get('/api/tokens', (request, reply) => {
      const user = guards.user(request, reply);
      if (!user) return reply;
      return directory.tokens(user.id).map(({userId, ...token}) => token);
    });

    app.post<{Body: Body}>('/api/tokens', (request, reply) => {
      const user = guards.user(request, reply);
      if (!user) return reply;
      // A token without a name is shown under a default one in the reader's language.
      const name = str(request.body?.name).trim();
      if (name && !validName(name)) return reply.code(400).send({error: 'invalid_name'});
      const secret = newSecret('qt_m');
      const {userId, ...token} = directory.createToken(secret, secretHint(secret), user.id, name, Date.now());
      // The secret is shown once; only its hash is kept.
      return {...token, secret};
    });

    app.delete<{Params: {token: string}}>('/api/tokens/:token', (request, reply) => {
      const user = guards.user(request, reply);
      if (!user) return reply;
      // Its machines are disconnected with it, and take along what only they measured.
      const revoked = directory.transaction(() => directory.revokeToken(user.id, request.params.token, Date.now()) && (store.releaseRevoked(user.id), true));
      if (revoked) hub.ingest.live.forget(directory.devicesOfToken(request.params.token));
      return revoked ? {ok: true} : notFound(reply);
    });

    // ---------- approving a device code ----------

    app.get<{Querystring: {code?: string}}>('/api/device', (request, reply) => {
      const user = guards.user(request, reply);
      if (!user) return reply;
      if (!lookups.allow(`user:${user.id}`)) return reply.code(429).send({error: 'too_many_attempts'});
      const pending = pairing.pending(request.query.code);
      if (!pending) return reply.code(404).send({error: 'invalid_code'});
      return {userCode: pending.userCode, machine: pending.machine, expiresAt: pending.expiresAt};
    });

    app.post<{Body: Body}>('/api/device/:decision', (request, reply) => {
      const user = guards.user(request, reply);
      if (!user) return reply;
      const decision = (request.params as {decision: string}).decision;
      if (decision !== 'approve' && decision !== 'deny') return notFound(reply);
      if (!lookups.allow(`user:${user.id}`)) return reply.code(429).send({error: 'too_many_attempts'});
      const ok = pairing.decide(request.body?.code, decision === 'approve', user.id);
      return ok ? {ok: true} : reply.code(400).send({error: 'invalid_code'});
    });
  }
}
