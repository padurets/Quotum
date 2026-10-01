import {cellsOf} from '../domain/cells.js';
import {compose, type Chunk} from '../domain/history.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {edge, type Sample} from '../domain/quota.js';

const start = 1_800_000_000_000;
const sample = (change: Partial<Sample> = {}): Sample => ({
  sourceId: 'codex',
  provider: 'codex',
  id: 'weekly',
  kind: 'weekly',
  label: null,
  at: start,
  staleAfterMs: 330_000,
  used: 20,
  remaining: 80,
  resetAt: start + 86_400_000,
  minutes: 10080,
  ...change,
});

function series(samples: Sample[], cell = 60_000) {
  const from = Math.floor(samples[0].at / cell) * cell;
  const to = Math.floor(samples.at(-1)!.at / cell) * cell + cell;
  const known = {work: 0, sources: {codex: 0}};
  const chunks = cellsOf([{source: 'codex', window: 'weekly', samples}], [], {}, cell, from, to, known) as unknown as Chunk[];
  return compose(chunks, {now: to, historyStart: 0, known}, {cell, k0: from / cell, k1: to / cell - 1, length: to - from, live: false, key: '', now: to}, new Set(['codex weekly'])).series[0];
}

test('deltas are percentage points between consecutive samples of a window', () => {
  assert.equal(edge(sample(), sample({at: start + 120_000, used: 24})).delta, 4);
});

test('resets, corrections, unknown reset identity and missing observations are excluded', () => {
  const changes: Partial<Sample>[] = [{resetAt: start + 2 * 86_400_000}, {resetAt: null}, {used: 3}, {at: start + 500_000}];
  for (const change of changes) {
    assert.equal(edge(sample(), sample({at: start + 120_000, used: 24, ...change})).valid, false);
  }
});

test('a small reset-time jitter does not invent a new quota window', () => {
  assert.equal(edge(sample(), sample({at: start + 120_000, used: 21, resetAt: start + 86_400_000 + 30_000})).delta, 1);
});

test('an idle rolling window moving its reset time forward is not a reset', () => {
  const idle = sample({used: 0, resetAt: start + 18_000_000});
  assert.equal(edge(idle, sample({at: start + 120_000, used: 0, resetAt: start + 18_120_000})).valid, true);
  assert.equal(edge(idle, sample({at: start + 120_000, used: 2, resetAt: start + 18_121_000})).delta, 2);
  const expired = sample({resetAt: start + 60_000});
  assert.equal(edge(expired, sample({at: start + 180_000, used: 24, resetAt: start + 18_180_000})).valid, false);
});

test('unchanged usage without reset times stays continuous', () => {
  assert.equal(edge(sample({resetAt: null, used: 0}), sample({at: start + 120_000, resetAt: null, used: 0})).valid, true);
});

test('chart continuity breaks only on gaps; a reset is drawn, not counted', () => {
  const later = {resetAt: start + 2 * 86_400_000};
  const result = series([
    sample(),
    sample({at: start + 120_000, used: 30}),
    sample({at: start + 240_000, used: 2, ...later}),
    sample({at: start + 900_000, used: 3, ...later}),
    sample({at: start + 1_020_000, used: 4, ...later}),
  ]);
  assert.deepEqual(result.points.map(p => p[2]), [1, 1, 1, 2, 2]);
  assert.equal(result.consumed, 11);
});

test('series share one time grid: lowest value per cell, breaks only on empty cells', () => {
  const minute = 60_000;
  const point = (at: number, remaining: number) => sample({at: start + at * minute, used: 100 - remaining, remaining});
  const grid = series([point(0, 90), point(2, 88), point(4, 87), point(6, 86), point(8, 85), point(20, 70), point(22, 69)], 5 * minute).points;
  assert.deepEqual(
    grid.map(p => [(p[0] - start) / minute, p[1], p[2]]),
    [[0, 87, 1], [5, 85, 1], [20, 69, 2]],
  );
  // A 6-minute hiccup inside adjacent cells is below the grid resolution.
  const hiccup = series([point(0, 50), point(7, 49)], 5 * minute);
  assert.deepEqual(hiccup.points.map(p => p[2]), [1, 1]);
});
