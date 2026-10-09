import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Evidence, safeEvidence} from '../evidence.js';

test('a phase manifest and completed readings survive a later failure with verifiable hashes', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-evidence-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const evidence = new Evidence(dir), root = path.join(dir, evidence.id);
  evidence.save('idle', {seconds: 120, scriptMsPerSecond: .2});
  evidence.begin('panning');
  const manifest = () => JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest().phase, 'panning'); assert.equal(manifest().status, 'running');
  const file = manifest().files[0];
  const data = readFileSync(path.join(root, file.name));
  assert.equal(file.sha256, createHash('sha256').update(data).digest('hex'));
  evidence.finish('failed', {status: 'closed'});
  assert.equal(manifest().status, 'failed'); assert.equal(manifest().files.length, 2);
});

test('unsafe data is omitted and evidence overflow remains explicit', () => {
  const value = safeEvidence({cookie: 'canary-cookie', environment: {token: 'canary-token'}, commandLine: 'canary-command',
    method: 'Runtime.evaluate', expression: 'canary-expression', name: 'https://private.invalid/canary-url', message: 'canary-conversation',
    values: Array.from({length: 10_003}, (_, i) => i)});
  assert.doesNotMatch(JSON.stringify(value), /canary|private/);
  assert.equal((value as {method: string}).method, 'Runtime.evaluate');
  assert.equal((value as {values: {omittedEntries: number}}).values.omittedEntries, 3);
});

test('an unavailable diagnostic destination cannot interrupt resource cleanup', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-evidence-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'occupied'); writeFileSync(file, 'fixture');
  assert.doesNotThrow(() => {const evidence = new Evidence(file); evidence.begin('startup'); evidence.save('state', {}); evidence.finish('failed', {});});
});
