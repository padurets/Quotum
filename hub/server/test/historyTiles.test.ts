import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HistoryTiles} from '../history.js';
import {cellsOf} from '../domain/cells.js';
import {decodeCells, tileOf, tileStart} from '../domain/history.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';
import type {Touches} from '../touches.js';

const M = 60_000;
const H = 60 * M;
const start = tileStart(tileOf(Date.now() - 3 * H, M), M);
function fixture(budget?: number) {
  const store = new Store(':memory:', start - H);
  const directory = new Directory(store.db);
  const user = directory.createUser('a@example.com', 'Ann', 'x', start - H);
  const board = directory.boards(user.id)[0].id;
  const device = directory.saveDevice({userId: user.id, machine: {id: 'laptop-0123456789', name: 'Laptop', os: 'linux', arch: 'x86_64'}, agent: 'quotum/0.4.0', tokenId: null}, start).id;
  const source = store.source('codex', 'test', start);
  store.hold(source, user.id, start);
  const tiles = new HistoryTiles(store, budget);
  const nothing = () => {};
  const observer: Touches = {touchSources: nothing, touchBoards: nothing, touchUser: nothing, touchHub: nothing, history: (source, since) => tiles.touch(source, since), dropSessions: nothing, dropMember: nothing, dropBoard: nothing};
  store.setObserver(observer);
  const sample = (at: number, used: number, window = 'weekly') => store.record(source, {observedAt: at, staleAfterMs: 5 * M, plan: '', resets: null, windows: [{id: window, kind: 'weekly', label: null, used, remaining: 100 - used, resetAt: start + 24 * H, minutes: 10080}]});
  let calls = 0;
  const original = store.cells.bind(store);
  store.cells = (...args) => {calls++; return original(...args);};
  const read = (from = start, to = start + H, now = start + 3 * H, hidden: string[] = []) => tiles.read(board, M, from, to, now, store.shown(board, hidden));
  return {store, directory, user, board, device, source, tiles, sample, read, calls: () => calls};
}

test('closed tiles hit without recounting, open and retention-edge tiles always count', () => {
  const h = fixture(); h.sample(start, 20);
  assert.deepEqual(h.read(), h.read()); assert.equal(h.calls(), 1);
  h.read(start + 2 * H, start + 3 * H, start + 2 * H); h.read(start + 2 * H, start + 3 * H, start + 2 * H); assert.equal(h.calls(), 3);
  const edge = start - 90 * 24 * H;
  h.read(edge, edge + H); h.store.prune(start + 3 * H); h.read(edge, edge + H); assert.equal(h.calls(), 5);
  h.store.close();
});

test('measurements invalidate from their time, including a source that had no samples in the tile', () => {
  const h = fixture(); h.read(); assert.equal(h.calls(), 1);
  h.sample(start + M, 20); const first = h.read(); assert.equal(h.calls(), 2); assert.ok(JSON.parse(first[0]).series.length);
  h.sample(start + H + M, 25); h.read(); assert.equal(h.calls(), 2, 'a measurement after the tile cannot change it');
  h.tiles.touch(h.source, start - M); h.read(); assert.equal(h.calls(), 3, 'a preceding sample can change open and gap');
  h.store.close();
});

test('late work, hidden cards and renamed devices invalidate closed tiles, while opaque refs are stable', () => {
  const h = fixture(); h.sample(start, 20); h.read();
  h.store.creditWork(h.device, start + M, start + 2 * M, [{source: h.source, origin: 'terminal', startedAt: start, project: 'P', folder: '', ordinal: 0}]);
  const [json] = h.read(); assert.equal(h.calls(), 2);
  const chunk = JSON.parse(json);
  const ref = chunk.activity.sessions[0][0];
  assert.match(ref, /^[\w-]{8}$/);
  assert.equal(h.tiles.ref(h.board, 1), ref);
  assert.notEqual(h.tiles.ref('other', 1), ref);
  assert.notEqual(new HistoryTiles(h.store).ref(h.board, 1), ref);
  assert.equal(JSON.parse(h.read(start, start + H, start + 3 * H, [`source:${h.source}`])[0]).activity.sessions.length, 0);
  assert.equal(h.calls(), 3);
  h.read(); assert.equal(h.calls(), 4);
  h.store.db.prepare('UPDATE devices SET label = ? WHERE id = ?').run('Desk', h.device);
  assert.equal(JSON.parse(h.read()[0]).activity.devices[h.device], 'Desk'); assert.equal(h.calls(), 5);
  h.store.close();
});

test('missing adjacent tiles use one pass, and the cache evicts its least used entries', () => {
  const h = fixture(250); h.sample(start, 20);
  h.read(start, start + 3 * H, start + 4 * H); assert.equal(h.calls(), 1);
  h.read(start + 2 * H, start + 3 * H, start + 4 * H); assert.equal(h.calls(), 1, 'last tile still fits');
  h.read(start, start + H, start + 4 * H); assert.equal(h.calls(), 2, 'first tile was evicted');
  h.store.close();
});

test('a temporarily absent window remains in cells; a reset within a cell voids only its step', () => {
  const h = fixture();
  h.sample(start, 20);
  h.sample(start + 20_000, 25);
  h.sample(start + 40_000, 0);
  h.sample(start + 50_000, 2);
  h.sample(start + M, 10, 'other');
  const chunks = h.store.cells(h.board, M, start, start + H, {now: start + H});
  const weekly = chunks[0].series.find(s => s.window === 'weekly')!;
  const cell = decodeCells(weekly, start, M, start - H)[0];
  assert.deepEqual([cell.low, cell.first, cell.last, cell.spent, cell.covered], [75, 80, 98, 7, 30_000]);
  assert.ok(chunks[0].resets.length);
  h.sample(start + H + M, 3); h.read();
  assert.ok(JSON.parse(h.read()[0]).series.some((s: {window: string}) => s.window === 'weekly'));
  h.store.close();
});

test('activity writes an explicit group union only when it exceeds every member session', () => {
  const stretches = [
    {session: 1, source: 's', device: 'd', user: 'u', origin: 'terminal' as const, project: 'P', folder: null, startedAt: 0, from: 0, to: 40_000},
    {session: 2, source: 's', device: 'd', user: 'u', origin: 'terminal' as const, project: 'P', folder: null, startedAt: 0, from: 20_000, to: 60_000},
  ];
  const [chunk] = cellsOf([], stretches, {d: 'Device'}, M, 0, M, {work: 0, sources: {s: 0}});
  assert.deepEqual(chunk.activity.cells[0], [0, M, [[0, 40_000], [1, 40_000]], [['s', 's', M], ['p', '"P"', M], ['d', 'd', M]]]);
  const covered = cellsOf([], [{...stretches[0], to: M}, stretches[1]], {d: 'Device'}, M, 0, M, {work: 0, sources: {s: 0}})[0].activity.cells[0];
  assert.deepEqual(covered[2], [0, [1, 40_000]]); assert.deepEqual(covered[3], []);
});

test('open retains the old share only when the reset happened after the cell began', () => {
  const before = {at: 50_000, used: 20, resetAt: 60_000, staleAfterMs: 5 * M};
  const after = {at: 70_000, used: 2, resetAt: 3_600_000, staleAfterMs: 5 * M};
  const read = (resetAt: number) => cellsOf([{source: 's', window: 'w', samples: [{...before, resetAt}, after]}], [], {}, M, M, 2 * M, {work: 0, sources: {s: 0}})[0].series[0].open;
  assert.equal(read(60_000), null, 'a reset at the left edge already happened');
  assert.equal(read(65_000), 80, 'the old value held when the cell began');
});

test('compact JSON keeps exact numbers and every digit and escape inside names', () => {
  const h = fixture();
  h.sample(start, 20.12345, '300000');
  const name = '300000 "quoted"\\name\n120000';
  h.store.db.prepare('UPDATE devices SET label = ? WHERE id = ?').run(name, h.device);
  h.store.creditWork(h.device, start, start + M, [{source: h.source, origin: 'terminal', startedAt: start, project: name, folder: '', ordinal: 0}]);
  const raw = h.store.cells(h.board, M, start, start + H, {now: start + 3 * H})[0];
  const [json] = h.read();
  const expected = {...raw, activity: {...raw.activity, sessions: raw.activity.sessions.map(([id, ...rest]) => [h.tiles.ref(h.board, id), ...rest])}};
  assert.deepEqual(JSON.parse(json), expected);
  assert.ok(json.includes('3e5'), 'a hold uses its shorter exact spelling');
  assert.equal(JSON.parse(json).series[0].window, '300000');
  assert.equal(JSON.parse(json).activity.devices[h.device], name);
  h.store.close();
});

test('a changed known work start cannot reuse activity or expose sessions before it', () => {
  const h = fixture();
  h.store.creditWork(h.device, start, start + M, [{source: h.source, origin: 'terminal', startedAt: start, project: 'P', folder: '', ordinal: 0}]);
  assert.equal(JSON.parse(h.read()[0]).activity.sessions.length, 1);
  h.store.db.prepare("UPDATE meta SET value = ? WHERE key = 'agentWorkSince'").run(String(start + 2 * M));
  assert.deepEqual(JSON.parse(h.read()[0]).activity.sessions, []);
  assert.equal(h.calls(), 2);
  h.store.close();
});
