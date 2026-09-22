import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../store/store.js';
import {SCHEMA_VERSION} from '../store/schema.js';
import {DEFAULT_BOARD} from '../domain/sources.js';
import type {Measurement, Win} from '../domain/quota.js';

const start = 1_800_000_000_000;
const win = (change: Partial<Win> = {}): Win => ({
  id: 'weekly',
  label: 'Weekly',
  used: 20,
  remaining: 80,
  resetAt: start + 86_400_000,
  minutes: 10080,
  ...change,
});
const measurement = (change: Partial<Measurement> = {}): Measurement => ({sourceAt: start, plan: 'Pro', windows: [win()], ...change});

test('a source appears when first seen and shows it is waiting for data', () => {
  const store = new Store(':memory:', start);
  assert.deepEqual(store.states(DEFAULT_BOARD), []);
  const id = store.source(DEFAULT_BOARD, 'codex', 'account-a', start);
  assert.deepEqual(store.states(DEFAULT_BOARD).map(s => [s.id, s.provider, s.error]), [[id, 'codex', 'waiting']]);
  store.close();
});

test('failures keep the last good values on screen', () => {
  const store = new Store(':memory:', start);
  const id = store.source(DEFAULT_BOARD, 'codex', 'account-a', start);
  store.record(id, measurement());
  store.fail(id, 'not_logged_in', start + 150_000);
  const state = store.state(id);
  assert.deepEqual([state.successAt, state.windows[0].used, state.error, state.attemptAt], [start, 20, 'not_logged_in', start + 150_000]);
  store.record(id, measurement({sourceAt: start + 240_000}));
  assert.equal(store.state(id).error, null);
  store.close();
});

test('history returns one series per source and window, in the order of the cards', () => {
  const store = new Store(':memory:', start);
  const claude = store.source(DEFAULT_BOARD, 'claude', 'account-c', start);
  const codex = store.source(DEFAULT_BOARD, 'codex', 'account-a', start);
  const windows = (used: number) => [win({used}), win({id: 'session', minutes: 300, used: used * 2, resetAt: start + 3_600_000})];
  store.record(codex, measurement({windows: windows(20)}));
  store.record(codex, measurement({sourceAt: start + 240_000, windows: windows(25)}));
  store.record(claude, measurement({windows: [win({used: 5})]}));
  const history = store.history(DEFAULT_BOARD, start - 1, 60_000);
  assert.deepEqual(
    history.map(s => [s.provider, s.bucket, s.kind, s.consumed]),
    [['claude', 'weekly', 'weekly', 0], ['codex', 'weekly', 'weekly', 5], ['codex', 'session', 'session', 10]],
  );
  assert.deepEqual(store.history('elsewhere', start - 1, 60_000), [], 'boards do not see each other');
  store.close();
});

test('every change moves the revision the history cache follows', () => {
  const store = new Store(':memory:', start);
  const before = store.revision;
  const id = store.source(DEFAULT_BOARD, 'codex', 'account-a', start);
  store.record(id, measurement());
  store.fail(id, 'timeout', start + 1);
  assert.equal(store.revision, before + 3);
  store.close();
});

test('old samples are pruned after the retention period', () => {
  const store = new Store(':memory:', start);
  const id = store.source(DEFAULT_BOARD, 'codex', 'account-a', start);
  store.record(id, measurement());
  store.record(id, measurement({sourceAt: start + 100 * 86_400_000}));
  store.prune(start + 100 * 86_400_000);
  assert.equal(store.history(DEFAULT_BOARD, 0, 60_000)[0].samples, 1);
  store.close();
});

test('a new database gets the current layout and the unnamed default board; a newer one is refused', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'quotum-')), 'db.sqlite');
  const store = new Store(file, start);
  assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as any).user_version), SCHEMA_VERSION);
  assert.deepEqual(store.db.prepare('SELECT id, name, personal FROM boards').all().map((r: any) => [r.id, r.name, r.personal]), [['default', '', 1]]);
  assert.equal(store.collectionStart, start);
  store.close();
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => new Store(file, start), /layout/);
});
