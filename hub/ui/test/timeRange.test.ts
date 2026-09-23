import {test} from 'node:test';
import assert from 'node:assert/strict';
import {draggedRange, MIN_TIME_RANGE} from '../lib/timeRange';

const now = 1_800_000_000_000;
const minute = 60_000;

test('a dragged range is of measurements, whichever way it was dragged', () => {
  assert.deepEqual(draggedRange(now - 30 * minute, now - 90 * minute, now), {from: now - 90 * minute, to: now - 30 * minute});
  assert.deepEqual(draggedRange(now - 60 * minute, now + 60 * minute, now), {from: now - 60 * minute, to: now}, 'the future is cut off');
  assert.equal(draggedRange(now + minute, now + 60 * minute, now), null);
});

test('a dragged range too short to read grows around its middle, on whole minutes', () => {
  const range = draggedRange(now - 62 * minute + 5_000, now - 58 * minute, now)!;
  assert.equal(range.to - range.from >= MIN_TIME_RANGE, true);
  assert.equal(range.from % minute, 0);
  assert.ok(range.from < now - 60 * minute && range.to > now - 60 * minute);
  const atNow = draggedRange(now - 2 * minute, now, now)!;
  assert.ok(atNow.to >= now && atNow.to - atNow.from >= MIN_TIME_RANGE, 'at the right edge it grows to the left');
});
