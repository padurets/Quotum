import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {type Cdp, type Browser} from '../cdp.js';
import {traceIdle} from '../idleTiming.js';
import {ScriptBinding} from '../scriptBinding.js';
import {idleProblems} from '../budget.js';
import {idlePhaseProblems} from '../still.js';
import {scriptPerSecond, type Metrics} from '../report.js';
import {EventCounts} from '../stream.js';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true), matches: ts.Expression[] = [];
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'readIdle') {
    assert.ok(node.initializer); matches.push(node.initializer);
  }
  ts.forEachChild(node, visit);
}
visit(file); assert.equal(matches.length, 1);
const body = ts.transpileModule('const selected=' + matches[0].getText(file) + ';', {
  compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022},
}).outputText.replace('const selected =', '');
assert.match(source, /const problems = originalIdleTimingProblems \?\? \[/);

const metric = (Timestamp: number, ScriptDuration: number): Metrics => ({Timestamp, ScriptDuration, TaskDuration: ScriptDuration,
  ThreadTime: ScriptDuration, DevToolsCommandDuration: 0, V8CompileDuration: 0, LayoutDuration: 0, RecalcStyleDuration: 0});
type OriginalResult = {problems: {reason: string}[]};
type Timing = {measurement: {instrumentMs: number; actualSeconds: number; status: string}};
type IdleReading = {before: Metrics; after: Metrics; reading: {instrumentMs: number}; actualSeconds: number};
type Selected = {readIdle(): Promise<IdleReading>; problems(): string[] | undefined};

/** Run the caller's actual reading, so saving in a stand-in callback cannot pass. */
function fixture() {
  const files = new Map<string, unknown>(), listeners = new Map<string, (value: unknown) => void>();
  const from = 1791891785000, to = from + 120000;
  const reading = {instrumentMs: 0.125, commits: 0, renders: [
    {node: 'fixture-outside', time: false, kind: null, region: 'page', count: 1},
    {node: 'fixture-time', time: true, kind: 'label', region: 'page', count: 6},
  ], mutations: []};
  const phase = {from: 1791891785064, to: 1791891905005, monotonicFrom: 127683.5, monotonicTo: 247624.6, cellMs: 300000,
    starts: [5972972, 5972972, 5972972, 5972972, 5972972], ends: [5972973, 5972973, 5972973, 5972973, 5972973], transitions: [2, 1, 1, 1, 1]};
  let metricReads = 0, threadReads = 0, closes = 0, end = () => {};
  const stopping = new Promise<void>(resolve => {end = resolve;});
  const cdp = {endpoint: 'fixture', failDrain: false,
    on: (name: string, listener: (value: unknown) => void) => listeners.set(name, listener),
    off: (name: string) => listeners.delete(name),
    send: async (method: string, _params?: object): Promise<unknown> => {
      if (method === 'Tracing.end') {end(); if (!cdp.failDrain) listeners.get('Tracing.tracingComplete')?.({});}
      return {metrics: [{name: 'Timestamp', value: 42}]};
    },
    evaluate: async (expression: string) => expression.includes('quotum-trace-clock') ? {now: 7, after: 7, timeOrigin: 35}
      : expression.includes('__quotumBench.read()') ? reading : phase,
  };
  const evidence = {save: (name: string, value: unknown) => {files.set(name, value);}, saveTrace: (name: string, value: unknown) => {files.set(name, value);}};
  const thread = {send: async (method: string) => method === 'Performance.getMetrics'
    ? {metrics: Object.entries(metric(threadReads++ ? 123 : 1, threadReads === 1 ? 0 : 0.3)).map(([name, value]) => ({name, value}))} : {}, close: () => {}};
  const browser = {owned: true, endpoint: 'fixture', close: async () => {closes++;}};
  const events=new EventCounts();events.push('event: ping\ndata: {}\n\nevent: history\ndata: {}\n\n');
  const context = {metrics: async () => metric(metricReads++ ? 122 : 2, metricReads === 1 ? 0 : 0.2), cdp, sleep: async () => {}, to,
    Date: {now: () => to}, requests: {count: 1, byPath: {'/api/history': 1}, counting: true}, heard:events,
    idlePhaseProblems, planned: {boundary: 1791891900000}, scriptPerSecond, from, cellMs: 300000, evidence, idleTimingDiagnostic: '1',idleCpu:undefined,
    traffic: {problems: ['fixture-traffic-1', 'fixture-traffic-2', 'fixture-traffic-3', 'fixture-traffic-4']}, idleProblems};
  const selected = runInNewContext('(()=>{let originalIdleTimingProblems;const readIdle=' + body
    + ';return {readIdle,problems:()=>originalIdleTimingProblems};})()', context) as Selected;
  return {files, listeners, cdp, evidence, browser, connect: async () => thread as unknown as Cdp, selected, stopping, closes: () => closes};
}

test('the actual idle caller retains all original failures before a failed timer drain', async t => {
  t.mock.timers.enable({apis: ['setTimeout']}); const f = fixture(); f.cdp.failDrain = true;
  const result = assert.rejects(traceIdle(f.cdp as unknown as Cdp, f.browser as unknown as Browser, f.selected.readIdle, f.evidence, f.connect), /diagnostic trace drain failed at events/);
  await f.stopping; await new Promise<void>(resolve => queueMicrotask(resolve));
  const saved = f.files.get('idle-timing-result') as OriginalResult;
  assert.equal(saved.problems.length, 11); assert.deepEqual(Array.from(saved.problems, p => p.reason), Array.from(f.selected.problems()!));
  t.mock.timers.tick(5000); await result; assert.deepEqual(f.files.get('idle-timing-result'), saved); assert.equal(f.closes(), 1);
  const timing = f.files.get('idle-timing') as Timing;
  assert.equal(timing.measurement.instrumentMs, 0.125); assert.equal(timing.measurement.actualSeconds, 120); assert.equal(timing.measurement.status, 'complete');
});

test('the actual idle caller retains all original failures before source binding cleanup rejects', async () => {
  const f = fixture(), body = 'abc', hash = createHash('sha256').update(body).digest('hex'), url = 'https://fixture.invalid/assets/index-fixture.js';
  const binding = new ScriptBinding(f.cdp as unknown as Cdp, {status: 'available', name: 'index-fixture.js', bytes: 3, sha256: hash}, f.evidence.save), send = f.cdp.send;
  f.cdp.send = async (method, params) => {
    if (method === 'Network.getResponseBody') return {body, base64Encoded: false};
    if (method === 'Debugger.enable') {f.listeners.get('Debugger.scriptParsed')?.({scriptId: '8', hash, url}); return {};}
    if (method === 'Debugger.disable') throw new Error('fixture debugger cleanup');
    return send(method, params);
  };
  f.listeners.get('Network.responseReceived')?.({requestId: 'fixture', type: 'Script', response: {url}});
  await traceIdle(f.cdp as unknown as Cdp, f.browser as unknown as Browser, f.selected.readIdle, f.evidence, f.connect);
  const saved = f.files.get('idle-timing-result') as OriginalResult; assert.equal(saved.problems.length, 11);
  await assert.rejects(binding.afterFamily([1]), /cleanup unconfirmed/); assert.deepEqual(f.files.get('idle-timing-result'), saved); binding.close();
});
