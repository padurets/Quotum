import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unlessSame} from '../lib/http';

test('an answer the same as the one before keeps the value it replaces, so nothing is rendered again', () => {
  const before = {revision: 3, sources: [{id: 'a', windows: [1, 2]}]};
  assert.equal(unlessSame({revision: 3, sources: [{id: 'a', windows: [1, 2]}]})(before), before);
  const changed = {revision: 4, sources: [{id: 'a', windows: [1, 2]}]};
  assert.equal(unlessSame(changed)(before), changed);
});
