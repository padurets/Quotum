import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Duty} from '../duty.js';
import {Ingest, IngestError, type Credential} from '../ingest.js';
import {parseBatch} from '../domain/ingest.js';
import {edge, onGrid, series, type Sample} from '../domain/quota.js';
import {newSecret} from '../domain/auth.js';

const start = Date.parse('2026-09-22T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

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
  // Agents send right after measuring: the clock at sending is the last measurement's.
  sentAt: iso(Math.max(start, ...[...snapshots, ...failures].map((item: any) => Date.parse(item.observedAt)))),
  snapshots,
  failures,
});

/** A hub with Alice, her personal board and a board token of hers. */
function setup() {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-ingest-')), 'db.sqlite'), start);
  const directory = new Directory(store.db);
  const ingest = new Ingest(store, directory, new Duty());
  const alice = directory.createUser('alice@example.com', 'Alice', 'x', start);
  const board = directory.boards(alice.id)[0].id;
  const secret = newSecret('qt_b');
  const tokenRow = directory.createToken(secret, '…', board, 'images', alice.id, start);
  const token = ingest.authenticate(`Bearer ${secret}`) as Credential;
  return {store, directory, ingest, alice, board, secret, tokenRow, token};
}

/** The state of the only source of a provider on a board. */
const only = (store: Store, board: string, provider: string) => {
  const states = store.states(board).filter(s => s.provider === provider);
  assert.equal(states.length, 1);
  return states[0];
};

test('board and device tokens are told apart; anything else is refused', () => {
  const {ingest, secret} = setup();
  assert.equal((ingest.authenticate(`Bearer ${secret}`) as Credential).kind, 'board');
  assert.equal((ingest.authenticate(`bearer ${secret}`) as Credential).kind, 'board', 'the scheme is case-insensitive');
  assert.equal(ingest.authenticate(`Bearer ${secret}x`), null);
  assert.equal(ingest.authenticate(`Bearer ${newSecret('qt_d')}`), null);
  assert.equal(ingest.authenticate('Bearer test-token-0123456789abcdef'), null);
  assert.equal(ingest.authenticate(secret), null);
  assert.equal(ingest.authenticate(undefined), null);
});

test('a malformed batch is refused whole', () => {
  assert.throws(() => parseBatch({...batch([snapshot(start, 5)]), version: 2}), /invalid: version/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {account: 'dev@example.com'})])), /account/, 'accounts are pseudonyms');
  assert.throws(() => parseBatch(batch([snapshot(start, 120)])), /usedPercent/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {provider: 'cursor'})])), /provider/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {staleAfterMs: 0})])), /staleAfterMs/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {resets: {available: -1}})])), /resets/);
  assert.throws(() => parseBatch(batch([], [], undefined, {name: 7})), /owner name/);
  const parsed = parseBatch(batch([snapshot(start, 5)], [], undefined, {name: 'alice'}));
  assert.equal(parsed.snapshots[0].windows[0].resetsAt, start + 5 * 86_400_000);
  assert.deepEqual(parsed.owner, {name: 'alice'});
});

test('a window keeps its kind and the scope label the agent gave, nothing else', () => {
  const parsed = parseBatch(batch([snapshot(start, 5, {windows: [{id: 'weekly:fable', kind: 'weekly', minutes: null, label: 'Fable', usedPercent: 1, resetsAt: null}]})]));
  const [w] = parsed.snapshots[0].windows;
  assert.deepEqual([w.kind, w.label, w.minutes], ['weekly', 'Fable', null]);
});

test('every account of a provider is a source of its own, with a stable id', () => {
  const {store, ingest, board, token} = setup();
  const result = ingest.accept(token, batch([snapshot(start, 5), snapshot(start, 7, {account: 'ffffeeeeddddccccbbbbaaaa'})]), start);
  assert.deepEqual([result.accepted, result.duplicates, result.failures], [2, 0, 0]);
  const states = store.states(board);
  assert.deepEqual(states.map(s => s.windows[0]?.used), [5, 7]);
  assert.ok(states.every(s => /^codex:[0-9a-f]{12}$/.test(s.id)));
  assert.equal(store.source(board, 'codex', 'a1b2c3d4e5f6a1b2c3d4e5f6', start), states[0].id);
  assert.notEqual(store.source('team', 'codex', 'a1b2c3d4e5f6a1b2c3d4e5f6', start), states[0].id, 'another board has its own');
});

test('free resets the client reports are kept with the source until it stops reporting them', () => {
  const {store, ingest, board, token} = setup();
  const expiresAt = start + 30 * 86_400_000;
  ingest.accept(token, batch([snapshot(start, 5, {resets: {available: 1, expiresAt: iso(expiresAt)}})]), start);
  assert.deepEqual(only(store, board, 'codex').resets, {available: 1, expiresAt});
  ingest.accept(token, batch([snapshot(start + 60_000, 5)]), start + 60_000);
  assert.equal(only(store, board, 'codex').resets, null);
});

test('one account measured by several devices is one source', () => {
  const {store, ingest, board, token} = setup();
  ingest.accept(token, batch([snapshot(start, 5)], [], 'machine-one-0123456789'), start);
  ingest.accept(token, batch([snapshot(start + 120_000, 6)], [], 'machine-two-0123456789'), start + 120_000);
  const [series] = store.history(board, start - 1, 60_000);
  assert.deepEqual([store.states(board).length, series.samples, series.consumed], [1, 2, 1]);
});

test('a subscription the client does not name belongs to its owner, not to the machine', () => {
  const {store, ingest, board, token} = setup();
  const alice = {name: 'alice'};
  ingest.accept(token, batch([agy(start, 10)], [], 'machine-one-0123456789', alice), start);
  ingest.accept(token, batch([agy(start + 60_000, 12)], [], 'machine-two-0123456789', alice), start + 60_000);
  ingest.accept(token, batch([agy(start + 60_000, 50)], [], 'machine-six-0123456789', {name: 'bob'}), start + 60_000);
  ingest.accept(token, batch([agy(start + 60_000, 90, 'Work')], [], 'machine-one-0123456789', alice), start + 60_000);
  const used = store.states(board).map(s => s.windows[0].used).sort((a, b) => a - b);
  assert.deepEqual(used, [12, 50, 90], "alice's two machines share one subscription; bob and alice's named one are separate");
});

test('with a board token the owner is the declared name (a member when it is their email), else the token creator', () => {
  const {directory, ingest, board, token} = setup();
  const bob = directory.createUser('bob@example.com', 'Bob', 'x', start);
  directory.addMember(board, bob.id, start);

  const owner = (machine: string, claimed: object) => ingest.accept(token, batch([snapshot(start, 5)], [], machine, claimed), start).device.owner;
  assert.equal(owner('machine-aaa-0123456789', {name: 'build farm'}), 'build farm');
  assert.equal(owner('machine-bbb-0123456789', {name: 'BOB@example.com'}), 'Bob');
  assert.equal(owner('machine-ccc-0123456789', {}), 'Alice');
  assert.equal(directory.deviceByMachine(board, 'machine-bbb-0123456789')?.ownerUserId, bob.id);
});

test('a revoked device cannot come back with the board token; revoking the token disconnects its devices', () => {
  const {directory, ingest, board, secret, tokenRow, token} = setup();
  const {device} = ingest.accept(token, batch([snapshot(start, 5)]), start);
  directory.revokeDevice(board, device.id, start);
  assert.throws(() => ingest.accept(token, batch([snapshot(start + 60_000, 6)]), start + 60_000), IngestError);
  ingest.accept(token, batch([snapshot(start, 5)], [], 'machine-new-0123456789'), start);
  directory.revokeToken(board, tokenRow.id, start);
  assert.equal(ingest.authenticate(`Bearer ${secret}`), null);
  assert.deepEqual(directory.devices(board), []);
});

test('an agent whose clock is off has its times moved by the difference', () => {
  const {store, ingest, board, token} = setup();
  const ahead = 10 * 60_000;
  // The machine's clock is ten minutes fast: what it measured "at start + 10 min" happened at start.
  ingest.accept(token, {...batch([snapshot(start + ahead, 5)]), sentAt: iso(start + ahead)}, start);
  assert.equal(only(store, board, 'codex').successAt, start);
  const late = ingest.accept(token, {...batch([snapshot(start + 20_000, 6)]), sentAt: iso(start + 20_000)}, start + 30_000);
  assert.equal(late.accepted, 1, 'within the tolerance nothing is moved');
});

test('resent and older measurements are duplicates, not errors', () => {
  const {store, ingest, board, token} = setup();
  ingest.accept(token, batch([snapshot(start + 120_000, 6)]), start + 120_000);
  const again = ingest.accept(token, batch([snapshot(start, 5), snapshot(start + 120_000, 6)]), start + 130_000);
  assert.deepEqual([again.accepted, again.duplicates], [0, 2]);
  assert.equal(only(store, board, 'codex').error, null);
});

test('a device failure shows only once its source has gone quiet', () => {
  const {store, ingest, board, token} = setup();
  ingest.accept(token, batch([snapshot(start, 5)]), start);
  const failure = (at: number) => ({provider: 'codex', observedAt: iso(at), error: 'not_logged_in', detail: 'run codex login'});
  assert.equal(ingest.accept(token, batch([], [failure(start + 60_000)]), start + 60_000).failures, 0);
  assert.equal(ingest.accept(token, batch([], [failure(start + 600_000)]), start + 600_000).failures, 1);
  assert.equal(only(store, board, 'codex').error, 'not_logged_in');
  // A device that never delivered this provider keeps its failure to itself (shown on its row).
  assert.equal(ingest.accept(token, batch([], [failure(start + 600_000)], 'machine-two-0123456789'), start + 600_000).failures, 0);
});

test('an agent-declared staleness keeps sparse measurements continuous', () => {
  const sample = (at: number, used: number, staleAfterMs: number): Sample => ({
    sourceId: 'codex',
    provider: 'codex',
    id: 'weekly',
    kind: 'weekly',
    label: null,
    used,
    remaining: 100 - used,
    resetAt: start + 5 * 86_400_000,
    minutes: 10080,
    at,
    staleAfterMs,
  });
  // Eco mode: 15 minutes between measurements, announced by the agent.
  const eco = [sample(start, 10, 1_080_000), sample(start + 900_000, 12, 1_080_000)];
  assert.deepEqual(edge(eco[0], eco[1]), {valid: true, delta: 2, reason: 'continuous'});
  assert.equal(series(eco).consumed, 2);
  assert.deepEqual(onGrid(series(eco).points, 300_000).map(p => p.segment), [0, 0]);
  // Measured every two minutes: a quarter of an hour without a sample is a gap.
  const busy = [sample(start, 10, 204_000), sample(start + 900_000, 12, 204_000)];
  assert.equal(edge(busy[0], busy[1]).reason, 'gap');
  assert.deepEqual(onGrid(series(busy).points, 300_000).map(p => p.segment), [0, 1]);
});

test('stored agent samples carry their staleness into history', () => {
  const {store, ingest, board, token} = setup();
  ingest.accept(token, batch([snapshot(start, 10, {staleAfterMs: 1_080_000})]), start);
  ingest.accept(token, batch([snapshot(start + 900_000, 12, {staleAfterMs: 1_080_000})]), start + 900_000);
  const [history] = store.history(board, start - 1, 300_000);
  assert.equal(history.consumed, 2);
  assert.deepEqual(history.points.map(p => p[2]), [0, 0]);
});
