import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registryStages} from './registryDiagnostics.js';

test('registry diagnostics retain completed stages from a helper killed mid-operation', () => {
  const stderr = Buffer.from('QKS1 1 0\r\nQKS1 2 4102\r\nQKS1 3 0\r\nQKS1 4 3\r\nQKS1 5 9\r\n');
  assert.deepEqual(registryStages(stderr), [{stage: 1, ms: 0}, {stage: 2, ms: 4102}, {stage: 3, ms: 0}, {stage: 4, ms: 3}, {stage: 5, ms: 9}]);
  assert.notEqual(registryStages(stderr).at(-1)?.stage, 6);
});

test('registry diagnostics discard private, malformed and unbounded output', () => {
  const privateText = 'private-key-canary';
  const stderr = Buffer.from(`${privateText}\nQKS1 1 ${privateText}\nQKS1 12 0\nQKS1 2 -1\nQKS1 3 1.5\nQKS1 4 1000000\nQKS1 5 01\nQKS1 6 9 ${privateText}\nQKS1 7 11\n`);
  assert.deepEqual(registryStages(stderr), [{stage: 7, ms: 11}]);
  assert.equal(JSON.stringify(registryStages(stderr)).includes(privateText), false);
  assert.deepEqual(registryStages(Buffer.alloc(4097)), []);
  assert.deepEqual(registryStages(Buffer.from('QKS1 1 0\n', 'ascii').map(byte => byte | 128)), []);
  assert.deepEqual(registryStages('QKS1 1 0'), []);
  assert.equal(registryStages(Buffer.from('QKS1 1 0\n'.repeat(30))).length, 16);
});
