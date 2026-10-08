import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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
import {BUDGET_WIDGETS, QUOTA_WIDGETS, widgetVisible} from '../../server/domain/widgets.js';

const secret = 'SYNTHETIC_PROVIDER_KEY_0123456789';
async function harness(extended = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-prototype-test-'));
  const store = new Store(path.join(dir, 'db.sqlite')), directory = new Directory(store.db);
  const key = SecretKey.parse(Buffer.from(Buffer.alloc(32, 7).toString('base64url')));
  const report = startSecrets(store.db, {current: key, previous: null, reset: null, storageAtStart: null, wasFileAtStart: false});
  const transport = new ConnectorTransport({host: '127.0.0.1', port: 443, operations: {}});
  const connector: Connector = {id: 'openrouter', transport, abilities: ['balance'], secretFormat: value => value === secret, map: () => null,
    identify: async () => {
      const at = Date.now();
      return {account: 'a'.repeat(24), abilities: ['balance'], expiresAt: null, measurement: {type: 'meters', observedAt: at, staleAfterMs: 204_000, keys: [], inventoryComplete: false, inventoryError: 'connector_inventory_partial',
        meters: [{id: 'credits', kind: 'counter', unit: 'USD', amount: '70000000', at, staleAfterMs: 204_000, stale: false, limit: null, resetAt: null, minutes: null, scope: null, label: null}, {id: 'usage', kind: 'counter', unit: 'USD', amount: '33000000', at, staleAfterMs: 204_000, stale: false, limit: null, resetAt: null, minutes: null, scope: null, label: null}]}};
    }, measure: async () => {throw new Error('No background provider calls in this fixture');},
  };
  const registry = new Map([['openrouter', connector]]), credentials = new Credentials(store, key, report, registry);
  const owner = directory.createUser('owner@fixture.example', 'Owner', 'unused-password', Date.now());
  const member = directory.createUser('member@fixture.example', 'Member', 'unused-password', Date.now());
  const board = directory.createBoard('Team', owner.id, Date.now()); directory.addMember(board.id, member.id, Date.now());
  const cookies = new Map<string, string>();
  for (const user of [owner, member]) {const token = newSecret('qt_s'); directory.createSession(token, user.id, Date.now(), 60_000); cookies.set(user.id, 'quotum_session=' + token);}
  const app = await buildApp({store, directory, credentials, ingest: new Ingest(store, directory, new Duty(), new Cadence()), pairing: new Pairing(directory), resets: new ResetFeed(undefined, () => {}), setup: new Setup(false, null), local: null}, extended ? demoAdditionControls : undefined);
  const call = (method: 'GET' | 'POST', url: string, payload?: object, user = owner.id, origin: string | null = 'http://localhost') => app.inject({method, url, payload, headers: {'X-Quotum-View-Version':'2',cookie: cookies.get(user)!, ...(origin ? {origin} : {})}});
  const reserve = async (item: object, user = owner.id, boardId: string | null = board.id) => (await call('POST', '/api/additions', {requestId: randomUUID(), boardId, item}, user)).json();
  const close = async () => {await app.close(); store.close(); transport.close(); rmSync(dir, {recursive: true, force: true});};
  return {store, directory, credentials, owner, member, board, call, reserve, close};
}

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

for (const first of ['codex', 'deepseek'] as const) test(`a new board waits for its first ${first} source before placing only that analytics pair`, async t => {
  const h = await harness(); t.after(h.close);
  const pair = first === 'codex' ? QUOTA_WIDGETS : BUDGET_WIDGETS;
  const other = first === 'codex' ? BUDGET_WIDGETS : QUOTA_WIDGETS;
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
  assert.deepEqual(owner.widgets.map((widget: {id: string}) => widget.id), ['agents', 'quota-history', 'subscription-funds', 'budget-history', 'budget-table']);
  const member = await read(h.member.id);
  assert.deepEqual(member.sources.map((source: {id: string; action: string}) => [source.id, source.action]), [[shared, 'show']]);
  assert.deepEqual(member.widgets, []);
  const operation = await h.reserve({kind: 'sources', sourceIds: [own]});
  await h.call('POST', '/api/additions/' + operation.id + '/run', {});
  assert.deepEqual((await read()).sources.map((source: {id: string}) => source.id), [shared], 'an added source disappears from the choices');
});
