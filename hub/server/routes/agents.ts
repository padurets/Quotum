import type {FastifyInstance} from 'fastify';
import {config} from '../config.js';
import type {Hub} from '../api.js';
import {IngestError} from '../ingest.js';
import {Limiter, publicOrigin} from '../session.js';

/**
 * What agents talk to: the device-code flow (RFC 8628 style, JSON bodies) and ingest.
 * Agents authenticate with bearer tokens, never with cookies.
 */
export function agentRoutes(app: FastifyInstance, hub: Hub) {
  const {ingest, pairing} = hub;
  const codes = new Limiter(30, 60 * 60_000);

  app.post('/v1/device/code', (request, reply) => {
    if (!codes.allow(request.ip)) return reply.code(429).send({error: 'too_many_attempts'});
    const started = pairing.start(request.body);
    if (!started) return reply.code(400).send({error: 'invalid_request'});
    const page = `${publicOrigin(request)}/device`;
    return {...started, verificationUri: page, verificationUriComplete: `${page}?code=${started.userCode}`};
  });

  app.post<{Body: {deviceCode?: unknown}}>('/v1/device/token', (request, reply) => {
    const result = pairing.poll(request.body?.deviceCode);
    if (typeof result === 'string') return reply.code(400).send({error: result});
    return {
      token: result.token,
      device: {id: result.device.id, name: result.device.name, owner: result.device.owner},
      board: result.board,
    };
  });

  app.post('/v1/ingest', {bodyLimit: config.ingest.bodyLimit}, (request, reply) => {
    const credential = ingest.authenticate(request.headers.authorization);
    if (!credential) return reply.code(401).send({error: 'unauthorized'});
    try {
      return ingest.accept(credential, request.body);
    } catch (error) {
      if (error instanceof IngestError) return reply.code(403).send({error: error.code});
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith('invalid_batch')) return reply.code(400).send({error: 'invalid_batch', detail: message.slice('invalid_batch: '.length)});
      throw error;
    }
  });
}
