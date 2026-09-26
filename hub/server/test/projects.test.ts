import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildApp} from '../api.js';
import {Duty} from '../duty.js';
import {Ingest} from '../ingest.js';
import {Pairing} from '../pairing.js';
import {ResetFeed} from '../resets.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';
import {Setup} from '../setup.js';

const SETUP = 'BCDF-GHJK';
const minute = 60_000;

/** A hub with Ann and Bob, each with machines; time is credited to them directly, from one `now`. */
async function hub() {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-projects-')), 'db.sqlite'));
  const directory = new Directory(store.db);
  const app = await buildApp({
    store,
    directory,
    resets: new ResetFeed(undefined, () => {}),
    ingest: new Ingest(store, directory, new Duty()),
    pairing: new Pairing(directory),
    setup: new Setup(true, SETUP),
    local: null,
  });
  const cookies = new Map<string, string>();
  const call = async (method: 'GET' | 'POST', url: string, options: {as?: string; body?: object} = {}) => {
    const response = await app.inject({method, url, payload: options.body, headers: options.as && cookies.get(options.as) ? {cookie: cookies.get(options.as)!} : {}});
    const set = response.headers['set-cookie'];
    if (options.as && typeof set === 'string') cookies.set(options.as, set.split(';')[0]);
    return {status: response.statusCode, body: JSON.parse(response.body)};
  };
  const person = async (as: string, invite?: string) => {
    const body = {email: `${as}@example.com`, name: as, password: 'correct horse', invite, setupCode: SETUP};
    const signup = await call('POST', '/api/auth/signup', {as, body});
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    return (await call('GET', '/api/session', {as})).body.user.id as string;
  };
  const ann = await person('ann');
  const team = (await call('POST', '/api/boards', {as: 'ann', body: {name: 'Team'}})).body.id;
  const bob = await person('bob', (await call('POST', `/api/boards/${team}/invites`, {as: 'ann'})).body.url.split('/invite/')[1]);
  const now = Date.now();
  const machine = (user: string, name: string) =>
    directory.saveDevice({userId: user, machine: {id: `${name}-0123456789`, name, os: 'linux', arch: 'x86_64'}, agent: 'quotum/0.4.0', tokenId: null}, now).id;
  const machines = {laptop: machine(ann, 'laptop'), server: machine(ann, 'build-server'), bobs: machine(bob, 'bobs-laptop')};
  /** A session on `device` working in `project` for `minutes` minutes, ending `ago` minutes before now. */
  const credit = (device: string, project: string, minutes: number, ago = 60) =>
    store.creditWork(device, now - (ago + minutes) * minute, now - ago * minute, [
      {source: 'codex:1', origin: 'terminal', startedAt: now - ago * minute, project, folder: '', ordinal: 0},
    ]);
  const projects = async (as: string) => (await call('GET', '/api/projects', {as})).body.projects;
  const name = (as: string, groups: string[], to: string) => call('POST', '/api/projects', {as, body: {groups, name: to}});
  const kept = (user: string) =>
    (store.db.prepare('SELECT reported, name FROM project_names WHERE user_id = ? ORDER BY reported').all(user) as {reported: string; name: string}[]).map(r => [r.reported, r.name]);
  /** Agent time of each person's machines by project, as read for any period. */
  const split = (user: string) => {
    const time: Record<string, number> = {};
    for (const s of store.agentWork(0, Number.MAX_SAFE_INTEGER).filter(s => s.user === user)) time[String(s.project)] = (time[String(s.project)] ?? 0) + s.to - s.from;
    return time;
  };
  return {store, call, ann, bob, machines, credit, projects, name, kept, split};
}

test("a person sees and corrects the projects of their own machines, over past and new time, and undoes it", async () => {
  const {call, ann, bob, machines, credit, projects, name, split} = await hub();
  credit(machines.laptop, 'quotum', 30, 10);
  credit(machines.server, 'Quotum', 20, 60);
  credit(machines.bobs, 'quotum', 5);
  credit(machines.bobs, 'Quotum', 7);
  const annBefore = split(ann);
  const bobBefore = split(bob);

  const listed = await call('GET', '/api/projects', {as: 'ann'});
  assert.equal(listed.body.keptDays, 90);
  assert.deepEqual(
    listed.body.projects.map((p: any) => [p.name, p.agentMs, p.machines.map((m: any) => m.name), p.reported]),
    [
      ['quotum', 30 * minute, ['laptop'], [{name: 'quotum', agentMs: 30 * minute}]],
      ['Quotum', 20 * minute, ['build-server'], [{name: 'Quotum', agentMs: 20 * minute}]],
    ],
    'the most recent first',
  );
  const names = async (as: string) => (await projects(as)).map((p: any) => p.name).sort();
  assert.deepEqual(
    (await projects('bob')).map((p: any) => [p.name, p.machines.map((m: any) => m.name)]).sort(),
    [
      ['Quotum', ['bobs-laptop']],
      ['quotum', ['bobs-laptop']],
    ].sort(),
  );

  const bobUntouched = async () => {
    assert.deepEqual(split(bob), bobBefore, "Bob's time as it was");
    assert.deepEqual(await names('bob'), ['Quotum', 'quotum'].sort());
  };
  assert.deepEqual((await name('ann', ['Quotum', 'quotum'], 'quotum')).body, {ok: true});
  const [merged] = await projects('ann');
  assert.deepEqual([merged.name, merged.agentMs, merged.machines.map((m: any) => m.name)], ['quotum', 50 * minute, ['build-server', 'laptop']]);
  assert.deepEqual(split(ann), {quotum: 50 * minute}, 'past time counts under the new name');
  credit(machines.server, 'Quotum', 3, 0);
  assert.deepEqual(split(ann), {quotum: 53 * minute}, 'and new time too');
  await bobUntouched();

  assert.deepEqual((await call('POST', '/api/projects/restore', {as: 'ann', body: {reported: ['Quotum']}})).body, {ok: true});
  assert.deepEqual(split(ann), {...annBefore, Quotum: annBefore.Quotum + 3 * minute}, 'as it was, to the millisecond');
  await bobUntouched();

  await name('ann', ['quotum'], 'core');
  assert.deepEqual(Object.keys(split(ann)).sort(), ['Quotum', 'core']);
  await name('ann', ['core'], '');
  assert.deepEqual(Object.keys(split(ann)).sort(), ['Quotum', 'quotum'], 'an empty name gives each its own back');
  await bobUntouched();
});

test("the same reported name is each person's to correct, and one's correction draws nothing of another's in", async () => {
  const {ann, bob, machines, credit, projects, name, kept, split} = await hub();
  credit(machines.laptop, 'quotum', 30);
  credit(machines.server, 'Quotum', 20);
  credit(machines.bobs, 'Quotum', 7);
  const total = () => Object.values({...split(ann), ...Object.fromEntries(Object.entries(split(bob)).map(([k, v]) => [`bob ${k}`, v]))}).reduce((a, b) => a + b, 0);
  const before = total();
  await name('ann', ['Quotum'], 'X');
  await name('bob', ['Quotum'], 'Y');
  assert.deepEqual([split(ann).X, split(bob).Y], [20 * minute, 7 * minute]);
  assert.equal(total(), before, 'the time of the subscription is the same');

  await name('bob', ['Y'], 'quotum');
  await name('ann', ['X'], 'Quotum');
  await name('ann', ['quotum'], 'core');
  assert.deepEqual(kept(ann), [['quotum', 'core']], "Bob's correction of Quotum does not make Ann's a part of her quotum");
  assert.deepEqual((await projects('ann')).map((p: any) => p.name).sort(), ['Quotum', 'core'].sort());

  // A name only Bob's machines report is no member of Ann's group of that name.
  credit(machines.laptop, 'lib', 3);
  credit(machines.bobs, 'vendor', 3);
  await name('ann', ['lib'], 'vendor');
  await name('ann', ['vendor'], 'libs');
  assert.deepEqual(kept(ann), [
    ['lib', 'libs'],
    ['quotum', 'core'],
  ]);
});

test('corrections without time are listed and move with their group; renaming a name nothing reported corrects no phantom', async () => {
  const {call, ann, machines, credit, projects, name, kept} = await hub();
  credit(machines.laptop, 'quotum', 30);
  credit(machines.laptop, 'a', 10, 100);
  // Given before any agent reported it, as a demo seeds one.
  await name('ann', ['old'], 'quotum');
  await name('ann', ['docs-site'], 'docs');
  assert.deepEqual(kept(ann), [
    ['docs-site', 'docs'],
    ['old', 'quotum'],
  ]);
  const list = await projects('ann');
  const quotum = list.find((p: any) => p.name === 'quotum');
  assert.deepEqual(quotum.reported, [
    {name: 'old', agentMs: 0},
    {name: 'quotum', agentMs: 30 * minute},
  ]);
  const docs = list.find((p: any) => p.name === 'docs');
  assert.deepEqual([docs.agentMs, docs.lastAt, docs.machines, docs.reported], [0, null, [], [{name: 'docs-site', agentMs: 0}]]);
  assert.equal(list.at(-1).name, 'docs', 'without time, after those with');

  await name('ann', ['quotum'], 'core');
  assert.deepEqual(kept(ann), [
    ['docs-site', 'docs'],
    ['old', 'core'],
    ['quotum', 'core'],
  ]);

  await name('ann', ['a'], 'X');
  await name('ann', ['X'], 'Y');
  assert.deepEqual(kept(ann).filter(([reported]) => reported === 'a' || reported === 'X'), [['a', 'Y']], 'only what was reported');
  assert.deepEqual((await projects('ann')).find((p: any) => p.name === 'Y').reported, [{name: 'a', agentMs: 10 * minute}]);

  await name('ann', ['Y'], 'a');
  assert.deepEqual(kept(ann).filter(([reported]) => reported === 'a'), [], 'a name given back its own keeps nothing');
  assert.equal((await call('GET', '/api/projects')).status, 401);
});

test('names of projects are checked as agents send them', async () => {
  const {call, name} = await hub();
  const post = (body: object, url = '/api/projects') => call('POST', url, {as: 'ann', body});
  for (const groups of [[], [''], ['x'.repeat(121)], ['a', 'a'], 'a', Array.from({length: 101}, (_, i) => `p${i}`)]) {
    assert.deepEqual((await post({groups, name: 'x'})).body, {error: 'invalid_request'}, JSON.stringify(groups).slice(0, 40));
  }
  assert.deepEqual((await post({groups: ['a']})).body, {error: 'invalid_request'}, 'a name is said, if empty');
  assert.deepEqual((await name('ann', ['a'], 'x'.repeat(121))).body, {error: 'invalid_project_name'});
  assert.deepEqual((await name('ann', ['🚀'.repeat(120)], '🚀'.repeat(120))).body, {ok: true}, 'counted in characters');
  assert.deepEqual((await name('ann', ['a'], '🚀'.repeat(121))).body, {error: 'invalid_project_name'});
  assert.deepEqual((await post({reported: []}, '/api/projects/restore')).body, {error: 'invalid_request'});
  // A hundred names at their longest, each character escaped in JSON.
  const hundred = Array.from({length: 100}, (_, i) => String(i).padStart(3, '0') + '\u0001'.repeat(117));
  assert.deepEqual((await post({groups: hundred, name: 'x'})).body, {ok: true});
  assert.deepEqual((await post({reported: hundred}, '/api/projects/restore')).body, {ok: true});
});
