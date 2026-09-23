import {test} from 'node:test';
import assert from 'node:assert/strict';
import {draggedRange, MIN_TIME_RANGE, parseTimeRange, timeRangeLabel} from '../lib/timeRange';

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

test('the address holds a range the hub can read, or none', () => {
  const at = (from: number, to: number) => `?board=b1&from=${from}&to=${to}`;
  assert.deepEqual(parseTimeRange(at(now - 3_600_000, now - 1_800_000), now), {from: now - 3_600_000, to: now - 1_800_000});
  assert.deepEqual(parseTimeRange(at(now - 3_600_000, now + 3_600_000), now), {from: now - 3_600_000, to: now + 3_600_000}, 'the hub ends it now');
  for (const search of [
    at(now + minute, now + 60 * minute),
    at(now - 10 * minute, now + 60 * minute),
    at(now - 60 * minute, now - 50 * minute),
    at(now - 40 * 86_400_000, now),
    '?from=1e12&to=2e12',
    `?from=${now - 3_600_000}`,
    '',
  ]) {
    assert.equal(parseTimeRange(search, now), null, search);
  }
});

test('a range is named by its times, its days, or both', () => {
  const day = new Date(2026, 8, 23, 12, 40).getTime();
  const sameDay = timeRangeLabel({from: day, to: day + 150 * minute});
  const acrossMidnight = timeRangeLabel({from: day + 10 * 60 * minute, to: day + 14 * 60 * minute});
  const days = timeRangeLabel({from: day, to: day + 4 * 86_400_000});
  assert.match(sameDay, /^[^–]+, [^–]+–[^–]+$/, 'one day, then two times');
  assert.equal(acrossMidnight.split(' – ').length, 2, 'a day and a time at each end');
  assert.doesNotMatch(days, /\d:\d/, 'days alone');
});
