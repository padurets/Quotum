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
const USER = 'user';
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

/** A store with one person's personal board; `seen` is a source their device measures. */
function fresh() {
  const store = new Store(':memory:', start);
  store.db.prepare("INSERT INTO boards VALUES (?, '', 1, ?, ?)").run(BOARD, USER, start);
  return store;
}
const seen = (store: Store, provider: 'claude' | 'codex' | 'antigravity', account: string, user = USER) => {
  const id = store.source(provider, account, start);
  store.hold(id, user, start);
  return id;
};

test('a source appears when first seen and shows it is waiting for data', () => {
  const store = fresh();
  assert.deepEqual(store.states(BOARD), []);
  assert.deepEqual(store.states('elsewhere'), [], 'a board that does not exist shows nothing');
  const id = seen(store, 'codex', 'account-a');
  assert.deepEqual(store.states(BOARD).map(s => [s.id, s.provider, s.error]), [[id, 'codex', 'waiting']]);
  store.close();
});

test('failures keep the last good values on screen', () => {
  const store = fresh();
  const id = seen(store, 'codex', 'account-a');
  store.record(id, measurement());
  store.fail(id, 'not_logged_in');
  const state = store.state(id);
  assert.deepEqual([state.successAt, state.windows[0].used, state.error], [start, 20, 'not_logged_in']);
  store.record(id, measurement({observedAt: start + 240_000}));
  assert.equal(store.state(id).error, null);
  store.close();
});

test('history returns one series per source and window, in the order of the cards', () => {
  const store = fresh();
  const claude = seen(store, 'claude', 'account-c');
  const codex = seen(store, 'codex', 'account-a');
  const windows = (used: number) => [win({used}), win({id: 'session', kind: 'session', minutes: 300, used: used * 2, resetAt: start + 3_600_000})];
  store.record(codex, measurement({windows: windows(20)}));
  store.record(codex, measurement({observedAt: start + 240_000, windows: windows(25)}));
  store.record(claude, measurement({windows: [win({used: 5})]}));
  const history = store.history(BOARD, start - 1, 60_000).series;
  assert.deepEqual(
    history.map(s => [s.provider, s.windowId, s.kind, s.consumed]),
    [['claude', 'weekly', 'weekly', 0], ['codex', 'weekly', 'weekly', 5], ['codex', 'session', 'session', 10]],
  );
  assert.deepEqual(store.history('elsewhere', start - 1, 60_000).series, [], 'boards do not see each other');
  store.close();
});

test('every change moves the revision of its board, and only of its board', () => {
  const store = fresh();
  const before = store.revision(BOARD);
  const other = store.revision('other');
  const id = seen(store, 'codex', 'account-a');
  store.record(id, measurement());
  store.fail(id, 'timeout');
  assert.equal(store.revision(BOARD), before + 3);
  assert.equal(store.revision('other'), other);
  store.close();
});

test('a source is kept once: on the personal board of everyone who measures it, and where they shared it', () => {
  const store = fresh();
  store.db.prepare("INSERT INTO boards VALUES ('bob-board', '', 1, 'bob', ?), ('team', 'Team', 0, 'user', ?)").run(start, start);
  store.db.prepare("INSERT INTO members VALUES ('team', 'user', 'owner', ?), ('team', 'bob', 'member', ?)").run(start, start);
  const shared = seen(store, 'claude', 'team-account');
  assert.equal(seen(store, 'claude', 'team-account', 'bob'), shared, 'the same account is the same source');
  const own = seen(store, 'codex', 'bob-account', 'bob');
  assert.deepEqual(store.sources('bob-board').map(s => [s.id, s.holders]), [[shared, ['bob', 'user']], [own, ['bob']]]);
  assert.deepEqual(store.sources('team'), [], 'nothing on a shared board until someone shares it');

  const before = store.revision('team');
  store.share('team', shared, 'user', start);
  store.share('team', own, 'bob', start);
  assert.deepEqual(store.sources('team').map(s => [s.id, s.sharedBy]), [[shared, 'user'], [own, 'bob']]);
  store.record(shared, measurement());
  assert.equal(store.revision('team'), before + 3, 'a shared source moves the revision of the boards it is shared with');
  assert.deepEqual(store.history('team', start - 1, 60_000).series.map(s => s.sourceId), [shared]);

  // Bob leaves the team: his own subscription goes with him, the one Alice measures too stays.
  store.db.prepare("DELETE FROM members WHERE board_id = 'team' AND user_id = 'bob'").run();
  store.unshareOrphans('team');
  assert.deepEqual(store.sources('team').map(s => s.id), [shared]);
  store.removeBoard('team');
  assert.deepEqual(store.sources('team'), []);
  assert.equal(store.sources(BOARD).length, 1, 'the sources stay with their people');
  store.close();
});

test('limits back before their reset time and free resets granted are events for the chart', () => {
  const store = fresh();
  const id = seen(store, 'codex', 'account-a');
  const at = (minutes: number) => start + minutes * 60_000;
  const weekly = (used: number, resetAt = start + 3 * 86_400_000) => win({used, resetAt});
  const session = (used: number) => win({id: 'session', kind: 'session', minutes: 300, used, resetAt: start + 3 * 3_600_000});
  store.record(id, measurement({observedAt: at(0), windows: [weekly(90), session(40)], resets: {available: 0, expiresAt: null}}));
  store.record(id, measurement({observedAt: at(2), windows: [weekly(91), session(41)], resets: {available: 1, expiresAt: at(43_200)}}));
  // A free reset used: both windows back at zero days before their reset.
  store.record(id, measurement({observedAt: at(4), windows: [weekly(0, start + 7 * 86_400_000), session(0)], resets: {available: 0, expiresAt: null}}));
  store.record(id, measurement({observedAt: at(6), windows: [weekly(1, start + 7 * 86_400_000), session(1)], resets: {available: 0, expiresAt: null}}));
  const {events} = store.history(BOARD, start - 1, 60_000);
  assert.deepEqual(events, [
    {sourceId: id, at: at(2), kind: 'resets_granted', count: 1},
    {sourceId: id, at: at(4), kind: 'early_reset', windows: ['session', 'weekly']},
  ]);
  store.close();
});

test('old samples are pruned after the retention period', () => {
  const store = fresh();
  const id = seen(store, 'codex', 'account-a');
  store.record(id, measurement());
  store.record(id, measurement({observedAt: start + 100 * 86_400_000}));
  store.prune(start + 100 * 86_400_000);
  assert.equal(store.history(BOARD, 0, 60_000).series[0].samples, 1);
  store.close();
});

test('resets the trackers report are kept, once each, until the retention period ends', () => {
  const store = fresh();
  const grant = {at: start, url: 'https://example.com/1', text: 'A banked reset for everyone'};
  store.announce('codex', grant);
  store.announce('codex', grant);
  store.announce('claude', {...grant, at: start + 3_600_000});
  assert.deepEqual(store.announcements(start - 1), {codex: [grant], claude: [{...grant, at: start + 3_600_000}]});
  assert.deepEqual(store.announcements(start + 1), {claude: [{...grant, at: start + 3_600_000}]});
  store.prune(start + 100 * 86_400_000);
  assert.deepEqual(store.announcements(0), {});
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

test('a database of a development version before 0.2 is refused, not misread', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'quotum-')), 'db.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE sources (id TEXT PRIMARY KEY, board_id TEXT NOT NULL); PRAGMA user_version = 1');
  raw.close();
  assert.throws(() => new Store(file, start), /before 0\.2/);
});
