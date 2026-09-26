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
