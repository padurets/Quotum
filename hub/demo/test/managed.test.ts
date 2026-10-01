import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {SETS} from '../catalogue.js';
import {addressOf, Demo} from '../index.js';

test('a supplied demo directory stays owned by its caller on stop', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'quotum-demo-owned-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const sentinel = path.join(dir, 'foreign-sentinel');
  writeFileSync(sentinel, 'keep');
  const demo = new Demo({set: SETS[0], scene: SETS[0].scene, still: true, address: addressOf({}), dataDir: dir, onExit: () => {}});
  await demo.stop();
  assert.equal(existsSync(sentinel), true);
});

test('a demo removes a temporary directory it created itself', async () => {
  const demo = new Demo({set: SETS[0], scene: SETS[0].scene, still: true, address: addressOf({}), onExit: () => {}});
  assert.equal(existsSync(demo.dir), true);
  await demo.stop();
  assert.equal(existsSync(demo.dir), false);
});
