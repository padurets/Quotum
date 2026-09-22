import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import {config, serviceName, version} from './config.js';
import type {Collector} from './collector.js';
import type {ResetFeed} from './sources/resets.js';
import type {HistorySeries, Store} from './store/store.js';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self';" +
  ` img-src 'self' data:; font-src 'self'; frame-ancestors ${["'self'", ...config.http.frameAncestors].join(' ')}`;

/** Read-only HTTP surface: static client, `/health`, `/api/overview`, `/api/history`, `/api/resets`. */
export async function buildApp(store: Store, collector: Collector, resets: ResetFeed) {
  const app = Fastify({logger: false, bodyLimit: 1024});
  const hosts = new Set<string>(config.http.hosts);
  const historyCache = new Map<string, {key: string; value: HistorySeries[]}>();

  app.addHook('onRequest', async (request, reply) => {
    if (!hosts.has(request.hostname.toLowerCase())) return reply.code(403).send({error: 'forbidden_host'});
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(405).send({error: 'read_only'});
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

  app.get('/health', () => ({status: 'ok', service: serviceName, version, ...collector.status()}));

  app.get('/api/overview', () => {
    const now = Date.now();
    const {intervalMs, ...status} = collector.status();
    return {
      service: serviceName,
      now,
      collectionStart: store.collectionStart,
      intervalMs,
      ...status,
      sources: store.states().map(({scope, ...state}) => ({
        ...state,
        stale: state.successAt === null || now - state.successAt > config.retention.freshMs,
      })),
    };
  });

  app.get<{Querystring: {range?: string}}>('/api/history', (request, reply) => {
    const range = request.query.range ?? '24h';
    const spec = Object.hasOwn(config.history.ranges, range) ? config.history.ranges[range] : null;
    if (!spec) return reply.code(400).send({error: 'invalid_query'});

    const now = Date.now();
    const status = collector.status();
    const key = `${status.cycle}:${status.collecting}`;
    // History only changes when a collection writes; reuse it between cycles.
    if (historyCache.get(range)?.key !== key) historyCache.set(range, {key, value: store.history(now - spec.durationMs, spec.bucketMs)});

    return {
      range,
      now,
      since: now - spec.durationMs,
      bucketMs: spec.bucketMs,
      collectionStart: store.collectionStart,
      series: historyCache.get(range)!.value,
    };
  });

  app.get('/api/resets', () => resets.snapshot());

  await app.register(staticFiles, {root: config.clientRoot, index: 'index.html'});
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({error: 'not_found'}));
  return app;
}
