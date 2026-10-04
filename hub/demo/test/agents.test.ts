import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ALWAYS, MIN, lastOn, machineInfo, sessionsAt, type Agent, type DemoSet, type Machine, type Wave} from '../model.js';
import {Person} from '../client.js';
import {seedWork, type Stand} from '../setup.js';
import {parseSessions} from '../../server/domain/ingest.js';
import {Sessions} from '../../server/sessions.js';
import {Directory} from '../../server/store/directory.js';
import {Store} from '../../server/store/store.js';

test('the last work of a wave stays fixed throughout its idle part, including before the demo starts', () => {
  const wave: Wave = {period: 1000, on: 200, phase: 100};
  assert.equal(lastOn(wave, 100), 100);
  assert.equal(lastOn(wave, 299), 299);
  assert.equal(lastOn(wave, 300), 299);
  assert.equal(lastOn(wave, 1000), 299);
  assert.equal(lastOn(wave, -1), -701);
  assert.equal(lastOn({...wave, on: 0}, 100), null);
  assert.equal(lastOn(ALWAYS, -1000), -1000);
});

test('demo sessions omit last work while working and when no work was seen after their start', () => {
  const set: DemoSet = {id: 'test', about: '', scene: '', entries: [{
    kind: 'card', id: 'test', provider: 'codex', plan: '', machines: ['machine'], history: 0, windows: [], expect: [],
    agents: [
      {machine: 'machine', origin: 'terminal', project: 'idle', since: 0, works: {period: 1000, on: 200, phase: 0}},
      {machine: 'machine', origin: 'editor', project: 'working', since: 0, works: ALWAYS},
      {machine: 'machine', origin: 'app', project: 'unseen', since: 300, works: {period: 1000, on: 200, phase: 0}},
      {machine: 'machine', origin: 'terminal', project: 'never', since: 0},
    ],
  }]};
  const read = (t: number) => sessionsAt(set, {kind: 'machine', id: 'machine', expect: []}, 10_000, t);
  assert.deepEqual(read(400).map(s => s.lastWorkedAt), [new Date(10_199).toISOString(), undefined, undefined, undefined]);
  assert.deepEqual(read(800), read(400));
});

test('synthetic IDs are assigned before presence and work filters, even for identical twins', () => {
  const set: DemoSet = {id: 'identity', about: '', scene: '', entries: [{
    kind: 'card', id: 'twins', provider: 'codex', plan: '', machines: ['machine'], history: 0, windows: [], expect: [],
    agents: [
      {machine: 'machine', origin: 'terminal', project: 'same', since: 0, until: 200, works: ALWAYS},
      {machine: 'machine', origin: 'terminal', project: 'same', since: 0, works: {period: 1000, on: 100, phase: 0}},
      {machine: 'machine', origin: 'terminal', project: 'old', since: 0, legacy: true},
    ],
  }]};
  const read = (t: number) => sessionsAt(set, {kind: 'machine', id: 'machine', expect: []}, 10_000, t);
  const [a, b, old] = read(0);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.match(b.sessionId!, /^[0-9a-f]{32}$/);
  assert.equal(read(400)[0].sessionId, b.sessionId, 'the survivor keeps its ID while idle and after a twin exits');
  assert.equal(read(1000)[0].sessionId, b.sessionId, 'working again keeps its ID');
  assert.equal(old.sessionId, null);
});


test('seeded parallel stable and legacy work equals chronological reports in either order', () => {
  const start = 1_800_000_000_000;
  const machine: Machine = {kind: 'machine', id: 'machine', expect: []};
  for (const staggered of [false, true]) {
    for (const reversed of [false, true]) {
      const agents: Agent[] = [
        {machine: machine.id, origin: 'terminal', project: 'same', since: staggered ? -6 * MIN : -3 * MIN, until: staggered ? -MIN : undefined, works: ALWAYS},
        {machine: machine.id, origin: 'terminal', project: 'same', since: staggered ? -4 * MIN : -3 * MIN, works: ALWAYS, legacy: true},
      ];
      if (reversed) agents.reverse();
      const span = staggered ? 6 * MIN : 3 * MIN;
      const set: DemoSet = {id: 'mixed', about: '', scene: '', workHistoryMs: span, entries: [
        {kind: 'person', id: 'person', name: 'Person', expect: []},
        {kind: 'card', id: 'card', provider: 'codex', plan: '', machines: [machine.id], history: span, windows: [], expect: [], agents},
      ]};
      const fixtures = [false, true].map(() => {
        const store = new Store(':memory:', start - span);
        const directory = new Directory(store.db);
        const user = directory.createUser('person@example.com', 'Person', 'fixture', start - span);
        const device = directory.saveDevice({userId: user.id, machine: machineInfo(machine), agent: 'quotum-demo/1', tokenId: null}, start - span).id;
        const stand: Stand = {set, start, people: new Map([['person', new Person('', user.id, '', '')]]), boards: new Map(), agents: new Map(), sources: new Map([['card', 'codex:fixture']])};
        return {store, user, device, stand, live: new Sessions(store)};
      });
      const [seeded, reported] = fixtures;
      const report = (fixture: typeof seeded, t: number) => {
        const parsed = parseSessions({version: 1, agent: 'quotum-demo/1', machine: machineInfo(machine), sentAt: new Date(start + t).toISOString(), sessions: sessionsAt(set, machine, start, t)});
        fixture.live.report(fixture.device, fixture.user.id, parsed.sessions.map(({provider: _provider, account: _account, accountName: _accountName, ...session}) => ({
          ...session, sentStartedAt: session.startedAt, source: 'codex:fixture', device: {id: fixture.device, name: machine.id},
        })), start + t);
      };
      try {
        seedWork(seeded.store, seeded.stand);
        for (let t = -span; t <= 0; t += MIN) report(reported, t);
        const rows = (store: Store) => store.db.prepare(
          'SELECT producer_id, ordinal, started_at, project, folder, from_at, to_at FROM agent_sessions s JOIN agent_work w ON w.session_id=s.id ORDER BY producer_id, ordinal, from_at',
        ).all();
        assert.deepEqual(rows(seeded.store), rows(reported.store), `staggered=${staggered}, reversed=${reversed}`);
        const totals = seeded.store.db.prepare('SELECT producer_id IS NULL AS legacy, sum(to_at-from_at) AS ms FROM agent_sessions s JOIN agent_work w ON w.session_id=s.id GROUP BY producer_id IS NULL ORDER BY legacy').all();
        assert.deepEqual(totals.map(row => [row.legacy, row.ms]), [[0, (staggered ? 5 : 3) * MIN], [1, (staggered ? 4 : 3) * MIN]]);
        report(seeded, 0);
        assert.deepEqual(seeded.live.of('codex:fixture', [seeded.user.id], start).map(session => session.workedMs), reported.live.of('codex:fixture', [reported.user.id], start).map(session => session.workedMs), 'seed and live counters agree');
      } finally {
        for (const fixture of fixtures) fixture.store.close();
      }
    }
  }
});
