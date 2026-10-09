import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SETS} from '../../demo/catalogue.js';
import {cards, DAY} from '../../demo/model.js';
import {STILL_FOR} from '../../demo/setup.js';
import {panningSet} from '../fixture.js';

test('the still benchmark retains every quota value and past reset across grid alignment', () => {
  const original = cards(SETS[0]), stable = cards(panningSet(SETS[0]));
  assert.equal(stable.length, original.length);
  let deferred = 0, past = 0;
  for (const [index, card] of stable.entries()) for (let t = -75 * DAY; t <= 0; t += 300_000) {
    for (const [j, at] of card.windows.entries()) {
      const before = original[index].windows[j](t), after = at(t);
      assert.deepEqual({...after, resetsAt: before.resetsAt}, before);
      if (before.resetsAt !== null && before.resetsAt > 0 && before.resetsAt < STILL_FOR) {
        assert.equal(after.resetsAt, STILL_FOR); deferred++;
      } else {assert.deepEqual(after, before); past++;}
    }
  }
  assert.ok(deferred > 0 && past > 0);
});
