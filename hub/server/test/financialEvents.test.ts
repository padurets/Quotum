import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {ResetFeed} from '../resets.js';
import {Events, polled, sse, type Frame} from '../events.js';
import {Projection, type Snapshot} from '../projection.js';
import {config} from '../config.js';
import type {HistoryChange} from '../domain/history.js';
import type {WindowMeasurement} from '../domain/quota.js';

function fixture(t: TestContext, enabled = true) {
  let now = Date.UTC(2026, 9, 8, 12);
  const clock = {now: () => now, after: () => () => {}};
  t.mock.method(Date, 'now', clock.now);
  const next = () => ++now;
  const store = new Store(':memory:', now), directory = new Directory(store.db);
  const owner = directory.createUser('owner@example.test', 'Owner', 'fixture', now);
  const reader = directory.createUser('reader@example.test', 'Reader', 'fixture', now);
  const board = directory.createBoard('Shared', owner.id, now);
  directory.addMember(board.id, reader.id, now);
  const source = store.source('codex', 'a'.repeat(24), now);
  store.hold(source, owner.id, now);
  store.share(board.id, source, owner.id, now, enabled);
  const balance = (amount: string) => {
    const at = next();
    store.record(source, {observedAt: at, staleAfterMs: 3_600_000, plan: 'pro', windows: [], resets: null,
      resourceStatus: {windows: 'missing', resets: 'missing'},
      balances: [{id: 'balance:credits', unit: 'credits:codex', status: 'finite', amount, hasCredits: true}]});
    return at;
  };
  const firstBalanceAt = balance('2500');
  const quota: WindowMeasurement = {observedAt: next(), staleAfterMs: 3_600_000, plan: 'pro', resets: null,
    windows: [{id: 'weekly', kind: 'weekly', used: 40, remaining: 60, resetAt: null, minutes: 10080, label: null}]};
  store.record(source, quota);
  store.currencies.setRate(reader.id, 'credits:codex', 'USD', '30000', 0, now, 'basePerUnit');
  const parts = {store, directory, ingest: new Ingest(store, directory, new Duty(), new Cadence()), resets: new ResetFeed(undefined, () => {})};
  const events = new Events(parts, {...config.events, recheckMs: 0}, clock, null);
  events.attach();
  const secret = 'synthetic-financial-reader';
  directory.createSession(secret, reader.id, now, 86_400_000);
  const reading = {user: reader.id, secret, board: board.id};
  const poll = async (lease?: string) => {
    const answer = await events.poll(reading, lease);
    assert.ok(answer && answer !== 'limit');
    return answer;
  };
  const stream = (sent?: () => void) => {
    const frames: Frame[] = [];
    const opened = events.open({...reading, kind: 'stream', send: batch => {frames.push(...batch); sent?.();}, end: () => {}});
    assert.ok(opened && opened !== 'limit');
    return frames;
  };
  const grant = (on: boolean) => store.setBudget(board.id, source, owner.id, on, store.sources(board.id)[0].budget!.revision, next());
  t.after(() => {events.close(); store.close();});
  return {store, directory, owner, reader, board, source, events, poll, stream, balance, grant, firstBalanceAt, quotaAt: quota.observedAt,
    snapshot: () => JSON.parse(JSON.stringify(new Projection(parts).snapshot(reader.id, board.id, now))) as Snapshot};
}

const changes = (frames: Frame[]) => frames.flatMap(f => f.type === 'history' ? (JSON.parse(f.data) as {changes: HistoryChange[]}).changes : []);
function replacement(frames: Frame[]): Snapshot {
  assert.deepEqual(frames.map(f => f.type), ['snapshot']);
  return JSON.parse(frames[0].data) as Snapshot;
}

for (const flush of [false, true]) test(`a financial revoke replaces an undelivered poll batch ${flush ? 'after' : 'before'} the producer flush`, async t => {
  const h = fixture(t), lease = (await h.poll()).lease;
  h.balance('9911.23'); h.events.flush();
  h.grant(false); if (flush) h.events.flush();
  const answer = await h.poll(lease), snapshot = replacement(answer.frames);
  assert.deepEqual(snapshot, h.snapshot());
  assert.equal(snapshot.sources[0].meters, undefined);
  assert.equal(snapshot.sources[0].creditBalance, undefined);
  assert.equal(snapshot.currencies.sources[h.source], undefined);
  assert.equal(snapshot.sources[0].windows[0].id, 'weekly');
  assert.equal(polled(answer.frames).includes('991123'), false);
});

test('disable and re-enable replace the old lease generation and its private bindings', async t => {
  const h = fixture(t), lease = (await h.poll()).lease;
  h.balance('9911.23'); h.events.flush();
  h.grant(false); h.events.flush();
  const currentAt = h.balance('7777'); h.events.flush();
  const enabled = h.grant(true);
  const answer = await h.poll(lease), snapshot = replacement(answer.frames);
  assert.deepEqual(snapshot, h.snapshot());
  assert.equal(snapshot.sources[0].budget!.revision, enabled.revision);
  assert.equal(snapshot.sources[0].budget!.anchor, null);
  assert.equal(snapshot.sources[0].meters![0].amount, '7777', 'current last-known funds remain authorized');
  assert.deepEqual(snapshot.currencies.sources[h.source].map(b => b.at), [currentAt]);
  assert.equal(snapshot.currencies.sources[h.source][0].steps[0].to, '30000');
  assert.equal(polled(answer.frames).includes('991123'), false);
});

test('a waiting poll rechecks financial authority immediately before sending', async t => {
  const h = fixture(t), lease = (await h.poll()).lease;
  const waiting = h.poll(lease);
  h.grant(false); h.events.flush();
  const answer = await waiting;
  const snapshot = replacement(answer.frames);
  assert.deepEqual(snapshot, h.snapshot());
  assert.equal(snapshot.sources[0].meters, undefined);
  assert.equal(snapshot.currencies.sources[h.source], undefined);
});

test('an empty lease rebases a poll received after revoke without waiting for flush', async t => {
  const h = fixture(t), lease = (await h.poll()).lease;
  h.grant(false);
  assert.deepEqual(replacement((await h.poll(lease)).frames), h.snapshot());
});

for (const transport of ['stream', 'poll'] as const) test(`${transport} history excludes financial anchors on a quota-only placement`, async t => {
  const h = fixture(t, false), frames = transport === 'stream' ? h.stream() : null;
  const lease = transport === 'poll' ? (await h.poll()).lease : undefined;
  const at = h.balance('9911.23'); h.events.flush();
  const delivered = frames ?? (await h.poll(lease)).frames;
  const news = changes(delivered);
  assert.equal(news.length, 1);
  assert.equal(news[0].source, h.source);
  assert.equal(news[0].scope, 'quota');
  assert.ok(news[0].since >= h.quotaAt && news[0].since <= at);
  const encoded = transport === 'stream' ? sse(delivered) : polled(delivered);
  assert.equal(encoded.includes(String(h.firstBalanceAt)), false, 'the earlier balance-only anchor was never quota evidence');
  assert.equal(encoded.includes('991123'), false);
});

test('SSE filters pending financial history again when consent changes before flush', t => {
  const h = fixture(t), frames = h.stream();
  h.balance('9911.23'); h.grant(false); h.events.flush();
  assert.equal(changes(frames).some(c => c.scope === 'budget'), false);
  assert.equal(sse(frames).includes('991123'), false);
  frames.length = 0;
  h.grant(true); h.events.history(h.source, h.firstBalanceAt, ['budget']); h.events.flush();
  assert.deepEqual(changes(frames), [], 'pending consent has no admitted financial history');
});

test('SSE rechecks authority between preparing a batch and sending it to each reader', t => {
  const h = fixture(t);
  let revoke = false;
  h.stream(() => {if(revoke){revoke=false;h.grant(false);}});
  const later = h.stream();
  h.balance('9911.23'); revoke=true; h.events.flush();
  const snapshot = replacement(later);
  assert.deepEqual(snapshot, h.snapshot());
  assert.equal(snapshot.sources[0].meters, undefined);
  assert.equal(snapshot.currencies.sources[h.source], undefined);
  assert.equal(sse(later).includes('991123'), false);
});

test('a coalesced financial invalidation starts at the new grant admission, while wallet history stays unrestricted', t => {
  const h = fixture(t), frames = h.stream();
  h.balance('9911.23'); h.grant(false); h.grant(true);
  const admittedAt = h.balance('7777');
  const wallet = h.store.source('deepseek', 'b'.repeat(24), admittedAt);
  h.store.hold(wallet, h.owner.id, admittedAt);
  h.store.share(h.board.id, wallet, h.owner.id, admittedAt);
  h.events.flush();
  assert.deepEqual(changes(frames).filter(c => c.scope === 'budget'), [{source: h.source, scope: 'budget', since: admittedAt}]);
  frames.length = 0;
  h.events.history(h.source, h.firstBalanceAt, ['budget']);
  h.events.history(wallet, h.firstBalanceAt - 1000, ['budget']); h.events.flush();
  assert.deepEqual(changes(frames), [
    {source: h.source, scope: 'budget', since: admittedAt},
    {source: wallet, scope: 'budget', since: h.firstBalanceAt - 1000},
  ]);
});
