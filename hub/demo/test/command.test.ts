import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addressOf, parseArgs} from '../index.js';

test('the command takes a set and a reset scene, and refuses anything else with the lists', () => {
  assert.deepEqual([parseArgs([]).set.id, parseArgs([]).scene], ['all', 'announced']);
  assert.deepEqual([parseArgs(['showcase']).set.id, parseArgs(['showcase']).scene], ['showcase', 'showcase'], 'a set starts with its own scene');
  assert.deepEqual([parseArgs(['--resets', 'timeout']).set.id, parseArgs(['--resets', 'timeout']).scene], ['all', 'timeout']);
  assert.throws(() => parseArgs(['nope']), /Unknown set "nope"[\s\S]*sets: +all/);
  assert.throws(() => parseArgs(['--resets', 'nope']), /Unknown reset scene "nope"[\s\S]*scenes: +announced/);
  assert.throws(() => parseArgs(['--resets']), /Unknown reset scene/);
  assert.throws(() => parseArgs(['all', 'showcase']), /Unknown argument "showcase"/);
});

test('the demo reaches the hub where it listens and lets it answer that host', () => {
  assert.deepEqual(addressOf({}), {port: 8080, bind: '127.0.0.1', host: '127.0.0.1', base: 'http://127.0.0.1:8080', hosts: '127.0.0.1,localhost'});
  const any = addressOf({QUOTUM_BIND: '0.0.0.0', QUOTUM_PORT: '9000', QUOTUM_ALLOWED_HOSTS: 'quotum.example.com'});
  assert.deepEqual([any.base, any.hosts], ['http://127.0.0.1:9000', 'quotum.example.com,127.0.0.1'], "the developer's hosts, and the one the demo uses");
  assert.equal(addressOf({QUOTUM_BIND: '::'}).host, '127.0.0.1');
  const v6 = addressOf({QUOTUM_BIND: '::1'});
  assert.deepEqual([v6.base, v6.hosts], ['http://[::1]:8080', '127.0.0.1,localhost,[::1]']);
  assert.equal(addressOf({QUOTUM_BIND: '10.0.0.5'}).base, 'http://10.0.0.5:8080');
  for (const port of ['abc', '0', '70000', '80.5']) assert.throws(() => addressOf({QUOTUM_PORT: port}), /QUOTUM_PORT must be a port number from 1 to 65535/, port);
});
