import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {clientIdentity, Evidence, safeEvidence} from '../evidence.js';
import {measuredProblems} from '../budget.js';

test('saved activity drawing mode survives without admitting arbitrary request text',()=>{
  assert.deepEqual(safeEvidence({sections:[{scope:'quota',cells:'activity',evidence:'cursor'},{cells:'private-value',evidence:'private-cursor'}]}),{sections:[{scope:'quota',cells:'activity',evidence:'cursor'},{cells:'[text omitted]',evidence:'[text omitted]'}]});
});

test('saved measurements retain the card identity needed to replay their render budget', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-evidence-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const evidence = new Evidence(dir), root = path.join(dir, evidence.id);
  const source = 'antigravity:4a6850d9ad60';
  for (const region of [`card:${source}`, 'card:codex:58a998b30a2c']) {
    const reading = {source, latencies: [10], renders: [{node: 'article.card#1', time: false, kind: null, region, count: 1}], mutations: [], from: 0, to: 1000};
    const problems = (value: typeof reading) => measuredProblems({...value, card: value.source});
    evidence.save('measured', reading);
    const saved = JSON.parse(readFileSync(path.join(root, 'measured.json'), 'utf8'));
    assert.deepEqual(problems(saved), problems(reading));
  }
});

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
    method: 'Runtime.evaluate', expression: 'canary-expression', name: 'https://private.invalid/canary-url', message: 'canary-conversation', source: 'canary-source',
    unknownSource: {source: 'private-customer:0123456789ab'}, otherSource: {source: 'secret:0123456789ab'},
    mutation: {surface:'forecast',tag:'TD',attribute:'class'}, unknownMutation: {surface:'canary-surface',tag:'canary-tag',attribute:'canary-attribute'},
    values: Array.from({length: 10_003}, (_, i) => i)});
  assert.doesNotMatch(JSON.stringify(value), /canary|private/);
  assert.deepEqual((value as {otherSource: unknown}).otherSource, {source: '[text omitted]'});
  assert.equal((value as {method: string}).method, 'Runtime.evaluate');
  assert.deepEqual((value as {mutation:unknown}).mutation, {surface:'forecast',tag:'TD',attribute:'class'});
  assert.deepEqual((value as {unknownMutation:unknown}).unknownMutation, {surface:'[text omitted]',tag:'[text omitted]',attribute:'[text omitted]'});
  assert.equal((value as {values: {omittedEntries: number}}).values.omittedEntries, 3);
});

test('root wait clocks retain exact U64 strings without admitting other diagnostic text',()=>{
  const keys=['sampleFromNs','sampleToNs','terminationAttemptNs'];
  for(const key of keys){
    for(const value of ['0','9007199254740993','18446744073709551615'])assert.equal(safeEvidence(value,key),value);
    for(const value of ['-1','01','0x10','1.5','18446744073709551616','https://private.invalid/canary'])assert.equal(safeEvidence(value,key),'[text omitted]');
  }
  assert.deepEqual(safeEvidence({sampleFromNs:'9007199254740993',sampleToNs:'9007199254740994',terminationAttemptNs:'9007199254740995',
    beforeTermination:false,readBeforeTermination:true,otherNs:'9007199254740993'}),
  {sampleFromNs:'9007199254740993',sampleToNs:'9007199254740994',terminationAttemptNs:'9007199254740995',beforeTermination:false,readBeforeTermination:true,otherNs:'[text omitted]'});
});

test('saved cold request classifications survive while identities and cursor text stay omitted', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-evidence-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const evidence = new Evidence(dir), root = path.join(dir, evidence.id);
  const sections = [
    {scope: 'quota', from: 0, to: 300_000, cell: 300_000, cells: 'read', evidence: 'skip'},
    {scope: 'budget', from: 0, to: 300_000, cell: 300_000, cells: 'skip', evidence: 'cursor'},
    {scope: 'funds', from: 0, to: 300_000, cell: 300_000, cells: 'skip', evidence: 'baseline'},
  ];
  evidence.save('cold', {attempts: 1, omitted: 0, reads: [{endpoint: 'period', errorCode:'history_limit',requestBytes:128,request: {sections, values: 69, sessions: true}}],
    unsafe: {scope: 'canary-resource', cells: 'canary-cell', evidence: 'canary-cursor', endpoint: 'canary-endpoint',errorCode:'canary-error',
      resource: 'canary-id', meta: 'canary-meta', body: 'canary-body'}});
  const body = readFileSync(path.join(root, 'cold.json'), 'utf8'), saved = JSON.parse(body);
  assert.deepEqual(saved.reads[0], {endpoint: 'period',errorCode:'history_limit',requestBytes:128, request: {sections, values: 69, sessions: true}});
  assert.doesNotMatch(body, /canary/);
  assert.deepEqual(saved.unsafe, {scope: '[text omitted]', cells: '[text omitted]', evidence: '[text omitted]',
    endpoint: '[text omitted]',errorCode:'[text omitted]', resource: '[text omitted]', meta: '[text omitted]', body: '[text omitted]'});
});

test('an unavailable diagnostic destination cannot interrupt resource cleanup', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-evidence-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'occupied'); writeFileSync(file, 'fixture');
  assert.doesNotThrow(() => {const evidence = new Evidence(file); evidence.begin('startup'); evidence.save('state', {}); evidence.finish('failed', {});});
});

test('client identity distinguishes compiled bytes on the same source and filename', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-client-identity-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'index-public.js');
  writeFileSync(file, 'first compiled client');
  const first = clientIdentity(dir);
  assert.equal(first.status, 'available');
  assert.equal(first.name, 'index-public.js');
  assert.equal(first.bytes, 21);
  assert.equal(first.sha256, createHash('sha256').update('first compiled client').digest('hex'));
  writeFileSync(file, 'second compiled client');
  assert.notEqual(clientIdentity(dir).sha256, first.sha256);
  assert.doesNotMatch(JSON.stringify(first), /quotum-client-identity-/);
});

test('Chromium source revision admits exactly forty lowercase hexadecimal characters',()=>{
  const hash='3ff7ac5a9224be9156d7f8703a06e22890aafd34';
  assert.deepEqual(safeEvidence({sourceRevisionHash:hash}),{sourceRevisionHash:hash});
  for(const value of ['private-canary',hash.toUpperCase(),hash+'0','https://private-canary.invalid',hash.slice(1)])assert.deepEqual(safeEvidence({sourceRevisionHash:value}),{sourceRevisionHash:'[text omitted]'});
});

test('missing and ambiguous client bundles leave explicit unavailable identity', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-client-identity-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  assert.deepEqual(clientIdentity(path.join(dir, 'private-canary')), {status: 'unavailable'});
  assert.deepEqual(clientIdentity(dir), {status: 'unavailable'});
  writeFileSync(path.join(dir, 'index-one.js'), 'one');
  writeFileSync(path.join(dir, 'index-two.js'), 'two');
  assert.deepEqual(clientIdentity(dir), {status: 'unavailable'});
});

test('the phase journal retains the first failed checker without blaming successful cleanup', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-evidence-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const evidence = new Evidence(dir);evidence.plan('all');evidence.end();
  evidence.begin('preparation');evidence.end();
  evidence.begin('idle');evidence.save('idle', {seconds: 120});evidence.fail('budget');
  const active = JSON.parse(readFileSync(path.join(dir, evidence.id, 'manifest.json'), 'utf8')).journal.find((row: {phase: string}) => row.phase === 'idle');
  assert.equal(active.outcome, 'failed');assert.equal(active.endMs, undefined, 'later safe observations remain in the original phase duration');
  evidence.checked([]);
  evidence.begin('cleanup');evidence.end();evidence.finish('failed', {status: 'closed'});
  const saved = JSON.parse(readFileSync(path.join(dir, evidence.id, 'manifest.json'), 'utf8'));
  assert.deepEqual(saved.primaryFailure, {phase: 'idle', classification: 'budget'});
  const idle = saved.journal.find((row: {phase: string}) => row.phase === 'idle');
  assert.equal(idle.outcome, 'failed');assert.deepEqual(idle.artifactIds, ['idle.json']);
  assert.ok(idle.startMs >= 0 && idle.endMs >= idle.startMs && idle.durationMs === idle.endMs - idle.startMs);
  const cleanup = saved.journal.find((row: {phase: string}) => row.phase === 'cleanup');
  assert.equal(cleanup.outcome, 'passed');assert.equal(cleanup.classification, undefined);
  assert.equal(saved.journal.find((row: {phase: string}) => row.phase === 'measurements').outcome, 'unreached');
  assert.equal(saved.status, 'failed');
});

test('cancellation keeps completed artifacts and a cancelled current phase through cleanup', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-evidence-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const evidence = new Evidence(dir);evidence.end();evidence.begin('work');evidence.save('work', {count: 3});evidence.end();
  evidence.begin('panning');evidence.end('cancelled', 'cancelled');evidence.begin('cleanup');evidence.end();evidence.finish('cancelled', {});
  const saved = JSON.parse(readFileSync(path.join(dir, evidence.id, 'manifest.json'), 'utf8'));
  assert.deepEqual(saved.primaryFailure, {phase: 'panning', classification: 'cancelled'});
  assert.equal(saved.journal.find((row: {phase: string}) => row.phase === 'work').outcome, 'passed');
  assert.equal(saved.journal.find((row: {phase: string}) => row.phase === 'panning').outcome, 'cancelled');
  assert.equal(saved.journal.find((row: {phase: string}) => row.phase === 'cleanup').outcome, 'passed');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, evidence.id, 'work.json'), 'utf8')), {count: 3});
});


test('a real cleanup failure has its own outcome and preserves an earlier runtime failure', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-evidence-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  for (const earlier of [false, true]) {
    const evidence = new Evidence(dir);evidence.end();
    if (earlier) {evidence.begin('panning');evidence.end('failed', 'runtime');}
    evidence.begin('cleanup');evidence.end('failed', 'cleanup');evidence.finish('failed', {status: 'incomplete'});
    const saved = JSON.parse(readFileSync(path.join(dir, evidence.id, 'manifest.json'), 'utf8'));
    assert.deepEqual(saved.primaryFailure, earlier ? {phase: 'panning', classification: 'runtime'} : {phase: 'cleanup', classification: 'cleanup'});
    const cleanup = saved.journal.find((row: {phase: string}) => row.phase === 'cleanup');
    assert.equal(cleanup.outcome, 'failed');assert.equal(cleanup.classification, 'cleanup');
  }
});
