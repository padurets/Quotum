import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../config.js';
import type {Origin} from '../domain/ingest.js';
import {agentTime, workTime, type Stretch} from '../domain/work.js';
import {CREDIT_MS, KEEP_MS, Sessions, type LiveSession} from '../sessions.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';

const start = 1_800_000_000_000;
const minute = 60_000;
const second = 1_000;

/** A hub's store with Ann's laptop and Bob's server. */
function setup() {
  const store = new Store(':memory:', start);
  const directory = new Directory(store.db);
  const person = (name: string) => directory.createUser(`${name}@example.com`, name, 'x', start).id;
  const [ann, bob] = [person('ann'), person('bob')];
  const machine = (user: string, name: string) =>
    directory.saveDevice({userId: user, machine: {id: `${name}-0123456789`, name, os: 'linux', arch: 'x86_64'}, agent: 'quotum/0.4.0', tokenId: null}, start).id;
  return {store, live: new Sessions(store), ann, bob, laptop: machine(ann, 'laptop'), server: machine(bob, 'server')};
}

type Given = {source?: string; working?: boolean; project?: string | null; folder?: string | null; startedAt?: number; origin?: Origin};

/** A session as a machine's report brings it, started an hour before the tests begin unless said. */
const session = (device: string, {source = 'codex:1', working = true, project = null, folder = null, startedAt = start - 3_600_000, origin = 'terminal'}: Given = {}) => ({
  source,
  device: {id: device, name: device},
  origin,
  project,
  folder,
  startedAt: startedAt + 7_000,
  sentStartedAt: startedAt,
  lastWorkedAt: null,
  working,
}) satisfies LiveSession & {source: string};

/** What each stretch was, in seconds from the start. */
const seconds = (stretches: Stretch[]) => stretches.map(s => [s.project, s.folder, (s.from - start) / second, (s.to - start) / second]);
const all = (store: Store) => store.agentWork(0, Number.MAX_SAFE_INTEGER);
const count = (store: Store, table: string) => (store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n: number}).n;

test('each session keeps when it worked; agent time adds up by any group, and the time any worked counts overlaps once', () => {
  const {store, live, ann, bob, laptop, server} = setup();
  const quotum = session(laptop, {project: 'quotum'});
  const feature = session(laptop, {project: 'quotum', folder: 'quotum.feat'});
  const billing = session(laptop, {project: 'billing'});
  const docs = session(laptop, {project: 'docs', working: false});
  const nowhere = session(laptop);
  const claude = session(laptop, {source: 'claude:1', project: 'quotum'});
  const before = [quotum, feature, billing, docs, nowhere, claude];
  const after = [quotum, feature, nowhere];
  live.report(laptop, ann, before, start);
  live.report(server, bob, [session(server, {project: 'quotum'})], start + minute);
  live.report(laptop, ann, before, start + 2 * minute);
  live.report(server, bob, [], start + 3 * minute);
  live.report(laptop, ann, after, start + 4 * minute);
  // Quiet for longer than a list counts, then gone quiet for good.
  live.report(laptop, ann, after, start + 10 * minute);
  live.sweep(start + 10 * minute + KEEP_MS + 1);

  const credit = CREDIT_MS / second;
  const stretches = all(store);
  const on = (source: string, device: string) => seconds(stretches.filter(s => s.source === source && s.device === device));
  assert.deepEqual(on('codex:1', laptop), [
    ['quotum', null, 0, 240 + credit],
    ['quotum', null, 600, 600 + credit],
    ['quotum', 'quotum.feat', 0, 240 + credit],
    ['quotum', 'quotum.feat', 600, 600 + credit],
    ['billing', null, 0, 240],
    [null, null, 0, 240 + credit],
    [null, null, 600, 600 + credit],
  ]);
  assert.deepEqual(on('codex:1', server), [['quotum', null, 60, 180]]);
  assert.deepEqual(on('claude:1', laptop), [['quotum', null, 0, 240]]);
  assert.ok(stretches.every(s => s.user === (s.device === laptop ? ann : bob)));

  const byProject = agentTime(stretches, s => `${s.source} ${s.device === laptop ? 'laptop' : 'server'} ${s.project}`);
  const each = (240 + 2 * credit) * second;
  assert.deepEqual(
    Object.fromEntries(byProject),
    {
      'codex:1 laptop quotum': 2 * each,
      'codex:1 laptop billing': 240 * second,
      'codex:1 laptop null': each,
      'codex:1 server quotum': 120 * second,
      'claude:1 laptop quotum': 240 * second,
    },
    'two agents at once count twice',
  );
  const bySource = agentTime(stretches, s => s.source);
  assert.equal(bySource.get('codex:1'), [...byProject].filter(([key]) => key.startsWith('codex:1')).reduce((sum, [, ms]) => sum + ms, 0), 'the parts add up to the whole');
  const codex = stretches.filter(s => s.source === 'codex:1');
  assert.equal(workTime(codex), (240 + 2 * credit) * second, "the server's two minutes fall within the laptop's");
  assert.equal(workTime(codex.filter(s => s.user === bob)), 120 * second, "Bob's alone");
  store.close();
});

test('lists in a row lengthen one stretch; a gap longer than a list counts starts another', () => {
  const {store, live, ann, laptop} = setup();
  const list = [session(laptop, {project: 'quotum'})];
  for (const at of [0, 120, 240]) live.report(laptop, ann, list, start + at * second);
  assert.equal(count(store, 'agent_work'), 1);
  // Quiet for longer than a list counts, but not long enough to be forgotten.
  live.report(laptop, ann, list, start + 490 * second);
  live.report(laptop, ann, [], start + 520 * second);
  // Gone quiet, then back.
  live.report(laptop, ann, list, start + 600 * second);
  live.report(laptop, ann, [], start + 660 * second);
  assert.deepEqual(seconds(all(store)), [
    ['quotum', null, 0, 240 + CREDIT_MS / second],
    ['quotum', null, 490, 520],
    ['quotum', null, 600, 660],
  ]);
  assert.equal(count(store, 'agent_sessions'), 1);
  store.close();
});

test("a hub's clock set back credits nothing twice", () => {
  const {store, live, ann, laptop} = setup();
  const list = [session(laptop, {project: 'quotum'})];
  for (const at of [0, 120, 60, 180]) live.report(laptop, ann, list, start + at * second);
  live.report(laptop, ann, [], start + 240 * second);
  assert.deepEqual(seconds(all(store)), [['quotum', null, 0, 240]]);
  // Set back by an hour, then quiet: the list goes as any does, however far back the clock went.
  live.report(laptop, ann, list, start + 300 * second);
  const back = start + 300 * second - 3_600_000;
  live.report(laptop, ann, list, back);
  assert.equal(live.of('codex:1', [ann], back + KEEP_MS - second).length, 1);
  live.sweep(back + KEEP_MS + second);
  assert.deepEqual(live.of('codex:1', [ann], back + KEEP_MS + second), [], 'gone from the board');
  assert.deepEqual(seconds(all(store)), [['quotum', null, 0, 240]], 'nothing credited twice');
  store.close();
});

test('a clock set back after the hub forgot a machine credits nothing twice either', () => {
  const {store, live, ann, laptop} = setup();
  const list = [session(laptop, {project: 'quotum'})];
  live.report(laptop, ann, list, start);
  live.report(laptop, ann, list, start + 120 * second);
  // Quiet long enough to be forgotten, as after a restart of the hub; then the clock goes back.
  live.sweep(start + 20 * minute);
  for (const at of [60, 180, 300, 420]) live.report(laptop, ann, list, start + at * second);
  live.report(laptop, ann, [], start + 540 * second);
  assert.deepEqual(seconds(all(store)), [['quotum', null, 0, 540]], 'the time before 320 s once, then on');
  store.close();
});

test('a clock set back before anything was credited loses only the list it came back to', () => {
  const {store, live, ann, laptop} = setup();
  const list = [session(laptop, {project: 'quotum'})];
  // The hub's first list three hours ahead, then its clock is put right.
  live.report(laptop, ann, list, start + 3 * 3_600_000);
  for (let at = 0; at <= 10; at += 2) live.report(laptop, ann, list, start + at * minute);
  live.report(laptop, ann, [], start + 11 * minute);
  assert.deepEqual(seconds(all(store)), [['quotum', null, 0, 660]]);
  store.close();
});

test('a clock that ran ahead for a while costs its sessions at most as much as it ran ahead', () => {
  const {store, live, ann, laptop} = setup();
  const list = [session(laptop, {project: 'quotum'})];
  const ahead = 30 * minute;
  live.report(laptop, ann, list, start + ahead);
  live.report(laptop, ann, list, start + ahead + 2 * minute);
  // Put right: the session goes on from where its time ends, the time shown before as it was.
  for (let at = 0; at <= 60; at += 2) live.report(laptop, ann, list, start + at * minute);
  live.report(laptop, ann, [], start + 61 * minute);
  assert.deepEqual(seconds(all(store)), [['quotum', null, 30 * 60, 61 * 60]]);
  store.close();
});

test('idle agents are not credited', () => {
  const {store, live, ann, laptop} = setup();
  live.report(laptop, ann, [session(laptop, {project: 'quotum', working: false})], start);
  live.report(laptop, ann, [], start + minute);
  assert.deepEqual(all(store), []);
  assert.equal(count(store, 'agent_sessions'), 0);
  store.close();
});

test('a session without a project counts as none; one from an older agent, under the name it sends', () => {
  const {store, live, ann, laptop} = setup();
  const list = [
    session(laptop, {startedAt: start - 3}),
    session(laptop, {project: 'hub', startedAt: start - 2}),
    session(laptop, {folder: 'scratch', startedAt: start - 1}),
  ];
  live.report(laptop, ann, list, start);
  live.report(laptop, ann, [], start + minute);
  assert.deepEqual(seconds(all(store)), [
    [null, null, 0, 60],
    ['hub', null, 0, 60],
    [null, 'scratch', 0, 60],
  ]);
  store.close();
});

test('a session that changes project, folder or subscription is a session of its own', () => {
  const {store, live, ann, laptop} = setup();
  const lists = [
    session(laptop, {project: 'quotum'}),
    session(laptop, {project: 'quotum', folder: 'hub'}),
    session(laptop, {project: 'billing', folder: 'hub'}),
    session(laptop, {project: 'billing', folder: 'hub', source: 'claude:1'}),
    session(laptop, {project: 'billing', folder: 'hub', source: 'claude:1', origin: 'editor'}),
  ];
  lists.forEach((one, i) => live.report(laptop, ann, [one], start + i * minute));
  live.report(laptop, ann, [], start + lists.length * minute);
  assert.equal(count(store, 'agent_sessions'), lists.length);
  assert.deepEqual(
    all(store).map(s => [s.source, s.origin, s.project, s.folder, (s.from - start) / minute]),
    [
      ['codex:1', 'terminal', 'quotum', null, 0],
      ['codex:1', 'terminal', 'quotum', 'hub', 1],
      ['codex:1', 'terminal', 'billing', 'hub', 2],
      ['claude:1', 'terminal', 'billing', 'hub', 3],
      ['claude:1', 'editor', 'billing', 'hub', 4],
    ],
  );
  store.close();
});

test('agents alike in everything, started together, are each credited', () => {
  const {store, live, ann, laptop} = setup();
  const twins = [session(laptop, {project: 'quotum'}), session(laptop, {project: 'quotum'})];
  live.report(laptop, ann, twins, start);
  live.report(laptop, ann, twins, start + minute);
  live.report(laptop, ann, [], start + 2 * minute);
  assert.equal(count(store, 'agent_sessions'), 2);
  const stretches = all(store);
  assert.deepEqual(seconds(stretches), [
    ['quotum', null, 0, 120],
    ['quotum', null, 0, 120],
  ]);
  assert.equal(agentTime(stretches, s => s.source).get('codex:1'), 4 * minute);
  assert.equal(workTime(stretches), 2 * minute);
  store.close();
});

test('work is read for a period, cut to it, and for the subscriptions asked', () => {
  const {store, live, ann, laptop} = setup();
  const list = [session(laptop, {project: 'quotum'}), session(laptop, {project: 'quotum', source: 'claude:1'})];
  for (const at of [0, 2, 4]) live.report(laptop, ann, list, start + at * minute);
  live.report(laptop, ann, [], start + 5 * minute);
  const read = store.agentWork(start + minute, start + 3 * minute, ['codex:1']);
  assert.deepEqual(
    read.map(s => [s.source, (s.from - start) / minute, (s.to - start) / minute]),
    [['codex:1', 1, 3]],
  );
  assert.deepEqual(store.agentWork(start + 5 * minute, start + 6 * minute), [], 'nothing after');
  store.close();
});

test('old work and the sessions left without any are forgotten; names people gave their projects stay', () => {
  const {store, live, ann, laptop} = setup();
  const now = start + (config.retention.sampleDays + 1) * 86_400_000;
  const cutoff = now - config.retention.sampleDays * 86_400_000;
  live.report(laptop, ann, [session(laptop, {project: 'old'})], start);
  live.report(laptop, ann, [], start + minute);
  // Across the edge of what is kept: kept, for its part within.
  live.report(laptop, ann, [session(laptop, {project: 'across'})], cutoff - minute);
  live.report(laptop, ann, [session(laptop, {project: 'new'})], start + 50 * 86_400_000);
  live.report(laptop, ann, [], start + 50 * 86_400_000 + minute);
  store.db.prepare('INSERT INTO project_names VALUES (?, ?, ?)').run(ann, 'old', 'older');
  store.prune(now);
  assert.deepEqual(all(store).map(s => s.project), ['across', 'new']);
  assert.deepEqual(
    store.agentWork(cutoff, now).map(s => [s.project, s.from - cutoff]),
    [
      ['across', 0],
      ['new', 49 * 86_400_000],
    ],
  );
  assert.equal(count(store, 'agent_sessions'), 2);
  assert.equal(count(store, 'project_names'), 1);
  store.close();
});

test('a machine gone quiet is credited for a short while, whether or not it is swept first', () => {
  for (const swept of [false, true]) {
    const {store, live, ann, laptop} = setup();
    live.report(laptop, ann, [session(laptop)], start);
    assert.equal(live.of('codex:1', [ann], start + KEEP_MS).length, 1);
    if (swept) live.sweep(start + 10 * minute);
    live.report(laptop, ann, [session(laptop)], start + 60 * minute);
    live.report(laptop, ann, [], start + 61 * minute);
    assert.equal(agentTime(all(store), s => s.source).get('codex:1'), CREDIT_MS + minute, swept ? 'swept' : 'reported again');
    store.close();
  }
});

test("a board shows the sessions of those who show the subscription on it, each project as its person named it; a device taken off, none", () => {
  const {store, live, ann, bob, laptop, server} = setup();
  live.report(laptop, ann, [session(laptop, {project: 'quotum', folder: 'quotum.feat'})], start);
  live.report(server, bob, [session(server, {project: 'quotum', working: false})], start);
  store.db.prepare('INSERT INTO project_names VALUES (?, ?, ?)').run(ann, 'quotum', 'core');
  assert.deepEqual(live.of('codex:1', [ann], start).map(s => s.device.id), [laptop]);
  assert.deepEqual(
    live.of('codex:1', [ann, bob], start).map(s => [s.device.id, s.project, s.folder]),
    [
      [laptop, 'core', 'quotum.feat'],
      [server, 'quotum', null],
    ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
    "Ann's name for her project; Bob's as his machine reports it",
  );
  // In the project's own folder the agent tells no folder: renamed, the reported name shows where it works.
  live.report(laptop, ann, [session(laptop, {project: 'quotum'}), session(laptop, {project: 'billing'})], start + 1);
  assert.deepEqual(
    live.of('codex:1', [ann], start + 1).map(s => [s.project, s.folder]),
    [
      ['core', 'quotum'],
      ['billing', null],
    ],
  );
  live.forget([laptop]);
  assert.deepEqual(live.of('codex:1', [ann, bob], start).map(s => s.device.id), [server]);
  store.close();
});
