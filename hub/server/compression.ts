import compress from '@fastify/compress';
import type {FastifyInstance} from 'fastify';
import {constants} from 'node:zlib';

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
  app.addHook('onRoute', route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.every(method => eligible(method, route.url))) route.compress = false;
  });
  // History and poll responses are already serialized strings: preSerialization skips them.
  // A root onSend runs before the plugin's route encoder, after the authorization handler.
  app.addHook('onSend', async (request, reply, payload) => {
    if (!eligible(request.method, request.routeOptions.url ?? '')) return payload;
    const json = /^application\/json(?:;|$)/i.test(String(reply.getHeader('content-type')));
    // The plugin also recognizes MIME database types; restrict it to this JSON policy.
    // Fastify's setter overlays headers for hooks while preserving the original raw headers.
    request.headers = {...request.headers, 'accept-encoding': json ? normalizedEncoding(request.raw.headers['accept-encoding']) : 'identity'};
    if (!json) return payload;
    const vary = String(reply.getHeader('vary') ?? '').split(',').map(token => token.trim()).filter(Boolean);
    if (!vary.some(token => token === '*' || token.toLowerCase() === 'accept-encoding')) vary.push('Accept-Encoding');
    reply.header('vary', vary.join(', '));
    return payload;
  });
  await app.register(compress, {
    globalCompression: true, globalDecompression: false,
    threshold: 1024, syncThreshold: 0, encodings: ['br', 'gzip', 'identity'],
    customTypes: /^application\/json(?:;|$)/i,
    brotliOptions: {params: {[constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT}},
    zlibOptions: {level: 6},
  });
}
