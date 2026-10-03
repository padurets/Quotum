import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Preparations, drain, type Preparation} from '../lib/prepare';
import {ordered} from '../../server/domain/prepare';
import {HistoryTile} from '../lib/historyTiles';
import type {Chunk} from '../../server/domain/history';

export function sliced() {
  const tasks: (() => void)[] = [];
  let clock = 0, disposed = 0;
  const scheduler = new Preparations({now: () => clock++, post: run => tasks.push(run), dispose: () => {disposed++;}});
  const tick = () => tasks.shift()?.();
  const finish = () => {for (let i = 0; tasks.length && i < 100_000; i++) tick(); assert.equal(tasks.length, 0);};
  return {scheduler, tasks, tick, finish, disposed: () => disposed};
}

test('the real scheduler retains one latest generator per owner and releases cancelled buffers', () => {
  const h = sliced(), a = {}, b = {};
  let returned = 0, count = 0;
  const completed: number[] = [];
  const work = function* (result: number): Preparation<number> {try {for (let i = 0; i < 1_000; i++) {count++; yield;} return result;} finally {returned++;}};
  h.scheduler.replace(a, work(1), () => true, v => completed.push(v));
  h.tick(); assert.ok(count > 0 && count < 1_000, 'a deadline must interrupt the actual generator');
  h.scheduler.replace(a, work(2), () => true, v => completed.push(v));
  assert.equal(returned, 1);
  for (let i = 3; i < 30; i++) h.scheduler.replace(a, work(i), () => true, v => completed.push(v));
  h.scheduler.replace(b, work(30), () => false, v => completed.push(v));
  assert.equal(h.scheduler.size, 2); assert.equal(h.tasks.length, 1, 'stream replacements cannot queue more messages');
  h.finish(); assert.deepEqual(completed, [29]);
  assert.equal(h.scheduler.size, 0); assert.equal(h.tasks.length, 0);
  h.scheduler.dispose(); assert.equal(h.disposed(), 1);
});

test('stable sliced sorting uses the same producer as sync drain and preserves ties', () => {
  const input = Array.from({length: 2_000}, (_, i) => ({value: i * 73 % 19, i}));
  const expected = [...input].sort((a, b) => a.value - b.value);
  assert.deepEqual(drain(ordered(input, (a, b) => a.value - b.value)), expected);
  const h = sliced(); let result: typeof input | null = null;
  h.scheduler.replace({}, ordered(input, (a, b) => a.value - b.value), () => true, value => {result = value;});
  h.tick(); assert.equal(result, null);
  h.finish(); assert.deepEqual(result, expected);
});

test('staging session, device and series changes cannot mutate a live tile or a retained chunk', () => {
  const cell = 60_000, known = {work: 0, sources: {s: 0}};
  const original: Chunk = {from: 0, to: cell, series: [{source: 's', window: 'w', hold: cell, open: 90, cells: [[0, 80, 10, cell]]}], activity: {sessions: [['ref', 's', 'old', 'd']], devices: {d: 'old'}, cells: [[0, cell, [0], [['p', '"old"', cell]]]]}, resets: [], grants: []};
  const tile = new HistoryTile(0, cell); tile.merge(original, known); tile.readTo = tile.validTo = cell; tile.writeSeq = 1;
  const before = tile.chunk(known), copy = structuredClone(before);
  const changed: Chunk = {...original, series: [{...original.series[0], cells: [[0, 40, 40, cell]]}], activity: {...original.activity, sessions: [['ref', 's', 'new', 'd']], devices: {d: 'new'}}};
  const work = tile.staged(changed, known);
  for (let i = 0; i < 100; i++) {if (work.next().done) break; assert.deepEqual(tile.chunk(known), copy); assert.equal(tile.writeSeq, 1);}
  work.return(tile);
  assert.deepEqual(before, copy);
  const staged = drain(tile.staged(changed, known));
  assert.equal(staged.chunk(known).series[0].cells[0][1], 40);
  assert.equal(staged.chunk(known).activity.devices.d, 'new');
  assert.deepEqual(tile.chunk(known), copy);
  assert.deepEqual(before, copy, 'later merges leave prior snapshots immutable');
});
