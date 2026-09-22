import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../store/store.js';
import {SCHEMA_VERSION} from '../store/schema.js';
import type {Measurement, Win} from '../domain/quota.js';

const start = 1_800_000_000_000;
const BOARD = 'board';
const win = (change: Partial<Win> = {}): Win => ({
  id: 'weekly',
  kind: 'weekly',
  label: null,
  used: 20,
  remaining: 80,
  resetAt: start + 86_400_000,
  minutes: 10080,
  ...change,
});
const measurement = (change: Partial<Measurement> = {}): Measurement => ({observedAt: start, plan: 'Pro', windows: [win()], staleAfterMs: 300_000, resets: null, ...change});

test('a source appears when first seen and shows it is waiting for data', () => {
  const store = new Store(':memory:', start);
  assert.deepEqual(store.states(BOARD), []);
  const id = store.source(BOARD, 'codex', 'account-a', start);
  assert.deepEqual(store.states(BOARD).map(s => [s.id, s.provider, s.error]), [[id, 'codex', 'waiting']]);
  store.close();
});

test('failures keep the last good values on screen', () => {
  const store = new Store(':memory:', start);
  const id = store.source(BOARD, 'codex', 'account-a', start);
  store.record(id, measurement());
  store.fail(id, 'not_logged_in');
  const state = store.state(id);
  assert.deepEqual([state.successAt, state.windows[0].used, state.error], [start, 20, 'not_logged_in']);
  store.record(id, measurement({observedAt: start + 240_000}));
  assert.equal(store.state(id).error, null);
  store.close();
});

test('history returns one series per source and window, in the order of the cards', () => {
  const store = new Store(':memory:', start);
  const claude = store.source(BOARD, 'claude', 'account-c', start);
  const codex = store.source(BOARD, 'codex', 'account-a', start);
  const windows = (used: number) => [win({used}), win({id: 'session', kind: 'session', minutes: 300, used: used * 2, resetAt: start + 3_600_000})];
  store.record(codex, measurement({windows: windows(20)}));
  store.record(codex, measurement({observedAt: start + 240_000, windows: windows(25)}));
  store.record(claude, measurement({windows: [win({used: 5})]}));
  const history = store.history(BOARD, start - 1, 60_000);
  assert.deepEqual(
    history.map(s => [s.provider, s.windowId, s.kind, s.consumed]),
    [['claude', 'weekly', 'weekly', 0], ['codex', 'weekly', 'weekly', 5], ['codex', 'session', 'session', 10]],
  );
  assert.deepEqual(store.history('elsewhere', start - 1, 60_000), [], 'boards do not see each other');
  store.close();
});

test('every change moves the revision of its board, and only of its board', () => {
  const store = new Store(':memory:', start);
  const before = store.revision(BOARD);
  const other = store.revision('other');
  const id = store.source(BOARD, 'codex', 'account-a', start);
  store.record(id, measurement());
  store.fail(id, 'timeout');
  assert.equal(store.revision(BOARD), before + 3);
  assert.equal(store.revision('other'), other);
  assert.ok(store.removeSource(BOARD, id));
  assert.equal(store.revision(BOARD), before + 4);
  assert.deepEqual([store.states(BOARD), store.history(BOARD, 0, 60_000)], [[], []], 'nothing of it is left');
  store.close();
});

test('old samples are pruned after the retention period', () => {
  const store = new Store(':memory:', start);
  const id = store.source(BOARD, 'codex', 'account-a', start);
  store.record(id, measurement());
  store.record(id, measurement({observedAt: start + 100 * 86_400_000}));
  store.prune(start + 100 * 86_400_000);
  assert.equal(store.history(BOARD, 0, 60_000)[0].samples, 1);
  store.close();
});

test('a new database gets the current layout; one from a newer version is refused', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'quotum-')), 'db.sqlite');
  const store = new Store(file, start);
  assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as any).user_version), SCHEMA_VERSION);
  assert.equal(store.historyStart, start);
  store.close();
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => new Store(file, start), /layout/);
});
