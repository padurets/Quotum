import {randomUUID} from 'node:crypto';
import {newSecret} from '../server/domain/auth.js';
import type {ExtendHub} from '../server/api.js';
import type {Connector} from '../server/connectors/registry.js';
import {secretCode} from '../server/secrets/crypto.js';
import {sameSite, Limiter} from '../server/session.js';
import {DEMO_ADDITION_KEYS} from './onboarding.js';

type Item = {kind: 'sources'; sourceIds: string[]} | {kind: 'widget'; widgetId: string} | {kind: 'connection'; provider: string} | {kind: 'replace'; credentialId: string};
type Result = {sourceIds: string[]; credentialId?: string; connection?: 'created' | 'reused'; expiresAt?: number | null};
type Operation = {id: string; owner: string; requestId: string; boardId: string | null; item: Item; state: 'ready' | 'verifying' | 'needs_input' | 'complete' | 'failed'; result?: Result; error?: string};
const widgets = ['agents', 'activity', 'history', 'forecast'];
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const demo = {keys: DEMO_ADDITION_KEYS};

/**
 * Deliberate stand-in for the prepared operation service, attached only by demo/hub.ts.
 * Receipts are in memory and credential creation precedes placement. They do not prove
 * transaction recovery, durable storage or the final concurrency contract.
 */
export function prototypeAdditions(registry: ReadonlyMap<string, Connector>): ExtendHub {
  return async (app, hub, guards) => {
    const {store, directory, credentials} = hub;
    const operations = new Map<string, Operation>(), running = new Map<string, Promise<void>>();
    const lostReplies = new Set<string>();
    const attempts = new Limiter(10, 60_000);
    const hidden = (board: string, id: string) => {
      const view = directory.view(board);
      return id === 'agents' ? !view.shown.includes(id) : view.hidden.includes(id);
    };
    const answer = (operation: Operation) => {
      const {owner: _owner, requestId: _request, ...safe} = operation;
      const board = operation.boardId ?? directory.boards(operation.owner).find(item => item.personal)?.id;
      const accessible = board && directory.boards(operation.owner).some(item => item.id === board);
      const onBoard = accessible ? store.sources(board!).map(source => source.id) : [];
      return {...safe, current: {boardAccessible: !!accessible, sources: operation.result?.sourceIds.map(id => ({id, placement: !accessible ? 'unavailable' : !onBoard.includes(id) ? 'removed' : hidden(board!, 'source:' + id) ? 'hidden' : 'visible'})), widget: operation.item.kind === 'widget' ? {id: operation.item.widgetId, placement: !accessible ? 'unavailable' : hidden(board!, operation.item.widgetId) || !onBoard.length && !directory.view(board!).shown.includes('empty:' + operation.item.widgetId) ? 'hidden' : 'visible'} : undefined}};
    };
    await app.register(async scope => {
      scope.addHook('onRequest', async (request, reply) => {
        const user = guards.user(request, reply); if (!user) return reply;
        if (request.method === 'GET') return;
        const origin = request.headers.origin;
        let valid = false;
        try {const parsed = new URL(origin ?? ''); valid = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin && !parsed.username && !parsed.password;} catch { /* Invalid Origin. */ }
        if (!valid || !sameSite(origin!, request)) return reply.code(403).send({error: 'forbidden_origin'});
      });
      scope.setErrorHandler((error: {code?: string; statusCode?: number}, _request, reply) => reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 400).send({error: secretCode(error.code) ?? 'invalid_request'}));
      scope.get('/api/connections', (request, reply) => {
        const user = guards.user(request, reply); if (!user) return reply;
        const boards = directory.boards(user.id), personal = boards.find(board => board.personal)!;
        const names = directory.view(personal.id).names;
        return {demo, connections: credentials!.list(user.id).map(record => ({...record,
          label: names[record.sourceId ?? ''] ?? record.provider,
          lastSuccessAt: record.sourceId ? store.state(record.sourceId).successAt : null,
          placements: boards.filter(board => store.sources(board.id).some(source => source.id === record.sourceId)).map(board => ({...board, visible: !hidden(board.id, 'source:' + record.sourceId)})),
        }))};
      });
      scope.post('/api/prototype/device', (request, reply) => {
        const user = guards.user(request, reply); if (!user) return reply;
        const now = Date.now(), tokenSecret = newSecret('qt_m');
        const token = directory.createToken(tokenSecret, 'demo', user.id, 'Prototype device', now);
        const machine = {id: 'prototype-' + user.id, name: 'Prototype laptop', os: 'linux', arch: 'x86_64'};
        const device = hub.ingest.accept({kind: 'token', token}, {version: 1, agent: '0.6.0', machine, sentAt: new Date(now).toISOString(), failures: [], snapshots: [
          {provider: 'codex', account: 'c'.repeat(24), observedAt: new Date(now).toISOString(), staleAfterMs: 3_600_000, via: 'prototype', plan: 'plus', windows: [{id: 'weekly', kind: 'weekly', usedPercent: 18, minutes: 10080, resetsAt: new Date(now + 3 * 86_400_000).toISOString()}]},
          {provider: 'claude', account: 'd'.repeat(24), observedAt: new Date(now).toISOString(), staleAfterMs: 3_600_000, via: 'prototype', plan: 'Claude Pro', windows: [{id: 'weekly', kind: 'weekly', usedPercent: 32, minutes: 10080, resetsAt: new Date(now + 5 * 86_400_000).toISOString()}]},
        ]}, now).device;
        return {deviceId: device.id};
      });
      scope.post<{Body: {lostReply?: boolean}}>('/api/prototype/control', (request, reply) => {
        const user = guards.user(request, reply); if (!user) return reply;
        if (request.body?.lostReply === true) lostReplies.add(user.id); else lostReplies.delete(user.id);
        return {ok: true};
      });
      scope.get<{Params: {board: string}}>('/api/boards/:board/catalogue', (request, reply) => {
        const access = guards.board(request, reply, request.params.board); if (!access) return reply;
        const {board, user} = access;
        const own = store.held(user.id), sources = store.sources(board.id), view = directory.view(board.id);
        const personal = directory.boards(user.id).find(item => item.personal)!;
        const ownNames = directory.view(personal.id).names;
        const candidates = [...own, ...sources.filter(source => !own.some(item => item.id === source.id))];
        return {board, demo, connectors: [...registry.keys()].map(id => ({id, name: id === 'openrouter' ? 'OpenRouter' : id})),
          operations: [...operations.values()].filter(operation => operation.owner === user.id && operation.boardId === board.id).slice(-10).map(answer),
          sources: candidates.map((source, index) => {
            const mine = own.some(item => item.id === source.id), onBoard = sources.some(item => item.id === source.id), visible = onBoard && !hidden(board.id, 'source:' + source.id);
            const label = (mine ? ownNames[source.id] : view.names[source.id]) ?? `${source.provider === 'openrouter' ? 'OpenRouter' : source.provider} ${index + 1}`;
            return {id: source.id, provider: source.provider, label, origin: mine ? 'own' : 'shared', onBoard, visible,
              action: visible ? 'present' : !mine && board.role !== 'owner' ? 'forbidden' : onBoard ? 'show' : 'add'};
          }),
          widgets: widgets.map(id => ({id, action: board.role !== 'owner' ? 'forbidden' : !hidden(board.id, id) && (sources.length || view.shown.includes('empty:' + id)) ? 'present' : 'add'})),
        };
      });
      scope.post<{Body: {requestId: string; boardId: string | null; item: Item}}>('/api/additions', {bodyLimit: 32 * 1024}, (request, reply) => {
        const user = guards.user(request, reply); if (!user) return reply;
        const {requestId, boardId, item} = request.body ?? {};
        const allowed = item?.kind === 'sources' ? ['kind', 'sourceIds'] : item?.kind === 'widget' ? ['kind', 'widgetId'] : item?.kind === 'connection' ? ['kind', 'provider'] : ['kind', 'credentialId'];
        const validItem = item && typeof item === 'object' && Object.keys(item).every(key => allowed.includes(key)) && (item.kind === 'sources' ? Array.isArray(item.sourceIds) && item.sourceIds.length > 0 && item.sourceIds.length <= 100 && item.sourceIds.every(id => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,63}:[a-f0-9]{12}$/.test(id)) : item.kind === 'widget' ? widgets.includes(item.widgetId) : item.kind === 'connection' ? registry.has(item.provider) : item.kind === 'replace' && uuid(item.credentialId));
        if (!request.body || Object.keys(request.body).some(key => !['requestId', 'boardId', 'item'].includes(key)) || !uuid(requestId) || boardId !== null && (typeof boardId !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(boardId)) || !validItem || boardId === null && item.kind !== 'connection' && item.kind !== 'replace') return reply.code(400).send({error: 'invalid_request'});
        if (boardId && !guards.board(request, reply, boardId)) return reply;
        if (item.kind === 'replace' && !credentials!.list(user.id).some(record => record.id === item.credentialId)) return reply.code(404).send({error: 'not_found'});
        const previous = [...operations.values()].find(operation => operation.owner === user.id && operation.requestId === requestId);
        if (previous) return previous.boardId === boardId && JSON.stringify(previous.item) === JSON.stringify(item) ? answer(previous) : reply.code(409).send({error: 'credential_conflict'});
        if ([...operations.values()].filter(operation => operation.owner === user.id).length >= 50) return reply.code(429).send({error: 'too_many_attempts'});
        const operation: Operation = {id: randomUUID(), owner: user.id, requestId, boardId, item, state: 'ready'};
        operations.set(operation.id, operation); return reply.code(201).send(answer(operation));
      });
      scope.get<{Params: {id: string}}>('/api/additions/:id', (request, reply) => {
        const user = guards.user(request, reply), operation = operations.get(request.params.id);
        if (!user) return reply;
        return operation?.owner === user.id ? answer(operation) : reply.code(404).send({error: 'not_found'});
      });
      scope.post<{Params: {id: string}; Body: {secret?: string}}>('/api/additions/:id/run', {bodyLimit: 32 * 1024}, async (request, reply) => {
        const user = guards.user(request, reply), operation = operations.get(request.params.id);
        if (!user) return reply;
        if (!operation || operation.owner !== user.id) return reply.code(404).send({error: 'not_found'});
        if (operation.state === 'complete') return answer(operation);
        if (!request.body || Object.keys(request.body).some(key => key !== 'secret')) return reply.code(400).send({error: 'invalid_request'});
        const access = operation.boardId ? guards.board(request, reply, operation.boardId) : null;
        if (operation.boardId && !access) return reply;
        const work = async () => {
          operation.state = 'verifying'; delete operation.error;
          try {
            const item = operation.item;
            let result: Result = {sourceIds: []};
            if (item.kind === 'connection' || item.kind === 'replace') {
              const keys = ['user:' + user.id, 'ip:' + request.ip];
              if (keys.some(key => attempts.blocked(key))) {operation.state = 'needs_input'; operation.error = 'too_many_attempts'; return;}
              keys.forEach(key => attempts.record(key));
              const existing = item.kind === 'replace' ? credentials!.list(user.id).find(record => record.id === item.credentialId) : undefined;
              const provider = item.kind === 'connection' ? item.provider : existing?.provider;
              const connector = provider && registry.get(provider), secret = request.body?.secret;
              if (!connector || typeof secret !== 'string' || !connector.secretFormat(secret)) {operation.state = 'needs_input'; operation.error = 'credential_invalid'; return;}
              const bytes = Buffer.from(secret, 'ascii');
              // Only the prototype verification pauses; ordinary demo measurements keep their cadence.
              await new Promise(resolve => setTimeout(resolve, 700));
              const identity = await connector.identify(bytes).finally(() => bytes.fill(0));
              if (identity.expiresAt !== null && identity.expiresAt <= Date.now()) {operation.state = 'needs_input'; operation.error = 'credential_expired'; return;}
              // Verify authority again after provider I/O. No demo shortcut grants board rights.
              if (!guards.user(request, reply) || operation.boardId && !guards.board(request, reply, operation.boardId)) {operation.state = 'failed'; operation.error = 'forbidden'; return;}
              const reused = item.kind === 'connection' && credentials!.list(user.id).find(record => record.sourceId && store.account(record.sourceId) === identity.account && record.provider === provider);
              const record = item.kind === 'replace' ? await credentials!.replace(user.id, item.credentialId, secret, {allowNoExpiry: true}) : reused || await credentials!.create(user.id, provider!, secret, {allowNoExpiry: true, requestId: operation.requestId});
              result = {sourceIds: [record.sourceId!], credentialId: record.id, expiresAt: record.expiresAt, ...(item.kind === 'connection' ? {connection: reused ? 'reused' : 'created'} : {})};
              const personal = directory.boards(user.id).find(board => board.personal)!;
              const ownView = directory.view(personal.id);
              if (!ownView.names[record.sourceId!]) directory.saveView(personal.id, {...ownView, names: {...ownView.names, [record.sourceId!]: 'OpenRouter ' + (credentials!.list(user.id).filter(access => access.provider === provider).length)}}, user.id, Date.now());
            } else if (item.kind === 'sources') result = {sourceIds: item.sourceIds};
            const target = operation.boardId && directory.boards(user.id).find(board => board.id === operation.boardId);
            if (operation.boardId && !target) {operation.state = 'failed'; operation.error = 'board_not_found'; return;}
            if (target && item.kind !== 'replace') directory.transaction(() => {
              if (item.kind === 'widget' && target.role !== 'owner') throw {code: 'credential_permission'};
              const provided = store.sources(target.id).map(source => source.id);
              for (const id of result.sourceIds) if (!store.holds(user.id, id) && !(target.role === 'owner' && provided.includes(id))) throw {code: 'credential_permission'};
              for (const id of result.sourceIds) if (!target.personal && store.holds(user.id, id)) store.share(target.id, id, user.id, Date.now());
              const view = directory.view(target.id), ids = item.kind === 'widget' ? [item.widgetId] : result.sourceIds.map(id => 'source:' + id);
              directory.saveView(target.id, {...view, hidden: view.hidden.filter(id => !ids.includes(id)), shown: [...new Set([...view.shown, ...ids.filter(id => id === 'agents'), ...(item.kind === 'widget' ? ['empty:' + item.widgetId] : [])])]}, user.id, Date.now());
            });
            operation.result = result; operation.state = 'complete';
          } catch (error) {operation.state = 'needs_input'; operation.error = secretCode((error as {code?: string})?.code) ?? 'credential_failed';}
        };
        let flight = running.get(operation.id);
        if (!flight) {flight = work(); running.set(operation.id, flight);}
        await flight; running.delete(operation.id);
        if (operation.result && lostReplies.delete(user.id)) return reply.code(503).send({error: 'prototype_lost_reply'});
        return reply.sent ? reply : answer(operation);
      });
    });
  };
}
