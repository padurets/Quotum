import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type {Guards, Hub} from '../api.js';
import {clients} from '../domain/clients.js';
import {titled} from '../domain/presentation.js';
import type {LinkInput} from '../domain/links.js';

const basis = (value: LinkInput) => JSON.stringify([value.deviceId, value.clientId, value.route?.class ?? null, value.route?.provider ?? null, value.sourceId, value.from, value.to]);

/** Link management is always scoped to the authenticated owner. */
export function linkRoutes(app: FastifyInstance, hub: Hub, guards: Guards) {
  const store = hub.store.links;
  app.get('/api/links/suggestions', (request, reply) => {
    const user = guards.user(request, reply); if (!user) return reply;
    return {revision: store.revision(user.id), suggestions: hub.ingest.live.suggestions(user.id, Date.now())};
  });
  app.get('/api/links/attribution', (request, reply) => {
    const user = guards.user(request, reply); if (!user) return reply;
    return {sessions: hub.ingest.live.attributions(user.id, Date.now())};
  });
  app.get('/api/links', (request, reply) => {
    const user = guards.user(request, reply); if (!user) return reply;
    const personal=hub.directory.boards(user.id).find(board=>board.personal);
    const links=store.list(user.id),held=hub.store.held(user.id),ids=new Set(held.map(source=>source.id));
    // An owner's saved link retains its target's identity, never its measurements
    // or another person's private account label after disconnecting.
    const disconnected=hub.store.db.prepare('SELECT DISTINCT s.id,s.provider FROM client_links l JOIN sources s ON s.id=l.source_id WHERE l.user_id=? ORDER BY s.rowid').all(user.id) as {id:string;provider:string}[];
    const known=titled([...held,...disconnected.filter(source=>!ids.has(source.id))],personal?hub.directory.view(personal.id).names:{}).map(source=>({id:source.id,provider:source.provider,
      name:String(hub.store.db.prepare('SELECT name FROM declared_accounts WHERE user_id=? AND source_id=?').get(user.id,source.id)?.name??source.title)}));
    return {revision: store.revision(user.id), links: links.map(link => ({...link, active: ids.has(link.sourceId)})),
      sources: known.filter(source=>ids.has(source.id)),targets:known.filter(source=>links.some(link=>link.sourceId===source.id)),
      clients: [...new Set([...clients.map(c => c.id), ...(hub.store.db.prepare('SELECT client FROM device_clients c JOIN devices d ON d.id=c.device_id WHERE d.user_id=? UNION SELECT client FROM agent_sessions s JOIN devices d ON d.id=s.device_id WHERE d.user_id=?').all(user.id, user.id) as {client: string}[]).map(c => c.client)])],
      devices: hub.directory.devices(user.id).map(device => ({id: device.id, name: device.label ?? device.name}))};
  });
  const command = (request: FastifyRequest, reply: FastifyReply, operation: 'create' | 'correct' | 'change' | 'delete', id: string | null) => {
    const user = guards.user(request, reply); if (!user) return reply;
    try {
      const body = request.body as (LinkInput & {suggestion?: LinkInput}) | null;
      const fresh = operation === 'create' && body?.suggestion !== undefined ? () => {
        if (!body.suggestion || basis(body) !== basis(body.suggestion) || !hub.ingest.live.suggestions(user.id, Date.now()).some(candidate => basis(candidate) === basis(body.suggestion!))) throw new Error('suggestion_changed');
      } : undefined;
      const result = store.mutate(user.id, operation, id, request.body, Date.now(), fresh);
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
