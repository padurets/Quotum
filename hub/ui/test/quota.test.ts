import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freshness, PULSE_FOR} from '../lib/quota';

test('a card’s dot is fresh for half a minute, then fades to grey over five', () => {
  assert.equal(freshness(0), 1);
  assert.equal(freshness(PULSE_FOR), 1);
  assert.ok(freshness(2 * 60_000) > 0.3 && freshness(2 * 60_000) < 1);
  assert.ok(freshness(4 * 60_000) < freshness(2 * 60_000));
  assert.equal(freshness(PULSE_FOR + 5 * 60_000), 0);
  assert.equal(freshness(15 * 60_000), 0, 'a quarter of an hour in eco mode is grey, not a warning');
  assert.equal(freshness(Infinity), 0);
});

test('the fade goes in half-minute steps, so the page is idle in between', () => {
  const step = (seconds: number) => freshness(PULSE_FOR + seconds * 1000);
  assert.equal(step(1), step(29), 'one step for half a minute');
  assert.ok(step(31) < step(29), 'the next one after it');
  const values = new Set(Array.from({length: 301}, (_, s) => step(s)));
  assert.ok(values.size <= 11, `at most ten steps and grey, not ${values.size}`);
});
