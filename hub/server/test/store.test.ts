import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store/store.js';
import {SCHEMA_VERSION} from '../store/schema.js';
import {DEFAULT_BOARD, sourceId} from '../domain/sources.js';
import type {Measurement, Win} from '../domain/quota.js';

const start = 1_800_000_000_000;
const guard = {scope: 'a', confidence: 'provider' as const};
const win = (change: Partial<Win> = {}): Win => ({
  id: 'weekly',
  label: 'Неделя',
  used: 20,
  remaining: 80,
  resetAt: start + 86_400_000,
  minutes: 10080,
  ...change,
});
const measurement = (change: Partial<Measurement> = {}): Measurement => ({
  provider: 'codex',
  sourceAt: start,
  plan: 'Pro',
  identity: 'a',
  windows: [win()],
  ...change,
});

test('repeated source responses and failures keep the last good data without extra samples', () => {
  const store = new Store(':memory:', start);
  assert.equal(store.record('codex', measurement(), start, guard), true);
  assert.equal(store.record('codex', measurement(), start + 120_000, guard), false);
  store.fail('codex', 'source_unavailable', start + 150_000);
  const state = store.state('codex');
  assert.equal(state.successAt, start);
  assert.equal(state.windows[0].used, 20);
  assert.equal(state.error, 'source_unavailable');
  assert.equal(store.history(DEFAULT_BOARD, start - 1, 60_000)[0].samples, 1);
  store.close();
});

test('history returns one series per source and window, and short failures do not drop consumption', () => {
  const store = new Store(':memory:', start);
  const windows = [win(), win({id: 'session', minutes: 300, resetAt: start + 3_600_000})];
  store.record('codex', measurement({windows}), start, guard);
  store.fail('codex', 'source_unavailable', start + 120_000);
  store.record(
    'codex',
    measurement({sourceAt: start + 240_000, windows: [win({used: 25}), win({id: 'session', minutes: 300, used: 50, resetAt: start + 3_600_000})]}),
    start + 240_000,
    guard,
  );
  const history = store.history(DEFAULT_BOARD, start - 1, 60_000);
  assert.deepEqual(history.map(s => [s.bucket, s.kind, s.consumed]), [['weekly', 'weekly', 5], ['session', 'session', 30]]);
  assert.equal(history[0].points[1][2], 0, 'a single failed attempt is not a chart break');
  store.close();
});

test('a second account of the same provider keeps its own state and history', () => {
  const store = new Store(':memory:', start);
  const work = sourceId('codex', 'work');
  assert.equal(work, 'codex:work');
  store.register({id: work, provider: 'codex', accountKey: 'work', label: 'Codex · work'}, start);
  store.record('codex', measurement(), start, guard);
  store.record(work, measurement({identity: 'b', windows: [win({used: 70})]}), start, {scope: 'b', confidence: 'provider'});

  assert.deepEqual(store.sources().map(s => s.id).filter(id => id.startsWith('codex')), ['codex', 'codex:work']);
  assert.equal(store.state('codex').windows[0].used, 20);
  assert.equal(store.state(work).windows[0].used, 70);
  const history = store.history(DEFAULT_BOARD, start - 1, 60_000);
  assert.deepEqual(
    history.filter(s => s.provider === 'codex').map(s => [s.sourceId, s.points.at(-1)![1]]),
    [['codex', 80], ['codex:work', 30]],
  );
  store.close();
});

test('unverified identities rotate scope on auth metadata changes, never on token contents', () => {
  const store = new Store(':memory:', start);
  const first = store.scope('antigravity', null, 'inode-1:mtime-1');
  assert.equal(store.scope('antigravity', null, 'inode-1:mtime-1').scope, first.scope);
  assert.notEqual(store.scope('antigravity', null, 'inode-2:mtime-2').scope, first.scope);
  assert.notEqual(store.scope('claude', null, null).scope, store.scope('claude', null, null).scope);
  assert.equal(store.scope('claude', 'stable-account-subject', 'rotated-auth-metadata').scope, 'stable-account-subject');
  store.close();
});

test('a v1 database migrates to source-keyed storage without losing samples', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'agent-limits-')), 'v1.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE state (provider TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE guards (provider TEXT PRIMARY KEY, signature TEXT NOT NULL, scope TEXT NOT NULL);
    CREATE TABLE samples (provider TEXT NOT NULL, scope TEXT NOT NULL, bucket TEXT NOT NULL,
      source_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, label TEXT NOT NULL,
      used REAL NOT NULL, reset_at INTEGER, minutes INTEGER,
      PRIMARY KEY (provider, scope, bucket, source_at));
    CREATE TABLE attempts (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, at INTEGER NOT NULL, error TEXT);
    INSERT INTO meta VALUES ('collectionStart', '${start}');
    INSERT INTO samples VALUES ('codex', 'a', 'weekly', ${start}, ${start}, 'Неделя', 20, ${start + 86_400_000}, 10080);
    INSERT INTO samples VALUES ('codex', 'a', 'weekly', ${start + 120_000}, ${start + 120_000}, 'Неделя', 24, ${start + 86_400_000}, 10080);
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const store = new Store(file, start + 300_000);
  assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as any).user_version), SCHEMA_VERSION);
  assert.equal(store.collectionStart, start, 'collection start survives the migration');
  const [series] = store.history(DEFAULT_BOARD, start - 1, 60_000);
  assert.deepEqual([series.sourceId, series.samples, series.consumed], ['codex', 2, 4]);
  store.record('codex', measurement({sourceAt: start + 240_000, windows: [win({used: 26})]}), start + 240_000, {scope: 'a', confidence: 'provider'});
  assert.equal(store.history(DEFAULT_BOARD, start - 1, 60_000)[0].samples, 3);
  store.close();
});
