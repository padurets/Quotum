import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';
import staticFiles from '@fastify/static';
import {config, serviceName, version} from './config.js';
import type {Ingest} from './ingest.js';
import type {Pairing} from './pairing.js';
import type {ResetFeed} from './sources/resets.js';
import type {HistorySeries, Store} from './store/store.js';
import type {Board, Directory, User} from './store/directory.js';
import {staleAfter} from './domain/quota.js';
import {currentUser} from './session.js';
import {accountRoutes} from './routes/account.js';
import {agentRoutes} from './routes/agents.js';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self';" +
  ` img-src 'self' data:; font-src 'self'; frame-ancestors ${["'self'", ...config.http.frameAncestors].join(' ')}`;

export type Hub = {store: Store; directory: Directory; resets: ResetFeed; ingest: Ingest; pairing: Pairing};

/** Route helpers shared by the route modules. */
export type Guards = {
  user(request: FastifyRequest, reply: FastifyReply): User | null;
  board(request: FastifyRequest, reply: FastifyReply, boardId: string | undefined): {user: User; board: Board} | null;
};

/**
 * The HTTP surface. People sign in and read their boards under `/api`; agents talk to
 * `/v1` (device codes, ingest). Everything else is the single-page client.
 */
export async function buildApp(hub: Hub) {
  const {store, directory, resets} = hub;
  const app = Fastify({logger: false, bodyLimit: 16 * 1024});
  const hosts = new Set<string>(config.http.hosts);
  const historyCache = new Map<string, {key: string; value: HistorySeries[]}>();

  app.addHook('onRequest', async (request, reply) => {
    if (!hosts.has(request.hostname.toLowerCase())) return reply.code(403).send({error: 'forbidden_host'});
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const path = request.url.split('?')[0];
    const api = path.startsWith('/api/');
    const allowed = (request.method === 'POST' && (api || path.startsWith('/v1/'))) || (request.method === 'DELETE' && api);
    if (!allowed) return reply.code(405).send({error: 'method_not_allowed'});
    // Cookie-authenticated changes are accepted only from pages of this hub.
    const origin = request.headers.origin;
    if (api && origin) {
      let host = '';
      try {
        host = new URL(origin).hostname.toLowerCase();
      } catch {}
      if (host !== request.hostname.toLowerCase()) return reply.code(403).send({error: 'forbidden_origin'});
    }
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
  app.get('/api/resets', () => resets.snapshot());

  app.get<{Querystring: {board?: string}}>('/api/overview', (request, reply) => {
    const access = guards.board(request, reply, request.query.board);
    if (!access) return reply;
    const now = Date.now();
    // Who delivers each source: the owners of the devices that measure it.
    const owners = new Map<string, Set<string>>();
    const devices = new Map(directory.devices(access.board.id).map(d => [d.id, d.owner]));
    for (const {device, source} of store.deviceSources(access.board.id)) {
      const owner = devices.get(device);
      if (owner) owners.set(source, (owners.get(source) ?? new Set()).add(owner));
    }
    return {
      board: access.board,
      now,
      collectionStart: store.collectionStart,
      /** Changes whenever the data changes: the page re-reads history when it does. */
      revision: store.revision,
      sources: store.states(access.board.id).map(state => ({
        ...state,
        owners: [...(owners.get(state.id) ?? [])].sort(),
        stale: state.successAt === null || now - state.successAt > staleAfter(state),
      })),
    };
  });

  app.get<{Querystring: {range?: string; board?: string}}>('/api/history', (request, reply) => {
    const access = guards.board(request, reply, request.query.board);
    if (!access) return reply;
    const range = request.query.range ?? '24h';
    const spec = Object.hasOwn(config.history.ranges, range) ? config.history.ranges[range] : null;
    if (!spec) return reply.code(400).send({error: 'invalid_query'});

    const now = Date.now();
    const slot = `${access.board.id}:${range}`;
    // History changes when a measurement is stored or the grid moves on; reuse it until then.
    const key = `${store.revision}:${Math.floor(now / spec.bucketMs)}`;
    if (historyCache.get(slot)?.key !== key) {
      historyCache.set(slot, {key, value: store.history(access.board.id, now - spec.durationMs, spec.bucketMs)});
    }
    return {
      range,
      now,
      since: now - spec.durationMs,
      bucketMs: spec.bucketMs,
      collectionStart: store.collectionStart,
      series: historyCache.get(slot)!.value,
    };
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
