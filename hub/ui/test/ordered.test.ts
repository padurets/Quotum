import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ordered, type Preparation} from '../../server/domain/prepare';

test('delegated sorting keeps bounded step results and comparisons while preserving stable output', () => {
  const input = Array.from({length: 4096}, (_, index) => ({key: index * 83 % 23, index}));
  const before = [...input], expected = [...input].sort((a, b) => a.key - b.key);
  let comparisons = 0;
  const work = function* (): Preparation<typeof input> {
    return yield* ordered(input, (a, b) => {comparisons++; return a.key - b.key;});
  }();
  const pending = new Set<IteratorYieldResult<void|16>>();
  let steps = 0;
  for (;;) {
    const count = comparisons, step = work.next();
    assert.ok(comparisons - count <= 1, 'one step cannot hide a batch of comparisons');
    if (step.done) {
      assert.deepEqual(step.value, expected); assert.deepEqual(input, before);
      break;
    }
    assert.equal(step.value, undefined); pending.add(step); steps++;
  }
  assert.ok(steps >= input.length, 'copying and merging must remain interruptible');
  assert.equal(pending.size, 1, 'numeric work must not allocate a result for each yielded step');
  assert.ok(Object.isFrozen([...pending][0]), 'a consumer cannot corrupt the shared pending result');
});

test('sorting reads lazily and closes its input once when delegated work is cancelled', () => {
  for (const mode of ['return', 'throw'] as const) {
    const calls: string[] = [], value = [9], error = new Error('cancelled');
    const iterator: Iterator<number> = {
      next() {calls.push('next'); return {value: 3, done: false};},
      return() {calls.push('return'); return {value: undefined, done: true as const};},
    };
    // Iteration calls the method itself, even when its own .call is inaccessible.
    for (const method of [iterator.next, iterator.return!]) Object.defineProperty(method, 'call', {get() {throw new Error('unexpected call property');}});
    const input = {[Symbol.iterator]() {calls.push('iterator'); return iterator;}};
    const work = function* (): Preparation<number[]> {return yield* ordered(input, (a, b) => a - b);}();
    assert.deepEqual(calls, []);
    assert.deepEqual(work.next(), {value: undefined, done: false});
    assert.deepEqual(calls, ['iterator', 'next']);
    if (mode === 'return') assert.deepEqual(work.return(value), {value, done: true});
    else assert.throws(() => work.throw(error), caught => caught === error);
    assert.deepEqual(calls, ['iterator', 'next', 'return']);
    assert.deepEqual(work.next(), {value: undefined, done: true});
  }
});

test('an input failure ends sorting without replacing it with a closing failure', () => {
  const failure = new Error('input failure'), closing = new Error('closing failure');
  let reads = 0, closes = 0;
  const input = {[Symbol.iterator]() {return {
    next() {if (reads++) throw failure; return {value: 1, done: false};},
    return() {closes++; throw closing;},
  };}};
  const work = ordered(input, (a, b) => a - b);
  assert.equal(work.next().done, false);
  assert.throws(() => work.next(), caught => caught === failure);
  assert.equal(closes, 0); assert.deepEqual(work.next(), {value: undefined, done: true});
});
test('chronological history rows stay linear without losing stable ties', () => {
  const input = Array.from({length: 4096}, (_, index) => ({at: 1_790_000_000_000 + Math.floor(index / 2) * 600_000, index}));
  const before = [...input];
  let comparisons = 0, steps = 0;
  const work = ordered(input, (a, b) => {comparisons++; return a.at - b.at;});
  for (;;) {
    const count = comparisons, step = work.next();
    assert.ok(comparisons - count <= 1, 'checking order stays interruptible');
    if (step.done) {
      assert.deepEqual(step.value, before);
      assert.deepEqual(input, before);
      break;
    }
    steps++;
  }
  assert.ok(steps <= 2 * input.length, 'already ordered rows need no logarithmic merge passes');
  assert.ok(comparisons <= input.length, 'chronological cells are checked only once');
});

test('an inversion near either end falls back to stable sorting without mutating the input', () => {
  for (const length of [2, 3, 17, 127, 1024]) {
    for (const at of [0, length - 2]) {
      const input = Array.from({length}, (_, index) => ({key: Math.floor(index / 2), index}));
      input[at].key = length;
      const before = [...input], expected = [...input].sort((a, b) => a.key - b.key);
      let comparisons = 0;
      const work = ordered(input, (a, b) => {comparisons++; return a.key - b.key;});
      for (;;) {
        const count = comparisons, step = work.next();
        assert.ok(comparisons - count <= 1, 'falling back does not combine comparison steps');
        if (step.done) {assert.deepEqual(step.value, expected); break;}
      }
      assert.deepEqual(input, before);
    }
  }
});

test('cancellation and comparator errors during order checks retain the generator lifecycle', () => {
  for (const mode of ['return', 'throw', 'compare'] as const) {
    let reads = 0, closes = 0, comparisons = 0;
    const failure = new Error('order check failed');
    const input: Iterable<number> = {[Symbol.iterator]() {return {
      next() {return reads < 5 ? {value: reads++, done: false} : {value: undefined, done: true};},
      return() {closes++; return {value: undefined, done: true};},
    };}};
    const work = ordered(input, (a, b) => {comparisons++; if (mode === 'compare') throw failure; return a - b;});
    for (let i = 0; i < 5; i++) assert.equal(work.next().done, false);
    assert.equal(comparisons, 0);
    if (mode === 'compare') assert.throws(() => work.next(), caught => caught === failure);
    else {
      assert.equal(work.next().done, false);
      assert.equal(comparisons, 1);
      if (mode === 'return') assert.deepEqual(work.return([]), {value: [], done: true});
      else assert.throws(() => work.throw(failure), caught => caught === failure);
    }
    assert.equal(closes, 0, 'the exhausted input is not closed twice');
    assert.deepEqual(work.next(), {value: undefined, done: true});
  }
});
