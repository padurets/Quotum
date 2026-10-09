import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Cadence} from '../cadence.js';
import {Duty} from '../duty.js';
import {Ingest, type Credential} from '../ingest.js';
import {MEASURE_INTERVAL, type MeasureIntervalMs} from '../domain/frequency.js';
import {newSecret} from '../domain/auth.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {STEPS} from '../store/schema.js';
import {Projection} from '../projection.js';
import {ResetFeed} from '../resets.js';
import {Events, type Frame} from '../events.js';
import {buildApp} from '../api.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';

const T = Date.parse('2026-09-30T12:00:00Z');
const MIN = 60_000;
const ACCOUNT = '0123456789abcdef01234567';
const iso = (at: number) => new Date(T + at).toISOString();

function hub(t: TestContext) {
  const store = new Store(':memory:', T);
  t.after(() => store.close());
  const directory = new Directory(store.db);
  const user = directory.createUser('alice@example.com', 'Alice', 'x', T);
  const secret = newSecret('qt_m');
  directory.createToken(secret, 'test', user.id, 'test', T);
  const duty = new Duty();
  const cadence = new Cadence();
  const ingest = new Ingest(store, directory, duty, cadence);
  const credential = ingest.authenticate(`Bearer ${secret}`) as Credential;
  const agent = (name: string) => ({version: 1, agent: 'quotum/0.4.0', machine: {id: `${name}-0123456789abcdef`, name, os: 'linux', arch: 'x86_64'}});
  const ask = (at: number, minimum = MIN, name = 'laptop', active = false, paced = true) => ingest.checkin(credential, {
    ...agent(name), paced, subscriptions: [{provider: 'codex', account: ACCOUNT, active, minIntervalMs: minimum}],
  }, T + at).subscriptions[0];
  const deliver = (at: number, options: {observed?: number; stale?: number; name?: string; used?: number; failure?: string; reset?: number; credits?:string;windowless?:boolean} = {}) => ingest.accept(credential, {
    ...agent(options.name ?? 'laptop'), sentAt: iso(at),
    snapshots: options.failure ? [] : [{provider: 'codex', account: ACCOUNT, observedAt: iso(options.observed ?? at), via: 'codex/app-server', staleAfterMs: options.stale ?? 348_000,
      windows: options.windowless?[]:[{id: 'weekly', kind: 'weekly', usedPercent: options.used ?? 50, ...(options.reset === undefined ? {} : {resetsAt: iso(options.reset)})}],...(options.windowless?{resourceStatus:{windows:'missing',resets:'missing'}}:{}),...(options.credits===undefined?{}:{balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:options.credits}]})}],
    failures: options.failure ? [{provider: 'codex', error: options.failure, observedAt: iso(options.observed ?? at)}] : [],
  }, T + at);
  const source = () => store.findSource('codex', ACCOUNT)!;
  const frequency = (value: MeasureIntervalMs, at = 15_000) => {
    if (store.setMeasureInterval(source(), value)) ingest.frequencyChanged(source(), T + at);
  };
  const device = (name = 'laptop') => directory.deviceByMachine(user.id, agent(name).machine.id)!.id;
  const parts = {store, directory, ingest, resets: new ResetFeed(undefined, () => {})};
  return {store, directory, user, duty, cadence, ingest, credential, agent, ask, deliver, source, frequency, device, parts};
}

test('migration defaults old sources to Auto; every choice survives reopening and new sources still insert', t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'quotum-frequency-'));
  t.after(() => rmSync(folder, {recursive: true}));
  const file = path.join(folder, 'db.sqlite');
  const old = new DatabaseSync(file);
  // Layout 5 is the last one before measuring preferences, whatever is appended later.
  for (const step of STEPS.slice(0, 5)) old.exec(step);
  old.exec('PRAGMA user_version = 5');
  old.prepare('INSERT INTO meta VALUES (?, ?)').run('historyStart', String(T));
  old.prepare('INSERT INTO sources VALUES (?, ?, ?, ?)').run('old', 'codex', ACCOUNT, T);
  old.close();
  let store = new Store(file, T);
  assert.equal(store.measureInterval('old'), null);
  const ids = Object.values(MEASURE_INTERVAL).map((value, index) => {
    const id = store.source('claude', `account-${index}`, T);
    assert.equal(store.measureInterval(id), null);
    store.setMeasureInterval(id, value);
    assert.equal(store.setMeasureInterval(id, value), false);
    return id;
  });
  assert.throws(() => store.db.prepare('UPDATE sources SET measure_interval_ms = 123 WHERE id = ?').run('old'));
  store.close();
  store = new Store(file, T);
  assert.deepEqual(ids.map(id => store.measureInterval(id)), Object.values(MEASURE_INTERVAL));
  store.close();
});

for (const interval of Object.values(MEASURE_INTERVAL).filter((value): value is Exclude<MeasureIntervalMs, null> => value !== null)) {
  test(`fixed ${interval / MIN} minutes ignores work, low limits, changed percentages and resets`, t => {
    const h = hub(t);
    h.ask(0);
    h.deliver(0, {used: 95, reset: 30_000});
    h.frequency(interval);
    assert.equal(h.ask(15_000, MIN, 'laptop', true).measure, false);
    assert.equal(h.ask(interval - 1, MIN, 'laptop', true).measure, false);
    const command = h.ask(interval, MIN, 'laptop', true);
    assert.deepEqual([command.measure, command.nextInMs], [true, interval]);
    h.deliver(interval, {used: 98, reset: interval + 30_000});
    assert.equal(h.ask(2 * interval - 1).measure, false);
    assert.equal(h.ask(2 * interval).measure, true);
  });
}

test('interval writes replan immediately, keep historical freshness, and do not duplicate a command or refresh', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.frequency(900_000);
  assert.equal(h.ingest.nextMeasurement(h.source(), ACCOUNT, T + 15_000).value?.next, T + 15 * MIN);
  const old = h.store.state(h.source());
  h.ask(2 * MIN);
  h.frequency(MIN, 2 * MIN);
  assert.equal(h.ask(2 * MIN + 1).measure, true);
  h.frequency(900_000, 2 * MIN + 2);
  assert.equal(h.ask(2 * MIN + 15_000).measure, false, 'in-flight command has its usual retry delay');
  assert.equal(h.ingest.requestRefresh(h.source(), T + 2 * MIN + 15_001).status, 'accepted');
  assert.equal(h.ask(2 * MIN + 30_000).measure, false);
  h.deliver(2 * MIN + 35_000);
  assert.equal(h.ingest.nextMeasurement(h.source(), ACCOUNT, T + 2 * MIN + 35_000).value?.next, T + 17 * MIN + 35_000);
  assert.equal(old.staleAfterMs, 348_000);
  h.frequency(null, 2 * MIN + 40_000);
  assert.notEqual(h.ingest.nextMeasurement(h.source(), ACCOUNT, T + 2 * MIN + 40_000).value?.why, 'fixed');
});

test('raised frequency and device floors protect an anchored plan, but unanswered retries remain bounded', t => {
  for (const mode of ['frequency', 'floor'] as const) {
    const h = hub(t);
    h.ask(0);
    h.deliver(0);
    if (mode === 'frequency') h.frequency(900_000);
    const floor = mode === 'floor' ? 15 * MIN : MIN;
    h.ask(15_000, floor);
    const until = h.duty.until(ACCOUNT);
    assert.equal(until, T + 16 * MIN);
    for (let at = 30_000; at < 6 * MIN; at += 15_000) h.ask(at, floor);
    assert.equal(h.duty.until(ACCOUNT), until, 'questions never slide the protection');
    assert.equal(h.ask(6 * MIN, MIN, 'desk').measure, false);
    assert.equal(h.ingest.refresh(h.source(), T + 6 * MIN).value.unavailable, null);
    h.ask(15 * MIN, floor);
    for (let at = 15 * MIN + 15_000; at <= 21 * MIN; at += 15_000) h.ask(at, floor);
    assert.ok(h.duty.until(ACCOUNT)! <= T + 20 * MIN);
    assert.equal(h.ask(21 * MIN + 1, MIN, 'desk').onDuty, true, 'healthy idle device can take duty after holder-first retries');
  }
});

test('fixed handover, a higher minimum and restart keep the shared successful baseline', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.frequency(900_000);
  for (let at = 15_000; at <= 10 * MIN; at += 15_000) h.ask(at);
  assert.equal(h.ask(10 * MIN + 1, MIN, 'desk', true).measure, false);
  assert.equal(h.duty.holder(ACCOUNT), h.device('desk'));
  assert.deepEqual(h.ingest.nextMeasurement(h.source(), ACCOUNT, T + 10 * MIN + 1).value, {next: T + 15 * MIN, why: 'fixed'});
  assert.equal(h.ask(15 * MIN - 1, 20 * MIN, 'desk').measure, false);
  assert.equal(h.ask(20 * MIN, 20 * MIN, 'desk').measure, true);
  const restarted = new Ingest(h.store, h.directory, new Duty(), new Cadence());
  const check = (at: number) => restarted.checkin(h.credential, {...h.agent('laptop'), paced: true, subscriptions: [{provider: 'codex', account: ACCOUNT, active: false}]}, T + at).subscriptions[0];
  assert.equal(check(5 * MIN).measure, false);
  assert.equal(check(15 * MIN).measure, true);
  const cold = hub(t);
  const id = cold.store.source('codex', ACCOUNT, T);
  cold.store.setMeasureInterval(id, 900_000);
  assert.equal(cold.ask(0).measure, true, 'no successful data still means immediate');
});

test('fixed refresh respects the minimum and starts a new ordinary interval; failures do not protect duty', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.frequency(900_000);
  assert.equal(h.ingest.requestRefresh(h.source(), T + 15_000).status, 'accepted');
  assert.equal(h.ask(MIN - 1).measure, false);
  assert.equal(h.ask(MIN).measure, true);
  h.deliver(MIN, {stale: 19 * MIN});
  assert.equal(h.ingest.nextMeasurement(h.source(), ACCOUNT, T + MIN).value?.next, T + 16 * MIN);
  h.ask(16 * MIN);
  h.deliver(16 * MIN, {failure: 'not_logged_in'});
  assert.equal(h.ask(20 * MIN, MIN, 'desk').measure, true);
});

test('expired unanswered holder-first requests never retake a lease, and a fresh answer restores it', t => {
  const h = hub(t);
  h.ask(0);
  for (let at = 15_000; at <= 10 * MIN; at += 15_000) h.ask(at);
  assert.equal(h.duty.until(ACCOUNT), T + 5 * MIN);
  assert.equal(h.ingest.refresh(h.store.source('codex', ACCOUNT, T), T + 10 * MIN).value.unavailable, 'no_device');
  assert.equal(h.ask(10 * MIN + 1, MIN, 'desk').measure, true);
  h.deliver(10 * MIN + 2, {name: 'desk'});
  assert.ok(h.duty.until(ACCOUNT)! > T + 10 * MIN + 2);
});

for (const local of [false, true]) {
  test(`frequency route permissions, strict input and event authority, local=${local}`, async t => {
    const h = hub(t);
    t.mock.method(Date, 'now', () => T + 15_000);
    h.ask(0);
    h.deliver(0);
    const owner = h.directory.createUser('owner@example.com', 'Owner', 'x', T);
    const second = h.directory.createUser('second@example.com', 'Second', 'x', T);
    const outsider = h.directory.createUser('outsider@example.com', 'Outsider', 'x', T);
    h.store.hold(h.source(), second.id, T);
    const board = local ? h.directory.boards(h.user.id)[0] : h.directory.createBoard('Team', owner.id, T);
    if (!local) {
      h.directory.addMember(board.id, h.user.id, T);
      h.directory.addMember(board.id, second.id, T);
      h.store.share(board.id, h.source(), h.user.id, T);
    }
    const cookies = new Map([h.user, owner, second, outsider].map(user => {
      const secret = newSecret('qt_s');
      h.directory.createSession(secret, user.id, T, 86_400_000);
      return [user.id, `quotum_session=${secret}`];
    }));
    const events = new Events(h.parts, undefined, {now: () => T + 15_000, after: () => () => {}});
    h.ingest.setObserver(events);
    const app = await buildApp({...h.parts, events, pairing: new Pairing(h.directory), setup: new Setup(false, null), local: local ? {key: 'test-local-key'} : null});
    t.after(async () => { events.close(); await app.close(); });
    const action = (body: unknown, user = h.user.id, source = h.source(), boardId = board.id, origin?: string) => app.inject({method: 'POST', url: `/api/boards/${boardId}/sources/${source}/frequency`,
      headers: {cookie: cookies.get(user)!, ...(origin ? {origin} : {})}, payload: body as object});
    for (const body of [{}, {intervalMs: false}, {intervalMs: '60000'}, {intervalMs: 60000.1}, {intervalMs: 123}, {intervalMs: null, extra: 1}, []]) {
      assert.equal((await action(body)).statusCode, 400);
      assert.equal(h.store.measureInterval(h.source()), null);
    }
    assert.equal((await action({intervalMs: MIN}, h.user.id, 'missing')).statusCode, 404);
    assert.equal((await action({intervalMs: MIN}, h.user.id, h.source(), 'missing')).statusCode, 404);
    assert.equal((await action({intervalMs: MIN}, h.user.id, h.source(), board.id, 'https://evil.example')).statusCode, 403);
    if (!local) {
      assert.deepEqual((await action({intervalMs: MIN}, owner.id)).json(), {error: 'frequency_forbidden'});
      assert.equal((await action({intervalMs: MIN}, outsider.id)).statusCode, 404);
      assert.equal((await action({intervalMs: 120_000}, second.id)).statusCode, 200);
    }
    const frames: Frame[] = [];
    const opened = events.open({user: h.user.id, secret: cookies.get(h.user.id)!.split('=')[1], board: board.id, kind: 'stream', send: got => frames.push(...got), end: () => {}});
    assert.ok(opened && opened !== 'limit');
    assert.equal((await action({intervalMs: 900_000})).statusCode, 200);
    events.flush();
    assert.equal(h.duty.until(ACCOUNT), T + 16 * MIN);
    const card = JSON.parse(frames.filter(f => f.type === 'card').at(-1)!.data);
    assert.equal(card.measureIntervalMs, 900_000);
    const projection = new Projection(h.parts);
    assert.equal(projection.snapshot(h.user.id, h.directory.boards(h.user.id)[0].id, T + 15_000)!.sources[0].measureIntervalMs, 900_000);
    const count = frames.length;
    await action({intervalMs: 900_000});
    events.flush();
    assert.equal(frames.length, count, 'equal writes publish no events');
    h.store.db.prepare('DELETE FROM holders WHERE source_id = ? AND user_id = ?').run(h.source(), h.user.id);
    if (!local) {
      const denied = await action({intervalMs: MIN});
      assert.deepEqual([denied.statusCode, denied.json()], [403, {error: 'frequency_forbidden'}]);
      assert.equal(h.store.measureInterval(h.source()), 900_000);
    }
  });
}

test('a silent holder gets no later grant from a frequency write, while a fresh competitor inherits the fixed plan', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  const lease = h.duty.until(ACCOUNT);
  h.frequency(900_000, 3 * MIN);
  assert.equal(h.duty.until(ACCOUNT), lease, 'POST is not a heartbeat for the silent holder');
  assert.equal(h.ask(6 * MIN, MIN, 'desk').measure, false);
  assert.equal(h.duty.holder(ACCOUNT), h.device('desk'));
  assert.equal(h.duty.until(ACCOUNT), T + 16 * MIN);
  assert.equal(h.ask(16 * MIN + 1, MIN, 'third').measure, true, 'sleeping through the fixed plan loses duty at a bounded time');
});

test('a failure from another device cannot remove the healthy holder’s waiting protection', t => {
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.frequency(900_000);
  h.ask(15_000, MIN, 'desk');
  h.deliver(30_000, {name: 'desk', failure: 'timeout'});
  assert.equal(h.duty.until(ACCOUNT), T + 16 * MIN);
  assert.equal(h.ask(6 * MIN, MIN, 'third').measure, false);
});

test('Auto cold start preserves its ordinary first promise even with stored low limits', t => {
  const h = hub(t);
  h.deliver(0, {used: 95});
  const restarted = new Ingest(h.store, h.directory, new Duty(), new Cadence());
  const command = restarted.checkin(h.credential, {...h.agent('laptop'), paced: true, subscriptions: [{provider: 'codex', account: ACCOUNT, active: true}]}, T + MIN).subscriptions[0];
  assert.deepEqual([command.measure, command.nextInMs], [true, 4 * MIN]);
});

test('expired backlog cannot renew an unanswered holder, while representative data and a current answer can', t => {
  for (const kind of ['expired', 'representative', 'current'] as const) {
    const h = hub(t);
    h.ask(0);
    h.deliver(0);
    h.frequency(900_000);
    h.ask(15 * MIN);
    h.ask(15 * MIN + 15_000);
    h.ask(21 * MIN);
    const before = h.duty.until(ACCOUNT);
    assert.equal(before, T + 20 * MIN);
    const result = h.deliver(21 * MIN, {observed: kind === 'current' ? 21 * MIN : MIN, stale: kind === 'representative' ? 24 * MIN : 132_000});
    assert.equal(result.accepted, 1, 'backlog is still accepted into state and history');
    assert.equal(h.store.state(h.source()).successAt, T + (kind === 'current' ? 21 * MIN : MIN));
    if (kind === 'expired') {
      assert.equal(h.duty.until(ACCOUNT), before, 'expired non-answer grants no new thirty-second lease');
      assert.equal(h.ingest.refresh(h.source(), T + 21 * MIN).value.unavailable, 'no_device');
      assert.equal(h.ask(21 * MIN + 1, MIN, 'desk').onDuty, true);
    } else {
      assert.ok(h.duty.until(ACCOUNT)! > T + 21 * MIN);
      assert.equal(h.ask(21 * MIN + 1, MIN, 'desk').onDuty, false);
    }
  }
});

test('a fixed preference after Auto cold start hydrates stored success without replacing the in-flight command', t => {
  for (const handover of [false, true]) {
    const h = hub(t);
    h.deliver(0);
    const restarted = new Ingest(h.store, h.directory, new Duty(), new Cadence());
    const ask = (at: number, name = 'laptop', active = false) => restarted.checkin(h.credential, {...h.agent(name), paced: true, subscriptions: [{provider: 'codex', account: ACCOUNT, active}]}, T + at).subscriptions[0];
    assert.equal(ask(2 * MIN).measure, true);
    h.store.setMeasureInterval(h.source(), 900_000);
    restarted.frequencyChanged(h.source(), T + 2 * MIN + 15_000);
    assert.equal(ask(2 * MIN + 15_000).measure, false, 'the boot command is still outstanding');
    restarted.accept(h.credential, {...h.agent('laptop'), sentAt: iso(2 * MIN + 30_000), snapshots: [], failures: [{provider: 'codex', observedAt: iso(2 * MIN + 30_000), error: 'timeout'}]}, T + 2 * MIN + 30_000);
    if (handover) {
      const result = ask(8 * MIN, 'desk', true);
      assert.deepEqual([result.onDuty, result.measure], [true, false]);
      assert.deepEqual(restarted.nextMeasurement(h.source(), ACCOUNT, T + 8 * MIN).value, {next: T + 15 * MIN, why: 'fixed'});
    } else {
      for (let at = 2 * MIN + 45_000; at < 15 * MIN; at += 15_000) ask(at);
      assert.equal(ask(15 * MIN).measure, true, 'due from stored success, not the boot command');
    }
    assert.equal(h.store.state(h.source()).successAt, T, 'hydration does not record a delivery');
  }
});

test('a silent holder loses longer waiting protection when frequency shortens, but cannot receive a longer grant', t => {
  for (const next of [MIN, null] as const) {
    const h = hub(t);
    h.ask(0);
    h.deliver(0);
    h.frequency(900_000);
    assert.equal(h.duty.until(ACCOUNT), T + 16 * MIN);
    h.frequency(next, 3 * MIN);
    assert.equal(h.duty.until(ACCOUNT), T + 348_000, 'only the unchanged snapshot lease remains');
    assert.equal(h.ask(6 * MIN, MIN, 'desk').onDuty, true);
  }
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.frequency(MIN);
  const before = h.duty.until(ACCOUNT);
  h.frequency(900_000, 3 * MIN);
  assert.equal(h.duty.until(ACCOUNT), before, 'a setting write is not a heartbeat');
});

test('an unanswered Auto retry keeps its interval reason, rather than claiming it follows a reset long ago', () => {
  const cadence = new Cadence();
  const signals = {inUse: false, windows: [{id: 'weekly', kind: 'weekly' as const, label: null, used: 50, remaining: 50, resetAt: T + MIN, minutes: null}]};
  cadence.answer(ACCOUNT, 'laptop', 'codex', T, MIN, signals);
  cadence.delivered(ACCOUNT, 'laptop', [{id: 'weekly', usedPercent: 50}], T, 3_600_000, false, T);
  for (let at = 15_000; at <= 16 * MIN + 15_000; at += 15_000) cadence.answer(ACCOUNT, 'laptop', 'codex', T + at, MIN, signals);
  assert.deepEqual(cadence.view(ACCOUNT, 'laptop', T + 16 * MIN + 15_000, signals), {next: T + 17 * MIN, why: 'idle'});
});

test('a bounded delivery restores waiting protection after its fresh word, including a duplicate', t => {
  for (const arrival of [3 * MIN, 3 * MIN + 1, 4 * MIN]) {
    const h = hub(t);
    h.ask(0);
    h.deliver(0);
    h.frequency(MIN);
    const command = h.ask(MIN);
    assert.equal(command.nextInMs, MIN);
    h.frequency(900_000, MIN + 15_000);
    h.deliver(arrival, {observed: MIN, stale: command.nextInMs! * 1.2 + MIN});
    assert.equal(h.duty.until(ACCOUNT), T + 17 * MIN, 'install the new plan using the delivery heardAt');
    assert.equal(h.ingest.refresh(h.source(), T + arrival + 30_000).value.unavailable, null);
    assert.equal(h.store.state(h.source()).staleAfterMs, 132_000, 'waiting protection does not extend snapshot freshness');
  }
  for (const arrival of [4 * MIN + 50_000, 6 * MIN]) {
    const h = hub(t);
    h.ask(0);
    h.deliver(0);
    h.frequency(900_000, 3 * MIN);
    assert.equal(h.duty.until(ACCOUNT), T + 348_000, 'the silent setting write grants no protection');
    assert.equal(h.deliver(arrival, {observed: 0}).duplicates, 1);
    assert.equal(h.duty.until(ACCOUNT), T + (arrival < 5 * MIN ? 16 * MIN : 348_000), 'only a word within the bounded delivery window restores protection');
    assert.equal(h.store.state(h.source()).successAt, T, 'a duplicate remains a duplicate');
  }
  const h = hub(t);
  h.ask(0);
  h.deliver(0);
  h.frequency(MIN);
  h.ask(MIN);
  h.frequency(900_000, MIN + 15_000);
  h.deliver(3 * MIN + 1, {failure: 'timeout'});
  assert.equal(h.ingest.refresh(h.source(), T + 3 * MIN + 1).value.unavailable, 'paused');
  assert.equal(h.duty.until(ACCOUNT), T + 348_000, 'a fresh failure still grants no waiting protection');
});

test('a failed first fixed measurement retries after its pause and minimum without a successful baseline', t => {
  for (const interval of [60_000, 120_000, 300_000, 900_000] as const) {
    for (const floor of [MIN, 20 * MIN]) {
      const h = hub(t);
      const source = h.store.source('codex', ACCOUNT, T);
      h.store.setMeasureInterval(source, interval);
      assert.equal(h.ask(0, floor).measure, true);
      h.deliver(5_000, {failure: 'timeout'});
      const allowed = Math.max(125_000, floor);
      assert.equal(h.ask(allowed - 1, floor).measure, false);
      const retry = h.ask(allowed, floor);
      assert.equal(retry.measure, true, 'a failed command is not a successful fixed baseline');
      assert.equal(retry.nextInMs, Math.max(interval, floor));
      assert.equal(h.store.state(source).successAt, null);
    }
    const h = hub(t);
    const source = h.store.source('codex', ACCOUNT, T);
    h.store.setMeasureInterval(source, interval);
    h.ask(0);
    assert.equal(h.ask(89_999).measure, false, 'an unanswered first command retains its retry delay');
    assert.equal(h.ask(90_000).measure, true);
  }
});


test('windowless Codex delivery restores fixed cadence after restart without a quota success',t=>{
  const h=hub(t);h.ask(0);h.deliver(0,{windowless:true,credits:'2500'});h.frequency(900_000);
  assert.equal(h.store.state(h.source()).successAt,null);
  assert.equal(h.store.state(h.source()).delivery?.at,T);
  const restarted=new Ingest(h.store,h.directory,new Duty(),new Cadence());
  const check=(at:number)=>restarted.checkin(h.credential,{...h.agent('laptop'),paced:true,subscriptions:[{provider:'codex',account:ACCOUNT,active:false}]},T+at).subscriptions[0];
  assert.equal(check(5*MIN).measure,false);assert.equal(check(15*MIN).measure,true);
});

test('late independent funds preserve the newer fixed plan and old failures cannot pause it',t=>{
  const h=hub(t);h.ask(0);h.deliver(0);h.frequency(900_000);
  h.deliver(2*MIN);const before=h.ingest.nextMeasurement(h.source(),ACCOUNT,T+3*MIN).value;
  const accepted=h.deliver(3*MIN,{observed:MIN,windowless:true,credits:'1.23'});
  assert.equal(accepted.accepted,1);assert.equal(h.store.state(h.source()).delivery?.at,T+2*MIN);
  assert.deepEqual(h.ingest.nextMeasurement(h.source(),ACCOUNT,T+3*MIN).value,before);
  h.deliver(3*MIN,{observed:MIN,failure:'failed'});
  assert.deepEqual(h.ingest.nextMeasurement(h.source(),ACCOUNT,T+3*MIN).value,before);
  const restarted=new Ingest(h.store,h.directory,new Duty(),new Cadence());
  restarted.accept(h.credential,{...h.agent('laptop'),sentAt:iso(3*MIN),snapshots:[],failures:[{provider:'codex',error:'not_logged_in',observedAt:iso(MIN)}]},T+3*MIN);
  assert.equal(restarted.checkin(h.credential,{...h.agent('laptop'),paced:true,subscriptions:[{provider:'codex',account:ACCOUNT,active:false}]},T+17*MIN).subscriptions[0].measure,true);
});

test('nonadvancing accepted credits clear only their sender\'s older pause', t => {
  for (const sender of ['laptop', 'server']) for (const observed of [50_000, 90_000]) {
    const h = hub(t);
    h.ask(0); h.deliver(0);
    h.deliver(MIN, {failure:'timeout'});
    h.deliver(150_000, {name:'server'});
    assert.equal(h.cadence.pausedUntil(ACCOUNT,h.device(),T+160_000),T+3*MIN);
    assert.equal(h.deliver(160_000, {name:sender,observed,windowless:true,credits:'1.23'}).accepted,1);
    const cleared = sender === 'laptop' && observed > MIN;
    assert.equal(h.cadence.pausedUntil(ACCOUNT,h.device(),T+160_000),cleared ? null : T+3*MIN);
    assert.deepEqual(h.store.state(h.source()).delivery,{at:T+150_000,staleAfterMs:348_000});
  }
});

test('duplicate quota data and independent credits do not stretch Auto speed', t => {
  const h = hub(t);
  h.ask(0); h.deliver(0);
  h.deliver(MIN); h.ask(MIN);
  const expected = {next:T+5*MIN,why:'idle'};
  assert.deepEqual(h.ingest.nextMeasurement(h.source(),ACCOUNT,T+MIN).value,expected);
  assert.equal(h.deliver(MIN+15_000,{observed:MIN}).duplicates,1);
  assert.deepEqual(h.ingest.nextMeasurement(h.source(),ACCOUNT,T+MIN+15_000).value,expected);
  assert.equal(h.deliver(MIN+30_000,{observed:MIN,credits:'1.23'}).accepted,1);
  assert.deepEqual(h.ingest.nextMeasurement(h.source(),ACCOUNT,T+MIN+30_000).value,expected);
});
