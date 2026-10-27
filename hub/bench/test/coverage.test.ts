import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {ACTIVITY_CASES, activityScenario, Coverage, REQUIRED_COVERAGE, historyScenario, type CoverageSummary} from '../coverage.js';
import {Evidence, safeEvidence} from '../evidence.js';

function complete(coverage: Coverage, omit?: string) {
  for (const row of REQUIRED_COVERAGE.filter(row => coverage.summary().expected.includes(row.scenarioId))) {
    if (row.scenarioId !== omit) coverage.record(row.scenarioId, [], row.minimumSamples);
  }
}

test('the independent manifest preserves the complete current workload and runtime pan keys', () => {
  const ids = REQUIRED_COVERAGE.map(row => row.scenarioId);
  assert.equal(new Set(ids).size, ids.length);
  const count = (prefix: string) => ids.filter(id => id.startsWith(prefix)).length;
  assert.equal(count('updates/quota/'), 20);
  assert.equal(count('updates/credits/'), 4);
  assert.equal(count('updates/activity/'), 18); // Eight cases and a terminal pool per period.
  assert.equal(count('updates/disclosure/'), 16);
  assert.equal(count('panning/'), 10);
  assert.equal(count('history/controlled/'), 24);
  assert.equal(count('history/browser/'), 96);
  assert.equal(count('history/cancel/'), 12);
  for (const initiator of ['quota', 'session', 'activity', 'budget', 'funds']) {
    for (const period of ['24h', '30d']) assert.ok(ids.includes(`panning/${initiator}/${period}` as typeof ids[number]));
  }
});

for (const scope of ['all', 'dashboard', 'history', 'updates', 'panning'] as const) test(`coverage rejects empty, missing, duplicate, incomplete and diagnostic-only ${scope}`, () => {
  const empty = new Coverage(scope);
  assert.equal(empty.summary().status, 'incomplete');assert.ok(empty.summary().missing.length);
  const missing = new Coverage(scope), id = missing.summary().expected[0];complete(missing, id);
  assert.deepEqual(missing.summary().missing, [id]);
  const duplicate = new Coverage(scope);complete(duplicate);duplicate.record(id);
  assert.equal(duplicate.summary().status, 'incomplete');assert.deepEqual(duplicate.summary().duplicates, [id]);
  for (const samples of [0, NaN, Infinity, -1]) {
    const incomplete = new Coverage(scope);complete(incomplete, id);incomplete.record(id, [], samples);
    assert.equal(incomplete.summary().status, 'incomplete');assert.deepEqual(incomplete.summary().incomplete, [id]);
  }
  const failed = new Coverage(scope);complete(failed, id);failed.record(id, ['original-checker-failure']);
  assert.equal(failed.summary().status, 'incomplete');
  const diagnostic = new Coverage(scope, true);complete(diagnostic);assert.equal(diagnostic.summary().status, 'incomplete');
  const stopped = new Coverage(scope);complete(stopped);assert.equal(stopped.summary().status, 'passed');stopped.stop();assert.equal(stopped.summary().status, 'incomplete');
});

test('history terminal identities omit only bounded take numbers and retain exact accounting families', () => {
  for (const take of [1, 2, 3]) {
    assert.equal(historyScenario(`1d/history/0ms/0.5/take${take}`), 'history/controlled/1d/history/0ms/0.5');
    assert.equal(historyScenario(`browser/30d/activity/400ms/0.04/take${take}/all-accounting`), 'history/browser/30d/activity/400ms/0.04/all-accounting');
    assert.equal(historyScenario(`controlled/1d/during-staging/take${take}`), 'history/cancel/controlled/1d/during-staging');
    assert.equal(historyScenario(`browser/30d/after-delivery/take${take}`), 'history/cancel/browser/30d/after-delivery');
  }
  for (const name of ['1d/history/0ms/0.5/take4', 'browser/1d/history/0ms/0.5/take1', 'browser/1d/history/0ms/0.5/take1/activity', 'controlled/1d/after-delivery/take1', 'browser/1d/during-staging/take1']) assert.throws(() => historyScenario(name));
});

test('actual serialized coverage survives the sanitizer and carries every required identity', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-coverage-'));t.after(() => rmSync(dir, {recursive: true, force: true}));
  const evidence = new Evidence(dir), coverage = new Coverage('all');complete(coverage);
  const expected = coverage.summary();assert.equal(expected.status, 'passed');
  assert.deepEqual(safeEvidence(expected), expected);assert.equal(evidence.saveCoverage(expected), true);
  const saved = JSON.parse(readFileSync(path.join(dir, evidence.id, 'coverage.json'), 'utf8'));
  assert.deepEqual(saved, expected);
  assert.deepEqual(safeEvidence({scenarioId: 'private-canary', missing: ['private-canary'], outcome: 'private-canary', classification: 'private-canary'}),
    {scenarioId: '[text omitted]', missing: ['[text omitted]'], outcome: '[text omitted]', classification: '[text omitted]'});
  assert.equal(new Evidence('').saveCoverage(expected), true, 'validation works without an artifact directory');
});

test('required evidence cannot pass unavailable, removed or truncated artifact storage', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-coverage-'));t.after(() => rmSync(dir, {recursive: true, force: true}));
  const coverage = new Coverage('history');complete(coverage);const summary = coverage.summary();
  const occupied = path.join(dir, 'occupied');writeFileSync(occupied, 'fixture');
  const unavailable = new Evidence(occupied);assert.equal(unavailable.saveCoverage(summary), false);
  const removed = new Evidence(dir);rmSync(path.join(dir, removed.id), {recursive: true});assert.equal(removed.saveCoverage(summary), false);
  const truncated = new Evidence(dir);
  const huge = {...summary, padding: Array(9000).fill(Array(20).fill(1234567890))} as CoverageSummary;
  assert.equal(truncated.saveCoverage(huge), false);
  const saved = JSON.parse(readFileSync(path.join(dir, truncated.id, 'coverage.json'), 'utf8'));
  assert.equal(saved.status, 'insufficient-evidence');
});

/** Execute the actual period tail: assertions and finally must finish before any receipt. */
test('a fixed Activity report cannot pass a late pool assertion or owned cleanup failure', async () => {
  const source = ts.createSourceFile('fixedActivity.ts', readFileSync(new URL('../fixedActivity.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'fixedActivity') as ts.FunctionDeclaration;
  const loop = fn.body!.statements.find(ts.isForOfStatement)!;
  const statements = (loop.statement as ts.Block).statements;
  const attempt = statements.find(ts.isTryStatement)!;
  const poolIndex = attempt.tryBlock.statements.findIndex(node => node.getText(source).startsWith('const receipt='));assert.ok(poolIndex >= 0);
  const tail = attempt.tryBlock.statements.slice(poolIndex).map(node => node.getText(source)).join('\n');
  const after = statements.slice(statements.indexOf(attempt) + 1).map(node => node.getText(source)).join('\n');
  const code = ts.transpileModule(`globalThis.run=async()=>{try{${tail}}${attempt.catchClause!.getText(source)}finally${attempt.finallyBlock!.getText(source)}${after}}`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  for (const faults of [[], ['pool'], ['tab'], ['actor'], ['listener'], ['tab', 'actor'], ['pool', 'tab', 'actor']] as const) {
    const coverage = new Coverage('dashboard'), closed: string[] = [], saved = new Map<string, unknown>(), failures: string[] = [];
    const poolError = Error('original-checker'), tabError = Error('private-canary-tab'), actorError = Error('private-canary-actor'), listenerError = Error('private-canary-listener');
    const has = (fault: string) => (faults as readonly string[]).includes(fault);
    const context = {assert: {...assert, equal: (actual: unknown, expected: unknown) => {if (actual !== expected) throw poolError;}}, days: 1,
      cdp: {evaluate: async () => ({status: has('pool') ? 'incomplete' : 'complete', members: Array(4).fill({kind: 'period'})})},
      coverage, evidence: {save(name: string, value: unknown) {saved.set(name, value);}}, browser: {owner: {failures}}, ACTIVITY_CASES, activityScenario,
      reports: ACTIVITY_CASES.map(name => ({days: 1, name})), failed: false, poolSaved: false, lastPool: undefined,
      releaseInterrupted() {closed.push('listener');if (has('listener')) throw listenerError;},
      tab: {close: async () => {closed.push('tab');if (has('tab')) throw tabError;}}, actor: {close: async () => {closed.push('actor');if (has('actor')) throw actorError;}}};
    runInNewContext(code, context);
    const run = (context as unknown as {run(): Promise<void>}).run;
    if (!faults.length) {await run();assert.equal(coverage.summary().observed.length, 9);}
    else {
      const primary = has('pool') ? poolError : has('listener') ? listenerError : has('tab') ? tabError : actorError;
      await assert.rejects(run(), error => error === primary);
      assert.equal(coverage.summary().observed.length, 0, 'pre-assertion reports confer no coverage');
    }
    assert.deepEqual(closed, ['listener', 'tab', 'actor'], 'every owned cleanup runs even after the checker and tab both fail');
    const failedStages = ['listener', 'tab', 'actor'].filter(has);
    assert.deepEqual(failures, failedStages.map(stage => `fixed Activity ${stage} cleanup failed`));
    if (failedStages.length) {
      const receipt = saved.get('fixed-activity-cleanup-24h');
      assert.deepEqual(JSON.parse(JSON.stringify(receipt)), {days: 1, status: 'failed', failures: failedStages.map(stage => ({stage, status: 'failed'}))});
      assert.doesNotMatch(JSON.stringify(receipt), /private-canary/);
    }
  }
});

test('coverage classifies only the current record and stop never repeats an old failure', () => {
  const seen: ('budget' | 'coverage' | undefined)[] = [];
  const coverage = new Coverage('dashboard', false, (_summary, classification) => seen.push(classification));
  coverage.record('updates/work/ordinary', [], 0);
  coverage.record('panning/quota/24h', ['frame budget'], 30);
  coverage.stop();
  coverage.record('updates/frequency');
  assert.deepEqual(seen, ['coverage', 'budget', undefined, undefined]);
});


test('leaf coverage is the exact disjoint union used by the legacy composites',()=>{
  const ids=(scope:ConstructorParameters<typeof Coverage>[0])=>new Coverage(scope).summary().expected;
  assert.deepEqual(new Set(ids('all')),new Set([...ids('history'),...ids('updates'),...ids('panning')]));
  assert.deepEqual(new Set(ids('dashboard')),new Set([...ids('updates'),...ids('panning')]));
  assert.equal(new Set([...ids('history'),...ids('updates'),...ids('panning')]).size,218);
});
