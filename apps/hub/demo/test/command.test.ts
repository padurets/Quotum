import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {addressOf, parseArgs} from '../index.js';

test('desktop capture isolates hub configuration and only inherits the requested port', async () => {
  const capture = fileURLToPath(new URL('../desktopCapture.ts', import.meta.url));
  await assert.rejects(
    promisify(execFile)(process.execPath, ['--import', 'tsx', capture], {
      env: {...process.env, QUOTUM_LOCAL_KEY: '', QUOTUM_PUBLIC_URL: 'invalid', QUOTUM_PORT: 'bad'},
    }),
    /QUOTUM_PORT must be a port number/,
  );
});

test('the command takes a set and a reset scene, and refuses anything else with the lists', () => {
  assert.deepEqual([parseArgs([]).set.id, parseArgs([]).scene], ['all', 'announced']);
  assert.deepEqual(
    [parseArgs(['onboarding', '--still']).set.id, parseArgs(['onboarding']).scene],
    ['onboarding', 'quiet'],
  );
  assert.deepEqual(
    [parseArgs(['showcase']).set.id, parseArgs(['showcase']).scene],
    ['showcase', 'showcase'],
    'a set starts with its own scene',
  );
  assert.deepEqual(
    [parseArgs(['--resets', 'timeout']).set.id, parseArgs(['--resets', 'timeout']).scene],
    ['all', 'timeout'],
  );
  assert.throws(() => parseArgs(['nope']), /Unknown set "nope"[\s\S]*sets: +all/);
  assert.throws(
    () => parseArgs(['--resets', 'nope']),
    /Unknown reset scene "nope"[\s\S]*scenes: +announced/,
  );
  assert.throws(() => parseArgs(['--resets']), /Unknown reset scene/);
  assert.throws(() => parseArgs(['all', 'showcase']), /Unknown argument "showcase"/);
  assert.throws(() => parseArgs(['--', '--']), /Unknown argument "--"/);
  assert.deepEqual(
    [
      parseArgs(['--', 'showcase', '--still']).set.id,
      parseArgs(['--', 'showcase', '--still']).still,
    ],
    ['showcase', true],
    'a leading -- separator is ignored for package-manager forwarding',
  );
  assert.deepEqual(
    [parseArgs([]).still, parseArgs(['showcase', '--still']).still],
    [false, true],
    'still: measurements stop, running agents still work',
  );
});

test('the demo reaches the hub where it listens and lets it answer that host', () => {
  assert.deepEqual(addressOf({}), {
    port: 8080,
    bind: '127.0.0.1',
    host: '127.0.0.1',
    base: 'http://127.0.0.1:8080',
    hosts: '127.0.0.1,localhost',
  });
  const any = addressOf({
    QUOTUM_BIND: '0.0.0.0',
    QUOTUM_PORT: '9000',
    QUOTUM_ALLOWED_HOSTS: 'quotum.example.com',
  });
  assert.deepEqual(
    [any.base, any.hosts],
    ['http://127.0.0.1:9000', 'quotum.example.com,127.0.0.1'],
    "the developer's hosts, and the one the demo uses",
  );
  assert.equal(addressOf({QUOTUM_BIND: '::'}).host, '127.0.0.1');
  const v6 = addressOf({QUOTUM_BIND: '::1'});
  assert.deepEqual([v6.base, v6.hosts], ['http://[::1]:8080', '127.0.0.1,localhost,[::1]']);
  assert.equal(addressOf({QUOTUM_BIND: '10.0.0.5'}).base, 'http://10.0.0.5:8080');
  for (const port of ['abc', '0', '70000', '80.5'])
    assert.throws(
      () => addressOf({QUOTUM_PORT: port}),
      /QUOTUM_PORT must be a port number from 1 to 65535/,
      port,
    );
});
