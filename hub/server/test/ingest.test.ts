import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Duty} from '../duty.js';
import {Ingest, IngestError, type Credential} from '../ingest.js';
import {parseBatch, windowLabel} from '../domain/ingest.js';
import {bucketize, edge, series, type Sample} from '../domain/quota.js';
import {DEFAULT_BOARD} from '../domain/sources.js';
import {newSecret} from '../domain/auth.js';

const start = Date.parse('2026-09-22T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const TOKEN = 'test-token-0123456789abcdef';
const STATIC: Credential = {kind: 'static'};

const snapshot = (at: number, used: number, change: Record<string, unknown> = {}) => ({
  provider: 'codex',
  account: 'a1b2c3d4e5f6a1b2c3d4e5f6',
  plan: 'pro',
  observedAt: iso(at),
  via: 'codex/app-server',
  client: '0.154.0',
  staleAfterMs: 204_000,
  windows: [{id: 'weekly', kind: 'weekly', minutes: 10080, usedPercent: used, resetsAt: iso(start + 5 * 86_400_000)}],
  ...change,
});

const agy = (at: number, used: number, accountName?: string) =>
  snapshot(at, used, {
    provider: 'antigravity',
    account: undefined,
    accountName,
    plan: undefined,
    via: 'agy/usage',
    windows: [{id: 'gemini:weekly', kind: 'weekly', minutes: 10080, label: 'Gemini', usedPercent: used, resetsAt: null}],
  });

const batch = (snapshots: unknown[], failures: unknown[] = [], machine = 'machine-one-0123456789', owner: object = {}) => ({
  version: 1,
  agent: 'quotum/0.1.0',
  machine: {id: machine, name: `host-${machine.slice(8, 11)}`, os: 'linux', arch: 'x86_64'},
  owner,
  sentAt: iso(start),
  snapshots,
  failures,
});

function setup() {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-ingest-')), 'db.sqlite'), start);
  const directory = new Directory(store.db);
  return {store, directory, ingest: new Ingest(store, directory, [TOKEN], new Duty())};
}

/** The state of the only source of a provider on the default board. */
const only = (store: Store, provider: string) => {
  const states = store.states(DEFAULT_BOARD).filter(s => s.provider === provider);
  assert.equal(states.length, 1);
  return states[0];
};

test('static, board and device tokens are told apart; anything else is refused', () => {
  const {directory, ingest} = setup();
  const alice = directory.createUser('alice@example.com', 'Alice', 'x', start);
  const boardSecret = newSecret('qt_b');
  directory.createToken(boardSecret, '…', DEFAULT_BOARD, 'ci', alice.id, start);
  assert.deepEqual(ingest.authenticate(`Bearer ${TOKEN}`), {kind: 'static'});
  assert.equal(ingest.authenticate(`Bearer ${boardSecret}`)?.kind, 'board');
  assert.equal(ingest.authenticate(`Bearer ${TOKEN}x`), null);
  assert.equal(ingest.authenticate(`Bearer ${newSecret('qt_d')}`), null);
  assert.equal(ingest.authenticate(TOKEN), null);
  assert.equal(ingest.authenticate(undefined), null);
});

test('a malformed batch is refused whole', () => {
  assert.throws(() => parseBatch({...batch([snapshot(start, 5)]), version: 2}), /invalid_batch: version/);
  assert.throws(() => parseBatch(batch([snapshot(start, 120)])), /usedPercent/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {provider: 'cursor'})])), /provider/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {staleAfterMs: 0})])), /staleAfterMs/);
  assert.throws(() => parseBatch(batch([], [], undefined, {name: 7})), /owner name/);
  const parsed = parseBatch(batch([snapshot(start, 5)], [], undefined, {name: 'alice'}));
  assert.equal(parsed.snapshots[0].windows[0].resetsAt, start + 5 * 86_400_000);
  assert.deepEqual(parsed.owner, {name: 'alice'});
});

test('windows get language-neutral labels', () => {
  const w = {id: 'x', minutes: 10080, usedPercent: 0, resetsAt: null};
  assert.equal(windowLabel({...w, kind: 'weekly', label: null}), 'Weekly');
  assert.equal(windowLabel({...w, kind: 'weekly', label: 'Fable'}), 'Fable');
  assert.equal(windowLabel({...w, kind: 'session', minutes: 300, label: 'Gemini'}), 'Gemini');
  assert.equal(windowLabel({...w, kind: 'other', minutes: 60, label: null}), '60 min');
});

test('every account of a provider is a source of its own, with a stable id', () => {
  const {store, ingest} = setup();
  const result = ingest.accept(STATIC, batch([snapshot(start, 5), snapshot(start, 7, {account: 'ffffeeeeddddccccbbbbaaaa'})]), start);
  assert.deepEqual([result.accepted, result.duplicates, result.failures], [2, 0, 0]);
  const states = store.states(DEFAULT_BOARD);
  assert.deepEqual(states.map(s => s.windows[0]?.used), [5, 7]);
  assert.ok(states.every(s => /^codex:[0-9a-f]{8}$/.test(s.id)));
  assert.equal(store.source(DEFAULT_BOARD, 'codex', 'a1b2c3d4e5f6a1b2c3d4e5f6', start), states[0].id);
  assert.notEqual(store.source('team', 'codex', 'a1b2c3d4e5f6a1b2c3d4e5f6', start), states[0].id, 'another board has its own');
});

test('one account measured by several devices is one source', () => {
  const {store, ingest} = setup();
  ingest.accept(STATIC, batch([snapshot(start, 5)], [], 'machine-one-0123456789'), start);
  ingest.accept(STATIC, batch([snapshot(start + 120_000, 6)], [], 'machine-two-0123456789'), start + 120_000);
  const [series] = store.history(DEFAULT_BOARD, start - 1, 60_000);
  assert.deepEqual([store.states(DEFAULT_BOARD).length, series.samples, series.consumed], [1, 2, 1]);
});

test('a subscription the client does not name belongs to its owner, not to the machine', () => {
  const {store, ingest} = setup();
  const alice = {name: 'alice'};
  ingest.accept(STATIC, batch([agy(start, 10)], [], 'machine-one-0123456789', alice), start);
  ingest.accept(STATIC, batch([agy(start + 60_000, 12)], [], 'machine-two-0123456789', alice), start + 60_000);
  ingest.accept(STATIC, batch([agy(start + 60_000, 50)], [], 'machine-six-0123456789', {name: 'bob'}), start + 60_000);
  ingest.accept(STATIC, batch([agy(start + 60_000, 90, 'Work')], [], 'machine-one-0123456789', alice), start + 60_000);
  const used = store.states(DEFAULT_BOARD).map(s => s.windows[0].used).sort((a, b) => a - b);
  assert.deepEqual(used, [12, 50, 90], "alice's two machines share one subscription; bob and alice's named one are separate");
});

test('with a board token the owner is the declared name (a member when it is their e-mail), else the token creator', () => {
  const {directory, ingest} = setup();
  const alice = directory.createUser('alice@example.com', 'Alice', 'x', start);
  const bob = directory.createUser('bob@example.com', 'Bob', 'x', start);
  directory.addMember(DEFAULT_BOARD, bob.id, start);
  const secret = newSecret('qt_b');
  directory.createToken(secret, '…', DEFAULT_BOARD, 'images', alice.id, start);
  const board = ingest.authenticate(`Bearer ${secret}`)!;

  const owner = (machine: string, claimed: object) => ingest.accept(board, batch([snapshot(start, 5)], [], machine, claimed), start).device.owner;
  assert.equal(owner('machine-aaa-0123456789', {name: 'build farm'}), 'build farm');
  assert.equal(owner('machine-bbb-0123456789', {name: 'BOB@example.com'}), 'Bob');
  assert.equal(owner('machine-ccc-0123456789', {}), 'Alice');
  assert.equal(directory.deviceByMachine(DEFAULT_BOARD, 'machine-bbb-0123456789')?.ownerUserId, bob.id);
});

test('a revoked device cannot come back with the board token; revoking the token disconnects its devices', () => {
  const {directory, ingest} = setup();
  const alice = directory.createUser('alice@example.com', 'Alice', 'x', start);
  const secret = newSecret('qt_b');
  const token = directory.createToken(secret, '…', DEFAULT_BOARD, 'images', alice.id, start);
  const board = ingest.authenticate(`Bearer ${secret}`)!;
  const {device} = ingest.accept(board, batch([snapshot(start, 5)]), start);
  directory.revokeDevice(DEFAULT_BOARD, device.id, start);
  assert.throws(() => ingest.accept(board, batch([snapshot(start + 60_000, 6)]), start + 60_000), IngestError);
  ingest.accept(board, batch([snapshot(start, 5)], [], 'machine-new-0123456789'), start);
  directory.revokeToken(DEFAULT_BOARD, token.id, start);
  assert.equal(ingest.authenticate(`Bearer ${secret}`), null);
  assert.deepEqual(directory.devices(DEFAULT_BOARD), []);
});

test('resent and older measurements are duplicates, not errors', () => {
  const {store, ingest} = setup();
  ingest.accept(STATIC, batch([snapshot(start + 120_000, 6)]), start + 120_000);
  const again = ingest.accept(STATIC, batch([snapshot(start, 5), snapshot(start + 120_000, 6)]), start + 130_000);
  assert.deepEqual([again.accepted, again.duplicates], [0, 2]);
  assert.equal(only(store, 'codex').error, null);
});

test('a device failure shows only once its source has gone quiet', () => {
  const {store, ingest} = setup();
  ingest.accept(STATIC, batch([snapshot(start, 5)]), start);
  const failure = (at: number) => ({provider: 'codex', observedAt: iso(at), error: 'not_logged_in', detail: 'run codex login'});
  assert.equal(ingest.accept(STATIC, batch([], [failure(start + 60_000)]), start + 60_000).failures, 0);
  assert.equal(ingest.accept(STATIC, batch([], [failure(start + 600_000)]), start + 600_000).failures, 1);
  assert.equal(only(store, 'codex').error, 'not_logged_in');
  // Failures from a device that never delivered this provider are ignored.
  assert.equal(ingest.accept(STATIC, batch([], [failure(start + 600_000)], 'machine-two-0123456789'), start + 600_000).failures, 0);
});

test('an agent-declared staleness keeps sparse measurements continuous', () => {
  const sample = (at: number, used: number, staleAfterMs: number | null): Sample => ({
    sourceId: 'codex',
    provider: 'codex',
    id: 'weekly',
    label: 'Weekly',
    used,
    remaining: 100 - used,
    resetAt: start + 5 * 86_400_000,
    minutes: 10080,
    sourceAt: at,
    staleAfterMs,
  });
  // Eco mode: 15 minutes between measurements, announced by the agent.
  const eco = [sample(start, 10, 1_080_000), sample(start + 900_000, 12, 1_080_000)];
  assert.deepEqual(edge(eco[0], eco[1]), {valid: true, delta: 2, reason: 'continuous'});
  assert.equal(series(eco).consumed, 2);
  assert.deepEqual(bucketize(series(eco).points, 300_000).map(p => p.segment), [0, 0]);
  // Without the announcement the default 5.5 minutes apply: a gap.
  const legacy = [sample(start, 10, null), sample(start + 900_000, 12, null)];
  assert.equal(edge(legacy[0], legacy[1]).reason, 'gap');
  assert.deepEqual(bucketize(series(legacy).points, 300_000).map(p => p.segment), [0, 1]);
});

test('stored agent samples carry their staleness into history', () => {
  const {store, ingest} = setup();
  ingest.accept(STATIC, batch([snapshot(start, 10, {staleAfterMs: 1_080_000})]), start);
  ingest.accept(STATIC, batch([snapshot(start + 900_000, 12, {staleAfterMs: 1_080_000})]), start + 900_000);
  const [history] = store.history(DEFAULT_BOARD, start - 1, 300_000);
  assert.equal(history.consumed, 2);
  assert.deepEqual(history.points.map(p => p[2]), [0, 0]);
});
