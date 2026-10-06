import {newSecret} from '../server/domain/auth.js';
import type {ExtendHub} from '../server/api.js';
import {currentUser, sameSite} from '../server/session.js';
import {DEMO_ADDITION_KEYS} from './onboarding.js';

/** Only external answers and fault injection are synthetic; additions use production routes. */
export const demoAdditionControls: ExtendHub = async (app, hub, guards) => {
  const lostReplies = new Set<string>();
  app.addHook('onSend', async (request, reply, payload) => {
    const route = request.routeOptions.url;
    if (typeof payload !== 'string' || reply.statusCode >= 400) return payload;
    if (request.method === 'GET' && (route === '/api/boards/:board/catalogue' || route === '/api/connections'))
      return JSON.stringify({...JSON.parse(payload), demo: {keys: DEMO_ADDITION_KEYS}});
    if (request.method === 'POST' && route === '/api/additions/:id/run') {
      const user = currentUser(request, hub.directory);
      if (user && lostReplies.has(user.id) && JSON.parse(payload).state === 'complete') {
        lostReplies.delete(user.id); reply.code(503);
        return JSON.stringify({error: 'prototype_lost_reply'});
      }
    }
    return payload;
  });
  await app.register(async scope => {
    scope.addHook('onRequest', async (request, reply) => {
      if (!guards.user(request, reply)) return reply;
      const origin = request.headers.origin;
      if (!origin || !sameSite(origin, request)) return reply.code(403).send({error: 'forbidden_origin'});
    });
    scope.post('/api/prototype/device', (request, reply) => {
      const user = guards.user(request, reply); if (!user) return reply;
      const now = Date.now(), tokenSecret = newSecret('qt_m');
      const token = hub.directory.createToken(tokenSecret, 'demo', user.id, 'Demo device', now);
      const machine = {id: 'demo-' + user.id, name: 'Demo laptop', os: 'linux', arch: 'x86_64'};
      const device = hub.ingest.accept({kind: 'token', token}, {version: 1, agent: '0.6.0', machine, sentAt: new Date(now).toISOString(), failures: [], snapshots: [
        {provider: 'codex', account: 'c'.repeat(24), observedAt: new Date(now).toISOString(), staleAfterMs: 3_600_000, via: 'demo', plan: 'plus', windows: [{id: 'weekly', kind: 'weekly', usedPercent: 18, minutes: 10080, resetsAt: new Date(now + 3 * 86_400_000).toISOString()}]},
        {provider: 'claude', account: 'd'.repeat(24), observedAt: new Date(now).toISOString(), staleAfterMs: 3_600_000, via: 'demo', plan: 'Claude Pro', windows: [{id: 'weekly', kind: 'weekly', usedPercent: 32, minutes: 10080, resetsAt: new Date(now + 5 * 86_400_000).toISOString()}]},
      ]}, now).device;
      return {deviceId: device.id};
    });
    scope.post<{Body: {lostReply?: boolean}}>('/api/prototype/control', (request, reply) => {
      const user = guards.user(request, reply); if (!user) return reply;
      if (request.body?.lostReply === true) lostReplies.add(user.id); else lostReplies.delete(user.id);
      return {ok: true};
    });
  });
};
