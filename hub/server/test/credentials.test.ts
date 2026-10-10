import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildApp, type Hub} from '../api.js';
import type {BoardAdditions} from '../additions.js';
import {Cadence} from '../cadence.js';
import {Duty} from '../duty.js';
import {Ingest} from '../ingest.js';
import {Pairing} from '../pairing.js';
import {ResetFeed} from '../resets.js';
import {Setup} from '../setup.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';
import {ConnectorTransport, type Connector} from '../connectors/index.js';
import {Credentials, SecretError, SecretKey, startSecrets, type SecretKeyReport} from '../secrets/index.js';
import {newSecret} from '../domain/auth.js';
import {VIEW_VERSION, VIEW_VERSION_HEADER} from '../domain/view.js';

const CANARY = 'CANARY_PRIVATE_CREDENTIAL_0123456789';
const KEK = Buffer.alloc(32, 7).toString('base64url');
const ORIGIN = 'http://localhost';
const fixture: Connector = {id: 'test', secretFormat: value => value.length >= 16, abilities: ['balance'], transport: new ConnectorTransport({host: '127.0.0.1', port: 443, operations: {balance: {path: '/balance'}}}), map: () => ({abilities: ['balance'], expiresAt: null}), identify: async () => ({account: '0'.repeat(24), abilities: ['balance'], expiresAt: Date.now()+3_600_000}), measure: async () => {throw new SecretError('connector_invalid_response');}};

async function harness(options: {available?: boolean; report?: SecretKeyReport} = {}) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'quotum-credentials-')), 'db.sqlite');
  const store = new Store(file);
  const directory = new Directory(store.db);
  const key = options.available === false ? null : SecretKey.parse(Buffer.from(KEK));
  const report = options.report ?? startSecrets(store.db, {current: key, previous: null, reset: null, storageAtStart: null, wasFileAtStart: false});
  const credentials = new Credentials(store, key, report, new Map([['test', fixture]]));
  const cookies = new Map<string, string>();
  const users = new Map<string, string>();
  for (const name of ['alice', 'bob']) {
    const user = directory.createUser(`${name}@example.com`, name, 'unused-test-password', Date.now());
    const token = newSecret('qt_s'); directory.createSession(token, user.id, Date.now(), 60_000);
    cookies.set(name, `quotum_session=${token}`); users.set(name, user.id);
  }
  const hub:Hub={store, directory, credentials, resets: new ResetFeed(undefined, () => {}), ingest: new Ingest(store, directory, new Duty(), new Cadence()), pairing: new Pairing(directory), setup: new Setup(false, null), local: null};
  let additions!:BoardAdditions;
  const app = await buildApp(hub,(_app,current)=>{additions=current.additions!;});
  const call = (method: 'POST' | 'GET' | 'DELETE', url: string, payload?: object | string, as = 'alice', origin: string | null = ORIGIN) => app.inject({method, url, payload, headers: {[VIEW_VERSION_HEADER]: String(VIEW_VERSION), ...(cookies.has(as) ? {cookie: cookies.get(as)} : {}), ...(origin ? {origin} : {}), ...(typeof payload === 'string' ? {'content-type': 'application/json'} : {})}});
  const clean = (...outputs: string[]) => {
    for (const output of outputs) for (const secret of [CANARY, KEK]) assert.equal(output.includes(secret), false, 'no complete secret in output');
    for (const suffix of ['', '-wal', '-shm']) for (const secret of [CANARY, KEK]) assert.equal(readFileSync(file + suffix).includes(Buffer.from(secret)), false, 'no plaintext in SQLite files');
  };
  return {app, call, store, directory, credentials, additions, users, clean};
}

test('credentials are owner-only, write-only, and never shared with a board', async t => {
  const h = await harness(); t.after(async () => { await h.app.close(); h.store.close(); });
  const created = await h.call('POST', '/api/credentials', {provider: 'test', secret: CANARY});
  assert.equal(created.statusCode, 201);
  const dto = created.json();
  assert.deepEqual(Object.keys(dto).sort(), ['abilities', 'createdAt', 'expiresAt', 'expiryKind', 'hint', 'id', 'identityOrigin', 'lastError', 'lastUsedAt', 'provider', 'revision', 'sourceId', 'unreadable']);
  assert.equal(dto.hint, CANARY.slice(-4));
  assert.equal((await h.call('GET', '/api/credentials')).json().credentials.length, 1);
  assert.deepEqual((await h.call('GET', '/api/credentials', undefined, 'bob')).json(), {credentials: []});
  assert.equal((await h.call('POST', `/api/credentials/${dto.id}`, {secret: CANARY}, 'bob')).statusCode, 404);
  assert.equal((await h.call('DELETE', `/api/credentials/${dto.id}`, undefined, 'bob')).statusCode, 204);
  assert.equal((await h.call('GET', '/api/credentials')).json().credentials.length, 1);
  const team = h.directory.createBoard('Team', h.users.get('alice')!, Date.now());
  h.directory.addMember(team.id, h.users.get('bob')!, Date.now());
  const shared = await h.call('GET', `/api/overview?board=${team.id}`, undefined, 'bob');
  assert.equal(shared.statusCode, 200);
  assert.equal(shared.body.includes(dto.id), false);
  h.clean(created.body, shared.body);
});

test('credentials require session and an explicit valid Origin before parsing the body', async t => {
  const h = await harness(); t.after(async () => { await h.app.close(); h.store.close(); });
  assert.equal((await h.call('POST', '/api/credentials', '{bad-json', 'anonymous')).statusCode, 401);
  assert.equal((await h.call('POST', '/api/credentials', '{bad-json', 'alice', null)).statusCode, 403);
  assert.equal((await h.call('POST', '/api/credentials', '{bad-json', 'alice', 'http://foreign.example')).statusCode, 403);
  assert.equal((await h.call('GET', '/api/credentials', undefined, 'anonymous')).statusCode, 401);
});

test('strict body and secret validation never reflects malformed canaries, including parser failures', async t => {
  const h = await harness(); t.after(async () => { await h.app.close(); h.store.close(); });
  const errors: string[] = []; const oldError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  t.after(() => { console.error = oldError; });
  const cases: (object | string)[] = [
    {provider: 'test', secret: CANARY + '\r\n'}, {provider: 'test', secret: CANARY + '\0'}, {provider: 'test', secret: 'short'},
    {provider: 'test', secret: 123}, {provider: 'test', secret: CANARY, extra: true}, {secret: CANARY},
    `{"provider":"test","secret":"${CANARY}"`, `{"provider":"test","secret":"${CANARY}\u0000"}`, null as unknown as object,
  ];
  for (const body of cases) {
    const response = await h.call('POST', '/api/credentials', body);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {error: 'credential_invalid'});
    h.clean(response.body);
  }
  for (const url of [`/api/credentials/${CANARY}%zz`, `/api/credentials/${CANARY.repeat(5)}`]) {
    const response = await h.call('POST', url, {secret: CANARY});
    assert.equal(response.statusCode, 400);
    h.clean(response.body);
  }
  h.clean(...errors);
});

test('the full 4096-byte printable secret fits even when every character is JSON-escaped', async t => {
  const h = await harness(); t.after(async () => { await h.app.close(); h.store.close(); });
  const body = '{"provider":"test","secret":"' + '\\u0041'.repeat(4096) + '"}';
  const response = await h.call('POST', '/api/credentials', body);
  assert.equal(response.statusCode, 201);
  assert.equal((await h.call('POST', '/api/credentials', {provider: 'test', secret: 'A'.repeat(4097)})).statusCode, 400);
});

test('successful mutations count against the per-user and address limits', async t => {
  const h = await harness(); t.after(async () => { await h.app.close(); h.store.close(); });
  for (let i = 0; i < 10; i++) assert.equal((await h.call('POST', '/api/credentials', {provider: 'test', secret: CANARY})).statusCode, 201);
  const refused = await h.call('POST', '/api/credentials', {provider: 'test', secret: CANARY});
  assert.equal(refused.statusCode, 429); assert.equal(refused.headers['retry-after'], '60');
  assert.equal((await h.call('POST', '/api/credentials', {provider: 'test', secret: CANARY}, 'bob')).statusCode, 429, 'same address cannot bypass the limit');
  assert.equal((await h.call('GET', '/api/credentials')).statusCode, 200);
});

test('replace uses a new nonce and remove truncates WAL; repeating removal still does maintenance', async t => {
  const h = await harness(); t.after(async () => { await h.app.close(); h.store.close(); });
  const first = await h.call('POST', '/api/credentials', {provider: 'test', secret: CANARY});
  const id = first.json().id;
  const before = h.store.db.prepare('SELECT cipher, nonce FROM credentials').get()!;
  const second = await h.call('POST', `/api/credentials/${id}`, {secret: CANARY + '_replacement'});
  assert.equal(second.statusCode, 200);
  assert.notDeepEqual(h.store.db.prepare('SELECT nonce FROM credentials').get()?.nonce, before.nonce);
  assert.equal(readFileSync(h.store.db.location()! + '-wal').length, 0);
  assert.equal((await h.call('DELETE', `/api/credentials/${id}`)).statusCode, 204);
  assert.equal((await h.call('DELETE', `/api/credentials/${id}`)).statusCode, 204);
  assert.deepEqual((await h.call('GET', '/api/credentials')).json(), {credentials: []});
  h.clean(first.body, second.body);
});

test('disabled KEK blocks create/replace, while listing and explicit removal remain available', async t => {
  const h = await harness({available: false}); t.after(async () => { await h.app.close(); h.store.close(); });
  const result = await h.call('POST', '/api/credentials', {provider: 'test', secret: CANARY});
  assert.equal(result.statusCode, 409); assert.equal(result.json().error, 'secret_key_missing');
  assert.equal((await h.call('GET', '/api/credentials')).statusCode, 200);
  assert.equal((await h.call('DELETE', '/api/credentials/00000000-0000-0000-0000-000000000000')).statusCode, 204);
  const session = (await h.call('GET', '/api/session')).json();
  assert.deepEqual(session.trustedKeys, {available: false, reason: 'secret_key_missing'});
  assert.equal(session.secretKey, undefined);
  assert.equal((await h.call('GET', '/api/session', undefined, 'anonymous')).json().trustedKeys, undefined);
});

test('raw SQL failures are code-only and preserve the previous credential', async t => {
  const h = await harness(); t.after(async () => { await h.app.close(); h.store.close(); });
  const id = (await h.call('POST', '/api/credentials', {provider: 'test', secret: CANARY})).json().id;
  const before = h.store.db.prepare('SELECT cipher FROM credentials').get()?.cipher;
  h.store.db.function('test_private_failure', () => { throw new Error(CANARY); });
  h.store.db.exec('CREATE TRIGGER test_failure BEFORE UPDATE ON credentials BEGIN SELECT test_private_failure(); END');
  const result = await h.call('POST', `/api/credentials/${id}`, {secret: CANARY + '_next'});
  assert.equal(result.statusCode, 500); assert.deepEqual(result.json(), {error: 'credential_failed'});
  assert.deepEqual(h.store.db.prepare('SELECT cipher FROM credentials').get()?.cipher, before);
  h.clean(result.body);
});

test('an old probe cannot change the status of a replaced credential', async t => {
  const h = await harness(); t.after(async () => { await h.app.close(); h.store.close(); });
  const owner = h.users.get('alice')!;
  const id = (await h.credentials.create(owner, 'test', CANARY)).id;
  let finish!: (value: unknown) => void;
  const original = fixture.transport.send;
  fixture.transport.send = () => new Promise(resolve => { finish = resolve; });
  t.after(() => { fixture.transport.send = original; });
  const old = h.credentials.probe(owner, id, 'balance');
  await h.credentials.replace(owner, id, CANARY + '_replacement');
  finish({}); await old;
  const current = h.credentials.list(owner)[0];
  assert.equal(current.lastUsedAt, null);
  assert.equal(current.lastError, null);
  assert.equal(current.unreadable, false);
});

for (const reason of ['missing', 'mismatch', 'unknown-provider'] as const) {
  test(`a ${reason} probe preserves a previously unreadable credential and startup count`, async t => {
    const h = await harness(); t.after(async () => { await h.app.close(); h.store.close(); });
    const owner = h.users.get('alice')!;
    const id = (await h.credentials.create(owner, 'test', CANARY)).id;
    h.store.db.prepare("UPDATE credentials SET cipher = zeroblob(length(cipher)), unreadable = 1, last_error = 'credential_unreadable' WHERE id = ?").run(id);
    const before = h.store.db.prepare('SELECT cipher, nonce FROM credentials WHERE id = ?').get(id)!;
    const matching = SecretKey.parse(Buffer.from(KEK));
    const key = reason === 'missing' ? null : reason === 'mismatch' ? SecretKey.parse(Buffer.from(Buffer.alloc(32, 8).toString('base64url'))) : matching;
    const report = startSecrets(h.store.db, {current: key, previous: null, reset: null, storageAtStart: null, wasFileAtStart: false});
    const credentials = new Credentials(h.store, key, report, reason === 'unknown-provider' ? new Map() : new Map([['test', fixture]]));
    const code = reason === 'unknown-provider' ? 'credential_provider_unknown' : `secret_key_${reason}`;
    await assert.rejects(credentials.probe(owner, id, 'balance'), error => error instanceof SecretError && error.code === code);
    const after = credentials.list(owner)[0];
    assert.equal(after.unreadable, true);
    assert.equal(after.lastError, code);
    assert.deepEqual(h.store.db.prepare('SELECT cipher, nonce FROM credentials WHERE id = ?').get(id), before);
    assert.equal(startSecrets(h.store.db, {current: matching, previous: null, reset: null, storageAtStart: null, wasFileAtStart: false}).unreadable, 1);
    h.clean(JSON.stringify(after));
  });
}

test('a transport failure after authenticated decryption clears a stale unreadable flag', async t => {
  const h = await harness(); t.after(async () => { await h.app.close(); h.store.close(); });
  const owner = h.users.get('alice')!;
  const id = (await h.credentials.create(owner, 'test', CANARY)).id;
  h.store.db.prepare("UPDATE credentials SET unreadable = 1, last_error = 'credential_unreadable' WHERE id = ?").run(id);
  const original = fixture.transport.send;
  fixture.transport.send = async (_operation, secret) => {
    assert.equal(secret.toString('ascii'), CANARY);
    throw new SecretError('connector_timeout');
  };
  t.after(() => { fixture.transport.send = original; });
  await assert.rejects(h.credentials.probe(owner, id, 'balance'), error => error instanceof SecretError && error.code === 'connector_timeout');
  const after = h.credentials.list(owner)[0];
  assert.equal(after.unreadable, false);
  assert.equal(after.lastError, 'connector_timeout');
  h.clean(JSON.stringify(after));
});

test('an authenticated probe failure cannot clear a replacement credential unreadable flag', async t => {
  const h = await harness(); t.after(async () => { await h.app.close(); h.store.close(); });
  const owner = h.users.get('alice')!;
  const id = (await h.credentials.create(owner, 'test', CANARY)).id;
  let reject!: (error: Error) => void;
  const original = fixture.transport.send;
  fixture.transport.send = () => new Promise((_resolve, fail) => { reject = fail; });
  t.after(() => { fixture.transport.send = original; });
  const old = h.credentials.probe(owner, id, 'balance');
  await h.credentials.replace(owner, id, CANARY + '_replacement');
  h.store.db.prepare("UPDATE credentials SET unreadable = 1, last_error = 'credential_unreadable' WHERE id = ?").run(id);
  reject(new SecretError('connector_timeout'));
  await assert.rejects(old, error => error instanceof SecretError && error.code === 'connector_timeout');
  const current = h.credentials.list(owner)[0];
  assert.equal(current.unreadable, true);
  assert.equal(current.lastError, 'credential_unreadable');
  h.clean(JSON.stringify(current));
});

test('HTTP replacement accepts no-expiry keys in one submit',async t=>{
  const h=await harness();t.after(async()=>{await h.app.close();h.store.close();});
  const created=(await h.call('POST','/api/credentials',{provider:'test',secret:CANARY})).json();
  const before=h.store.db.prepare('SELECT cipher,nonce,source_id FROM credentials WHERE id=?').get(created.id);
  const original=fixture.identify;
  fixture.identify=async()=>({account:'0'.repeat(24),abilities:['balance'],expiresAt:null});t.after(()=>{fixture.identify=original;});
  const response=await h.call('POST','/api/credentials/'+created.id,{secret:CANARY+'_next'});
  assert.equal(response.statusCode,200);assert.equal(response.json().expiresAt,null);
  assert.notDeepEqual(h.store.db.prepare('SELECT cipher,nonce,source_id FROM credentials WHERE id=?').get(created.id),before);
  const stable={secret:CANARY,requestId:'11111111-1111-4111-8111-111111111111'};
  const saved=await h.call('POST','/api/credentials/'+created.id,stable);
  const replay=await h.call('POST','/api/credentials/'+created.id,stable);
  assert.equal(saved.statusCode,200);assert.equal(replay.json().operationId,saved.json().operationId);
  assert.equal((await h.call('POST','/api/credentials/'+created.id,{secret:CANARY,allowNoExpiry:true})).statusCode,200);
  h.clean(response.body);
});

test('legacy and addition APIs share the same provider verification limit',async t=>{
  const h=await harness();t.after(async()=>{await h.app.close();h.store.close();});
  const identify=fixture.identify;let calls=0;
  fixture.identify=async(...args)=>{calls++;return identify(...args);};t.after(()=>{fixture.identify=identify;});
  for(let i=0;i<10;i++)assert.equal((await h.call('POST','/api/credentials',{provider:'test',secret:CANARY})).statusCode,201);
  const operation=(await h.call('POST','/api/additions',{requestId:'22222222-2222-4222-8222-222222222222',boardId:null,item:{kind:'connection',provider:'test'}})).json();
  assert.equal((await h.call('POST','/api/additions/'+operation.id+'/run',{secret:CANARY})).statusCode,429);
  assert.equal(calls,10);
});

test('legacy create rechecks a revoked session after asynchronous verification before any saved access',async t=>{
  const h=await harness();t.after(async()=>{await h.app.close();h.store.close();});
  let release!:(value:Awaited<ReturnType<typeof fixture.identify>>)=>void,started!:()=>void;
  const paused=new Promise<Awaited<ReturnType<typeof fixture.identify>>>(resolve=>release=resolve),ready=new Promise<void>(resolve=>started=resolve);
  t.mock.method(fixture,'identify',()=>{started();return paused;});
  const request=h.call('POST','/api/credentials',{provider:'test',secret:CANARY});await ready;
  h.directory.deleteSessions(h.users.get('alice')!);release({account:'0'.repeat(24),abilities:['balance'],expiresAt:Date.now()+60_000});
  const denied=await request;assert.equal(denied.statusCode,401);assert.deepEqual(denied.json(),{error:'unauthorized'});
  for(const table of ['credentials','holders','sources'])assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM '+table).get()!.n,0);
});

test('a revoked in-flight create cannot replay a concurrent request from a new session',async t=>{
  const h=await harness();t.after(async()=>{await h.app.close();h.store.close();});
  let release!:()=>void,started!:()=>void,calls=0;
  const paused=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>started=resolve),identify=fixture.identify;
  t.mock.method(fixture,'identify',async(...args:Parameters<Connector['identify']>)=>{if(++calls===1){started();await paused;}return identify(...args);});
  const input={provider:'test',secret:CANARY,requestId:'33333333-3333-4333-8333-333333333333'};
  const pending=h.call('POST','/api/credentials',input);await ready;
  const owner=h.users.get('alice')!,token=newSecret('qt_s');h.directory.deleteSessions(owner);h.directory.createSession(token,owner,Date.now(),60_000);
  const concurrent=await h.app.inject({method:'POST',url:'/api/credentials',payload:input,headers:{[VIEW_VERSION_HEADER]: String(VIEW_VERSION),origin:ORIGIN,cookie:`quotum_session=${token}`}});
  assert.equal(concurrent.statusCode,201);release();
  const late=await pending;assert.equal(late.statusCode,401);assert.deepEqual(late.json(),{error:'unauthorized'});
  assert.equal((await h.call('GET','/api/credentials')).statusCode,401);
  assert.equal(h.credentials.list(owner).length,1);assert.equal(h.credentials.list(owner)[0].id,concurrent.json().id);
  h.clean(late.body,concurrent.body);
});

test('each session waiting for a shared addition or replacement must retain access to its result',async t=>{
  for(const mode of ['addition','replacement'] as const) {
    const h=await harness();t.after(async()=>{await h.app.close();h.store.close();});
    const credential=mode==='replacement'?(await h.call('POST','/api/credentials',{provider:'test',secret:CANARY})).json():null;
    const operation=mode==='addition'?(await h.call('POST','/api/additions',{requestId:'44444444-4444-4444-8444-444444444444',boardId:null,item:{kind:'connection',provider:'test'}})).json():null;
    let release!:()=>void,started!:()=>void,joined!:()=>void,calls=0;
    const paused=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>started=resolve),joining=new Promise<void>(resolve=>joined=resolve),identify=fixture.identify,run=h.additions.run.bind(h.additions);
    t.mock.method(fixture,'identify',async(...args:Parameters<Connector['identify']>)=>{started();await paused;return identify(...args);});
    t.mock.method(h.additions,'run',(...args:Parameters<BoardAdditions['run']>)=>{const result=run(...args);if(++calls===2)joined();return result;});
    const url=mode==='addition'?'/api/additions/'+operation.id+'/run':'/api/credentials/'+credential.id;
    const input={secret:CANARY+'_next',...(mode==='replacement'?{requestId:'55555555-5555-4555-8555-555555555555'}:{})};
    const token=newSecret('qt_s');h.directory.createSession(token,h.users.get('alice')!,Date.now(),60_000);
    const winner=h.call('POST',url,input);await ready;
    const pending=h.app.inject({method:'POST',url,payload:input,headers:{[VIEW_VERSION_HEADER]: String(VIEW_VERSION),origin:ORIGIN,cookie:`quotum_session=${token}`}});await joining;
    h.directory.deleteSession(token);release();
    const saved=await winner,late=await pending;assert.equal(saved.statusCode,200);
    assert.equal(late.statusCode,mode==='addition'?403:401);assert.deepEqual(late.json(),{error:mode==='addition'?'addition_permission':'unauthorized'});
    const records=h.credentials.list(h.users.get('alice')!);assert.equal(records.length,1);
    if(mode==='addition'){assert.equal(saved.json().state,'complete');assert.equal(records[0].id,saved.json().result.credentialId);}
    else {assert.equal(records[0].id,credential.id);assert.equal(records[0].revision,credential.revision+1);}
    const denied=await h.app.inject({method:'GET',url:'/api/credentials',headers:{cookie:`quotum_session=${token}`}});assert.equal(denied.statusCode,401);
    h.clean(saved.body,late.body);
    t.mock.restoreAll();
  }
});

test('a provider permission refusal remains a key error while the session is active',async t=>{
  const h=await harness();t.after(async()=>{await h.app.close();h.store.close();});
  t.mock.method(fixture,'identify',async()=>{throw new SecretError('credential_permission');});
  const refused=await h.call('POST','/api/credentials',{provider:'test',secret:CANARY});
  assert.equal(refused.statusCode,400);assert.deepEqual(refused.json(),{error:'credential_permission'});
  assert.equal((await h.call('GET','/api/credentials')).statusCode,200);assert.equal(h.credentials.list(h.users.get('alice')!).length,0);
  h.clean(refused.body);
});

test('legacy replacement preserves unknown expiry rather than claiming confirmed no expiry',async t=>{
  const h=await harness();t.after(async()=>{await h.app.close();h.store.close();});
  t.mock.method(fixture,'identify',async()=>({account:'0'.repeat(24),abilities:['balance'],expiresAt:null,expiryKind:'unknown' as const}));
  // The low-level synthetic provider permits unknown expiry during measurement; a declared provider drives the HTTP contract.
  Object.assign(fixture,{identityOrigin:'declared',declaredAccounts:false});t.after(()=>{delete fixture.identityOrigin;delete fixture.declaredAccounts;});
  t.mock.method(fixture,'identify',async()=>({identityOrigin:'declared' as const,abilities:['balance'],expiresAt:null,expiryKind:'unknown' as const}));
  const created=await h.call('POST','/api/credentials',{provider:'test',secret:CANARY,allowUnknownExpiry:true});assert.equal(created.statusCode,201);
  const refused=await h.call('POST','/api/credentials/'+created.json().id,{secret:CANARY,sameAccount:true});
  assert.equal(refused.statusCode,409);assert.deepEqual(refused.json(),{error:'credential_expiry_confirmation',expiresAt:null,expiryKind:'unknown'});
});
