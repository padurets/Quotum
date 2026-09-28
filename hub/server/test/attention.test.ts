import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advanceWindow, level, resetEvidence, type Candidate, type WindowLedger, type WindowSample} from '../domain/attention.js';
import {Attention} from '../attention.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Events, type Frame} from '../events.js';
import {Projection} from '../projection.js';
import {ResetFeed} from '../resets.js';
import {config} from '../config.js';
import {newSecret} from '../domain/auth.js';
import type {ResetStatus} from '../domain/resets.js';

const T = 1_800_000_000_000;
const sample = (remaining: number, at = T): WindowSample => ({id: 'week', kind: 'weekly', label: null, minutes: 10080, used: 100 - remaining, remaining, resetAt: T + 600_000, at, staleAfterMs: 204_000});

test('shared levels include 10 and 30 in low', () => {
  assert.deepEqual([31, 30, 10, 9.99, 0].map(level), ['ok', 'warn', 'warn', 'crit', 'crit']);
});

test('threshold consumption lasts through corrections, with a critical-only jump', () => {
  for (const [values, expected] of [
    [[35, 30, 10, 9.99], [null, 'low', null, 'critical']],
    [[35, 9, 12, 8], [null, 'critical', null, null]],
    [[29, 31, 29], [null, null, null]],
  ] as const) {
    let ledger: WindowLedger | null = null;
    const events = values.map((v, i) => { const next = advanceWindow(ledger, sample(v, T + i * 1000), true); ledger = next.ledger; return next.event; });
    assert.deepEqual(events, expected);
  }
});

test('reset evidence separates rolling drift, unknown times and minor corrections', () => {
  const old = sample(8);
  assert.equal(resetEvidence(old, sample(14, T + 1000)), true);
  assert.equal(resetEvidence(old, sample(13, T + 1000)), false);
  assert.equal(resetEvidence({...old, resetAt: null}, sample(100, T + 1000)), false);
  assert.equal(resetEvidence(old, {...sample(8, T + 600_000), resetAt: T + 1_200_000}), false, 'rolling now + window');
  const next = {...sample(8, T + 600_000), resetAt: T + 86_400_000};
  assert.equal(resetEvidence(old, next), true);
  const baseline = advanceWindow(null, old, false).ledger;
  assert.equal(advanceWindow(baseline, sample(100, T + 1000), true).event, 'reset');
  assert.equal(advanceWindow(baseline, sample(100, T + 300_000), true).event, null, 'gap suppresses even proven recovery');
  assert.equal(advanceWindow(baseline, {...sample(100, T + 1000), label: 'new pool'}, true).event, null, 'identity change');
  assert.equal(advanceWindow(baseline, {...next, at: T + 1000, resetAt: T + 1000 + 60_000}, true).event, null, 'reset timestamp alone is not proof');
});

function setup(t: {after(fn: () => void): void}, desktop = true) {
  const store = new Store(':memory:', T);
  const directory = new Directory(store.db);
  const ingest = new Ingest(store, directory, new Duty(), new Cadence());
  const user = directory.createUser('test@example.com', 'Tester', 'x', T);
  const board = directory.boards(user.id)[0].id;
  const secret = newSecret('qt_m');
  directory.createToken(secret, '…', user.id, 'fixture', T);
  const credential = ingest.authenticate(`Bearer ${secret}`);
  assert.ok(credential && credential !== 'revoked');
  let now = T;
  const resets = new ResetFeed(undefined, () => {}, {...config.resets, enabled: false});
  const events = new Events({store, directory, ingest, resets}, {...config.events, recheckMs: 0, heartbeatMs: 0}, {now: () => now, after: () => () => {}}, null);
  const projection = new Projection({store, directory, ingest, resets});
  events.attach();
  const attention = new Attention(store, T);
  ingest.attention = attention;
  const candidates: Candidate[] = [];
  attention.onCandidates = list => { candidates.push(...list); events.candidates(list); };
  const frames: Frame[] = [];
  const open = () => {
    const result = events.open({user: user.id, secret: 'fixture', board, kind: 'stream', desktop, send: list => frames.push(...list), end: () => {}});
    assert.ok(result && result !== 'limit');
    frames.push(...result.frames);
    return result;
  };
  const deliver = (values: [number, number][], received = values.at(-1)![0]) => {
    now = received;
    return ingest.accept(credential, {
      version: 1, agent: 'quotum/0.4.0', machine: {id: 'fixture-machine-0123456789', name: 'Fixture', os: 'linux', arch: 'x86_64'}, sentAt: new Date(received).toISOString(), failures: [],
      snapshots: values.map(([at, remaining]) => ({provider: 'codex', account: 'a1b2c3d4e5f6a1b2c3d4e5f6', plan: 'pro', observedAt: new Date(at).toISOString(), via: 'codex/app-server', client: 'fixture', staleAfterMs: 204_000, windows: [{id: 'week', kind: 'weekly', minutes: 10080, usedPercent: 100 - remaining, resetsAt: new Date(T + 600_000).toISOString()}]})),
    }, received);
  };
  t.after(() => { events.close(); store.close(); });
  return {store, directory, ingest, attention, projection, board, user, candidates, events, frames, open, deliver, time: (at: number) => { now = at; }};
}

const notifications = (frames: Frame[]) => frames.filter(f => f.type === 'attention').flatMap(f => JSON.parse(f.data).notifications);

test('accepted batch publishes the strongest transition after commit; duplicates consume nothing', t => {
  const h = setup(t);
  h.open();
  h.deliver([[T, 35]]);
  h.deliver([[T + 1000, 29], [T + 2000, 9]]);
  assert.deepEqual(h.candidates.map(c => c.kind), ['critical']);
  h.events.flush();
  assert.equal(notifications(h.frames).length, 1);
  assert.equal(notifications(h.frames)[0].name, 'Codex');
  h.deliver([[T + 1000, 29], [T + 2000, 9]]);
  assert.equal(h.candidates.length, 1);
});

test('rollback leaves neither consumed events nor live startup bookkeeping', t => {
  const h = setup(t);
  const record = h.store.record.bind(h.store);
  let calls = 0;
  h.store.record = (...args) => { if (++calls === 2) throw new Error('fixture rollback'); return record(...args); };
  assert.throws(() => h.deliver([[T, 35], [T + 1000, 29]]), /fixture rollback/);
  assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM attention_windows').get()!.n, 0);
  assert.equal(h.candidates.length, 0);
  h.store.record = record;
  h.deliver([[T + 2000, 29]]);
  assert.equal(h.candidates.length, 0, 'first live remains a baseline');
  h.deliver([[T + 3000, 9]]);
  assert.deepEqual(h.candidates.map(c => c.kind), ['critical']);
});

test('startup and connection cutoffs ignore old spool, including a recent last sample', t => {
  const h = setup(t);
  h.deliver([[T - 90_000, 29], [T - 20_000, 9]], T + 1000);
  assert.equal(h.candidates.length, 0);
  h.deliver([[T + 2000, 100]]);
  assert.equal(h.candidates.length, 0, 'first post-start recovery is silent');
  const first = h.open();
  h.deliver([[T + 3000, 29]]);
  h.events.flush();
  assert.equal(notifications(h.frames).length, 1);
  first.close();
  h.time(T + 4000);
  h.open();
  h.frames.length = 0;
  h.deliver([[T + 3500, 9]], T + 5000);
  h.events.flush();
  assert.equal(notifications(h.frames).length, 0, 'new receive time cannot make a pre-baseline transition live');
  h.deliver([[T + 6000, 100]]);
  h.deliver([[T + 7000, 29]]);
  h.events.flush();
  assert.equal(notifications(h.frames).length, 1);
  assert.equal(notifications(h.frames)[0].kind, 'low', 'a transition wholly after the new baseline');
});

test('attention shares board visibility, and keeps stale low figures distinct from quality', t => {
  const h = setup(t);
  h.deliver([[T, 8]]);
  const card = h.store.states(h.board)[0];
  assert.equal(h.projection.attention(h.board, T).level, 'crit');
  assert.equal(h.projection.attention(h.board, T + 205_000).quality, 'partial');
  assert.equal(h.projection.attention(h.board, T + 600_001).minimum?.remaining, 8);
  const view = h.directory.view(h.board);
  h.directory.saveView(h.board, {...view, windows: [`${card.id}/week`]}, h.user.id, T);
  assert.deepEqual(h.projection.attention(h.board, T), {boardId: h.board, level: null, quality: 'unavailable', minimum: null});
});

test('tracker scheduled events baseline on first success and failure recovery', t => {
  const h = setup(t);
  const status = (at: number): ResetStatus => ({scheduled: {at, url: 'https://x.com/fixture/1', text: 'never sent', scheduledFor: null, kind: 'regular'}, latest: null, watch: null, policy: null, credit: {name: 'Fixture', url: 'https://x.com/fixture'}});
  h.attention.announcement('codex', status(T), true, T);
  h.attention.announcement('codex', status(T + 1), true, T + 1000);
  h.attention.announcement('codex', status(T + 1), true, T + 2000);
  assert.equal(h.candidates.length, 1);
  h.attention.announcement('codex', undefined, false, T + 3000);
  h.attention.announcement('codex', status(T + 2), true, T + 4000);
  assert.equal(h.candidates.length, 1);
});

test('hidden events are consumed and visibility is checked again before stream delivery', t => {
  const h = setup(t);
  h.open();
  h.deliver([[T, 35]]);
  const card = h.store.states(h.board)[0];
  const view = h.directory.view(h.board);
  h.directory.saveView(h.board, {...view, hidden: [`source:${card.id}`]}, h.user.id, T);
  h.deliver([[T + 1000, 29]]);
  h.directory.saveView(h.board, view, h.user.id, T + 2000);
  h.events.flush();
  assert.equal(notifications(h.frames).length, 0);
  h.deliver([[T + 3000, 9]]);
  h.directory.saveView(h.board, {...view, windows: [`${card.id}/week`]}, h.user.id, T + 3000);
  h.events.flush();
  assert.equal(notifications(h.frames).length, 0, 'hidden after enqueue');
  h.directory.saveView(h.board, view, h.user.id, T + 4000);
  h.deliver([[T + 5000, 12], [T + 6000, 9]]);
  h.events.flush();
  assert.equal(notifications(h.frames).length, 0, 'corrections do not reset consumed thresholds');
});

test('restarting the service keeps consumed thresholds and prunes only orphan ledgers', t => {
  const h = setup(t);
  h.deliver([[T, 35], [T + 1000, 29]]);
  const restarted = new Attention(h.store, T + 1500);
  h.ingest.attention = restarted;
  const events: Candidate[] = [];
  restarted.onCandidates = c => events.push(...c);
  h.deliver([[T + 2000, 31], [T + 3000, 29], [T + 4000, 9]]);
  assert.deepEqual(events.map(c => c.kind), ['critical']);
  const card = h.store.states(h.board)[0];
  h.store.prune(T + 10_000);
  assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM attention_windows').get()!.n, 1);
  h.store.db.prepare('DELETE FROM sources WHERE id = ?').run(card.id);
  assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM attention_windows').get()!.n, 0);
});

test('candidate overflow gives a new empty baseline, never replay', t => {
  const h = setup(t);
  h.deliver([[T, 35]]);
  h.open();
  const source = h.store.states(h.board)[0];
  const candidate: Candidate = {id: 'fixture', kind: 'critical', at: T, observedFrom: T, observedAt: T + 1, sourceId: source.id, windowId: 'week', provider: 'codex', name: '', window: {kind: 'weekly', label: null, minutes: 10080}, remaining: 9, resetAt: null};
  h.events.candidates(Array.from({length: 2000}, () => candidate));
  h.events.flush();
  const attention = h.frames.filter(f => f.type === 'attention').map(f => JSON.parse(f.data));
  assert.equal(attention.length, 2);
  assert.ok(attention.every(f => f.baseline && !f.notifications.length));
  assert.ok(attention[1].seq > attention[0].seq);
});

test('a window missing from the previous measurement returns silently, keeping its ledger', t => {
  const h = setup(t);
  h.deliver([[T, 35]]);
  const source = h.store.states(h.board)[0];
  h.store.record(source.id, {observedAt: T + 1000, plan: 'pro', windows: [{...sample(50), id: 'other'}], staleAfterMs: 204_000, resets: null});
  h.deliver([[T + 2000, 29]]);
  assert.equal(h.candidates.length, 0, 'a missing window is not continuous observation');
  h.deliver([[T + 3000, 9]]);
  assert.deepEqual(h.candidates.map(c => c.kind), ['critical'], 'the next observed crossing is still eligible');
});
