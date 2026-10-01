import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plotPath} from '../lib/plotPath';

test('straight rounded runs retain their endpoints without redundant vertices', () => {
  assert.equal(plotPath([Array.from({length: 60}, (_, i): [number, number] => [i, 80])]), 'M0.0,80.0L59.0,80.0');
  assert.equal(plotPath([[[.12, .21], [.22, .31], [.32, .41]]]), 'M0.1,0.2L0.3,0.4');
});

test('steps and holes retain every turning point and their separate runs', () => {
  assert.equal(plotPath([[[0, 0], [1, 0], [1, 1], [2, 1]], [[3, 1], [4, 1]]]), 'M0.0,0.0L1.0,0.0L1.0,1.0L2.0,1.0M3.0,1.0L4.0,1.0');
});

test('collinear reversal keeps the far corner rather than shortening the drawn line', () => {
  assert.equal(plotPath([[[0, 0], [10, 10], [0, 0]]]), 'M0.0,0.0L10.0,10.0L0.0,0.0');
});
