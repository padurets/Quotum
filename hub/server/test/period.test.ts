import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluatedRange, intersectPeriod, parsePeriod, periodKey} from '../domain/period.js';

test('a viewing range keeps its exclusive end while live accounting advances without new evidence', () => {
  const hour = 3_600_000, now = 10 * hour;
  const live = parsePeriod({mode: 'live', periodMs: hour})!;
  const fixed = parsePeriod({mode: 'range', from: now - hour, to: now})!;
  assert.deepEqual(evaluatedRange(live, now), evaluatedRange(fixed, now));
  assert.deepEqual(evaluatedRange(live, now + hour / 2), {from: now - hour / 2, to: now + hour / 2});
  assert.deepEqual(evaluatedRange(fixed, now + hour / 2), {from: now - hour, to: now});
  assert.equal(intersectPeriod(evaluatedRange(fixed, now), {from: now, to: now + hour}), null);
  assert.equal(periodKey(live), periodKey({...live}));
  for (const invalid of [{mode: 'live', periodMs: 1}, {mode: 'live', periodMs: 32 * 24 * hour}, {mode: 'range', from: -1, to: hour}, {mode: 'range', from: 1.5, to: hour}, {mode: 'range', from: Infinity, to: Infinity}]) assert.equal(parsePeriod(invalid), null);
});
