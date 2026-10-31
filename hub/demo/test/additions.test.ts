import {VIEW_VERSION, VIEW_VERSION_HEADER} from '../../server/domain/view.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {Events, type Clock} from '../../server/events.js';
import {HubSources} from '../../server/hubSources.js';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {demoAdditionControls} from '../additions.js';
import {buildApp} from '../../server/api.js';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {newSecret} from '../../server/domain/auth.js';
import {Credentials, SecretKey, startSecrets} from '../../server/secrets/index.js';
import {ConnectorTransport, type Connector} from '../../server/connectors/index.js';
import {Ingest} from '../../server/ingest.js';
import {Duty} from '../../server/duty.js';
import {Cadence} from '../../server/cadence.js';
import {Pairing} from '../../server/pairing.js';
import {ResetFeed} from '../../server/resets.js';
import {Setup} from '../../server/setup.js';
import {LEGACY_BUDGET_WIDGETS, QUOTA_WIDGETS, widgetVisible} from '../../server/domain/widgets.js';

const secret = 'SYNTHETIC_PROVIDER_KEY_0123456789';
class TestClock implements Clock {
  time = Date.now();
  tasks = new Map<number, {at: number; run: () => void}>();
  id = 0;
  now = () => this.time;
  after = (ms: number, run: () => void) => {const id = ++this.id; this.tasks.set(id, {at: this.time + ms, run}); return () => {this.tasks.delete(id);};};
  tick(ms = 0) {this.time += ms; for (let i = 0; i < 100; i++) {const due = [...this.tasks].find(([, task]) => task.at <= this.time); if (!due) return; this.tasks.delete(due[0]); due[1].run();} throw new Error('timer_loop');}
}
const settle = async () => {for (let i = 0; i < 20; i++) await setImmediate();};
async function harness(extended = true, managed = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-prototype-test-'));
  const store = new Store(path.join(dir, 'db.sqlite')), directory = new Directory(store.db);
  const key = SecretKey.parse(Buffer.from(Buffer.alloc(32, 7).toString('base64url')));
  const report = startSecrets(store.db, {current: key, previous: null, reset: null, storageAtStart: null, wasFileAtStart: false});
  const transport = new ConnectorTransport({host: '127.0.0.1', port: 443, operations: {}});
  const clock = new TestClock(), poll = {calls: 0, delay: false, release: null as (() => void) | null};
  const connector: Connector = {id: 'openrouter', transport, abilities: ['balance'], secretFormat: value => value === secret, map: () => null,
    identify: async () => {
      const at = clock.now();
      return {account: 'a'.repeat(24), abilities: ['balance'], expiresAt: null, measurement: {type: 'meters', observedAt: at, staleAfterMs: 204_000, keys: [], inventoryComplete: false, inventoryError: 'connector_inventory_partial',
        meters: [{id: 'credits', kind: 'counter', unit: 'USD', amount: '70000000', at, staleAfterMs: 204_000, stale: false, limit: null, resetAt: null, minutes: null, scope: null, label: null}, {id: 'usage', kind: 'counter', unit: 'USD', amount: '33000000', at, staleAfterMs: 204_000, stale: false, limit: null, resetAt: null, minutes: null, scope: null, label: null}]}};
    }, measure: async (secret, _expected, signal) => {
      if (!managed) throw new Error('No background provider calls in this fixture');
      poll.calls++;
      if (poll.delay) await new Promise<void>(resolve => {poll.release = resolve;});
      return connector.identify(secret, signal);
    },
  };
  const registry = new Map([['openrouter', connector]]), credentials = new Credentials(store, key, report, registry);
  const owner = directory.createUser('owner@fixture.example', 'Owner', 'unused-password', Date.now());
  const member = directory.createUser('member@fixture.example', 'Member', 'unused-password', Date.now());
  const board = directory.createBoard('Team', owner.id, Date.now()); directory.addMember(board.id, member.id, Date.now());
  const cookies = new Map<string, string>();
  for (const user of [owner, member]) {const token = newSecret('qt_s'); directory.createSession(token, user.id, Date.now(), 60_000); cookies.set(user.id, 'quotum_session=' + token);}
  const ingest = new Ingest(store, directory, new Duty(), new Cadence()), resets = new ResetFeed(undefined, () => {});
  const hubSources = managed ? new HubSources(store, credentials, clock, ingest.live) : undefined;
  const events = new Events({store, directory, ingest, resets, hubSources}, undefined, clock);
  const histories: {source: string; since: number; scopes: readonly string[]}[] = [];
  const app = await buildApp({store, directory, credentials, ingest, pairing: new Pairing(directory), resets, setup: new Setup(false, null), local: null, hubSources, events}, extended ? demoAdditionControls : undefined);
  const onHistory = events.onHistory;
  events.onHistory = (source, since, scopes, work) => {histories.push({source, since, scopes: scopes ?? []}); onHistory?.(source, since, scopes, work);};
  const call = (method: 'GET' | 'POST', url: string, payload?: object, user = owner.id, origin: string | null = 'http://localhost') => app.inject({method, url, payload, headers: {[VIEW_VERSION_HEADER]:String(VIEW_VERSION),cookie: cookies.get(user) ?? '', ...(origin ? {origin} : {})}});
  const reserve = async (item: object, user = owner.id, boardId: string | null = board.id) => (await call('POST', '/api/additions', {requestId: randomUUID(), boardId, item}, user)).json();
  const close = async () => {hubSources?.stop(); await app.close(); store.close(); transport.close(); rmSync(dir, {recursive: true, force: true});};
  return {store, directory, credentials, owner, member, board, call, reserve, close, clock, hubSources, poll, histories};
}

test('the producer stop control is demo-only, authenticated and same-site', async t => {
  const url = '/api/prototype/stop-hub-sources';
  const normal = await harness(false); t.after(normal.close);
  assert.equal((await normal.call('POST', url)).statusCode, 404);
  const h = await harness(true, true); t.after(h.close);
  let stops = 0; const stop = h.hubSources!.stop.bind(h.hubSources);
  t.mock.method(h.hubSources!, 'stop', () => {stops++; stop();});
  assert.equal((await h.call('POST', url, undefined, 'no-session')).statusCode, 401);
  for (const origin of [null, 'https://foreign.example']) assert.equal((await h.call('POST', url, undefined, h.owner.id, origin)).statusCode, 403);
  assert.equal(stops, 0);
  const result = await h.call('POST', url);
  assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), {ok: true}); assert.equal(stops, 1);
});

test('the producer stop control fails explicitly without a composed hub producer', async t => {
  const h = await harness(); t.after(h.close);
  const result = await h.call('POST', '/api/prototype/stop-hub-sources');
  assert.equal(result.statusCode, 503); assert.deepEqual(result.json(), {error: 'prototype_hub_sources_unavailable'});
});

for (const mode of ['poll', 'stop-before-poll', 'stop-inflight'] as const) test(`the fixture ${mode} preserves financial evidence and isolates fixed Activity`, async t => {
  const h = await harness(true, true); t.after(h.close);
  const operation = await h.reserve({kind: 'connection', provider: 'openrouter'});
  const added = await h.call('POST', '/api/additions/' + operation.id + '/run', {secret});
  assert.equal(added.json().state, 'complete');
  const source = added.json().result.sourceIds[0] as string;
  h.store.setMeasureInterval(source, 120_000);
  h.clock.tick(1); h.hubSources!.start(); h.clock.tick(); await settle();
  const at = h.store.state(source).successAt!;
  assert.equal(h.poll.calls, 1); assert.equal(h.hubSources!.cadence(source).value!.next - h.clock.now(), 120_000);
  assert.equal(h.store.state(source).staleAfterMs, 204_000);
  const snapshot = () => JSON.stringify({
    state: h.store.state(source), cohort: h.store.sources(h.board.id),
    credentials: h.store.db.prepare('SELECT * FROM credentials ORDER BY id').all(),
    holders: h.store.db.prepare('SELECT * FROM holders ORDER BY source_id, user_id').all(),
    readings: h.store.db.prepare('SELECT * FROM readings ORDER BY source_id, meter_id, at').all(),
    spans: h.store.db.prepare('SELECT * FROM meter_spans ORDER BY source_id, meter_id, from_at').all(),
  });
  const before = snapshot(); h.histories.length = 0;
  if (mode === 'stop-before-poll') assert.equal((await h.call('POST', '/api/prototype/stop-hub-sources')).statusCode, 200);
  if (mode === 'stop-inflight') h.poll.delay = true;
  h.clock.tick(120_000); await settle();
  if (mode === 'stop-inflight') {
    assert.ok(h.poll.release, 'the scheduled poll reached its delayed synthetic answer');
    assert.equal((await h.call('POST', '/api/prototype/stop-hub-sources')).statusCode, 200);
    h.poll.release(); await settle();
  }
  if (mode === 'poll') {
    assert.equal(h.store.state(source).successAt, at + 120_000);
    assert.ok(h.histories.some(row => row.source === source && row.scopes.includes('budget') && row.since === at), 'unchanged amounts at a new time invalidate budget history');
  } else {
    assert.equal(snapshot(), before, 'stopping preserves credentials, holders, cohort, readings, spans and source state');
    assert.deepEqual(h.histories, []); assert.equal(h.hubSources!.cadence(source).value, null);
    h.clock.tick(240_000); await settle();
    assert.equal(snapshot(), before); assert.deepEqual(h.histories, []);
    assert.equal(h.poll.calls, mode === 'stop-before-poll' ? 1 : 2, 'a stopped producer never restarts');
  }
});

test('prototype routes require explicit composition and preserve Origin and owner boundaries', async t => {
  const normal = await harness(false); t.after(normal.close);
  assert.equal((await normal.call('GET', '/api/boards/' + normal.board.id + '/catalogue')).statusCode, 200);
  assert.equal((await normal.call('POST', '/api/prototype/device', {})).statusCode, 404);
  const h = await harness(); t.after(h.close);
  const payload = {requestId: randomUUID(), boardId: h.board.id, item: {kind: 'connection', provider: 'openrouter'}};
  assert.equal((await h.call('POST', '/api/additions', payload, h.owner.id, null)).statusCode, 403);
  assert.equal((await h.call('POST', '/api/additions', {...payload, item: {...payload.item, secret}})).statusCode, 400);
  const reserved = await h.reserve(payload.item);
  assert.equal((await h.call('GET', '/api/additions/' + reserved.id, undefined, h.member.id)).statusCode, 404);
  assert.equal(h.credentials.list(h.owner.id).length, 0);
});

test('one no-expiry prototype submit gives the shared board a real measured card and reuses access', async t => {
  const h = await harness(); t.after(h.close);
  assert.equal(h.store.sources(h.board.id).length, 0);
  const operation = await h.reserve({kind: 'connection', provider: 'openrouter'}, h.member.id);
  const runs = await Promise.all([h.call('POST', '/api/additions/' + operation.id + '/run', {secret}, h.member.id), h.call('POST', '/api/additions/' + operation.id + '/run', {secret}, h.member.id)]);
  for (const run of runs) assert.equal(run.json().state, 'complete');
  assert.equal(h.credentials.list(h.member.id).length, 1);
  const source = h.store.sources(h.board.id)[0].id;
  assert.equal(h.store.state(source).successAt !== null, true);
  assert.equal(h.directory.view(h.board.id).hidden.includes('source:' + source), false);
  const snapshot = await h.call('GET', '/api/overview?board=' + h.board.id);
  assert.equal(snapshot.body.includes(secret), false);
  assert.equal(snapshot.body.includes(runs[0].json().result.credentialId), false);
  assert.equal((await h.call('GET', '/api/connections')).json().connections.length, 0, 'board owner cannot inspect the member connection');
  const repeat = await h.reserve({kind: 'connection', provider: 'openrouter'}, h.member.id);
  assert.equal((await h.call('POST', '/api/additions/' + repeat.id + '/run', {secret}, h.member.id)).json().result.connection, 'reused');
  assert.equal(h.credentials.list(h.member.id).length, 1);
});

test('lost response recovery finds the receipt and never resurrects a later hidden card', async t => {
  const h = await harness(); t.after(h.close);
  await h.call('POST', '/api/prototype/control', {lostReply: true});
  const operation = await h.reserve({kind: 'connection', provider: 'openrouter'});
  const lost = await h.call('POST', '/api/additions/' + operation.id + '/run', {secret});
  assert.equal(lost.statusCode, 503);
  const receipt = (await h.call('GET', '/api/additions/' + operation.id)).json();
  assert.equal(receipt.state, 'complete');
  const source = receipt.result.sourceIds[0], view = h.directory.view(h.board.id);
  h.directory.saveView(h.board.id, {...view, hidden: ['source:' + source]}, h.owner.id, Date.now());
  const replay = (await h.call('POST', '/api/additions/' + operation.id + '/run', {})).json();
  assert.equal(replay.current.sources[0].placement, 'hidden');
  assert.deepEqual(h.directory.view(h.board.id).hidden, ['source:' + source]);
  assert.equal((await h.call('GET', '/api/additions')).json().operations[0].id, receipt.id);
});

test('members add only their sources; an empty analytic does not expose the other defaults', async t => {
  const h = await harness(); t.after(h.close);
  const source = h.store.source('codex', 'own-fixture', Date.now()); h.store.hold(source, h.owner.id, Date.now());
  const stolen = await h.reserve({kind: 'sources', sourceIds: [source]}, h.member.id);
  assert.equal(stolen.error, 'addition_permission');
  assert.equal(h.store.sources(h.board.id).length, 0);
  const widget = await h.reserve({kind: 'widget', widgetId: 'quota-history'});
  assert.equal((await h.call('POST', '/api/additions/' + widget.id + '/run', {})).json().state, 'complete');
  assert.deepEqual(h.directory.view(h.board.id).shown, ['quota-history']);
  const memberWidget = await h.reserve({kind: 'widget', widgetId: 'agents'}, h.member.id);
  assert.equal(memberWidget.error, 'addition_permission');
  assert.deepEqual(h.directory.view(h.board.id).shown, ['quota-history']);
});

test('the sessions table is an owner-only explicit placement and receipt replay preserves a subsequent hide',async t=>{
  const h=await harness();t.after(h.close);
  assert.equal(h.directory.view(h.board.id).shown.includes('agents'),false);
  assert.equal((await h.reserve({kind:'widget',widgetId:'agents'},h.member.id)).error,'addition_permission');
  const receipt=await h.reserve({kind:'widget',widgetId:'agents'});
  assert.equal((await h.call('POST','/api/additions/'+receipt.id+'/run',{})).json().state,'complete');
  const placed=h.directory.view(h.board.id);assert.deepEqual(placed.shown,['agents']);
  assert.equal(placed.layout.places['agents'],undefined,'the normal client arrangement materializes geometry');
  h.directory.saveView(h.board.id,{...placed,hidden:['agents']},h.owner.id,Date.now());
  await h.call('POST','/api/additions/'+receipt.id+'/run',{});
  assert.ok(h.directory.view(h.board.id).hidden.includes('agents'));
  const readd=await h.reserve({kind:'widget',widgetId:'agents'});
  await h.call('POST','/api/additions/'+readd.id+'/run',{});
  assert.ok(!h.directory.view(h.board.id).hidden.includes('agents'));
});

for (const first of ['codex', 'deepseek'] as const) test(`a new board waits for its first ${first} source before placing only that analytics pair`, async t => {
  const h = await harness(); t.after(h.close);
  const pair = first === 'codex' ? QUOTA_WIDGETS : LEGACY_BUDGET_WIDGETS;
  const other = first === 'codex' ? LEGACY_BUDGET_WIDGETS : QUOTA_WIDGETS;
  const source = h.store.source(first, 'first-source', Date.now());
  h.store.hold(source, h.owner.id, Date.now());
  // Owning the source on the personal board does not place it on a new shared board.
  const snapshot = async () => (await h.call('GET', '/api/overview?board=' + h.board.id)).json();
  const before = await snapshot();
  assert.equal(before.sources.length, 0);
  for (const id of [...pair, ...other]) assert.equal(widgetVisible(before.view, id, 0), false);
  const operation = await h.reserve({kind: 'sources', sourceIds: [source]});
  assert.equal((await h.call('POST', '/api/additions/' + operation.id + '/run', {})).json().state, 'complete');
  const after = await snapshot();
  assert.equal(after.sources.length, 1);
  for (const id of pair) assert.equal(widgetVisible(after.view, id, 1), true);
  for (const id of other) assert.equal(widgetVisible(after.view, id, 1), false);
  assert.deepEqual((await snapshot()).view, after.view, 'reload preserves the same placement');
  const hidden = {...after.view, hidden: [...after.view.hidden, pair[0]]};
  h.directory.saveView(h.board.id, hidden, h.owner.id, Date.now());
  const second = h.store.source(first === 'codex' ? 'deepseek' : 'codex', 'second-source', Date.now());
  h.store.hold(second, h.owner.id, Date.now());
  const next = await h.reserve({kind: 'sources', sourceIds: [second]});
  assert.equal((await h.call('POST', '/api/additions/' + next.id + '/run', {})).json().state, 'complete');
  const mixed = await snapshot();
  for (const id of other) assert.equal(widgetVisible(mixed.view, id, 2), true);
  assert.equal(widgetVisible(mixed.view, pair[0], 2), false, 'a hidden widget is not restored by another family');
});

test('synthetic device discovery provides nothing until its selected source is added', async t => {
  const h = await harness(); t.after(h.close);
  const response = await h.call('POST', '/api/prototype/device', {}, h.member.id);
  assert.equal(response.statusCode, 200);
  const device = h.directory.deviceById(response.json().deviceId)!;
  assert.equal(device.userId, h.member.id);
  const sources = h.store.held(h.member.id);
  assert.equal(sources.length, 2);
  assert.equal(h.store.sources(h.board.id).length, 0);
  const selection = await h.reserve({kind: 'sources', sourceIds: [sources[0].id]}, h.member.id);
  assert.equal((await h.call('POST', '/api/additions/' + selection.id + '/run', {}, h.member.id)).json().state, 'complete');
  assert.deepEqual(h.store.sources(h.board.id).map(source => source.id), [sources[0].id]);
});

test('the add catalogue contains only eligible absent or hidden widgets', async t => {
  const h = await harness(); t.after(h.close);
  const own = h.store.source('codex', 'own-fixture', Date.now()), shared = h.store.source('claude', 'shared-fixture', Date.now());
  h.store.hold(own, h.owner.id, Date.now()); h.store.hold(shared, h.member.id, Date.now());
  h.store.share(h.board.id, shared, h.member.id, Date.now());
  const read = async (user = h.owner.id) => (await h.call('GET', '/api/boards/' + h.board.id + '/catalogue', undefined, user)).json();
  assert.deepEqual((await read()).sources.map((source: {id: string}) => source.id), [own]);
  const view = h.directory.view(h.board.id);
  h.directory.saveView(h.board.id, {...view, hidden: ['source:' + shared, 'quota-history']}, h.owner.id, Date.now());
  const owner = await read();
  assert.deepEqual(owner.sources.map((source: {id: string; action: string}) => [source.id, source.action]), [[own, 'add'], [shared, 'show']]);
  assert.deepEqual(owner.widgets.map((widget: {id: string}) => widget.id), ['agent-hours-heatmap', 'agents', 'quota-history', 'subscription-funds', 'budget-history', 'budget-table']);
  const member = await read(h.member.id);
  assert.deepEqual(member.sources.map((source: {id: string; action: string}) => [source.id, source.action]), [[shared, 'show']]);
  assert.deepEqual(member.widgets, []);
  const operation = await h.reserve({kind: 'sources', sourceIds: [own]});
  await h.call('POST', '/api/additions/' + operation.id + '/run', {});
  assert.deepEqual((await read()).sources.map((source: {id: string}) => source.id), [shared], 'an added source disappears from the choices');
});
