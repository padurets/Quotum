import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {config} from '../config.js';
import type {Hub} from '../api.js';
import {Invalid} from '../domain/ingest.js';
import {IngestError, type Credential} from '../ingest.js';
import {Limiter, publicOrigin} from '../session.js';

/**
 * What agents talk to: the device-code flow (RFC 8628 style, JSON bodies), check-ins
 * and ingest. Agents authenticate with bearer tokens, never with cookies.
 */
export function agentRoutes(app: FastifyInstance, hub: Hub) {
  const {ingest, pairing} = hub;
  const codes = new Limiter(30, 60 * 60_000);

  /**
   * Checks the token before the body is read (a route's own hooks run after the hub's
   * Host and method checks): a request without a valid one is refused at once, so whoever
   * reaches the hub cannot make it hold bodies it would throw away. What it finds is
   * kept for the handler, which asks nothing more of the database.
   */
  const credentials = new WeakMap<FastifyRequest, Credential>();
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const credential = ingest.authenticate(request.headers.authorization);
    if (credential === 'revoked') return reply.code(403).send({error: 'device_revoked'});
    if (!credential) return reply.code(401).send({error: 'unauthorized'});
    credentials.set(request, credential);
  };

  /** Runs an agent request with its credential, answering refusals in the spec's terms. */
  const asAgent = <T>(request: FastifyRequest, reply: FastifyReply, invalid: string, work: (credential: Credential) => T) => {
    try {
      return work(credentials.get(request)!);
    } catch (error) {
      if (error instanceof IngestError) return reply.code(403).send({error: error.code});
      if (error instanceof Invalid) return reply.code(400).send({error: invalid, detail: error.what});
      throw error;
    }
  };

  // The desktop app's hub connects no other machine: its own agent has its token.
  if (!hub.local) {
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
      return {token: result.token, device: {id: result.device.id, name: result.device.label ?? result.device.name}, account: result.account};
    });
  }

  app.post('/v1/checkin', {onRequest: authenticate}, (request, reply) => asAgent(request, reply, 'invalid_request', credential => ingest.checkin(credential, request.body)));

  // Up to 200 sessions with names at their longest, in any script (spec: Reporting running agents).
  app.post('/v1/sessions', {bodyLimit: 256 * 1024, onRequest: authenticate}, (request, reply) =>
    asAgent(request, reply, 'invalid_request', credential => ingest.sessions(credential, request.body)),
  );

  app.post('/v1/ingest', {bodyLimit: config.ingest.bodyLimit, onRequest: authenticate}, (request, reply) =>
    asAgent(request, reply, 'invalid_batch', credential => ingest.accept(credential, request.body)),
  );
}
