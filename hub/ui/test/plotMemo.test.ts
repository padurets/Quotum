import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlotMemo} from '../components/plotMemo';

test('current and replacing immutable calculations survive alternating render attempts', () => {
  const current = {cells: [1, 2, 3]}, replacing = {cells: [4, 5, 6]}, memo = new PlotMemo<{sum: number}>();
  let calls = 0;
  const read = (strip: typeof current) => memo.get(() => {calls++; return {sum: strip.cells.reduce((a, b) => a + b, 0)};}, [strip]);
  const first = read(current), next = read(replacing);
  for (let i = 0; i < 100; i++) {
    assert.equal(read(current), first);
    assert.equal(read(replacing), next);
  }
  assert.deepEqual([first, next], [{sum: 6}, {sum: 15}]);
  assert.equal(calls, 2, 'interrupted attempts do not repeat either pure calculation');
  read({cells: [7]});
  assert.notEqual(read(current), first, 'a third input releases the least recently used result');
  assert.equal(calls, 4);
});

test('plot calculation keys snapshot dependencies and follow Object.is', () => {
  const memo = new PlotMemo<object>(), deps: unknown[] = [NaN, -0];
  const first = memo.get(() => ({}), deps);
  assert.equal(memo.get(() => ({}), [NaN, -0]), first);
  deps[1] = 0;
  assert.notEqual(memo.get(() => ({}), deps), first);
  assert.equal(memo.get(() => ({}), [NaN, -0]), first, 'mutating the caller array does not rewrite a retained key');
});
