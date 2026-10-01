import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StackPaths} from '../lib/stackPaths';

const groups = [{group: {key: 'p', name: 'P', cells: [[0, 2], [10, 3], [30, 1]] as [number, number][]}}, {group: {key: 'q', name: 'Q', cells: [[0, 1], [10, 2]] as [number, number][]}}];

test('narrow stacks join adjacent bars, preserve holes and follow muted lower groups', () => {
  const cache = new StackPaths();
  const both = cache.draw(groups, 0, .1, 10, 140, 10);
  assert.equal(both[0], 'M0.0,92.0L1.0,92.0L1.0,82.0L2.0,82.0L2.0,112.0L1.0,112.0L1.0,112.0L0.0,112.0ZM3.0,102.0L4.0,102.0L4.0,112.0L3.0,112.0Z');
  assert.equal((both[1].match(/M/g) ?? []).length, 1);
  const muted = cache.draw([groups[1]], 0, .1, 10, 140, 10);
  assert.ok(muted[0].startsWith('M0.0,102.0L1.0,102.0'));
  assert.deepEqual(cache.draw(groups, 0, .1, 10, 140, 10), both);
});

test('wide bars keep their gaps when the plot scale and data change', () => {
  const cache = new StackPaths();
  const wide = cache.draw(groups, 0, 1, 10, 140, 10);
  assert.equal((wide[0].match(/M/g) ?? []).length, 3);
  assert.ok(wide[0].startsWith('M0.5,92.0L9.5,92.0'));
  const moved = cache.draw([{group: {...groups[0].group, cells: [[10, 4]]}}], 10, 1, 10, 140, 10);
  assert.equal(moved[0], 'M0.5,72.0L9.5,72.0L9.5,112.0L0.5,112.0Z');
});
