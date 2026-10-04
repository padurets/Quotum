import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ALWAYS, lastOn, sessionsAt, type DemoSet, type Wave} from '../model.js';

test('the last work of a wave stays fixed throughout its idle part, including before the demo starts', () => {
  const wave: Wave = {period: 1000, on: 200, phase: 100};
  assert.equal(lastOn(wave, 100), 100);
  assert.equal(lastOn(wave, 299), 299);
  assert.equal(lastOn(wave, 300), 299);
  assert.equal(lastOn(wave, 1000), 299);
  assert.equal(lastOn(wave, -1), -701);
  assert.equal(lastOn({...wave, on: 0}, 100), null);
  assert.equal(lastOn(ALWAYS, -1000), -1000);
});

test('demo sessions omit last work while working and when no work was seen after their start', () => {
  const set: DemoSet = {id: 'test', about: '', scene: '', entries: [{
    kind: 'card', id: 'test', provider: 'codex', plan: '', machines: ['machine'], history: 0, windows: [], expect: [],
    agents: [
      {machine: 'machine', origin: 'terminal', project: 'idle', since: 0, works: {period: 1000, on: 200, phase: 0}},
      {machine: 'machine', origin: 'editor', project: 'working', since: 0, works: ALWAYS},
      {machine: 'machine', origin: 'app', project: 'unseen', since: 300, works: {period: 1000, on: 200, phase: 0}},
      {machine: 'machine', origin: 'terminal', project: 'never', since: 0},
    ],
  }]};
  const read = (t: number) => sessionsAt(set, {kind: 'machine', id: 'machine', expect: []}, 10_000, t);
  assert.deepEqual(read(400).map(s => s.lastWorkedAt), [new Date(10_199).toISOString(), undefined, undefined, undefined]);
  assert.deepEqual(read(800), read(400));
});

test('synthetic IDs are assigned before presence and work filters, even for identical twins', () => {
  const set: DemoSet = {id: 'identity', about: '', scene: '', entries: [{
    kind: 'card', id: 'twins', provider: 'codex', plan: '', machines: ['machine'], history: 0, windows: [], expect: [],
    agents: [
      {machine: 'machine', origin: 'terminal', project: 'same', since: 0, until: 200, works: ALWAYS},
      {machine: 'machine', origin: 'terminal', project: 'same', since: 0, works: {period: 1000, on: 100, phase: 0}},
      {machine: 'machine', origin: 'terminal', project: 'old', since: 0, legacy: true},
    ],
  }]};
  const read = (t: number) => sessionsAt(set, {kind: 'machine', id: 'machine', expect: []}, 10_000, t);
  const [a, b, old] = read(0);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.match(b.sessionId!, /^[0-9a-f]{32}$/);
  assert.equal(read(400)[0].sessionId, b.sessionId, 'the survivor keeps its ID while idle and after a twin exits');
  assert.equal(read(1000)[0].sessionId, b.sessionId, 'working again keeps its ID');
  assert.equal(old.sessionId, null);
});
