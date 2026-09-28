import {STATUS_CODES} from 'node:http';
import type {Socket} from 'node:net';
import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';
import staticFiles from '@fastify/static';
import {config, serviceName, version} from './config.js';
import type {Ingest} from './ingest.js';
import {KEEP_MS} from './sessions.js';
import type {Pairing} from './pairing.js';
import type {ResetFeed} from './resets.js';
import type {HistoryActivity, HistorySeries, Shown, SourceEvent, Store} from './store/store.js';
import type {Board, Directory, User} from './store/directory.js';
import {CSP, currentUser, sameSite} from './session.js';
import type {Setup} from './setup.js';
import {Events} from './events.js';
import {Projection} from './projection.js';
import {accountRoutes} from './routes/account.js';
import {eventRoutes} from './routes/events.js';
import {agentRoutes} from './routes/agents.js';
import {localRoutes} from './local.js';

/**
 * `local`: the desktop app's hub, with the key its window enters with (see local.ts); null
 * on a server. `events`: what open dashboards hear, made here when not given.
 */
export type Hub = {store: Store; directory: Directory; resets: ResetFeed; ingest: Ingest; pairing: Pairing; setup: Setup; local: {key: string} | null; events?: Events};

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
 * The cell a period of `span` is drawn on: the finest that keeps it within `maxCells`, a
 * little over the count rather than a three times coarser grid for a day over a month.
 */
function cellOf(span: number) {
  const {cells, maxCells} = config.history;
  return cells.find(cell => span / cell <= maxCells * 1.05) ?? cells.at(-1)!;
}

/**
 * A period from `from` to `to` (milliseconds) within the kept history, from 15 minutes to
 * a month long, with the cell it is drawn on; null when it is not one. Its end is at most
 * now; its edges go out to whole cells, so periods that differ by less than a cell are
 * one answer (and one entry of the cache).
 */
function selected(from: string | undefined, to: string | undefined, now: number): {since: number; to: number; cellMs: number} | null {
  if (!from || !to || !/^\d{1,15}$/.test(from) || !/^\d{1,15}$/.test(to)) return null;
  const start = Number(from);
  const end = Math.min(Number(to), now);
  const span = end - start;
  if (span < config.history.minSpanMs || span > config.history.maxSpanMs || start < now - config.retention.sampleDays * 86_400_000) return null;
  const cellMs = cellOf(span);
  return {since: Math.floor(start / cellMs) * cellMs, to: Math.min(Math.ceil(end / cellMs) * cellMs, now), cellMs};
}

/**
 * The HTTP surface. People sign in and read their boards under `/api`; agents talk to
 * `/v1` (device codes, check-ins, ingest). Everything else is the single-page client.
 * The desktop app's hub (`local`) has one person who never signs in: the window enters
 * at `/local`, and what is about accounts, sharing and connecting is not there.
 */
export async function buildApp(hub: Hub) {
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
  });
  const hosts = new Set<string>(config.http.hosts);
  const anyHost = hosts.has('*');
  type Answer = {series: HistorySeries[]; events: SourceEvent[]; activity: HistoryActivity};
  type Kept = {cell: number; revision: number; work: string; at: number; costly: boolean; value: Answer};
  /**
   * An answer is reused while the grid stays on the same cell, the board shows the same
   * sources and agents under the same names (`Store.workKey`) and their data has not
   * changed. A costly one (a month of a busy board takes a good part of a second) is also
   * reused for a quarter of a cell after new data came: a month is drawn in 2-hour cells,
   * where half an hour of news does not show. Such an answer says when a newer one will be
   * ready (`refreshInMs`), so the page asks again then. Work up to a range's end is credited
   * from the lists machines send after it, up to `KEEP_MS` later (server/sessions.ts),
   * without a new revision: until then (`settles`) an answer says when to ask again, and one
   * read before then is not reused after. The ranges ending now are kept per board; of the
   * periods selected on charts, the latest few.
   */
  const fixedHistory = new Map<string, Kept>();
  const selectedHistory = new Map<string, Kept>();
  const SELECTED_KEPT = 32;
  const reused = (cache: Map<string, Kept>, slot: string, board: string, cellMs: number, end: number, read: (shown: Shown) => Answer, settles = 0) => {
    const now = Date.now();
    const cell = Math.floor(end / cellMs);
    const revision = store.revision(board);
    const shown = store.shown(board, directory.view(board).hidden);
    const work = store.workKey(board, shown);
    // A newer answer is ready this much later, if at all: the earlier of the two.
    const refresh = (ms: number | null) => (now < settles ? Math.ceil(Math.min(ms ?? Infinity, settles - now)) : ms);
    const hit = cache.get(slot);
    if (hit && hit.cell === cell && hit.work === work && (hit.at >= settles || now < settles)) {
      if (hit.revision === revision) return {...hit.value, refreshInMs: refresh(null)};
      const left = hit.at + cellMs / 4 - now;
      if (hit.costly && left > 0) return {...hit.value, refreshInMs: refresh(Math.ceil(left))};
    }
    const value = read(shown);
    const costly = Date.now() - now >= config.history.costlyMs;
    // Map order is insertion order: the entry read last goes to the end, the oldest is dropped.
    cache.delete(slot);
    cache.set(slot, {cell, revision, work, at: now, costly, value});
    if (cache === selectedHistory && cache.size > SELECTED_KEPT) cache.delete(cache.keys().next().value!);
    return {...value, refreshInMs: refresh(null)};
  };

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
    return projection.snapshot(access.user.id, access.board.id, Date.now());
  });

  app.get<{Querystring: {range?: string; from?: string; to?: string; board?: string}}>('/api/history', (request, reply) => {
    const access = guards.board(request, reply, request.query.board);
    if (!access) return reply;
    const now = Date.now();
    // A machine gone quiet has its last list credited five minutes on, here as well as when
    // another machine reports: a range that ended that long ago has all of its work.
    hub.ingest.live.sweep(now);
    const {from, to} = request.query;
    if (from !== undefined || to !== undefined) {
      // A period selected on the chart, as long as a month at most.
      const span = selected(from, to, now);
      if (!span) return reply.code(400).send({error: 'invalid_request'});
      const board = access.board.id;
      // A period up to now keeps its entry as now moves on; `reused` tells when it is stale.
      const slot = `${board}:${span.since}:${span.to === now ? 'now' : span.to}`;
      const answer = reused(selectedHistory, slot, board, span.cellMs, span.to, shown => store.history(board, span.since, span.cellMs, {to: span.to, now, shown}), span.to + KEEP_MS);
      // Named as asked, so the page knows its answer even when the end was cut to now.
      return {range: `${from}-${to}`, now, since: span.since, to: span.to, cellMs: span.cellMs, historyStart: store.historyStart(now), ...answer};
    }
    const range = request.query.range ?? '24h';
    const durationMs = Object.hasOwn(config.history.ranges, range) ? config.history.ranges[range] : null;
    if (!durationMs) return reply.code(400).send({error: 'invalid_request'});

    const board = access.board.id;
    const cellMs = cellOf(durationMs);
    const answer = reused(fixedHistory, `${board}:${range}`, board, cellMs, now, shown => store.history(board, now - durationMs, cellMs, {now, shown}));
    return {range, now, since: now - durationMs, to: now, cellMs, historyStart: store.historyStart(now), ...answer};
  });

  const events = hub.events ?? new Events(hub);
  events.attach();
  // Open streams and held polls would keep the server from closing: they end first.
  app.addHook('preClose', async () => events.close());
  eventRoutes(app, directory, events, guards);
  accountRoutes(app, hub, guards);
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
