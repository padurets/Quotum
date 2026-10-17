import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {transaction} from '../touches.js';
import {resolveLink, safeRoute, splitLinks, suggestion, type ClientLink, type LinkContext, type AttributionInput, type LinkInput} from '../domain/links.js';
import type {SessionRoute} from '../domain/ingest.js';

const rule = (value: Partial<ClientLink> = {}): ClientLink => ({id: randomUUID(), clientId: 'codex', deviceId: null, route: null, sourceId: 'wallet', from: 100, to: 200, createdAt: 0, ...value});

test('temporal resolver agrees with an independent exhaustive precedence oracle', () => {
  // Six ordered buckets encode the product decision independently of numeric ranks.
  const routes: (SessionRoute | null)[] = [null, ...(['subscription', 'api', 'unknown'] as const).flatMap(className => (['session', 'machine'] as const).flatMap(by => [null, 'openrouter', 'unrecognized'].map(provider => ({class: className, by, provider, host: null}))))];
  let checks = 0;
  for (const conditionClass of ['subscription', 'api', 'unknown'] as const) for (let mask = 0; mask < 64; mask++) {
    const templates = [null, 'device'].flatMap(deviceId => [null, {class: conditionClass, provider: null}, {class: conditionClass, provider: 'openrouter'}].map(route => rule({deviceId, route})));
    const links = templates.filter((_, i) => mask & 1 << i);
    for (const heldWallet of [false, true]) for (const enabled of [false, true]) for (const route of routes) for (const source of [null, 'account', 'unheld']) for (const accountBy of ['login', 'inferred', 'legacy'] as const) for (const at of [99, 100, 199, 200]) {
      const context: LinkContext = {links, held: new Map([['account', 'codex'], ...(heldWallet ? [['wallet', 'openrouter'] as [string, string]] : [])]), routeEnabled: enabled};
      const input: AttributionInput = {clientId: 'codex', deviceId: 'device', route, source, accountBy};
      const observed = enabled ? route : null;
      const provider = observed?.by === 'session' && observed.provider === 'openrouter' ? 'openrouter' : null;
      const matching = links.filter(l => at >= l.from && (l.to === null || at < l.to) && (l.route === null || observed !== null && observed.class === l.route.class && (l.route.provider === null || l.route.provider === provider)));
      const buckets = ['device', null].flatMap(device => [2, 1, 0].map(specificity => matching.filter(l => l.deviceId === device && (l.route === null ? 0 : l.route.provider === null ? 1 : 2) === specificity)));
      const winners = buckets.find(bucket => bucket.length);
      assert.ok(!winners || winners.length === 1);
      const expected = winners ? heldWallet ? 'wallet' : null : observed?.class === 'api' || observed?.class === 'unknown' ? null : source === 'account' ? source : null;
      const actual = resolveLink(input, context, at);
      assert.equal(actual.source, expected);
      assert.equal(actual.linkId, winners?.[0].id);
      checks++;
    }
  }
  assert.equal(checks, 525_312);
});

test('safe route mapping, inactive masking, free suggestion gap and temporal conservation', () => {
  assert.deepEqual(safeRoute({class: 'api', by: 'session', host: 'openrouter.ai', provider: null}).route, {class: 'api', provider: 'openrouter'});
  assert.equal(safeRoute({class: 'api', by: 'session', host: 'openrouter.ai', provider: 'deepseek'}).route!.provider, null);
  assert.equal(safeRoute({class: 'api', by: 'machine', host: 'openrouter.ai', provider: 'openrouter'}).route!.provider, null);
  const input: AttributionInput = {clientId: 'codex', deviceId: 'device', source: 'account', route: {class: 'api', by: 'session', host: null, provider: 'openrouter'}};
  const context: LinkContext = {links: [rule({deviceId: 'device', sourceId: 'unheld'}), rule({route: {class: 'api', provider: 'openrouter'}})], held: new Map([['wallet', 'openrouter'], ['account', 'codex']]), routeEnabled: true};
  assert.equal(resolveLink(input, context, 100).source, null);
  assert.equal(suggestion(input, context, 100, 0), null);
  context.links = [rule({deviceId: 'device', route: {class: 'api', provider: 'openrouter'}, from: 0, to: 100}), rule({deviceId: 'device', route: {class: 'api', provider: 'openrouter'}, from: 200, to: null})];
  assert.deepEqual(suggestion(input, context, 150, 50), {clientId: 'codex', deviceId: 'device', route: {class: 'api', provider: 'openrouter'}, sourceId: 'wallet', from: 100, to: 200});
  context.held = new Map([...context.held, ['second', 'openrouter']]);
  assert.equal(suggestion(input, context, 150, 50), null);
  const splits = splitLinks(input, context, 50, 250);
  assert.deepEqual(splits, [{source: 'wallet', from: 50, to: 100}, {source: null, from: 100, to: 200}, {source: 'wallet', from: 200, to: 250}]);
  assert.equal(splits.reduce((ms, s) => ms + s.to - s.from, 0), 200);
});

function fixture(file = ':memory:') {
  const store = new Store(file, 0), directory = new Directory(store.db);
  const owner = directory.createUser('owner@example.com', 'Owner', 'fixture', 0), other = directory.createUser('other@example.com', 'Other', 'fixture', 0);
  const device = directory.saveDevice({userId: owner.id, machine: {id: 'machine', name: 'Machine', os: 'linux', arch: 'x86_64'}, agent: 'fixture', tokenId: null}, 0);
  const foreign = directory.saveDevice({userId: other.id, machine: {id: 'foreign', name: 'Foreign', os: 'linux', arch: 'x86_64'}, agent: 'fixture', tokenId: null}, 0);
  const source = store.source('openrouter', 'fixture', 0), second = store.source('openrouter', 'second', 0), alien = store.source('deepseek', 'alien', 0);
  store.hold(source, owner.id, 0); store.hold(second, owner.id, 0); store.hold(alien, other.id, 0);
  const input: LinkInput = {clientId: 'opencode', deviceId: null, route: null, sourceId: source, from: 100, to: 200};
  const mutate = (operation: 'create' | 'correct' | 'change' | 'delete', id: string | null, value: object, now = 0) => store.links.mutate(owner.id, operation, id, {...value, requestId: randomUUID(), expectedRevision: store.links.revision(owner.id)}, now);
  return {store, owner, other, device, foreign, source, second, alien, input, mutate};
}

test('owner links preserve exact nullable overlap semantics and atomic dated edits', () => {
  const f = fixture(); const {store, input, mutate} = f;
  try {
    const first = mutate('create', null, input).body.links[0];
    mutate('create', null, {...input, from: 200, to: null});
    for (const range of [{from: 99, to: 101}, {from: 100, to: 101}, {from: 150, to: null}, {from: 201, to: 202}]) assert.throws(() => mutate('create', null, {...input, ...range}), /link_overlap/);
    mutate('create', null, {...input, deviceId: f.device.id});
    mutate('create', null, {...input, route: {class: 'api', provider: null}});
    mutate('create', null, {...input, route: {class: 'api', provider: 'openrouter'}});
    const revision = store.links.revision(f.owner.id);
    mutate('correct', first.id, input); assert.equal(store.links.revision(f.owner.id), revision, 'no-op correction keeps revision');
    assert.throws(() => mutate('create', null, {...input, deviceId: f.foreign.id}), /not_found/);
    assert.throws(() => mutate('create', null, {...input, sourceId: f.alien}), /not_found/);
    const before = store.links.list(f.owner.id);
    assert.throws(() => mutate('change', first.id, {at: 150, newSourceId: f.alien}), /not_found/);
    assert.deepEqual(store.links.list(f.owner.id), before);
    mutate('change', first.id, {at: 150, newSourceId: f.second});
    const links = store.links.list(f.owner.id).filter(l => l.deviceId === null && l.route === null);
    assert.deepEqual(links.map(l => [l.from, l.to, l.sourceId]), [[100, 150, f.source], [150, 200, f.second], [200, null, f.source]]);
    store.release(f.second, f.owner.id);
    assert.ok(store.links.list(f.owner.id).some(l => l.sourceId === f.second));
    assert.equal(resolveLink({clientId: 'opencode', deviceId: 'another', source: f.source}, store.links.context(f.owner.id, 'another'), 150).source, null);
    store.hold(f.second, f.owner.id, 0);
    assert.equal(resolveLink({clientId: 'opencode', deviceId: f.device.id, source: f.source}, store.links.context(f.owner.id, f.device.id), 150).source, f.source, 'device wins');
    assert.throws(() => store.links.mutate(f.other.id, 'delete', first.id, {expectedRevision: '0', requestId: randomUUID()}, 0), /not_found/);
  } finally {store.close();}
});

test('one dated edit preserves the prefix while replacing its scope and end atomically', () => {
  const f=fixture();
  try{
    const old=f.mutate('create',null,f.input).body.links[0];
    const replacement={at:150,newSourceId:f.second,clientId:'codex',deviceId:f.device.id,route:{class:'api',provider:'openrouter'},to:250};
    f.mutate('change',old.id,replacement);
    const rows=f.store.links.list(f.owner.id),prefix=rows.find(row=>row.id===old.id)!,suffix=rows.find(row=>row.id!==old.id)!;
    assert.deepEqual(prefix,{...old,to:150});
    assert.deepEqual([suffix.clientId,suffix.deviceId,suffix.route,suffix.sourceId,suffix.from,suffix.to],['codex',f.device.id,replacement.route,f.second,150,250]);
    const before=rows,revision=f.store.links.revision(f.owner.id);
    assert.throws(()=>f.mutate('change',suffix.id,{...replacement,at:175,deviceId:f.foreign.id}),/not_found/);
    assert.deepEqual(f.store.links.list(f.owner.id),before);assert.equal(f.store.links.revision(f.owner.id),revision);
    f.mutate('create',null,{...f.input,clientId:'codex',deviceId:null,from:200,to:300});
    const conflict=f.store.links.list(f.owner.id),version=f.store.links.revision(f.owner.id);
    assert.throws(()=>f.mutate('change',suffix.id,{at:175,newSourceId:f.second,deviceId:null,route:null}),/link_overlap/);
    assert.deepEqual(f.store.links.list(f.owner.id),conflict);assert.equal(f.store.links.revision(f.owner.id),version);
  }finally{f.store.close();}
});

test('two connections reject stale revisions, replay lost replies and expire receipts', () => {
  const path = mkdtempSync(join(tmpdir(), 'quotum-links-')), f = fixture(join(path, 'test.sqlite')), second = new Store(join(path, 'test.sqlite'), 0);
  try {
    const body = {...f.input, expectedRevision: '0', requestId: randomUUID()};
    const first = f.store.links.mutate(f.owner.id, 'create', null, body, 0);
    assert.deepEqual(second.links.mutate(f.owner.id, 'create', null, body, 1), first);
    assert.throws(() => second.links.mutate(f.owner.id, 'create', null, {...body, from: 1}, 1), /mutation_conflict/);
    assert.throws(() => second.links.mutate(f.owner.id, 'create', null, {...body, requestId: randomUUID()}, 1), /links_changed/);
    assert.throws(() => second.links.mutate(f.owner.id, 'create', null, body, 7 * 86_400_000 + 1), /links_changed/);
    assert.equal(f.store.links.list(f.owner.id).length, 1);
    assert.equal(f.store.links.revision(f.owner.id), '1');
  } finally {second.close(); f.store.close(); rmSync(path, {recursive: true});}
});

test('batched resolution follows committed corrections, rollback, holdings and route policy', () => {
  const path=mkdtempSync(join(tmpdir(),'quotum-link-batches-')),f=fixture(join(path,'test.sqlite')),other=new Store(join(path,'test.sqlite'),0);
  try {
    const input={...f.input,route:{class:'api' as const,provider:null}},rule=f.mutate('create',null,input).body.links[0];
    const evidence:AttributionInput={clientId:input.clientId,deviceId:f.device.id,source:f.source,route:{class:'api',by:'session',host:null,provider:'openrouter'}};
    const observed=(store:Store)=>resolveLink(evidence,store.links.batch([f.owner.id,f.owner.id])(f.owner.id,f.device.id,input.clientId),150).source;
    assert.equal(observed(f.store),f.source);assert.equal(observed(other),f.source);
    assert.throws(()=>transaction(f.store.db,()=>{f.mutate('correct',rule.id,{...input,sourceId:f.second});assert.equal(observed(f.store),f.second);throw new Error('rollback');}),/rollback/);
    f.store.hold(f.alien,f.owner.id,0);
    other.links.mutate(f.owner.id,'correct',rule.id,{...input,sourceId:f.alien,requestId:randomUUID(),expectedRevision:other.links.revision(f.owner.id)},0);
    assert.equal(observed(f.store),f.alien);assert.equal(observed(other),f.alien);
    f.store.release(f.alien,f.owner.id);assert.equal(observed(other),null);
    f.store.hold(f.alien,f.owner.id,0);assert.equal(observed(other),f.alien);
    f.store.db.prepare('INSERT INTO device_tracking_policy VALUES (?,?,0)').run(f.device.id,input.clientId);
    assert.equal(observed(other),f.source);
  }finally{other.close();f.store.close();rmSync(path,{recursive:true});}
});
