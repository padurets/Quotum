import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Cadence, type Signals} from '../cadence.js';
import {Duty} from '../duty.js';
import {Ingest, type Credential} from '../ingest.js';
import {newSecret} from '../domain/auth.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Projection} from '../projection.js';
import {ResetFeed} from '../resets.js';
import {Events, type Frame} from '../events.js';
import {buildApp} from '../api.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';

const T = Date.parse('2026-09-28T00:00:00Z');
const MIN = 60_000;
const ACCOUNT = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const iso = (at: number) => new Date(at).toISOString();

function hub(t: TestContext) {
  const folder = mkdtempSync(path.join(tmpdir(), 'quotum-refresh-'));
  const store = new Store(path.join(folder, 'db.sqlite'), T);
  t.after(() => {
    store.close();
    rmSync(folder, {recursive: true});
  });
  const directory = new Directory(store.db);
  const duty = new Duty();
  const cadence = new Cadence();
  const ingest = new Ingest(store, directory, duty, cadence);
  const user = directory.createUser('a@example.com', 'Alice', 'x', T);
  const board = directory.boards(user.id)[0].id;
  const secret = newSecret('qt_m');
  const token = directory.createToken(secret, '…', user.id, 'test', T);
  const credential = ingest.authenticate(`Bearer ${secret}`) as Credential;
  const agent = (name: string) => ({version: 1, agent: 'quotum/0.4.0', machine: {id: `${name}-0123456789abcd`, name, os: 'linux', arch: 'x86_64'}});
  const source = () => store.findSource('codex', ACCOUNT)!;
  const ask = (at: number, minimum = MIN, name = 'laptop', paced = true) =>
    ingest.checkin(
      credential,
      {
        ...agent(name),
        paced,
        subscriptions: [{provider: 'codex', account: ACCOUNT, active: false, minIntervalMs: minimum}],
      },
      T + at,
    ).subscriptions[0];
  const deliver = (at: number, options: {observed?: number; name?: string; failure?: string; used?: number; stale?: number; skew?: number} = {}) => {
    const behind = options.skew ?? 0;
    const observedAt = iso(T + (options.observed ?? at) - behind);
    return ingest.accept(
      credential,
      {
        ...agent(options.name ?? 'laptop'),
        sentAt: iso(T + at - behind),
        snapshots: options.failure
          ? []
          : [
              {
                provider: 'codex',
                account: ACCOUNT,
                observedAt,
                via: 'codex/app-server',
                staleAfterMs: options.stale ?? 3_600_000,
                windows: [{id: 'weekly', kind: 'weekly', usedPercent: options.used ?? 50}],
              },
            ],
        failures: options.failure ? [{provider: 'codex', error: options.failure, observedAt}] : [],
      },
      T + at,
    );
  };
  const refresh = (at: number) => ingest.refresh(source(), T + at).value;
  const request = (at: number) => ingest.requestRefresh(source(), T + at);
  const device = (name = 'laptop') => directory.deviceByMachine(user.id, agent(name).machine.id)!.id;
  const resets = new ResetFeed(undefined, () => {});
  const parts = {store, directory, ingest, resets};
  const projection = new Projection(parts);
  return {
    store,
    directory,
    duty,
    cadence,
    ingest,
    user,
    board,
    credential,
    secret,
    token,
    ask,
    deliver,
    source,
    refresh,
    request,
    device,
    parts,
    projection,
    agent,
  };
}

test('refresh shortens the automatic wait, with one command and the same automatic promise', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  assert.equal(h.request(10_000).status, 'accepted');
  const queued = h.refresh(10_000).request!;
  assert.equal(queued.status, 'queued');
  assert.equal(queued.notBefore, T + MIN);
  assert.equal(h.ask(MIN - 1).measure, false);
  assert.deepEqual(h.ask(MIN), {provider: 'codex', measure: true, onDuty: true, askInMs: 15_000, nextInMs: 4 * MIN, until: iso(T + MIN + 15_000)});
  assert.equal(h.request(MIN + 1).status, 'accepted');
  assert.equal(h.refresh(MIN + 1).request?.requestedAt, T + 10_000);
  assert.equal(h.ask(MIN + 1).measure, false);
  h.deliver(MIN + 2);
  assert.equal(h.refresh(MIN + 2).request?.status, 'updated', 'unchanged percentages still count');
  assert.equal(h.request(69_999).status, 'too_soon');
  assert.equal(h.request(70_000).status, 'accepted');
});

test('queued refresh follows changed device minima in both directions, and the normal path respects a raised floor', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0, {stale: 132_000});
  h.request(10_000);
  assert.equal(h.ask(15_000, 5 * MIN).measure, false);
  assert.deepEqual([h.refresh(15_000).request?.notBefore, h.refresh(15_000).request?.deadline], [T + 5 * MIN, T + 10 * MIN]);
  assert.equal(h.ask(30_000, 2 * MIN).measure, false);
  assert.deepEqual([h.refresh(30_000).request?.notBefore, h.refresh(30_000).request?.deadline], [T + 2 * MIN, T + 7 * MIN]);
  assert.equal(h.ask(2 * MIN - 1, 2 * MIN).measure, false);
  assert.equal(h.ask(2 * MIN, 2 * MIN).measure, true);
  h.deliver(2 * MIN);
  assert.equal(h.ask(4 * MIN, 10 * MIN).measure, false, 'old promise cannot override a raised floor');
});

for (const manual of [false, true])
  test(`old accepted data cannot acknowledge a command or bypass retries, refresh=${manual}`, t => {
    const h = hub(t);
    h.ask(0);
    h.deliver(0, {used: 95, stale: 132_000});
    assert.equal(h.ask(MIN).measure, true);
    if (manual) h.request(61_000);
    assert.equal(h.deliver(65_000, {observed: 10_000, used: 95, stale: 132_000}).accepted, 1);
    for (const at of [75_000, 149_999]) assert.equal(h.ask(at).measure, false);
    assert.equal(h.ask(150_000).measure, true);
    if (manual) {
      const joined = h.refresh(150_000).request;
      assert.equal(joined?.status, 'waiting', 'the old snapshot lease lapses before the retry, the holder is still measuring');
      assert.equal(joined?.dispatchAt, T + MIN);
      assert.equal(joined?.deadline, T + 361_000, 'retry never extends request deadline');
      assert.equal(h.refresh(361_000).request?.status, 'no_result');
    }
  });

test('answer timestamp tolerance and success after a failure protect the shared producer', () => {
  const signals: Signals = {windows: [], inUse: false};
  for (const failure of [false, true])
    for (const delta of [30_000, 30_001]) {
      const c = new Cadence();
      c.answer('s', 'd', 'codex', T, MIN, signals);
      if (failure) c.failed('s', 'd', 'failed', T - delta);
      else c.delivered('s', 'd', [], T - delta, 132_000, false, T + 1);
      const at = c.view('s', 'd', T + 1, signals)?.next;
      if (!failure) assert.equal(at, delta === 30_000 ? T + MIN : T, 'accepted answer still respects command floor');
      if (failure) {
        // Past the pause, an answered command waits out its interval, an unanswered one is retried.
        assert.equal(c.answer('s', 'd', 'codex', T + 90_000, MIN, signals).measure, delta === 30_001, 'only a failure within the tolerance answers the command');
        c.delivered('s', 'd', [], T - delta - 1, 132_000, false, T + 2);
        assert.notEqual(c.pausedUntil('s', 'd', T + 2), null, 'old success does not clear the pause');
        c.delivered('s', 'd', [], T - delta, 132_000, false, T + 2);
        assert.notEqual(c.pausedUntil('s', 'd', T + 2), null, 'a success taken as the failure was does not clear the pause');
        c.delivered('s', 'd', [], T + 3, 132_000, false, T + 3);
        assert.equal(c.pausedUntil('s', 'd', T + 3), null);
      }
    }
});

test('waiting survives a sequential provider measurement beyond silence, including repeated POST and snapshot', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.request(10_000);
  h.ask(MIN);
  const deadline = h.refresh(MIN).request?.deadline;
  const silent = MIN + 120_001;
  assert.equal(h.refresh(silent).unavailable, null, 'measuring what it was told to, it is not silent');
  assert.equal(h.refresh(6 * MIN - 1).unavailable, null);
  assert.equal(h.refresh(6 * MIN).unavailable, 'silent', 'not for more than five minutes');
  assert.equal(h.refresh(silent).request?.status, 'waiting');
  assert.equal(h.request(silent).status, 'accepted');
  assert.equal(h.projection.snapshot(h.user.id, h.board, T + silent)?.refresh[h.source()].request?.deadline, deadline);
  h.deliver(MIN + 150_000);
  assert.equal(h.refresh(MIN + 150_000).request?.status, 'updated');
});

test('timeout, terminal expiry and late delivery behave the same without any open page', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.request(10_000);
  h.ask(MIN);
  assert.equal(h.refresh(6 * MIN - 1).request?.status, 'waiting');
  assert.equal(h.refresh(6 * MIN).request?.status, 'no_result');
  h.deliver(6 * MIN + 1);
  assert.equal(h.refresh(6 * MIN + 1).request?.status, 'no_result');
  assert.equal(h.refresh(7 * MIN).request, null);
});

test('availability checks capability per subscription, silence, lease, and error pauses', t => {
  const h = hub(t);
  h.deliver(0);
  assert.equal(h.request(1).status, 'unavailable');
  assert.equal(h.refresh(1).unavailable, 'unsupported');
  h.ask(2);
  h.deliver(3);
  h.ask(4, MIN, 'laptop', false);
  assert.equal(h.refresh(4).unavailable, 'unsupported');
  assert.equal(h.request(4).status, 'unavailable');
  h.ask(5);
  assert.equal(h.refresh(120_005).unavailable, null);
  assert.equal(h.refresh(120_006).unavailable, 'silent');
  h.ask(120_007);
  h.deliver(120_008, {failure: 'failed'});
  assert.equal(h.refresh(120_008).unavailable, 'paused');
  assert.equal(h.request(120_008).status, 'unavailable');
  assert.equal(h.refresh(120_008).retryAt, null);
  h.ask(240_007);
  assert.equal(h.refresh(240_007).unavailable, 'paused');
  assert.equal(h.refresh(240_008).unavailable, null);
  assert.equal(h.refresh(3_600_004).unavailable, 'no_device');
});

test('queued silence has a fixed terminal time and cannot be revived by a later check-in', t => {
  const h = hub(t);
  h.ask(0, 5 * MIN);
  h.deliver(0);
  h.request(10_000);
  assert.equal(h.refresh(120_000).request?.status, 'queued');
  assert.equal(h.refresh(120_001).request?.finishedAt, T + 120_001);
  assert.deepEqual(h.refresh(120_002).request, h.refresh(120_001).request);
  h.ask(120_003, 5 * MIN);
  assert.equal(h.refresh(120_003).request?.status, 'unavailable');
});

test('freshness boundaries, duplicates, other-device success and failures stay distinct', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  // The other machine measures this subscription too: its failures are known to be about it.
  h.deliver(1_000, {name: 'other'});
  h.request(40_000);
  h.deliver(41_000, {observed: 9_999});
  assert.equal(h.refresh(41_000).request?.status, 'queued');
  h.deliver(42_000, {name: 'other', failure: 'failed'});
  assert.equal(h.refresh(42_000).request?.status, 'queued');
  h.deliver(43_000, {observed: 10_000, name: 'other'});
  assert.equal(h.refresh(43_000).request?.status, 'updated');
  h.ask(100_000);
  h.request(100_000);
  h.ask(100_000);
  h.deliver(101_000, {observed: 10_000});
  assert.equal(h.refresh(101_000).request?.status, 'waiting');
  h.deliver(102_000, {failure: 'failed'});
  assert.equal(h.refresh(102_000).request?.status, 'failed');
  assert.equal(h.store.state(h.source()).error, null, 'fresh previous limits remain good');
});

test('revocation reaches requests with no sessions, at a fixed time', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.request(10_000);
  h.directory.revokeToken(h.user.id, h.token.id, T + 11_000);
  h.ingest.forget([h.device()], T + 11_000);
  assert.equal(h.refresh(11_000).request?.status, 'unavailable');
  assert.equal(h.refresh(11_000).unavailable, 'no_device');
  assert.equal(h.refresh(11_000).request?.finishedAt, T + 11_000);
  assert.equal(h.refresh(15_000).request?.finishedAt, T + 11_000, 'a later reading does not move the end');
});

test('forgetting a device ends its request when it happens, whatever else is known of it yet', () => {
  const c = new Cadence();
  const duty = {holder: 'd', until: T + 10 * MIN, live: true};
  c.capability('s', 'd', true, MIN, T);
  assert.equal(c.requestRefresh('s', duty, null, T + 1_000).status, 'accepted');
  assert.deepEqual(c.forget(['d'], T + 2_000), ['s']);
  const request = c.refresh('s', duty, T + 5_000).value.request;
  assert.deepEqual([request?.status, request?.finishedAt], ['unavailable', T + 2_000]);
});

for (const legacy of [false, true])
  test(`revoking ${legacy ? 'a legacy holder that only delivers' : 'a holder that only asks'} tells the boards at once`, t => {
    const h = hub(t);
    let now = T;
    const frames: Frame[] = [];
    const events = new Events(h.parts, undefined, {now: () => now, after: () => () => {}});
    h.ingest.setObserver(events);
    t.after(() => events.close());
    const session = newSecret('qt_s');
    h.directory.createSession(session, h.user.id, T, 86_400_000);
    h.deliver(0, {stale: MIN});
    // The laptop measures without the hub's pace; the desk takes the lapsed duty by asking alone.
    if (!legacy) h.ask(61_000, MIN, 'desk');
    const holder = h.device(legacy ? 'laptop' : 'desk');
    assert.equal(h.duty.holder(ACCOUNT), holder);
    const opened = events.open({user: h.user.id, secret: session, board: h.board, kind: 'stream', send: got => frames.push(...got), end: () => {}});
    assert.ok(opened && opened !== 'limit');
    now = T + 62_000;
    events.flush();
    const before = frames.length;
    h.directory.revokeDevice(h.user.id, holder, now);
    h.ingest.forget([holder], now);
    events.flush();
    const sent = frames.slice(before).filter(f => f.type === 'refresh');
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(sent[0].data).refresh.unavailable, 'no_device');
  });

test('revoking a device with no sessions tells the boards at once', t => {
  const h = hub(t);
  let now = T;
  const frames: Frame[] = [];
  const events = new Events(h.parts, undefined, {now: () => now, after: () => () => {}});
  h.ingest.setObserver(events);
  t.after(() => events.close());
  const session = newSecret('qt_s');
  h.directory.createSession(session, h.user.id, T, 86_400_000);
  h.ask(0);
  h.deliver(0);
  const opened = events.open({user: h.user.id, secret: session, board: h.board, kind: 'stream', send: got => frames.push(...got), end: () => {}});
  assert.ok(opened && opened !== 'limit');
  now = T + 10_000;
  h.request(10_000);
  events.flush();
  now = T + 11_000;
  h.directory.revokeDevice(h.user.id, h.device(), now);
  h.ingest.forget([h.device()], now);
  events.flush();
  assert.equal(JSON.parse(frames.filter(f => f.type === 'refresh').at(-1)!.data).refresh.request.status, 'unavailable');
});

test('projection changesAt remains a future boundary through silence, deadline and terminal expiry', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.request(10_000);
  h.ask(MIN);
  let now = T + MIN;
  while (now < T + 8 * MIN) {
    const read = h.ingest.refresh(h.source(), now);
    const next = read.changesAt ?? T + 8 * MIN;
    assert.ok(next > now);
    for (const at of [now, now + 1, Math.floor((now + next) / 2), next - 1]) assert.deepEqual(h.ingest.refresh(h.source(), at).value, read.value);
    now = next;
  }
});

test('the board action, events and check-in share one request across viewers and reject outsiders', async t => {
  const h = hub(t);
  let now = T;
  t.mock.method(Date, 'now', () => now);
  const frames: Frame[] = [];
  const events = new Events(h.parts, undefined, {now: () => now, after: () => () => {}});
  h.ingest.setObserver(events);
  const app = await buildApp({...h.parts, events, pairing: new Pairing(h.directory), setup: new Setup(false, null), local: null});
  t.after(async () => {
    events.close();
    await app.close();
  });
  const viewer = h.directory.createUser('v@example.com', 'Viewer', 'x', T);
  const team = h.directory.createBoard('Team', h.user.id, T);
  h.directory.addMember(team.id, viewer.id, T);
  const session = newSecret('qt_s');
  h.directory.createSession(session, viewer.id, T, 86_400_000);
  // Measured, but not yet by a device that follows the hub's pace.
  h.deliver(0);
  h.store.share(team.id, h.source(), h.user.id, T);
  const elsewhere = h.directory.createBoard('Elsewhere', h.user.id, T);
  h.directory.addMember(elsewhere.id, viewer.id, T);
  const opened = events.open({user: viewer.id, secret: session, board: team.id, kind: 'stream', send: got => frames.push(...got), end: () => {}});
  assert.ok(opened && opened !== 'limit');
  const action = (board = team.id, source = h.source(), cookie = `quotum_session=${session}`, origin?: string) =>
    app.inject({method: 'POST', url: `/api/boards/${board}/sources/${source}/refresh`, headers: {cookie, ...(origin ? {origin} : {})}});
  now += 5_000;
  const unavailable = await action();
  assert.deepEqual([unavailable.statusCode, unavailable.json()], [409, {error: 'refresh_unavailable'}]);
  h.ask(5_000);
  now += 5_000;
  assert.equal((await action(team.id, h.source(), '')).statusCode, 401);
  assert.equal((await action(h.board)).statusCode, 404);
  assert.equal((await action(team.id, 'other')).statusCode, 404);
  assert.equal((await action(elsewhere.id)).statusCode, 404, 'a board of the reader without this source');
  assert.equal(h.refresh(10_000).request, null, 'refusals create no work');
  assert.equal((await action(team.id, h.source(), undefined, 'https://evil.example')).statusCode, 403);
  assert.equal((await action()).statusCode, 202);
  assert.equal((await action()).statusCode, 202);
  events.flush();
  assert.equal(JSON.parse(frames.find(f => f.type === 'refresh')!.data).refresh.request.status, 'queued');
  assert.equal(h.refresh(10_000).request?.requestedAt, now);
  now = T + MIN;
  h.ask(MIN);
  events.flush();
  assert.equal(JSON.parse(frames.filter(f => f.type === 'refresh').at(-1)!.data).refresh.request.status, 'waiting');
  now++;
  h.deliver(MIN + 1);
  events.flush();
  assert.equal(JSON.parse(frames.filter(f => f.type === 'refresh').at(-1)!.data).refresh.request.status, 'updated');
  const refused = await action();
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.headers['retry-after'], '10');
  const snapshot = h.projection.snapshot(viewer.id, team.id, now)!;
  assert.deepEqual(snapshot.refresh[h.source()], h.refresh(MIN + 1));
  assert.equal(JSON.stringify(snapshot.refresh).includes(h.device()), false);
});

test('handover ends a queued or waiting request instead of moving it to the next device', t => {
  for (const waiting of [false, true]) {
    const h = hub(t);
    h.ask(0);
    h.deliver(0);
    h.ask(11 * MIN);
    h.deliver(11 * MIN);
    h.request(11 * MIN + 1);
    const other = (at: number) => h.ingest.checkin(h.credential, {...h.agent('other'), paced: true, subscriptions: [{provider: 'codex', account: ACCOUNT, active: true}]}, T + at).subscriptions[0];
    let at = 12 * MIN + 1;
    if (waiting) {
      h.ask(12 * MIN);
      // Someone works on the other machine while the laptop measures: it does not take over halfway.
      assert.equal(other(at).measure, false);
      assert.equal(h.refresh(at).request?.status, 'waiting');
      // Asking again, the laptop is done measuring.
      h.ask(12 * MIN + 15_000);
      at = 12 * MIN + 15_001;
    }
    assert.equal(other(at).measure, true);
    assert.equal(h.refresh(at).request?.status, 'unavailable');
    assert.equal(h.refresh(at).request?.finishedAt, T + at);
    assert.equal(h.refresh(at + 5_000).request?.finishedAt, T + at, 'the handover is kept as it happened');
    assert.equal(h.duty.holder(ACCOUNT), h.device('other'));
  }
});

test('revoking a device after the deadline preserves the earlier timeout', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.request(10_000);
  h.ask(MIN);
  h.directory.revokeDevice(h.user.id, h.device(), T + 6 * MIN + 1);
  h.ingest.forget([h.device()], T + 6 * MIN + 1);
  assert.equal(h.refresh(6 * MIN + 1).request?.status, 'no_result');
  assert.equal(h.refresh(6 * MIN + 1).request?.finishedAt, T + 6 * MIN);
});

test('an old failure does not turn a fresh pending request into a failure', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.request(10_000);
  h.deliver(11_000, {failure: 'failed', observed: 0});
  assert.equal(h.refresh(11_000).request?.status, 'queued');
});

test('three provider responses sent sequentially keep the last request waiting for 150 seconds, past its measurement\'s lease', t => {
  const h = hub(t);
  const subscriptions = (['claude', 'codex', 'antigravity'] as const).map((provider, i) => ({provider, account: ['a', 'b', 'c'][i].repeat(24), active: false}));
  // Little left, as when one refreshes before a long session: the agent promises the next
  // measurement in two minutes, so each lease lasts 204 seconds from its measurement.
  const snapshots = subscriptions.map(({provider, account}) => ({
    provider,
    account,
    observedAt: iso(T),
    via: 'stand-in',
    staleAfterMs: 204_000,
    windows: [{id: 'weekly', kind: 'weekly', usedPercent: 95}],
  }));
  h.ingest.accept(h.credential, {...h.agent('laptop'), sentAt: iso(T), snapshots, failures: []}, T);
  h.ingest.checkin(h.credential, {...h.agent('laptop'), paced: true, subscriptions}, T);
  const source = h.store.findSource('antigravity', 'c'.repeat(24))!;
  for (const {provider, account} of subscriptions)
    assert.equal(h.ingest.requestRefresh(h.store.findSource(provider, account)!, T + 10_000).status, 'accepted');
  const answer = h.ingest.checkin(h.credential, {...h.agent('laptop'), paced: true, subscriptions}, T + MIN);
  assert.ok(answer.subscriptions.every(s => s.measure));
  for (const [i, snapshot] of snapshots.entries()) {
    const at = T + MIN + (i + 1) * 50_000;
    if (i === 2) {
      assert.equal(h.ingest.refresh(source, T + MIN + 120_001).value.request?.status, 'waiting');
      // Its last measurement went stale at 204 s; told to measure, the laptop keeps duty meanwhile.
      assert.ok(h.duty.until('c'.repeat(24))! > T + 204_001);
      assert.equal(h.ingest.refresh(source, T + 204_001).value.request?.status, 'waiting');
    }
    h.ingest.accept(h.credential, {...h.agent('laptop'), sentAt: iso(at), snapshots: [{...snapshot, observedAt: iso(at)}], failures: []}, at);
  }
  assert.equal(h.ingest.refresh(source, T + MIN + 150_000).value.request?.status, 'updated');
});

test('a lapsed lease of the holder told to measure waits for the deadline, a lost result ends there', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0, {stale: 132_000});
  assert.equal(h.ask(MIN).measure, true);
  // Joined two minutes in, the wait ends seven minutes in; the command kept duty for five.
  h.request(2 * MIN);
  const joined = h.refresh(2 * MIN).request!;
  assert.deepEqual([joined.status, joined.dispatchAt, joined.deadline], ['waiting', T + MIN, T + 7 * MIN]);
  assert.equal(h.refresh(6 * MIN + 1).unavailable, 'no_device', 'the lease has lapsed');
  assert.equal(h.refresh(7 * MIN - 1).request?.status, 'waiting');
  assert.deepEqual([h.refresh(7 * MIN).request?.status, h.refresh(7 * MIN).request?.finishedAt], ['no_result', T + 7 * MIN]);
});

for (const joins of [true, false])
  test(`a request ${joins ? 'joins a command its holder has not asked past' : 'after a command its holder asked past waits for its retry'}`, t => {
    const h = hub(t);
    h.ask(0);
    h.deliver(0);
    assert.equal(h.ask(2 * MIN).measure, true);
    // Asking again with nothing delivered: the command was lost.
    if (!joins) assert.equal(h.ask(135_000).measure, false);
    const at = 3 * MIN;
    h.request(at);
    const request = h.refresh(at).request!;
    assert.equal(request.status, joins ? 'waiting' : 'queued');
    assert.equal(request.dispatchAt, joins ? T + 2 * MIN : null);
    assert.equal(request.notBefore, T + 210_000, 'the command is retried when its backoff allows, not sooner');
    assert.equal(h.ask(209_999).measure, false, 'no second command before the retry');
    assert.equal(h.ask(210_000).measure, true);
    const retried = h.refresh(210_000).request!;
    assert.equal(retried.status, 'waiting');
    assert.equal(retried.dispatchAt, joins ? T + 2 * MIN : T + 210_000);
    assert.equal(retried.deadline, joins ? T + at + 5 * MIN : T + 210_000 + 5 * MIN, 'the retry does not extend a joined wait');
    // The answer to the command already under way counts for the request that joined it.
    h.deliver(211_000, {observed: 130_000});
    assert.equal(h.refresh(211_000).request?.status, joins ? 'updated' : 'waiting');
  });

test('a request joins a command for as long as its holder measures, however many providers come first', t => {
  const h = hub(t);
  const subscriptions = (['claude', 'codex', 'antigravity'] as const).map((provider, i) => ({provider, account: ['a', 'b', 'c'][i].repeat(24), active: false}));
  const snapshot = (i: number, at: number) => ({...subscriptions[i], observedAt: iso(at), via: 'stand-in', staleAfterMs: 204_000, windows: [{id: 'weekly', kind: 'weekly', usedPercent: 95}]});
  const deliver = (i: number, at: number) => h.ingest.accept(h.credential, {...h.agent('laptop'), sentAt: iso(at), snapshots: [snapshot(i, at)], failures: []}, at);
  h.ingest.accept(h.credential, {...h.agent('laptop'), sentAt: iso(T), snapshots: [0, 1, 2].map(i => snapshot(i, T)), failures: []}, T);
  h.ingest.checkin(h.credential, {...h.agent('laptop'), paced: true, subscriptions}, T);
  // The hub's own pace asks for all three at once; the agent measures them one by one.
  assert.ok(h.ingest.checkin(h.credential, {...h.agent('laptop'), paced: true, subscriptions}, T + MIN).subscriptions.every(s => s.measure));
  deliver(0, T + 110_000);
  const source = h.store.findSource('antigravity', 'c'.repeat(24))!;
  assert.equal(h.ingest.requestRefresh(source, T + 125_000).status, 'accepted');
  const joined = h.ingest.refresh(source, T + 125_000).value.request;
  assert.deepEqual([joined?.status, joined?.dispatchAt], ['waiting', T + MIN], 'a minute later its command is still under way');
  deliver(1, T + 160_000);
  deliver(2, T + 210_000);
  assert.equal(h.ingest.refresh(source, T + 210_000).value.request?.status, 'updated');
});

test('a holder that asks but never delivers loses duty as before, retries of its commands notwithstanding', t => {
  const h = hub(t);
  assert.equal(h.ask(0).measure, true);
  // The desk is told to come back when the laptop's first lease runs out.
  assert.equal(h.ask(1_000, MIN, 'desk').askInMs, 299_000);
  // The laptop asks every 15 seconds and is retried at 90 and 210 s; nothing it measures arrives.
  for (let at = 15_000; at < 300_000; at += 15_000) h.ask(at);
  assert.equal(h.ask(300_000, MIN, 'desk').measure, true);
  assert.equal(h.duty.holder(ACCOUNT), h.device('desk'));
});

test('a request joins a command however long the holder measures without asking, up to five minutes', t => {
  const h = hub(t);
  const subscriptions = (['claude', 'codex', 'antigravity'] as const).map((provider, i) => ({provider, account: ['a', 'b', 'c'][i].repeat(24), active: false}));
  const snapshots = subscriptions.map(s => ({...s, observedAt: iso(T), via: 'stand-in', staleAfterMs: 204_000, windows: [{id: 'weekly', kind: 'weekly', usedPercent: 95}]}));
  h.ingest.accept(h.credential, {...h.agent('laptop'), sentAt: iso(T), snapshots, failures: []}, T);
  h.ingest.checkin(h.credential, {...h.agent('laptop'), paced: true, subscriptions}, T);
  assert.ok(h.ingest.checkin(h.credential, {...h.agent('laptop'), paced: true, subscriptions}, T + MIN).subscriptions.every(s => s.measure));
  const source = h.store.findSource('antigravity', 'c'.repeat(24))!;
  // Two minutes and more without a word from the laptop: it measures the others first.
  assert.equal(h.ingest.refresh(source, T + 185_000).value.unavailable, null);
  assert.equal(h.ingest.requestRefresh(source, T + 185_000).status, 'accepted');
  assert.equal(h.ingest.refresh(source, T + 185_000).value.request?.status, 'waiting');
  // Five minutes after the command, a holder that still has not asked is taken as gone, its duty with it.
  const other = h.store.findSource('codex', 'b'.repeat(24))!;
  assert.equal(h.ingest.refresh(other, T + 6 * MIN - 1).value.unavailable, null);
  assert.equal(h.ingest.refresh(other, T + 6 * MIN).value.unavailable, 'no_device');
});

test('another machine of the subscription does not take duty while the holder measures what it was told to', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0, {used: 95, stale: 204_000});
  // The desk is told to come back when the laptop's measurement goes stale.
  assert.deepEqual([h.ask(1_000, MIN, 'desk').measure, h.ask(1_000, MIN, 'desk').askInMs], [false, 203_000]);
  h.request(10_000);
  assert.equal(h.ask(MIN).measure, true);
  const desk = h.ask(204_000, MIN, 'desk');
  assert.deepEqual([desk.measure, desk.onDuty], [false, false], 'no second measurement of the same subscription');
  assert.equal(h.duty.holder(ACCOUNT), h.device());
  h.deliver(210_000, {used: 95, stale: 204_000});
  assert.equal(h.refresh(210_000).request?.status, 'updated');
});

test('a request waiting for the retry of a lost command outlives the holder\'s lease while it keeps asking', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0, {stale: 132_000});
  // Commands at 1, 3, 5 and 9 minutes go unanswered; the next retry comes 8 minutes after the last.
  for (let at = MIN; at <= 10 * MIN; at += MIN) h.ask(at);
  h.request(10 * MIN + 10_000);
  const queued = h.refresh(10 * MIN + 10_000).request!;
  assert.deepEqual([queued.status, queued.notBefore], ['queued', T + 17 * MIN]);
  for (let at = 11 * MIN; at < 17 * MIN; at += MIN) assert.equal(h.ask(at).measure, false);
  assert.equal(h.refresh(16 * MIN).request?.status, 'queued', 'its lease ran out at 14 minutes; it asked on');
  assert.equal(h.ask(17 * MIN).measure, true);
  assert.equal(h.refresh(17 * MIN).request?.status, 'waiting');
});

test('duty handed over by a delivery or a legacy check-in ends the request at that moment', t => {
  for (const legacy of [false, true]) {
    const h = hub(t);
    h.ask(0, 10 * MIN);
    h.deliver(0, {stale: MIN});
    h.ask(40_000, 10 * MIN);
    h.request(50_000);
    // The laptop's measurement went stale at a minute; another machine takes duty, with data too old to answer the request.
    if (legacy) h.ask(61_000, MIN, 'other', false);
    else h.deliver(61_000, {name: 'other', observed: 5_000});
    assert.equal(h.duty.holder(ACCOUNT), h.device('other'));
    const request = h.refresh(66_000).request;
    assert.deepEqual([request?.status, request?.finishedAt], ['unavailable', T + 61_000]);
  }
});

test('a device whose clock runs behind answers the request in the hub\'s time', t => {
  for (const failure of [undefined, 'failed']) {
    const h = hub(t);
    h.ask(0);
    h.deliver(0);
    h.request(10_000);
    h.ask(MIN);
    h.deliver(MIN + 5_000, {skew: 10 * MIN, failure});
    assert.equal(h.refresh(MIN + 5_000).request?.status, failure ? 'failed' : 'updated');
  }
});

test('a lowered device minimum lets a queued request go at once instead of ending it in the past', t => {
  const h = hub(t);
  h.ask(0, 10 * MIN);
  h.deliver(0);
  h.request(MIN);
  for (const at of [2 * MIN, 4 * MIN, 6 * MIN]) assert.equal(h.ask(at, 10 * MIN).measure, false);
  assert.deepEqual([h.refresh(7 * MIN).request?.status, h.refresh(7 * MIN).request?.deadline], ['queued', T + 15 * MIN]);
  assert.equal(h.ask(435_000, MIN).measure, true);
  const sent = h.refresh(435_000).request;
  assert.equal(sent?.status, 'waiting');
  assert.equal(sent?.dispatchAt, T + 435_000);
});

test('a pending request ends when its holder leaves the pace or waits out a failure', t => {
  const legacy = hub(t);
  legacy.ask(0);
  legacy.deliver(0);
  legacy.request(10_000);
  legacy.ask(20_000, MIN, 'laptop', false);
  assert.deepEqual([legacy.refresh(25_000).request?.status, legacy.refresh(25_000).request?.finishedAt], ['unavailable', T + 20_000]);
  // A failure too old to answer the request still pauses its holder.
  const paused = hub(t);
  paused.ask(0);
  paused.deliver(0);
  paused.request(50_000);
  paused.deliver(51_000, {failure: 'failed', observed: 10_000});
  assert.deepEqual([paused.refresh(55_000).request?.status, paused.refresh(55_000).request?.finishedAt], ['unavailable', T + 51_000]);
});

test('a failure after the deadline keeps the timeout it came after', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.request(10_000);
  h.ask(MIN);
  h.deliver(6 * MIN + 1, {failure: 'failed', observed: 6 * MIN});
  assert.deepEqual([h.refresh(6 * MIN + 1).request?.status, h.refresh(6 * MIN + 1).request?.finishedAt], ['no_result', T + 6 * MIN]);
});

test('an error pause is not advertised as a return time for a legacy device', t => {
  const h = hub(t);
  h.ask(0); h.deliver(0); h.ask(1, MIN, 'laptop', false);
  h.deliver(10_000, {failure: 'failed'});
  const before = h.refresh(10_000);
  assert.equal(before.unavailable, 'unsupported');
  assert.equal(before.availableAt, null, 'ending the pause cannot make a legacy device available');
  assert.deepEqual(h.refresh(130_000), before, 'no refresh event just because an irrelevant pause ended');
});

test('an expired duty lease does not advertise its former holder’s pause or change when it ends', t => {
  const h = hub(t);
  h.ask(0); h.deliver(0, {stale: MIN});
  h.deliver(10_000, {failure: 'failed'});
  const before = h.refresh(MIN);
  assert.equal(before.unavailable, 'no_device');
  assert.equal(before.availableAt, null);
  assert.deepEqual(h.refresh(130_000), before);
});
