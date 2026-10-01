import {test} from 'node:test';
import assert from 'node:assert/strict';
import {KEY_STORAGE} from '../catalogue.js';
import {known} from '../../ui/i18n/index.js';

test('every durable app key state has a fixture and both its label and explanation', () => {
  assert.deepEqual(Object.keys(KEY_STORAGE), ['keystore', 'file', 'wasFile', 'retainedFile', 'waiting', 'missing', 'mismatch']);
  for (const [scene, state] of Object.entries(KEY_STORAGE)) {
    assert.ok(known(`trustedKeys.scene.${scene}`));
    assert.ok(known(state.outcome === 'mismatch' ? 'trustedKeys.mismatch' : `trustedKeys.${state.state}`));
    assert.deepEqual(Object.keys(state).sort(), ['busy', 'outcome', 'resetAvailable', 'retainedFile', 'state', 'wasFile']);
    assert.equal(state.busy, false, 'busy belongs to a transient test, not a durable board scene');
    assert.equal(state.resetAvailable, ['waiting', 'missing'].includes(state.state));
  }
});
