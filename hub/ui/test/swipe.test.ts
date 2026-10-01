import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SWIPE, swiped} from '../lib/swipe';

type Event = Partial<Parameters<typeof swiped>[1]>;

/** Events 16 ms apart, unless one says when it comes; every accepted pixel delta. */
function run(events: Event[]) {
  let state = SWIPE;
  let at = 1_000;
  const steps: number[] = [];
  const own: boolean[] = [];
  for (const event of events) {
    at = event.timeStamp ?? at + 16;
    const result = swiped(state, {deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, cancelable: true, ...event, timeStamp: at});
    state = result.state;
    if (result.own) steps.push(result.delta);
    own.push(result.own);
  }
  return {steps, own};
}

const swipe = (dx: number, count: number) => Array.from({length: count}, (_, i) => ({deltaX: dx * (1 - i / count)}));

test('every pixel of a swipe and its momentum contributes to continuous movement', () => {
  const {steps, own} = run(swipe(12, 60));
  assert.deepEqual(steps, swipe(12, 60).map(e => e.deltaX));
  assert.ok(own.every(Boolean), 'every event of it is the chart’s');
  assert.deepEqual(run(swipe(-12, 60)).steps, swipe(-12, 60).map(e => e.deltaX));
  assert.equal(swiped({axis: 'y', last: 1_000}, {deltaX: 12, deltaY: 0, deltaMode: 0, shiftKey: false, cancelable: true, timeStamp: 1_200}).own, true, 'a pause releases the axis lock');
});

test('a short nudge moves without a threshold', () => {
  assert.deepEqual(run(swipe(3, 10)).steps, swipe(3, 10).map(e => e.deltaX));
});

test('Shift normalizes the wheel once, with native deltaX and every deltaMode', () => {
  const wheel = Array.from({length: 5}, () => ({deltaY: 100}));
  const {steps, own} = run(wheel);
  assert.deepEqual([steps, own.some(Boolean)], [[], false]);
  assert.deepEqual(run(wheel.map(event => ({...event, shiftKey: true}))).steps, [100, 100, 100, 100, 100]);
  assert.deepEqual(run([{deltaX: -100, deltaY: 50, shiftKey: true}]).steps, [-100]);
  assert.deepEqual(run([{deltaY: 3, deltaMode: 1, shiftKey: true}]).steps, [48]);
  assert.deepEqual(run([{deltaY: 1, deltaMode: 2, shiftKey: true}]).steps, [400]);
  assert.deepEqual(run([{deltaX: 1.5, deltaMode: 7}]).steps, [1.5]);
});

test('a gesture that starts along the page never steps, even when it turns sideways', () => {
  const {steps, own} = run([{deltaY: 8, deltaX: 2}, {deltaY: 4, deltaX: 6}, ...swipe(12, 30)]);
  assert.deepEqual([steps, own.some(Boolean)], [[], false]);
  assert.deepEqual(run([{deltaX: 8, deltaY: 2}, ...Array.from({length: 20}, () => ({deltaX: 2, deltaY: 10}))]).steps, [8, ...Array(20).fill(2)], 'one that starts sideways stays so');
});

test('an event that cannot be held back is left to the page', () => {
  const {steps, own} = run(swipe(12, 30).map(event => ({...event, cancelable: false})));
  assert.deepEqual([steps, own.some(Boolean)], [[], false]);
});
