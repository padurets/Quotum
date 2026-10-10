import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type {Guards, Hub} from '../api.js';
import {clients} from '../domain/clients.js';

/** Link management is always scoped to the authenticated owner. */
export function linkRoutes(app: FastifyInstance, hub: Hub, guards: Guards) {
  const store = hub.store.links;
  app.get('/api/links', (request, reply) => {
    const user = guards.user(request, reply); if (!user) return reply;
    return {revision: store.revision(user.id), links: store.list(user.id).map(link => ({...link, active: hub.store.holds(user.id, link.sourceId)})),
      sources: hub.store.held(user.id).map(source => ({id: source.id, provider: source.provider,
        name: String(hub.store.db.prepare('SELECT name FROM declared_accounts WHERE user_id=? AND source_id=?').get(user.id, source.id)?.name ?? hub.store.state(source.id).plan ?? source.provider)})),
      clients: [...new Set([...clients.map(c => c.id), ...(hub.store.db.prepare('SELECT client FROM device_clients c JOIN devices d ON d.id=c.device_id WHERE d.user_id=? UNION SELECT client FROM agent_sessions s JOIN devices d ON d.id=s.device_id WHERE d.user_id=?').all(user.id, user.id) as {client: string}[]).map(c => c.client)])],
      devices: hub.directory.devices(user.id).map(device => ({id: device.id, name: device.label ?? device.name}))};
  });
  const command = (request: FastifyRequest, reply: FastifyReply, operation: 'create' | 'correct' | 'change' | 'delete', id: string | null) => {
    const user = guards.user(request, reply); if (!user) return reply;
    try {
      const result = store.mutate(user.id, operation, id, request.body, Date.now());
      return reply.code(result.status).send(result.body);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'not_found') return reply.code(404).send({error: code});
      if (['links_changed', 'link_overlap', 'source_not_held', 'mutation_conflict', 'suggestion_changed'].includes(code)) return reply.code(409).send({error: code});
      return reply.code(400).send({error: 'invalid_link'});
    }
  };
  app.post('/api/links', (request, reply) => command(request, reply, 'create', null));
  app.post<{Params: {id: string}}>('/api/links/:id', (request, reply) => command(request, reply, 'correct', request.params.id));
  app.post<{Params: {id: string}}>('/api/links/:id/change', (request, reply) => command(request, reply, 'change', request.params.id));
  app.delete<{Params: {id: string}}>('/api/links/:id', (request, reply) => command(request, reply, 'delete', request.params.id));
}
