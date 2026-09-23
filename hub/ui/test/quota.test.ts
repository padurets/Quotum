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
