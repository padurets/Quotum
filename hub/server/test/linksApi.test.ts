import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../api.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Ingest} from '../ingest.js';
import {Pairing} from '../pairing.js';
import {ResetFeed} from '../resets.js';
import {Setup} from '../setup.js';
import {bootstrapLocal} from '../local.js';
import {newSecret} from '../domain/auth.js';

for (const local of [false, true]) test(`link API enforces owner scope, origin, revisions and receipts (${local ? 'local' : 'web'})`, async () => {
  const now = Date.now(), store = new Store(':memory:', now), directory = new Directory(store.db), key = 'k'.repeat(43);
  const owner = local ? bootstrapLocal(directory, 'qt_m_' + 'a'.repeat(30), now, 'Fixture') : directory.createUser('owner@example.com', 'Owner', 'fixture', now);
  const other = local ? owner : directory.createUser('other@example.com', 'Other', 'fixture', now), source = store.source('openrouter', 'fixture', now);
  store.hold(source, owner.id, now);
  const ingest = new Ingest(store, directory, new Duty(), new Cadence());
  const app = await buildApp({store, directory, resets: new ResetFeed(undefined, () => {}), ingest, pairing: new Pairing(directory), setup: new Setup(false, null), local: local ? {key} : null});
  try {
    const cookies = new Map<string, string>();
    for (const user of [owner, other]) {const token = newSecret('qt_s'); directory.createSession(token, user.id, now, 3_600_000); cookies.set(user.id, 'quotum_session=' + token);}
    if (local) {const entered = await app.inject({url: '/local?key=' + key}); cookies.set(owner.id, String(entered.headers['set-cookie']).split(';')[0]);}
    const request = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, user = owner.id, origin?: string) => app.inject({method, url, payload, headers: {cookie: cookies.get(user)!, ...(origin ? {origin} : {})}});
    assert.equal((await app.inject({url: '/api/links'})).statusCode, 401);
    const initial = (await request('GET', '/api/links')).json();
    assert.equal(initial.revision, '0'); assert.deepEqual(initial.links, []); assert.equal(initial.sources[0].id, source);
    const body = {clientId: 'opencode', deviceId: null, route: null, sourceId: source, from: now, to: null, expectedRevision: '0', requestId: randomUUID()};
    assert.equal((await request('POST', '/api/links', body, owner.id, 'https://foreign.example')).statusCode, 403);
    const created = await request('POST', '/api/links', body); assert.equal(created.statusCode, 201);
    assert.deepEqual((await request('POST', '/api/links', body)).json(), created.json());
    const id = created.json().links[0].id;
    assert.equal((await request('POST', '/api/links', {...body, from: now + 1})).json().error, 'mutation_conflict');
    assert.equal((await request('POST', '/api/links/' + id, {...body, requestId: randomUUID()})).json().error, 'links_changed');
    assert.equal((await request('POST', '/api/links', {...body, expectedRevision: '1', requestId: randomUUID(), userId: other.id})).statusCode, 400);
    if (!local) {
      const foreign = await request('GET', '/api/links', undefined, other.id); assert.deepEqual(foreign.json().links, []); assert.deepEqual(foreign.json().sources, []);
      assert.equal((await request('DELETE', '/api/links/' + id, {expectedRevision: '0', requestId: randomUUID()}, other.id)).statusCode, 404);
      assert.equal((await request('POST', '/api/links', body, other.id)).statusCode, 404);
    }
    const removed = await request('DELETE', '/api/links/' + id, {expectedRevision: '1', requestId: randomUUID()}); assert.equal(removed.statusCode, 200); assert.deepEqual(removed.json().links, []);
    const bad = {...body, requestId: randomUUID(), expectedRevision: '2', route: {class: 'api', provider: 'custom-private-gateway'}};
    const denied = await request('POST', '/api/links', bad); assert.equal(denied.statusCode, 400); assert.ok(!denied.body.includes('custom-private-gateway'));
    const device = directory.saveDevice({userId: owner.id, machine: {id: 'fixture', name: 'Laptop', os: 'linux', arch: 'x86_64'}, agent: 'fixture', tokenId: null}, now).id;
    const route = {class: 'api' as const, provider: 'openrouter', by: 'session' as const, host: 'openrouter.ai'};
    const session = {clientId: 'codex', source: null, sessionId: 'a'.repeat(32), origin: 'terminal' as const, project: 'Project', folder: null, startedAt: now - 20 * 60_000, sentStartedAt: now - 20 * 60_000, lastWorkedAt: null, working: true, route, device: {id: device, name: 'Laptop'}};
    ingest.live.report(device, owner.id, [session], now);
    const future = {...body, deviceId: device, clientId: 'codex', route: {class: 'api', provider: 'openrouter'}, from: now + 10 * 60_000, expectedRevision: '2', requestId: randomUUID()};
    assert.equal((await request('POST', '/api/links', future)).statusCode, 201);
    const past = {...future, from: now - 10 * 60_000, to: now - 2 * 60_000, expectedRevision: '3', requestId: randomUUID()};
    assert.equal((await request('POST', '/api/links', past)).statusCode, 201);
    const before = [store.links.list(owner.id), store.links.revision(owner.id), store.db.prepare('SELECT * FROM link_mutations').all()];
    const hint = (await request('GET', '/api/links/suggestions')).json().suggestions[0];
    assert.deepEqual([hint.from, hint.to], [past.to, future.from]);
    assert.deepEqual([store.links.list(owner.id), store.links.revision(owner.id), store.db.prepare('SELECT * FROM link_mutations').all()], before);
    const second = store.source('openrouter', 'second', now); store.hold(second, owner.id, now);
    assert.deepEqual((await request('GET', '/api/links/suggestions')).json().suggestions, []);
    const suggestionBody = {...hint, suggestion: hint, expectedRevision: '4', requestId: randomUUID()};
    assert.equal((await request('POST', '/api/links', suggestionBody)).json().error, 'suggestion_changed');
    store.release(second, owner.id);
    const accepted = await request('POST', '/api/links', suggestionBody); assert.equal(accepted.statusCode, 201);
    assert.deepEqual((await request('GET', '/api/links/suggestions')).json().suggestions, []);
    store.db.prepare('INSERT INTO device_tracking_policy VALUES (?,?,0)').run(device, 'codex');
    assert.deepEqual((await request('POST', '/api/links', suggestionBody)).json(), accepted.json());
    const attribution = (await request('GET', '/api/links/attribution')).json().sessions[0];
    assert.equal(attribution.route, null); assert.equal(attribution.host, undefined);
    if (!local) assert.deepEqual((await request('GET', '/api/links/attribution', undefined, other.id)).json().sessions, []);
  } finally {await app.close(); store.close();}
});
