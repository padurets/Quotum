import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {STEPS} from '../store/schema.js';

/**
 * Every step a release shipped, by its hash. A database records which steps it has
 * run, so a shipped step that changes afterwards leaves databases without what it now
 * creates. A new layout is a new step: add its hash here once it is released.
 */
const RELEASED = [
  '02cb748c205697bd5af76c42c46d7bdb09ab4ec3d311a7841f89ccf552fb48ff', // 0.2
  '93bef51f9d1b8ff1ad525301dfeac3f98c87068d6211e6e02f6388bc1de4cfb2', // 0.3
];

test('released layout steps never change; new ones come after them', () => {
  const hashes = STEPS.map(step => createHash('sha256').update(step).digest('hex'));
  assert.deepEqual(hashes.slice(0, RELEASED.length), RELEASED);
});
