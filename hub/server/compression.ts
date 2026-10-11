import type {FastifyInstance} from 'fastify';
import {Readable, pipeline} from 'node:stream';
import {constants, createBrotliCompress, createGzip} from 'node:zlib';

const READS = new Set([
  '/api/overview', '/api/history', '/api/events', '/api/resets', '/api/devices',
  '/api/projects', '/api/boards/:board/sources/:source/keys',
]);
const eligible = (method: string, route: string) => (method === 'GET' || method === 'HEAD') && READS.has(route);

/** Explicit exclusions outrank wildcard preferences, including duplicate aliases. */
export function normalizedEncoding(header: string | undefined): string {
  if (!header || header.length > 16 * 1024) return 'identity';
  const weights = new Map<string, number>();
  for (const part of header.split(',')) {
    const match = /^([!#$%&'*+.^_`|~0-9a-z-]+)(?:[ \t]*;[ \t]*q[ \t]*=[ \t]*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.exec(part.trim());
    if (!match) return 'identity';
    const token = match[1].toLowerCase(), coding = token === 'x-gzip' ? 'gzip' : token;
    const q = match[2] === undefined ? 1 : Number(match[2]);
    weights.set(coding, Math.min(weights.get(coding) ?? 1, q));
  }
  const values = ['br', 'gzip', 'identity'].flatMap(coding => {
    const q = weights.get(coding) ?? (coding === 'identity' ? undefined : weights.get('*'));
    return q === undefined ? [] : [`${coding};q=${q}`];
  });
  return values.length ? values.join(',') : 'identity';
}

/** One response-only policy for read projections; local hubs keep identity throughout. */
export async function responseCompression(app: FastifyInstance, local: boolean) {
  if (local) return;
  // History and poll responses are already serialized strings: preSerialization skips them.
  app.addHook('onSend', (request, reply, payload, done) => {
    if (!eligible(request.method, request.routeOptions.url ?? '')) return done(null, payload);
    const json = /^application\/json(?:;|$)/i.test(String(reply.getHeader('content-type')));
    if (!json) return done(null, payload);
    const vary = String(reply.getHeader('vary') ?? '').split(',').map(token => token.trim()).filter(Boolean);
    if (!vary.some(token => token === '*' || token.toLowerCase() === 'accept-encoding')) vary.push('Accept-Encoding');
    reply.header('vary', vary.join(', '));

    const encoded = reply.getHeader('content-encoding');
    if ((encoded && encoded !== 'identity') || reply.statusCode < 200 || [204, 206, 304].includes(reply.statusCode)
      || reply.getHeader('content-range') !== undefined || request.headers['x-no-compression'] !== undefined
      || (typeof payload !== 'string' && !Buffer.isBuffer(payload)) || Buffer.byteLength(payload) < 1024) return done(null, payload);
    let coding = 'identity', weight = 0;
    for (const preference of normalizedEncoding(request.raw.headers['accept-encoding']).split(',')) {
      const [name, q = '1'] = preference.split(';q=');
      if (Number(q) > weight) {coding = name; weight = Number(q);}
    }
    if (coding === 'identity') return done(null, payload);
    // HEAD describes the GET representation without starting unused compression work.
    if (request.method === 'HEAD') {
      reply.header('content-encoding', coding).removeHeader('content-length');
      return done(null, Readable.from([]));
    }
    const codec = coding === 'br' ? createBrotliCompress({params: {
      [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    }}) : createGzip({level: 6});
    reply.header('content-encoding', coding).removeHeader('content-length');
    // A pre-header stream error is replaced by Fastify's ordinary JSON error response.
    codec.once('error', () => {if (!reply.raw.headersSent) reply.removeHeader('content-encoding');});
    // Fastify owns this native stream, so a socket close destroys it directly.
    // Pipeline propagates that destruction to the source; Fastify also owns stream errors.
    pipeline(Readable.from([payload]), codec, () => {});
    done(null, codec);
  });
}
