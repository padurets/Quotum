import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store, type WorkKey} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Sessions, CREDIT_MS, KEEP_MS, type LiveSession} from '../sessions.js';
import {HistoryTiles} from '../history.js';
import {compose, targetOf, type Chunk} from '../domain/history.js';
import {readHistory} from './historyRead.js';
import type {LinkInput} from '../domain/links.js';

const now = 1_800_000_000_000, minute = 60_000;
function setup() {
  const store = new Store(':memory:', now), directory = new Directory(store.db), live = new Sessions(store);
  const owner = directory.createUser('owner@example.com', 'Owner', 'fixture', now);
  const board = directory.boards(owner.id).find(b => b.personal)!.id;
  const device = directory.saveDevice({userId: owner.id, machine: {id: 'fixture', name: 'Laptop', os: 'linux', arch: 'x86_64'}, agent: 'fixture', tokenId: null}, now).id;
  const account = store.source('codex', 'account', now), wallet = store.source('openrouter', 'wallet', now), second = store.source('openrouter', 'second', now);
  for (const source of [account, wallet, second]) store.hold(source, owner.id, now);
  const session = (clientId = 'opencode', source: string | null = null, extra: Partial<LiveSession> = {}): LiveSession & {source: string | null} => ({clientId, source, sessionId: 'a'.repeat(32), origin: 'terminal', project: 'Project', folder: null, startedAt: now, sentStartedAt: now, lastWorkedAt: null, working: true, device: {id: device, name: 'Laptop'}, ...extra});
  const key = (source: string | null = null): WorkKey => ({client: 'opencode', source, origin: 'terminal', project: 'Project', folder: '', startedAt: now, identity: {kind: 'stable', sessionId: 'a'.repeat(32)}});
  const link = (input: Partial<LinkInput> = {}) => store.links.mutate(owner.id, 'create', null, {clientId: 'opencode', deviceId: null, route: null, sourceId: wallet, from: now, to: null, ...input, expectedRevision: store.links.revision(owner.id), requestId: randomUUID()}, now).body.links.at(-1)!;
  return {store, directory, owner, board, device, account, wallet, second, live, session, key, link};
}

test('a later link reattributes live, credit and history without changing the ledger', () => {
  const f = setup(); try {
    f.live.report(f.device, f.owner.id, [f.session()], now);
    f.live.report(f.device, f.owner.id, [f.session()], now + 2 * minute);
    const before = f.store.db.prepare('SELECT * FROM agent_sessions').all(), work = f.store.db.prepare('SELECT * FROM agent_work').all();
    assert.equal(f.live.own(f.owner.id, f.board, now + 2 * minute)[0].workedMs, 2 * minute);
    f.link();
    assert.deepEqual(f.live.own(f.owner.id, f.board, now + 2 * minute), []);
    assert.equal(f.live.of(f.wallet, [f.owner.id], now + 2 * minute)[0].workedMs, 2 * minute);
    assert.equal(f.live.working(f.wallet, now + 2 * minute), true);
    assert.deepEqual(f.live.sourcesOf(f.device, now + 2 * minute), [f.wallet]);
    const history = readHistory(f.store, f.board, now, minute, {to: now + 2 * minute});
    assert.deepEqual(history.activity.by.source.map(s => [s.key, s.agentMs, s.agents]), [[f.wallet, 2 * minute, 1]]);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM agent_sessions').all(), before);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM agent_work').all(), work);
    f.store.release(f.wallet, f.owner.id);
    assert.equal(f.live.working(f.wallet, now + 2 * minute), false);
    assert.equal(f.live.own(f.owner.id, f.board, now + 2 * minute)[0].workedMs, 2 * minute);
    f.store.hold(f.wallet, f.owner.id, now);
    assert.equal(f.live.of(f.wallet, [f.owner.id], now + 2 * minute)[0].workedMs, 2 * minute);
  } finally {f.store.close();}
});

test('temporal fragments preserve one agent within the same cell and live counters use current source', () => {
  const f = setup(); try {
    f.store.creditWork(f.device, now, now + 2 * minute, [f.key()]);
    f.link({to: now + minute}); f.link({sourceId: f.second, from: now + minute});
    const tiles = new HistoryTiles(f.store), shown = f.store.shown(f.board, []);
    const chunks = tiles.read(f.board, 5 * minute, now, now + 5 * minute, now + 5 * minute, shown).map(json => JSON.parse(json) as Chunk);
    const result = compose(chunks, {now: now + 5 * minute, historyStart: now, known: f.store.historyKnown(shown, f.owner.id)}, targetOf(5 * minute, now + 5 * minute, 'test', {from: now, to: now + 5 * minute}), new Set());
    assert.equal(result.activity.agentMs, 2 * minute); assert.equal(result.activity.activeMs, 2 * minute); assert.equal(result.activity.agents, 1);
    assert.deepEqual(result.activity.by.source.map(s => [s.key, s.agentMs, s.agents]).sort(), [[f.wallet, minute, 1], [f.second, minute, 1]].sort());
    assert.equal(chunks[0].activity.sessions.length, 2);
    assert.notEqual(chunks[0].activity.sessions[0][0], chunks[0].activity.sessions[1][0]);
    assert.equal(chunks[0].activity.sessions[0][4], chunks[0].activity.sessions[1][4]);
    assert.deepEqual(f.store.worked(f.device, [f.key()], now + minute), [minute]);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_sessions').get()!.n, 1);
  } finally {f.store.close();}
});

test('mixed Codex routes and idle evidence corrections use one resolver', () => {
  const f = setup(); try {
    const api = f.session('codex', f.account, {sessionId: 'a'.repeat(32), route: {class: 'api', by: 'session', host: 'openrouter.ai', provider: 'openrouter'}});
    const subscription = f.session('codex', f.account, {sessionId: 'b'.repeat(32), route: {class: 'subscription', by: 'session', host: null, provider: null}});
    f.live.report(f.device, f.owner.id, [api, subscription], now);
    assert.equal(f.live.of(f.account, [f.owner.id], now).length, 1);
    f.link({clientId: 'codex', deviceId: f.device, route: {class: 'api', provider: 'openrouter'}});
    f.live.report(f.device, f.owner.id, [api, subscription], now + minute);
    assert.equal(f.live.of(f.account, [f.owner.id], now + minute).length, 1);
    assert.equal(f.live.of(f.wallet, [f.owner.id], now + minute).length, 1);
    const rows = f.store.db.prepare('SELECT id,producer_id FROM agent_sessions').all();
    f.live.report(f.device, f.owner.id, [{...api, working: false, route: {...api.route!, class: 'subscription'}}, subscription], now + minute);
    assert.deepEqual(f.store.db.prepare('SELECT id,producer_id FROM agent_sessions').all(), rows);
    assert.equal(f.store.db.prepare('SELECT route_class FROM agent_sessions WHERE producer_id=?').get(api.sessionId!)!.route_class, 'unknown');
    assert.equal(f.live.of(f.wallet, [f.owner.id], now + minute).length, 0);
    const history = readHistory(f.store, f.board, now, minute, {to: now + minute});
    assert.deepEqual(history.activity.by.source.map(s => s.key).sort(), ['unknown', f.account].sort());
    const sharedSafe = JSON.stringify(f.live.of(f.account, [f.owner.id], now + minute));
    for (const privateValue of ['openrouter.ai', api.sessionId!, f.owner.id]) assert.ok(!sharedSafe.includes(privateValue));
  } finally {f.store.close();}
});

test('future boundaries and expiry update source activity without a new report', () => {
  const f = setup(); try {
    f.link({from: now + minute, to: now + 2 * minute});
    f.live.report(f.device, f.owner.id, [f.session()], now);
    assert.equal(f.live.working(f.wallet, now), false);
    assert.equal(f.live.ofChangesAt(f.wallet, [f.owner.id], now), now + minute);
    assert.equal(f.live.workingChangesAt(f.wallet, now), now + minute);
    assert.equal(f.live.devicesChangesAt(f.owner.id, now), now + minute);
    assert.equal(f.live.working(f.wallet, now + minute), true);
    assert.equal(f.live.working(f.wallet, now + 2 * minute), false);
    assert.equal(f.live.working(f.wallet, now + CREDIT_MS + 1), false);
    assert.deepEqual(f.live.of(f.wallet, [f.owner.id], now + KEEP_MS + 1), []);
  } finally {f.store.close();}
});
