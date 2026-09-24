import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store, WORK_CELL_MS} from '../store/store.js';
import {KEEP_MS, Sessions, type LiveSession} from '../sessions.js';

const start = 1_800_000_000_000 - (1_800_000_000_000 % WORK_CELL_MS);
const minute = 60_000;

const session = (source: string, working: boolean, device = 'laptop'): LiveSession & {source: string} => ({
  source,
  device: {id: device, name: device},
  origin: 'terminal',
  project: null,
  startedAt: start,
  working,
});

test('the time agents worked is added up per subscription, cell by cell', () => {
  const store = new Store(':memory:', start);
  const live = new Sessions(store);
  live.report('laptop', [session('codex:1', true), session('codex:1', true), session('claude:1', false)], start);
  live.report('laptop', [session('codex:1', true)], start + 4 * minute);
  live.report('laptop', [session('codex:1', false)], start + 7 * minute);
  // First cell: two agents for four minutes, then one for a minute; second cell: one for two.
  assert.deepEqual(store.work('codex:1', 0), [
    {at: start, agentMs: 9 * minute, busyMs: 5 * minute},
    {at: start + WORK_CELL_MS, agentMs: 2 * minute, busyMs: 2 * minute},
  ]);
  assert.deepEqual(store.work('claude:1', 0), [], 'idle agents add nothing');
  store.close();
});

test('a machine gone quiet is not credited for its silence, and its sessions go away', () => {
  const store = new Store(':memory:', start);
  const live = new Sessions(store);
  live.report('laptop', [session('codex:1', true)], start);
  assert.equal(live.of('codex:1', start + KEEP_MS).length, 1);
  live.report('laptop', [session('codex:1', true)], start + 60 * minute);
  const credited = store.work('codex:1', 0).reduce((sum, cell) => sum + cell.agentMs, 0);
  assert.equal(credited, KEEP_MS, 'only as long as a list is kept');
  assert.deepEqual(live.of('codex:1', start + 60 * minute + KEEP_MS + 1), []);
  store.close();
});

test('machines are credited apart, and the time any agent worked stays within its cell', () => {
  const store = new Store(':memory:', start);
  const live = new Sessions(store);
  for (const device of ['laptop', 'server']) live.report(device, [session('codex:1', true, device)], start);
  for (const device of ['laptop', 'server']) live.report(device, [], start + WORK_CELL_MS);
  assert.deepEqual(store.work('codex:1', 0), [{at: start, agentMs: 2 * WORK_CELL_MS, busyMs: WORK_CELL_MS}]);
  assert.deepEqual(
    live.of('codex:1', start).map(s => s.device.name),
    [],
    'an empty list clears the machine',
  );
  store.close();
});
