import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentTime, workTime, type Stretch} from '../domain/work.js';

const stretch = (from: number, to: number, project: string | null = 'quotum', device = 'laptop'): Stretch => ({
  source: 'codex:1',
  device,
  user: 'ann',
  origin: 'terminal',
  project,
  folder: null,
  startedAt: 0,
  from,
  to,
});

test('the time any agent worked counts each moment once', () => {
  assert.equal(workTime([]), 0);
  assert.equal(workTime([stretch(0, 100), stretch(20, 50)]), 100, 'one within another');
  assert.equal(workTime([stretch(50, 100), stretch(0, 50)]), 100, 'one after another, in any order');
  assert.equal(workTime([stretch(0, 10), stretch(20, 30)]), 20, 'apart');
  assert.equal(workTime([stretch(0, 60), stretch(40, 100), stretch(200, 210)]), 110, 'overlapping, then apart');
});

test('agent time adds up the stretches of each group: two agents at once count twice', () => {
  const stretches = [stretch(0, 100), stretch(0, 100, 'quotum', 'server'), stretch(50, 80, 'billing'), stretch(0, 30, null)];
  assert.deepEqual(Object.fromEntries(agentTime(stretches, s => String(s.project))), {quotum: 200, billing: 30, null: 30});
  assert.deepEqual(Object.fromEntries(agentTime(stretches, s => s.device)), {laptop: 160, server: 100});
});
