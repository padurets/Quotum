import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SWIPE, swiped} from '../lib/swipe';

type Event = Partial<Parameters<typeof swiped>[1]>;

/** Events 16 ms apart, unless one says when it comes; the steps they make and whether each was the chart's. */
function run(events: Event[]) {
  let state = SWIPE;
  let at = 1_000;
  const steps: number[] = [];
  const own: boolean[] = [];
  for (const event of events) {
    at = event.timeStamp ?? at + 16;
    const result = swiped(state, {deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, cancelable: true, ...event, timeStamp: at});
    state = result.state;
    if (result.step) steps.push(result.step);
    own.push(result.own);
  }
  return {steps, own};
}

const swipe = (dx: number, count: number) => Array.from({length: count}, (_, i) => ({deltaX: dx * (1 - i / count)}));

test('a swipe steps once, however long it and its momentum run', () => {
  const {steps, own} = run(swipe(12, 60));
  assert.deepEqual(steps, [1]);
  assert.ok(own.every(Boolean), 'every event of it is the chart’s');
  assert.deepEqual(run(swipe(-12, 60)).steps, [-1], 'to the right is back in time');
  assert.deepEqual(run([...swipe(12, 20), {deltaX: 12, timeStamp: 5_000}, ...swipe(12, 20)]).steps, [1, 1], 'a pause ends a gesture');
});

test('a short nudge does not step', () => {
  assert.deepEqual(run(swipe(3, 10)).steps, []);
});

test('the wheel scrolls the page; with Shift it steps', () => {
  const wheel = Array.from({length: 5}, () => ({deltaY: 100}));
  const {steps, own} = run(wheel);
  assert.deepEqual([steps, own.some(Boolean)], [[], false]);
  assert.deepEqual(run(wheel.map(event => ({...event, shiftKey: true}))).steps, [1]);
  assert.deepEqual(run([{deltaX: -100, shiftKey: true}]).steps, [-1], 'as the browser turned it sideways');
  assert.deepEqual(run([{deltaY: 3, deltaMode: 1, shiftKey: true}]).steps, [1], 'a wheel counting lines');
  assert.deepEqual(run([{deltaY: 1, deltaMode: 1, shiftKey: true}]).steps, [], 'a line is less than a step');
});

test('a gesture that starts along the page never steps, even when it turns sideways', () => {
  const {steps, own} = run([{deltaY: 8, deltaX: 2}, {deltaY: 4, deltaX: 6}, ...swipe(12, 30)]);
  assert.deepEqual([steps, own.some(Boolean)], [[], false]);
  assert.deepEqual(run([{deltaX: 8, deltaY: 2}, ...Array.from({length: 20}, () => ({deltaX: 2, deltaY: 10}))]).steps, [1], 'one that starts sideways stays so');
});

test('an event that cannot be held back is left to the page', () => {
  const {steps, own} = run(swipe(12, 30).map(event => ({...event, cancelable: false})));
  assert.deepEqual([steps, own.some(Boolean)], [[], false]);
});
