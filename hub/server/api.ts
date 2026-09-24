import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';
import staticFiles from '@fastify/static';
import {config, serviceName, version} from './config.js';
import type {Ingest} from './ingest.js';
import type {Pairing} from './pairing.js';
import type {ResetFeed} from './resets.js';
import type {HistorySeries, SourceEvent, Store} from './store/store.js';
import type {Board, Directory, User} from './store/directory.js';
import {currentUser, publicOrigin} from './session.js';
import type {Setup} from './setup.js';
import {accountRoutes} from './routes/account.js';
import {agentRoutes} from './routes/agents.js';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self';" +
  ` img-src 'self' data:; font-src 'self'; frame-ancestors ${["'self'", ...config.http.frameAncestors].join(' ')}`;

export type Hub = {store: Store; directory: Directory; resets: ResetFeed; ingest: Ingest; pairing: Pairing; setup: Setup};

/** Route helpers shared by the route modules. */
export type Guards = {
  user(request: FastifyRequest, reply: FastifyReply): User | null;
  board(request: FastifyRequest, reply: FastifyReply, boardId: string | undefined): {user: User; board: Board} | null;
};

/**
 * Whether a page at `origin` belongs to this hub: the public address when one is set,
 * else the same host name and port as the request (default ports aside). The scheme is
 * not compared: behind a TLS-terminating proxy the hub itself sees plain http.
 */
function sameSite(origin: string, request: FastifyRequest): boolean {
  let page: URL;
  try {
    page = new URL(origin);
  } catch {
    return false;
  }
  if (config.auth.publicUrl) return page.origin === publicOrigin(request);
  const own = new URL(`${request.protocol}://${request.host}`);
  return page.hostname === own.hostname && page.port === own.port;
}

/** Errors of the framework itself (malformed JSON, a body too large…) in the hub's `{error}` shape. */
function errorCode(status: number, path: string): string {
  if (status === 413) return 'too_large';
  if (status >= 500) return 'internal_error';
  return path.startsWith('/v1/ingest') ? 'invalid_batch' : 'invalid_request';
}

/**
 * A period from `from` to `to` (milliseconds) within the kept history, from 15 minutes to
 * a month long, with the cell it is drawn on; null when it is not one. Its end is at most now.
 */
function selected(from: string | undefined, to: string | undefined, now: number): {since: number; to: number; cellMs: number} | null {
  if (!from || !to || !/^\d{1,15}$/.test(from) || !/^\d{1,15}$/.test(to)) return null;
  const since = Number(from);
  const end = Math.min(Number(to), now);
  const span = end - since;
  if (span < config.history.minSpanMs || span > config.history.maxSpanMs || since < now - config.retention.sampleDays * 86_400_000) return null;
  const {cells, maxCells} = config.history;
  const cellMs = cells.find(cell => (end - since) / cell <= maxCells) ?? cells.at(-1)!;
  return {since, to: end, cellMs};
}

/**
 * The HTTP surface. People sign in and read their boards under `/api`; agents talk to
 * `/v1` (device codes, check-ins, ingest). Everything else is the single-page client.
 */
export async function buildApp(hub: Hub) {
  const {store, directory, resets} = hub;
  const app = Fastify({logger: false, bodyLimit: 16 * 1024, trustProxy: config.http.trustProxy});
  const hosts = new Set<string>(config.http.hosts);
  const anyHost = hosts.has('*');
  type Answer = {series: HistorySeries[]; events: SourceEvent[]};
  type Kept = {cell: number; revision: number; sources: string; at: number; costly: boolean; value: Answer};
  /**
   * An answer is reused while the grid stays on the same cell, the board has the same
   * sources and their data has not changed. A costly one (a month of a busy board takes a
   * good part of a second) is also reused for a quarter of a cell after new data came: a
   * month is drawn in 2-hour cells, where half an hour of news does not show. Such an
   * answer says when a newer one will be ready (`refreshInMs`), so the page asks again
   * then. The fixed ranges are kept per board; of the periods selected on charts, the
   * latest few.
   */
  const fixedHistory = new Map<string, Kept>();
  const selectedHistory = new Map<string, Kept>();
  const SELECTED_KEPT = 32;
  const reused = (cache: Map<string, Kept>, slot: string, board: string, cellMs: number, end: number, read: () => Answer) => {
    const now = Date.now();
    const cell = Math.floor(end / cellMs);
    const revision = store.revision(board);
    const sources = store.sources(board).map(s => s.id).join(' ');
    const hit = cache.get(slot);
    if (hit && hit.cell === cell && hit.sources === sources) {
      if (hit.revision === revision) return {...hit.value, refreshInMs: null};
      const left = hit.at + cellMs / 4 - now;
      if (hit.costly && left > 0) return {...hit.value, refreshInMs: Math.ceil(left)};
    }
    const value = read();
    const costly = Date.now() - now >= config.history.costlyMs;
    // Map order is insertion order: the entry read last goes to the end, the oldest is dropped.
    cache.delete(slot);
    cache.set(slot, {cell, revision, sources, at: now, costly, value});
    if (cache === selectedHistory && cache.size > SELECTED_KEPT) cache.delete(cache.keys().next().value!);
    return {...value, refreshInMs: null};
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
  // With the resets the trackers reported over the longest period the chart shows.
  app.get('/api/resets', () => ({...resets.snapshot(), past: store.announcements(Date.now() - 31 * 86_400_000)}));

  app.get<{Querystring: {board?: string}}>('/api/overview', (request, reply) => {
    const access = guards.board(request, reply, request.query.board);
    if (!access) return reply;
    const now = Date.now();
    // Whose each source is: the people on this board whose devices measure it.
    const members = new Map(directory.members(access.board.id).map(m => [m.id, m.name]));
    return {
      board: access.board,
      view: directory.view(access.board.id),
      historyStart: store.historyStart,
      /** Changes whenever the board's data changes: the page re-reads history when it does. */
      revision: store.revision(access.board.id),
      sources: store.sources(access.board.id).map(source => {
        const state = store.state(source.id);
        return {
          ...state,
          owners: source.holders.flatMap(id => members.get(id) ?? []).sort(),
          /** Measured by the reader's devices: theirs to take off a shared board. */
          mine: source.holders.includes(access.user.id),
          stale: state.successAt === null || state.staleAfterMs === null || now - state.successAt > state.staleAfterMs,
          /** The coding agents running on it right now, on any machine. */
          sessions: hub.ingest.live.of(source.id, now),
        };
      }),
    };
  });

  app.get<{Querystring: {range?: string; from?: string; to?: string; board?: string}}>('/api/history', (request, reply) => {
    const access = guards.board(request, reply, request.query.board);
    if (!access) return reply;
    const now = Date.now();
    const {from, to} = request.query;
    if (from !== undefined || to !== undefined) {
      // A period selected on the chart, as long as a month at most.
      const span = selected(from, to, now);
      if (!span) return reply.code(400).send({error: 'invalid_request'});
      const board = access.board.id;
      const slot = `${board}:${span.since}:${span.to}`;
      const answer = reused(selectedHistory, slot, board, span.cellMs, span.to, () => store.history(board, span.since, span.cellMs, span.to));
      // Named as asked, so the page knows its answer even when the end was cut to now.
      return {range: `${from}-${to}`, now, since: span.since, to: span.to, cellMs: span.cellMs, historyStart: store.historyStart, ...answer};
    }
    const range = request.query.range ?? '24h';
    const spec = Object.hasOwn(config.history.ranges, range) ? config.history.ranges[range] : null;
    if (!spec) return reply.code(400).send({error: 'invalid_request'});

    const board = access.board.id;
    const answer = reused(fixedHistory, `${board}:${range}`, board, spec.cellMs, now, () => store.history(board, now - spec.durationMs, spec.cellMs));
    return {range, now, since: now - spec.durationMs, to: now, cellMs: spec.cellMs, historyStart: store.historyStart, ...answer};
  });

  accountRoutes(app, hub, guards);
  agentRoutes(app, hub);

  await app.register(staticFiles, {root: config.clientRoot, index: 'index.html'});
  // Client-side pages (/device, /invite/…) are served by the same single-page client.
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0];
    const page = request.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/v1/') && !path.includes('.');
    return page ? reply.sendFile('index.html') : reply.code(404).send({error: 'not_found'});
  });
  return app;
}
