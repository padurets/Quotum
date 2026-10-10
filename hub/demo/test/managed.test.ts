import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {SETS} from '../catalogue.js';
import {addressOf, Demo} from '../index.js';
import {audited, deadline, partial, signalOptions, start} from '../../server/test/shutdownHarness.js';

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

test('the demo watchdog lets its busy child reach the hub shutdown deadline', signalOptions, async t => {
  const hub = await start(t, false, 'busy');
  await partial(t, hub.port);
  const demo = new Demo({set: SETS[0], scene: SETS[0].scene, still: true, address: addressOf({}), dataDir: hub.dir, onExit: () => {}});
  // Exercise the real parent stop with an owned child, without seeding a full board.
  Object.assign(demo, {hub: hub.child});
  await deadline(demo.stop(), 6500);
  assert.deepEqual(await hub.exited, {code: 0, signal: null}, 'the parent did not SIGKILL before finalization');
  audited(hub.dir);
});
