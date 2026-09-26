import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store, WORK_CELL_MS} from '../store/store.js';
import {CREDIT_MS, KEEP_MS, Sessions, type LiveSession} from '../sessions.js';

const start = 1_800_000_000_000 - (1_800_000_000_000 % WORK_CELL_MS);
const minute = 60_000;

const session = (source: string, working: boolean, device = 'laptop'): LiveSession & {source: string} => ({
  source,
  device: {id: device, name: device},
  origin: 'terminal',
  project: null,
  startedAt: start,
  lastWorkedAt: null,
  working,
});

test('the time agents worked is added up per subscription, cell by cell', () => {
  const store = new Store(':memory:', start);
  const live = new Sessions(store);
  live.report('laptop', 'ann', [session('codex:1', true), session('codex:1', true), session('claude:1', false)], start);
  live.report('laptop', 'ann', [session('codex:1', true)], start + 2 * minute);
  live.report('laptop', 'ann', [session('codex:1', true)], start + 4 * minute);
  live.report('laptop', 'ann', [], start + 6 * minute);
  // Two agents for two minutes, then one for four, across the end of the first cell.
  assert.deepEqual(store.work('codex:1', 0), [
    {at: start, agentMs: 7 * minute, busyMs: 5 * minute},
    {at: start + WORK_CELL_MS, agentMs: minute, busyMs: minute},
  ]);
  assert.deepEqual(store.work('claude:1', 0), [], 'idle agents add nothing');
  store.close();
});

test('a machine gone quiet is credited for a short while, whether or not it is swept first', () => {
  for (const swept of [false, true]) {
    const store = new Store(':memory:', start);
    const live = new Sessions(store);
    live.report('laptop', 'ann', [session('codex:1', true)], start);
    assert.equal(live.of('codex:1', ['ann'], start + KEEP_MS).length, 1);
    if (swept) live.sweep(start + 10 * minute);
    live.report('laptop', 'ann', [session('codex:1', true)], start + 60 * minute);
    live.report('laptop', 'ann', [], start + 61 * minute);
    const credited = store.work('codex:1', 0).reduce((sum, cell) => sum + cell.agentMs, 0);
    assert.equal(credited, CREDIT_MS + minute, swept ? 'swept' : 'reported again');
    store.close();
  }
});

test('machines add up agent time, and the time any of them worked counts overlaps once', () => {
  const store = new Store(':memory:', start);
  const live = new Sessions(store);
  live.report('laptop', 'ann', [session('codex:1', true, 'laptop')], start);
  live.report('server', 'ann', [session('codex:1', true, 'server')], start + minute);
  live.report('laptop', 'ann', [], start + 2 * minute);
  live.report('server', 'ann', [], start + 3 * minute);
  assert.deepEqual(store.work('codex:1', 0), [{at: start, agentMs: 4 * minute, busyMs: 3 * minute}]);
  store.close();
});

test('a board shows the sessions of those who show the subscription on it; a device taken off, none', () => {
  const store = new Store(':memory:', start);
  const live = new Sessions(store);
  live.report('laptop', 'ann', [session('codex:1', true, 'laptop')], start);
  live.report('desktop', 'bob', [session('codex:1', false, 'desktop')], start);
  assert.deepEqual(live.of('codex:1', ['ann'], start).map(s => s.device.name), ['laptop']);
  assert.deepEqual(live.of('codex:1', ['ann', 'bob'], start).map(s => s.device.name), ['desktop', 'laptop']);
  live.forget(['laptop']);
  assert.deepEqual(live.of('codex:1', ['ann', 'bob'], start).map(s => s.device.name), ['desktop']);
  store.close();
});
