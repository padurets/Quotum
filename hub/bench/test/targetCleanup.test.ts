import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Cdp, openTab, type Browser} from '../cdp.js';
import {RunOwner} from '../runOwner.js';

type Caller = (...args: unknown[]) => Promise<unknown>;

/** Execute the complete production caller with controlled lower-level dependencies. */
function caller(file: string, name: string, bindings: Record<string, unknown>): Caller {
  const source = ts.createSourceFile(file, readFileSync(new URL('../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, 'the actual caller must exist');
  const binding = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'passiveHistoryBinding');
  const context = {...bindings, run: undefined as Caller | undefined};
  runInNewContext(ts.transpileModule((binding?.getText(source) ?? '') + '\n' + declaration.getText(source).replace(/^export /, '') + '\nglobalThis.run=' + name + ';', {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText, context);
  assert.ok(context.run);
  return context.run;
}

async function target(t: TestContext, send: (method: string, params?: object) => Promise<unknown>) {
  const actions: string[] = [], files = new Map<string, unknown>();
  const primary = new Error('private-primary-canary'), cleanup = new Error('private-target-cleanup-canary');
  const owner = new RunOwner({save: (name, value) => {files.set(name, value);}});
  const browser = await owner.start(async (): Promise<Browser> => ({owned: true, endpoint: 'http://fixture.invalid', close: async () => {}}));
  let interval = 0;
  const cdp = {at: () => {}, on: () => {}, off: () => {}, close: () => {}, send,
    snapshot: () => ({context: 'original', failure: {id: 1, method: 'Runtime.evaluate'}}),
    evaluate: async (expression: string) => {
      if (expression.includes('const from=performance.now()')) {const from = interval++ * 100; return {from, to: from + 100};}
      if (expression.startsWith('document.querySelectorAll(\'.card:not')) return true;
      if (expression === 'document.querySelectorAll(".card").length') return 2;
      if (expression === 'window.__quotumIdleRetention()') return null;
      return {instrumentMs: 0, renders: [], mutations: []};
    },
  } as unknown as Cdp;
  t.mock.method(Cdp, 'connect', async () => cdp);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('/json/new')) return new Response(JSON.stringify({id: 'owned-target', webSocketDebuggerUrl: 'ws://fixture.invalid/owned-target'}));
    assert.equal(url, 'http://fixture.invalid/json/close/owned-target'); actions.push('target'); throw cleanup;
  });
  t.mock.method(console, 'error', () => {});
  const evidence = {begin: () => {}, save: (name: string, value: unknown) => {files.set(name, value);}};
  const retained = async () => {
    assert.ok(owner.failures.includes('owned target cleanup failed'));
    assert.doesNotMatch(JSON.stringify(owner.failures), /private-.*canary/);
    await assert.rejects(owner.close(), /owned target cleanup failed/);
    assert.equal(actions.filter(action => action === 'target').length, 1, 'the failed close remains idempotent');
  };
  return {actions, files, primary, cleanup, owner, browser, cdp, evidence, retained};
}

for (const bindingFails of [false, true]) test(`history seed preserves its original error with ${bindingFails ? 'binding and target' : 'target'} cleanup failures`, async t => {
  let primary: Error;
  const f = await target(t, async () => {throw primary;}); primary = f.primary;
  let bindingsClosed = 0;
  const run = caller('historyTrafficBrowser.ts', 'historyPage', {
    openTab, process: {env: {}}, HistoryBodies: class {}, clientIdentity: () => ({status: 'unavailable'}),
    ScriptBinding: class {close() {bindingsClosed++; if (bindingFails) throw new Error('private-binding-cleanup-canary');}},
  });
  await assert.rejects(run(f.browser, {phase: () => {}}, '', 'fixture', 1, 0, bindingFails ? f.evidence : undefined), error => error === f.primary);
  assert.equal(bindingsClosed, Number(bindingFails));
  assert.deepEqual(f.actions, ['target'], 'binding cleanup failure cannot skip the owned target');
  if (bindingFails) assert.ok(f.owner.failures.includes('history source binding cleanup failed'));
  await f.retained();
});

for (const name of ['browserHistoryTraffic', 'browserCancellationTraffic']) for (const fatal of [true, false]) {
  test(`${name} attempts every cleanup and preserves ${fatal ? 'the scenario' : 'the first cleanup'} error`, async t => {
    let primary: Error;
    const keyFailure = new Error('private-key-cleanup-canary');
    let actions: string[];
    const f = await target(t, async (_method, params) => {
      if ((params as {type?: string})?.type === 'keyUp') {actions.push('key'); throw keyFailure;}
      throw primary;
    }); primary = f.primary; actions = f.actions;
    const poolFailure = new Error('private-pool-cleanup-canary'), observerFailure = new Error('private-observer-cleanup-canary');
    const run = caller('historyTrafficBrowser.ts', name, {
      DAY: 86_400_000, HISTORY_COHORT_TAKES: 1, process: {env: {}}, console,
      historyPage: async () => {
        const tab = await openTab(f.browser);
        return {cdp: tab.cdp, bodies: {reads: [], resources: [], activeCount: 0, pending: new Map(), diagnostic: () => ({})},
          geometry: {x: 10, y: 10, width: 100, series: 12}, cell: 1, seeds: new Map(), close: tab.close,
          capturePool: async () => {actions.push('pool'); throw poolFailure;}};
      },
      observeReversal: async () => ({watch: async (_label: string, work: () => Promise<unknown>) => work(),
        close: async () => {actions.push('observer'); throw observerFailure;}}),
      historyScroll: () => ({}), historyCutInvalidation: (error: unknown) => {if (fatal) throw error; return {};}, trafficReadEvidence: () => [],
    });
    const proxy = {transfers: [], phase: () => {}};
    const result = name === 'browserHistoryTraffic' ? run(f.browser, proxy, '', 'board', f.evidence) : run(f.browser, proxy, '', false, false, f.evidence);
    await assert.rejects(result, error => error === (fatal ? f.primary : name === 'browserHistoryTraffic' ? poolFailure : observerFailure));
    assert.deepEqual(actions, name === 'browserHistoryTraffic' ? ['pool', 'observer', 'target'] : ['observer', 'key', 'target']);
    assert.ok(f.owner.failures.includes('history observer cleanup failed'));
    assert.ok(f.owner.failures.includes(name === 'browserHistoryTraffic' ? 'history pool cleanup failed' : 'history input cleanup failed'));
    await f.retained();
  });
}
