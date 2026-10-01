import {Attention} from './attention.js';
import {STATUS_CODES} from 'node:http';
import type {Socket} from 'node:net';
import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';
import staticFiles from '@fastify/static';
import {config, serviceName, version} from './config.js';
import type {Ingest} from './ingest.js';
import {HistoryTiles} from './history.js';
import {CLOCK_TOLERANCE_MS, MAX_READ_TILES, READ_CELLS, cellStart, tileOf, tileStart} from './domain/history.js';
import type {Pairing} from './pairing.js';
import type {ResetFeed} from './resets.js';
import type {Store} from './store/store.js';
import type {Board, Directory, User} from './store/directory.js';
import {CSP, currentUser, sameSite} from './session.js';
import type {Setup} from './setup.js';
import {Events} from './events.js';
import {Projection} from './projection.js';
import {accountRoutes} from './routes/account.js';
import {eventRoutes} from './routes/events.js';
import {agentRoutes} from './routes/agents.js';
import {localRoutes} from './local.js';
import {credentialRoutes} from './routes/credentials.js';
import {Credentials, startSecrets, type SecretInputs} from './secrets/index.js';

/**
 * `local`: the desktop app's hub, with the key its window enters with (see local.ts); null
 * on a server. `events`: what open dashboards hear, made here when not given.
 */
export type Hub = {store: Store; directory: Directory; resets: ResetFeed; ingest: Ingest; pairing: Pairing; setup: Setup; local: {key: string} | null; events?: Events; credentials?: Credentials; secretSnapshot?: Pick<SecretInputs, 'storageAtStart' | 'wasFileAtStart'>};

/** Route helpers shared by the route modules. */
export type Guards = {
  user(request: FastifyRequest, reply: FastifyReply): User | null;
  board(request: FastifyRequest, reply: FastifyReply, boardId: string | undefined): {user: User; board: Board} | null;
};

/** Errors of the framework itself (malformed JSON, a body too large…) in the hub's `{error}` shape. */
function errorCode(status: number, path: string): string {
  if (status === 413) return 'too_large';
  if (status >= 500) return 'internal_error';
  return path.startsWith('/v1/ingest') ? 'invalid_batch' : 'invalid_request';
}

/**
 * A request that never got as far as the hub's handlers (it took too long to arrive, its
 * headers were too large or it was not HTTP), answered in the hub's `{error}` shape
 * rather than the framework's, and its connection closed.
 */
function clientError(error: NodeJS.ErrnoException, socket: Socket & {_httpMessage?: {headersSent: boolean} | null}) {
  // A connection the other side reset has nothing left to answer.
  if (error.code === 'ECONNRESET' || socket.destroyed) return;
  const [status, code] =
    error.code === 'ERR_HTTP_REQUEST_TIMEOUT'
      ? [408, 'request_timeout']
      : error.code === 'HPE_HEADER_OVERFLOW'
        ? [431, 'headers_too_large']
        : [400, 'invalid_request'];
  const body = JSON.stringify({error: code});
  // As Node does: an answer already on its way is cut short rather than spliced with this one.
  if (socket.writable && !socket._httpMessage?.headersSent) {
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }
  socket.destroy(error);
}

/**
 * The HTTP surface. People sign in and read their boards under `/api`; agents talk to
 * `/v1` (device codes, check-ins, ingest). Everything else is the single-page client.
 * The desktop app's hub (`local`) has one person who never signs in: the window enters
 * at `/local`, and what is about accounts, sharing and connecting is not there.
 */
export async function buildApp(hub: Hub) {
  hub = {...hub, credentials: hub.credentials ?? new Credentials(hub.store.db, null, startSecrets(hub.store.db, {current: null, previous: null, reset: null, storageAtStart: null, wasFileAtStart: false}))};
  const {store, directory} = hub;
  const projection = new Projection(hub);
  const {requestTimeoutMs, checkMs} = config.http;
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    trustProxy: config.http.trustProxy,
    requestTimeout: requestTimeoutMs,
    // Once the headers are in, Node holds a request to the longer of its two limits (the headers' is 60 seconds by default).
    http: {headersTimeout: requestTimeoutMs, connectionsCheckingInterval: checkMs},
    clientErrorHandler: clientError,
    // Bad URLs and overlong parameters fail before a route's error boundary.
    frameworkErrors(error, _request, reply) {
      const status = (error as {statusCode?: number}).statusCode ?? 400;
      return (reply as FastifyReply).code(status >= 500 ? 500 : 400).send({error: status >= 500 ? 'internal_error' : 'invalid_request'});
    },
  });
  const hosts = new Set<string>(config.http.hosts);
  const anyHost = hosts.has('*');
  const history = new HistoryTiles(store);
  const events = hub.events ?? new Events(hub);
  events.onHistory = (source, since) => history.touch(source, since);
  events.attach();

  app.addHook('onRequest', async (request, reply) => {
    // The health check answers any host: a container asks it at 127.0.0.1 whatever the hub's own address.
    if (!anyHost && !hosts.has(request.hostname.toLowerCase()) && request.url !== '/health') return reply.code(403).send({error: 'forbidden_host'});
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const path = request.url.split('?')[0];
    const api = path.startsWith('/api/');
    const allowed = (request.method === 'POST' && (api || path.startsWith('/v1/'))) || (request.method === 'DELETE' && api);
    if (!allowed) return reply.code(405).send({error: 'method_not_allowed'});
    // Cookie-authenticated changes are accepted only from pages of this hub.
    const origin = request.headers.origin;
    if (api && origin && !sameSite(origin, request)) return reply.code(403).send({error: 'forbidden_origin'});
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const immutable = request.url.startsWith('/assets/') && reply.statusCode >= 200 && reply.statusCode < 300;
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', immutable ? 'public,max-age=31536000,immutable' : 'no-store')
      .header('Content-Security-Policy', CSP);
    return payload;
  });

  app.setErrorHandler((error: {statusCode?: number}, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) console.error(JSON.stringify({event: 'error', url: request.url.split('?')[0], message: String((error as Error).message)}));
    return reply.code(status).send({error: errorCode(status, request.url)});
  });

  const guards: Guards = {
    user(request, reply) {
      const user = currentUser(request, directory);
      if (!user) void reply.code(401).send({error: 'unauthorized'});
      return user;
    },
    board(request, reply, boardId) {
      const user = guards.user(request, reply);
      if (!user) return null;
      const boards = directory.boards(user.id);
      const board = boardId ? boards.find(b => b.id === boardId) : boards[0];
      if (!board) {
        void reply.code(404).send({error: 'board_not_found'});
        return null;
      }
      return {user, board};
    },
  };

  app.get('/health', () => ({status: 'ok', service: serviceName, version}));
  // With the resets the trackers reported as far back as the chart can be moved: over the history kept.
  app.get('/api/resets', () => projection.hubPart(Date.now()).value);

  // The board as a stream's `snapshot` gives it (spec/dashboard-v1.md), once: for whatever
  // reads a board at a moment rather than following it.
  app.get<{Querystring: {board?: string}}>('/api/overview', (request, reply) => {
    const access = guards.board(request, reply, request.query.board);
    if (!access) return reply;
    const snapshot = projection.snapshot(access.user.id, access.board.id, Date.now());
    hub.ingest.forecasts.save();
    return snapshot;
  });

  app.get<{Querystring: {cell?: string; from?: string; to?: string; board?: string}}>('/api/history', (request, reply) => {
    const access = guards.board(request, reply, request.query.board);
    if (!access) return reply;
    const now = Date.now();
    // Credit quiet machines before deciding whether their tiles can be reused.
    hub.ingest.live.sweep(now);
    const number = (value: string | undefined) => value && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
    const cell = number(request.query.cell);
    const from = number(request.query.from);
    const askedTo = number(request.query.to);
    if (!READ_CELLS.includes(cell) || !Number.isFinite(from) || !Number.isFinite(askedTo) || from % cell || (askedTo <= now && askedTo % cell)) return reply.code(400).send({error: 'invalid_request'});
    const to = Math.min(Math.ceil(askedTo / cell) * cell, cellStart(now + CLOCK_TOLERANCE_MS, cell) + cell);
    const oldest = tileStart(tileOf(now - config.retention.sampleDays * 86_400_000, cell), cell);
    if (to <= from || to % cell || from < oldest || tileOf(to - 1, cell) - tileOf(from, cell) + 1 > MAX_READ_TILES) return reply.code(400).send({error: 'invalid_request'});
    const board = access.board.id;
    const shown = store.shown(board, directory.view(board).hidden);
    const chunks = history.read(board, cell, from, to, now, shown);
    const meta = JSON.stringify({now, run: events.epoch, historyStart: store.historyStart(now), known: store.historyKnown(shown)});
    return reply.type('application/json').send(`${meta.slice(0, -1)},"chunks":[${chunks.join(',')}]}`);
  });

  if (hub.local) {
    const attention = new Attention(store, Date.now());
    hub.ingest.attention = attention;
    attention.onEvents = changes => events.attention(changes);
    hub.resets.onAttention = (provider, status, ok, now) => attention.announcement(provider, status, ok, now);
  }
  // Open streams and held polls would keep the server from closing: they end first.
  app.addHook('preClose', async () => events.close());
  eventRoutes(app, directory, events, guards, !!hub.local);
  accountRoutes(app, hub, guards);
  await app.register(async scope => credentialRoutes(scope, hub.credentials!, guards));
  agentRoutes(app, hub);
  if (hub.local) localRoutes(app, hub, hub.local.key);

  await app.register(staticFiles, {root: config.clientRoot, index: 'index.html'});
  // Client-side pages (/device, /invite/…) are served by the same single-page client.
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0];
    const page = request.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/v1/') && !path.includes('.');
    return page ? reply.sendFile('index.html') : reply.code(404).send({error: 'not_found'});
  });
  return app;
}
