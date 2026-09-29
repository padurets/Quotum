import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Ingest, type Credential} from '../ingest.js';
import {Invalid} from '../domain/ingest.js';
import {newSecret} from '../domain/auth.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';

const MIN = 60_000;
const t0 = Date.parse('2026-09-22T12:00:00Z');

test('the first device to ask measures; the others wait and are told when to ask again', () => {
  const duty = new Duty();
  assert.deepEqual(duty.claim('acc', 'laptop', false, t0), {measure: true, until: t0});
  const waiting = duty.claim('acc', 'server', false, t0 + 1000);
  assert.equal(waiting.measure, false);
  assert.equal(waiting.until, t0 + 5 * MIN, 'until the holder’s first lease runs out');
  assert.equal(duty.claim('acc', 'laptop', false, t0 + 2 * MIN).measure, true, 'the holder keeps measuring');
  assert.equal(duty.claim('other', 'server', false, t0).measure, true, 'another subscription has its own duty');
});

test('duty sticks while the holder delivers, and passes on when it goes quiet', () => {
  const duty = new Duty();
  duty.claim('acc', 'laptop', false, t0);
  duty.delivered('acc', 'laptop', t0 + 10_000, 204_000, t0 + 11_000);
  const lease = t0 + 10_000 + 204_000;
  assert.deepEqual(duty.claim('acc', 'server', false, t0 + MIN), {measure: false, until: lease});
  // The laptop sleeps: nothing arrives, the lease runs out, the server takes over.
  assert.equal(duty.claim('acc', 'server', false, lease + 1).measure, true);
  assert.equal(duty.holder('acc'), 'server');
  assert.equal(duty.claim('acc', 'laptop', false, lease + MIN).measure, false, 'the old holder now waits');
});

test('a holder told to measure keeps duty while it does, until it answers', () => {
  for (const answer of ['delivery', 'failure', 'old delivery'] as const) {
    const duty = new Duty();
    duty.claim('acc', 'laptop', false, t0);
    duty.delivered('acc', 'laptop', t0, 132_000, t0);
    duty.asked('acc', 'laptop', t0 + MIN);
    assert.equal(duty.until('acc'), t0 + 6 * MIN, 'five minutes after the command, past its measurement going stale');
    assert.equal(duty.claim('acc', 'server', false, t0 + 3 * MIN).measure, false, 'no one takes over halfway');
    const at = t0 + 3 * MIN;
    if (answer === 'delivery') duty.delivered('acc', 'laptop', at, 132_000, at);
    else if (answer === 'failure') duty.failed('acc', 'laptop', at);
    // A measurement taken before the command, sent late, does not answer it.
    else duty.delivered('acc', 'laptop', t0 + 20_000, 132_000, at);
    const kept = answer === 'old delivery' ? t0 + 6 * MIN : answer === 'delivery' ? at + 132_000 : t0 + 132_000;
    assert.equal(duty.until('acc'), kept);
  }
  // Only the holder is told: another device asking does not move the lease.
  const duty = new Duty();
  duty.claim('acc', 'laptop', false, t0);
  duty.asked('acc', 'server', t0 + MIN);
  assert.equal(duty.until('acc'), t0 + 5 * MIN);
});

test('a holder measuring what it was told to is done once it answers within the clock tolerance, or asks again', () => {
  const told = () => {
    const duty = new Duty();
    duty.claim('acc', 'laptop', false, t0);
    duty.delivered('acc', 'laptop', t0, 132_000, t0);
    duty.asked('acc', 'laptop', t0 + MIN);
    return duty;
  };
  for (const [kind, at, done] of [['failure', t0 + 30_000, true], ['failure', t0 + 29_999, false], ['delivery', t0 + 30_000, true], ['delivery', t0 + 29_999, false]] as const) {
    const duty = told();
    if (kind === 'failure') duty.failed('acc', 'laptop', at);
    else duty.delivered('acc', 'laptop', at, 132_000, t0 + 2 * MIN);
    assert.equal(duty.until('acc') === t0 + 6 * MIN, !done, `${kind} taken at ${at - t0}`);
  }
  // Another device's measurement does not take duty from a holder measuring.
  const other = told();
  other.delivered('acc', 'server', t0 + 3 * MIN, 132_000, t0 + 3 * MIN);
  assert.equal(other.holder('acc'), 'laptop');
  // A waiting device is told to come back when the holder is done at the latest.
  assert.deepEqual(told().claim('acc', 'server', false, t0 + 3 * MIN), {measure: false, until: t0 + 6 * MIN});
  // Nor does a device in use take over halfway; once the holder asks again, it may.
  const busy = told();
  assert.equal(busy.claim('acc', 'server', true, t0 + 2 * MIN).measure, false);
  busy.claim('acc', 'laptop', false, t0 + 2 * MIN + 15_000);
  assert.equal(busy.claim('acc', 'server', true, t0 + 2 * MIN + 16_000).measure, true, 'asking again, it is done measuring');
});

test('a holder that asks again without answering keeps duty no longer than the devices waiting were told, and its retries keep none', () => {
  // Told before its measurement goes stale: the others come back then, as if it were not measuring.
  const early = new Duty();
  early.claim('acc', 'laptop', false, t0);
  early.delivered('acc', 'laptop', t0, 204_000, t0);
  early.asked('acc', 'laptop', t0 + MIN);
  assert.deepEqual(early.claim('acc', 'server', false, t0 + MIN + 1_000), {measure: false, until: t0 + 204_000});
  early.claim('acc', 'laptop', false, t0 + 150_000);
  early.asked('acc', 'laptop', t0 + 150_000);
  assert.equal(early.until('acc'), t0 + 204_000, 'the retry of a command left unanswered keeps no duty');
  assert.equal(early.claim('acc', 'server', false, t0 + 204_000).measure, true);

  // Told after it went stale, and a device waits for the five minutes to end: the holder keeps
  // duty until then, taking no new lease first, and not past it.
  const late = new Duty();
  late.claim('acc', 'laptop', false, t0);
  late.delivered('acc', 'laptop', t0, 132_000, t0);
  late.asked('acc', 'laptop', t0 + 3 * MIN);
  assert.deepEqual(late.claim('acc', 'server', false, t0 + 3 * MIN + 1_000), {measure: false, until: t0 + 8 * MIN});
  for (let at = t0 + 4 * MIN; at < t0 + 8 * MIN; at += 15_000) {
    late.claim('acc', 'laptop', false, at);
    late.asked('acc', 'laptop', at);
    assert.equal(late.until('acc'), t0 + 8 * MIN, `at ${(at - t0) / 1000} s`);
  }
  assert.equal(late.claim('acc', 'server', false, t0 + 8 * MIN).measure, true);

  // Retried after asking with nothing to show, it measures the retry without asking: that keeps
  // it no duty either, from a device waiting nor from one where someone works.
  const retried = (device: string, active: boolean, at: number) => {
    const duty = new Duty();
    duty.claim('acc', 'laptop', false, t0);
    duty.delivered('acc', 'laptop', t0, 204_000, t0);
    duty.asked('acc', 'laptop', t0 + MIN);
    duty.claim('acc', 'laptop', false, t0 + 75_000);
    duty.claim('acc', 'laptop', false, t0 + 150_000);
    duty.asked('acc', 'laptop', t0 + 150_000);
    assert.equal(duty.until('acc'), t0 + 204_000);
    return duty.claim('acc', device, active, at).measure;
  };
  assert.equal(retried('server', false, t0 + 204_000), true);
  assert.equal(retried('server', true, t0 + 160_000), true, 'an idle holder measuring a retry is not measuring what it was told to');

  // Nor when it took its lapsed lease again by asking first, nor when all it sends is older than the command.
  const retaken = new Duty();
  retaken.claim('acc', 'laptop', false, t0);
  retaken.delivered('acc', 'laptop', t0, 132_000, t0);
  retaken.asked('acc', 'laptop', t0 + MIN);
  retaken.claim('acc', 'laptop', false, t0 + 75_000);
  retaken.claim('acc', 'laptop', false, t0 + 150_000);
  retaken.asked('acc', 'laptop', t0 + 5 * MIN);
  assert.equal(retaken.until('acc'), t0 + 450_000, 'a new lease on asking, as any holder takes');
  assert.equal(retaken.claim('acc', 'server', true, t0 + 310_000).measure, true);
  const old = new Duty();
  old.claim('acc', 'laptop', false, t0);
  old.delivered('acc', 'laptop', t0, 132_000, t0);
  old.asked('acc', 'laptop', t0 + MIN);
  old.claim('acc', 'laptop', false, t0 + 75_000);
  old.delivered('acc', 'laptop', t0 + 20_000, 132_000, t0 + 80_000);
  old.asked('acc', 'laptop', t0 + 150_000);
  assert.equal(old.until('acc'), t0 + 152_000, 'as long as that measurement, no longer');
  // A retry replaces the command on record: what was taken before it, less the tolerance, answers neither.
  const replaced = new Duty();
  replaced.claim('acc', 'laptop', false, t0);
  replaced.delivered('acc', 'laptop', t0, 132_000, t0);
  replaced.asked('acc', 'laptop', t0 + MIN);
  replaced.claim('acc', 'laptop', false, t0 + 75_000);
  replaced.asked('acc', 'laptop', t0 + 150_000);
  replaced.delivered('acc', 'laptop', t0 + 100_000, 132_000, t0 + 160_000);
  replaced.asked('acc', 'laptop', t0 + 200_000);
  assert.equal(replaced.until('acc'), t0 + 232_000);

  // Answering again, even the command it asked past, it keeps duty while it measures once more.
  for (const [answer, at] of [['failure', 100_000], ['delivery', 100_000], ['late failure', 150_000], ['late delivery', 150_000]] as const) {
    const back = new Duty();
    back.claim('acc', 'laptop', false, t0);
    back.delivered('acc', 'laptop', t0, 132_000, t0);
    back.asked('acc', 'laptop', t0 + MIN);
    back.claim('acc', 'laptop', false, t0 + 90_000);
    // Told again at once, or asking on while its answer to the first command is under way.
    if (!answer.startsWith('late')) back.asked('acc', 'laptop', t0 + 90_000);
    if (answer.endsWith('failure')) back.failed('acc', 'laptop', t0 + at);
    else back.delivered('acc', 'laptop', t0 + at, 30_000, t0 + at);
    back.asked('acc', 'laptop', t0 + 3 * MIN);
    assert.equal(back.until('acc'), t0 + 8 * MIN, answer);
    assert.equal(back.claim('acc', 'server', true, t0 + 4 * MIN).measure, false, `${answer}: no one takes over halfway`);
  }
});

test('a holder measuring what it was told to keeps a working device off for five minutes at most', () => {
  const duty = new Duty();
  duty.claim('acc', 'laptop', false, t0);
  duty.delivered('acc', 'laptop', t0, 19 * MIN, t0);
  duty.asked('acc', 'laptop', t0 + MIN);
  // The laptop goes quiet halfway, its measurement fresh for a long while yet.
  assert.equal(duty.claim('acc', 'server', true, t0 + 6 * MIN - 1).measure, false);
  assert.equal(duty.claim('acc', 'server', true, t0 + 6 * MIN).measure, true);
  assert.equal(duty.holder('acc'), 'server');
});

test('a device in use takes duty from an idle holder, never from a busy one', () => {
  const duty = new Duty();
  duty.claim('acc', 'server', true, t0);
  duty.delivered('acc', 'server', t0, 18 * MIN, t0);
  // Someone works on the laptop, but the server was in use a minute ago: no flapping.
  const soon = duty.claim('acc', 'laptop', true, t0 + MIN);
  assert.deepEqual(soon, {measure: false, until: t0 + 2 * MIN}, 'a working device asks again in a minute');
  // Ten idle minutes on the server later, the laptop takes over.
  assert.equal(duty.claim('acc', 'laptop', true, t0 + 11 * MIN).measure, true);
  assert.equal(duty.holder('acc'), 'laptop');
});

test('a holder that keeps asking but never delivers does not keep duty', () => {
  const duty = new Duty();
  duty.claim('acc', 'broken', false, t0);
  for (let minute = 1; minute < 5; minute++) duty.claim('acc', 'broken', false, t0 + minute * MIN);
  assert.equal(duty.claim('acc', 'server', false, t0 + 4 * MIN).measure, false, 'still within its first lease');
  assert.equal(duty.claim('acc', 'server', false, t0 + 5 * MIN + 1).measure, true, 'the lease ran out despite the asking');
});

test('an idle waiting device asks again in at most ten minutes', () => {
  const duty = new Duty();
  duty.claim('acc', 'server', false, t0);
  duty.delivered('acc', 'server', t0, 18 * MIN, t0);
  assert.deepEqual(duty.claim('acc', 'laptop', false, t0 + MIN), {measure: false, until: t0 + 11 * MIN});
});

test('check-ins are resolved per subscription, the owner’s own ones included', () => {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-duty-')), 'db.sqlite'), t0);
  const directory = new Directory(store.db);
  const ingest = new Ingest(store, directory, new Duty(), new Cadence());
  const alice = directory.createUser('alice@example.com', 'Alice', 'x', t0);
  const secret = newSecret('qt_m');
  directory.createToken(secret, '…', alice.id, 'images', t0);
  const token = ingest.authenticate(`Bearer ${secret}`) as Credential;
  const checkin = (machine: string, subscriptions: object[]) =>
    ingest
      .checkin(token, {version: 1, agent: 'quotum/0.1.0', machine: {id: machine, name: machine, os: 'linux', arch: 'x86_64'}, subscriptions}, t0)
      .subscriptions.map(s => [s.provider, s.measure]);
  const subs = [
    {provider: 'claude', account: 'a1b2c3d4e5f6a1b2c3d4e5f6', active: false},
    {provider: 'antigravity', account: null, active: false},
  ];
  assert.deepEqual(checkin('machine-one-0123456789', subs), [['claude', true], ['antigravity', true]]);
  // Same person, same Claude account, same (unnamed) Antigravity: the second machine waits for both.
  assert.deepEqual(checkin('machine-two-0123456789', subs), [['claude', false], ['antigravity', false]]);
  // A differently named Antigravity subscription of the same person is separate.
  assert.deepEqual(checkin('machine-two-0123456789', [{provider: 'antigravity', account: null, accountName: 'work', active: false}]), [['antigravity', true]]);
  assert.throws(() => ingest.checkin(token, {version: 1}, t0), Invalid);
});
