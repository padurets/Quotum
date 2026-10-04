import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {STEPS} from '../store/schema.js';
import {Store} from '../store/store.js';

/**
 * Every step a release shipped, by its hash. A database records which steps it has
 * run, so a shipped step that changes afterwards leaves databases without what it now
 * creates. A new layout is a new step: add its hash here once it is released.
 */
const RELEASED = [
  '02cb748c205697bd5af76c42c46d7bdb09ab4ec3d311a7841f89ccf552fb48ff', // 0.2
  '93bef51f9d1b8ff1ad525301dfeac3f98c87068d6211e6e02f6388bc1de4cfb2', // 0.3
  'f0137f7875aee26476d1eb2b6f010b1365475c6e8cc452e863c282c4104c729b', // 0.4
  '1fd789e182b8d729fc874051306490e42a2b6c37d36cca805ec47464fafdf999', // 0.4
  '2001aa53d351ad58d717191dea8ada0028145647b8372751d54edf73e50c84bf', // 0.5
  '9ff26257825602cd24c4e8b209e8ff9ac70a8713dbc9697720c3b1d0a50d1748', // 0.5
];

test('released layout steps never change; new ones come after them', () => {
  const hashes = STEPS.map(step => createHash('sha256').update(step).digest('hex'));
  assert.deepEqual(hashes.slice(0, RELEASED.length), RELEASED);
});

test("a hub of 0.3 drops the sums of agents' work and keeps how they work from the upgrade on", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'quotum-schema-')), 'db.sqlite');
  const [made, upgraded] = [1_790_000_000_000, 1_800_000_000_000];
  const old = new DatabaseSync(file);
  for (const step of STEPS.slice(0, 2)) old.exec(step);
  old.exec('PRAGMA user_version = 2');
  old.prepare('INSERT INTO meta VALUES (?, ?)').run('historyStart', String(made));
  old.prepare('INSERT INTO work VALUES (?, ?, ?, ?)').run('codex:1', made, 60_000, 60_000);
  old.close();

  const store = new Store(file, upgraded);
  const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {name: string}[]).map(t => t.name);
  assert.ok(!tables.includes('work'));
  assert.ok(['agent_sessions', 'agent_work', 'project_names'].every(t => tables.includes(t)));
  assert.equal(store.agentWorkSince(), upgraded);
  assert.equal(store.historyStart(upgraded), made, 'history itself goes back as far as before');
  store.close();

  const fresh = new Store(':memory:', upgraded);
  assert.equal(fresh.agentWorkSince(), fresh.historyStart(upgraded));
  fresh.close();
});

test('identity migration preserves exact legacy session IDs, keys and intervals', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'quotum-identity-schema-')), 'db.sqlite');
  const old = new DatabaseSync(file);
  for (const step of STEPS.slice(0, 7)) old.exec(step);
  old.exec('PRAGMA user_version = 7');
  old.exec("INSERT INTO agent_sessions VALUES (42, 'device', 'codex:1', 'terminal', 123, 'P', 'wt', 3), (97, 'device', 'codex:2', 'app', 456, '', '', 0)");
  old.exec('INSERT INTO agent_work VALUES (42, 1000, 2000), (42, 3000, 4000), (97, 1500, 3500)');
  const sessions = old.prepare('SELECT * FROM agent_sessions ORDER BY id').all();
  const work = old.prepare('SELECT * FROM agent_work ORDER BY session_id, from_at').all();
  old.close();
  const store = new Store(file, 5000);
  assert.deepEqual(store.db.prepare('SELECT id, device_id, source_id, origin, started_at, project, folder, ordinal FROM agent_sessions ORDER BY id').all(), sessions);
  assert.deepEqual(store.db.prepare('SELECT * FROM agent_work ORDER BY session_id, from_at').all(), work);
  assert.deepEqual(store.db.prepare('SELECT producer_id FROM agent_sessions').all().map(row => row.producer_id), [null, null]);
  assert.match(String(store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM agent_sessions WHERE device_id='device' AND source_id='codex:1' AND started_at=123 AND origin='terminal' AND project='P' AND folder='wt' AND ordinal=3 AND producer_id IS NULL").get()!.detail), /agent_sessions_legacy_key/);
  assert.match(String(store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM agent_sessions WHERE device_id='device' AND producer_id='abc' AND source_id='codex:1' AND origin='terminal' AND project='P' AND folder='wt'").get()!.detail), /agent_sessions_stable_key/);
  store.close();
});
