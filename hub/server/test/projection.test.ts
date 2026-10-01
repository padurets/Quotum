import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Cadence} from '../cadence.js';
import {config} from '../config.js';
import {Duty} from '../duty.js';
import {Ingest, type Credential} from '../ingest.js';
import {Projection, type Timed} from '../projection.js';
import {ResetFeed} from '../resets.js';
import {newSecret} from '../domain/auth.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';
import {catalogue} from '../domain/providers.js';

const S = 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const t0 = Date.parse('2026-09-22T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ACCOUNT = 'a1b2c3d4e5f6a1b2c3d4e5f6';

test('a hub source failure leaves percentage attention current and publishes safe provider capabilities', () => {
  const h = hub();
  h.deliver(t0, 7 * MIN);
  const before = h.projection.attention(h.board, t0);
  const source = h.store.source('openrouter', '111111111111111111111111', t0);
  h.store.hold(source, h.alice.id, t0);
  h.store.fail(source, 'credential_revoked');
  assert.deepEqual(h.projection.attention(h.board, t0), before);
  const snapshot = h.projection.snapshot(h.alice.id, h.board, t0)!;
  assert.deepEqual(snapshot.providers, catalogue);
  assert.equal(snapshot.sources.find(s => s.id === source)?.error, 'unmeasured');
  h.store.close();
});
const machine = (id: string) => ({id: `${id}-0123456789`, name: id, os: 'linux', arch: 'x86_64'});

/** A hub with Alice, whose laptop measures one Codex account at the hub's pace. */
function hub() {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-projection-')), 'db.sqlite'), t0);
  const directory = new Directory(store.db);
  const ingest = new Ingest(store, directory, new Duty(), new Cadence());
  const projection = new Projection({store, directory, ingest, resets: new ResetFeed(undefined, () => {})});
  const alice = directory.createUser('alice@example.com', 'Alice', 'x', t0);
  const board = directory.boards(alice.id)[0].id;
  const secret = newSecret('qt_m');
  directory.createToken(secret, '…', alice.id, 'images', t0);
  const token = ingest.authenticate(`Bearer ${secret}`) as Credential;
  const agent = {version: 1, agent: 'quotum/0.4.0', machine: machine('laptop')};
  const ask = (t: number) => ingest.checkin(token, {...agent, paced: true, subscriptions: [{provider: 'codex', account: ACCOUNT, active: false}]}, t).subscriptions[0];
  const deliver = (t: number, staleAfterMs: number, used = 50, resetsAt: number | null = null) =>
    ingest.accept(
      token,
      {
        ...agent,
        sentAt: iso(t),
        snapshots: [
          {
            provider: 'codex',
            account: ACCOUNT,
            plan: 'pro',
            observedAt: iso(t),
            via: 'codex/app-server',
            staleAfterMs,
            windows: [{id: '5h', kind: 'session', minutes: 300, usedPercent: used, resetsAt: resetsAt === null ? null : iso(resetsAt)}],
          },
        ],
        failures: [],
      },
      t,
    );
  const running = (t: number, working: boolean) =>
    ingest.sessions(
      token,
      {...agent, sentAt: iso(t), sessions: [{provider: 'codex', account: ACCOUNT, origin: 'app', startedAt: iso(t - MIN), lastWorkedAt: iso(t), working}]},
      t,
    );
  const part = (now: number) => {
    const source = store.sources(board)[0];
    return projection.sourcePart(source, projection.members(board), now);
  };
  return {store, directory, projection, alice, board, ask, deliver, running, part};
}

/**
 * Walks a part through time from `from`: at each moment it says it changes, it is read
 * again; before that it reads the same at every moment tried. Returns the moments.
 */
function walk<T>(read: (now: number) => Timed<T>, from: number, until: number): number[] {
  const moments: number[] = [];
  for (let now = from; now < until;) {
    const {value, changesAt} = read(now);
    if (changesAt !== null) assert.ok(changesAt > now, `a change after ${now - from} ms, not at ${changesAt - from}`);
    const end = Math.min(changesAt ?? until, until);
    for (const at of [now + 1, Math.floor((now + end) / 2), end - 1, ...Array.from({length: 10}, (_, i) => Math.floor(now + ((end - now) * i) / 10))]) {
      if (at >= now && at < end) assert.deepEqual(read(at).value, value, `the same at +${at - from} ms as at +${now - from} ms`);
    }
    if (changesAt === null || changesAt >= until) break;
    moments.push(changesAt);
    now = changesAt;
  }
  return moments;
}

test('a card, the agents on it and its pace read the same until the moment the hub says they change by themselves', () => {
  const h = hub();
  assert.equal(h.ask(t0).measure, true);
  h.deliver(t0, 7 * MIN);
  h.running(t0 + 30 * S, true);
  const moments = walk(h.part, t0 + MIN, t0 + 2 * HOUR);
  assert.ok(moments.includes(t0 + 7 * MIN + 1), 'the card goes stale');
  assert.ok(moments.includes(t0 + 30 * S + 5 * MIN + 1), "the machine's list stops showing");
  assert.equal(h.part(t0 + 7 * MIN).value.card.stale, false);
  assert.equal(h.part(t0 + 7 * MIN + 1).value.card.stale, true);
  assert.deepEqual(h.part(t0 + 30 * S + 5 * MIN + 1).value.sessions, []);
  assert.equal(h.part(t0 + 3 * HOUR).changesAt, null, 'nothing left to change by itself');

  // A pace with little left in a window: the window resets.
  const low = hub();
  const resetAt = t0 + 20 * MIN;
  assert.equal(low.ask(t0).measure, true);
  low.deliver(t0, 3 * HOUR, 95, resetAt);
  for (let t = t0 + 15 * S; t < t0 + 10 * MIN; t += 15 * S) {
    const answer = low.ask(t);
    if (answer.measure) low.deliver(t, 3 * HOUR, 95, resetAt);
  }
  assert.equal(low.part(t0 + 10 * MIN).value.cadence?.why, 'low');
  walk(low.part, t0 + 10 * MIN, t0 + 30 * MIN);
});

test("the hub's part says when a past reset falls out of the history", () => {
  const h = hub();
  const kept = config.retention.sampleDays * 86_400_000;
  const at = t0 - kept + HOUR;
  h.store.announce('codex', {at, url: 'https://example.com', text: 'reset'});
  h.store.announce('claude', {at: t0 - HOUR, url: 'https://example.com', text: 'reset'});
  const moments = walk(now => h.projection.hubPart(now), t0, t0 + 2 * HOUR);
  assert.deepEqual(moments, [at + kept + 1]);
  assert.deepEqual(Object.keys(h.projection.hubPart(at + kept + 1).value.past), ['claude']);
});

test("a snapshot is the board as its reader sees it: every source's parts, and what is the reader's own", () => {
  const h = hub();
  h.deliver(t0, 7 * MIN);
  const bob = h.directory.createUser('bob@example.com', 'Bob', 'x', t0);
  const shared = h.directory.createBoard('Team', h.alice.id, t0);
  h.directory.addMember(shared.id, bob.id, t0);
  const source = h.store.sources(h.board)[0].id;
  h.store.share(shared.id, source, h.alice.id, t0);
  const ofAlice = h.projection.snapshot(h.alice.id, shared.id, t0 + MIN)!;
  const ofBob = h.projection.snapshot(bob.id, shared.id, t0 + MIN)!;
  assert.deepEqual(ofAlice.board, {id: shared.id, name: 'Team', personal: false});
  assert.deepEqual([ofAlice.sources.map(s => s.id), ofAlice.sources[0].owners, ofAlice.sources[0].stale], [[source], ['Alice'], false]);
  assert.deepEqual([Object.keys(ofAlice.sessions), Object.keys(ofAlice.cadence)], [[source], [source]]);
  assert.deepEqual([ofAlice.mine, ofBob.mine], [[source], []], 'measured by her devices, not his');
  assert.deepEqual([ofAlice.boards.find(b => b.id === shared.id)?.role, ofBob.boards.find(b => b.id === shared.id)?.role], ['owner', 'member']);
  assert.equal(h.projection.snapshot(h.alice.id, 'gone', t0), null);
});
