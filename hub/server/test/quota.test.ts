import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bucketize, edge, kindOf, series, type Point, type Sample} from '../domain/quota.js';

const start = 1_800_000_000_000;
const sample = (change: Partial<Sample> = {}): Sample => ({
  sourceId: 'codex',
  provider: 'codex',
  id: 'weekly',
  label: 'Weekly',
  sourceAt: start,
  used: 20,
  remaining: 80,
  resetAt: start + 86_400_000,
  minutes: 10080,
  ...change,
});

test('deltas are percentage points within exactly one source and window', () => {
  assert.equal(edge(sample(), sample({sourceAt: start + 120_000, used: 24})).delta, 4);
  assert.equal(edge(sample(), sample({sourceAt: start + 120_000, id: 'session', used: 90})).valid, false);
  assert.equal(edge(sample(), sample({sourceAt: start + 120_000, sourceId: 'codex:work', used: 90})).valid, false);
});

test('resets, corrections, unknown reset identity and missing observations are excluded', () => {
  const changes: Partial<Sample>[] = [{resetAt: start + 2 * 86_400_000}, {resetAt: null}, {used: 3}, {sourceAt: start + 500_000}];
  for (const change of changes) {
    assert.equal(edge(sample(), sample({sourceAt: start + 120_000, used: 24, ...change})).valid, false);
  }
});

test('a small reset-time jitter does not invent a new quota window', () => {
  assert.equal(edge(sample(), sample({sourceAt: start + 120_000, used: 21, resetAt: start + 86_400_000 + 30_000})).delta, 1);
});

test('an idle rolling window moving its reset time forward is not a reset', () => {
  const idle = sample({used: 0, resetAt: start + 18_000_000});
  assert.equal(edge(idle, sample({sourceAt: start + 120_000, used: 0, resetAt: start + 18_120_000})).valid, true);
  assert.equal(edge(idle, sample({sourceAt: start + 120_000, used: 2, resetAt: start + 18_121_000})).delta, 2);
  const expired = sample({resetAt: start + 60_000});
  assert.equal(edge(expired, sample({sourceAt: start + 180_000, used: 24, resetAt: start + 18_180_000})).valid, false);
});

test('unchanged usage without reset times stays continuous', () => {
  assert.equal(edge(sample({resetAt: null, used: 0}), sample({sourceAt: start + 120_000, resetAt: null, used: 0})).valid, true);
});

test('chart continuity breaks only on gaps; a reset is drawn, not counted', () => {
  const later = {resetAt: start + 2 * 86_400_000};
  const result = series([
    sample(),
    sample({sourceAt: start + 120_000, used: 30}),
    sample({sourceAt: start + 240_000, used: 2, ...later}),
    sample({sourceAt: start + 900_000, used: 3, ...later}),
    sample({sourceAt: start + 1_020_000, used: 4, ...later}),
  ]);
  assert.deepEqual(result.points.map(p => p.segment), [0, 0, 0, 1, 1]);
  assert.equal(result.consumed, 11);
});

test('windows are classified by length, with a label fallback', () => {
  assert.equal(kindOf(300, 'Gemini 5-hour'), 'session');
  assert.equal(kindOf(10080, 'Weekly'), 'weekly');
  assert.equal(kindOf(null, 'Claude/GPT weekly'), 'weekly');
  assert.equal(kindOf(60, 'Hourly burst'), 'other');
});

test('series share one time grid: lowest value per bucket, breaks only on empty buckets', () => {
  const minute = 60_000;
  const point = (at: number, remaining: number): Point => ({at: start + at * minute, used: 100 - remaining, remaining, segment: 0});
  const grid = bucketize([point(0, 90), point(2, 88), point(4, 87), point(6, 86), point(8, 85), point(20, 70), point(22, 69)], 5 * minute);
  assert.deepEqual(
    grid.map(p => [(p.at - start) / minute, p.remaining, p.segment]),
    [[0, 87, 0], [5, 85, 0], [20, 69, 1]],
  );
  // A 6-minute hiccup inside adjacent buckets is below the grid resolution.
  const hiccup = bucketize([point(0, 50), point(7, 49)], 5 * minute);
  assert.deepEqual(hiccup.map(p => p.segment), [0, 0]);
});
