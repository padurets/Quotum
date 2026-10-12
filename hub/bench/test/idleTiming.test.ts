import test from 'node:test';
import assert from 'node:assert/strict';
import {Cdp, type Browser} from '../cdp.js';
import {RunOwner} from '../runOwner.js';
import {timeIdle} from '../idleTiming.js';
import {safeEvidence} from '../evidence.js';

const counters = (at: number) => ({Timestamp: at, ScriptDuration: at / 10, TaskDuration: at / 5, ThreadTime: at / 4,
  DevToolsCommandDuration: at / 20, V8CompileDuration: 0, LayoutDuration: 0, RecalcStyleDuration: 0});
function fixture() {
  const sent: string[] = [], files = new Map<string, unknown>();
  let closed = 0, reads = 0;
  const thread = {send: async (method: string, params: object) => {
    sent.push(method);
    if (method === 'Performance.enable') assert.deepEqual(params, {timeDomain: 'threadTicks'});
    if (method === 'Performance.getMetrics') return {metrics: Object.entries(counters(reads++ ? 4 : 1)).map(([name, value]) => ({name, value}))};
  }, close: () => {closed++;}} as unknown as Cdp;
  const primary = {endpoint: 'ws://private-canary.invalid/target', send: () => {throw new Error('Primary counters changed');}} as unknown as Cdp;
  const owner = new RunOwner(), browser = {owned: true, owner} as Browser;
  const connect = async (endpoint: string) => {assert.equal(endpoint, primary.endpoint); return thread;};
  const evidence = {save: (name: string, value: unknown) => {files.set(name, value);}};
  const value = {before: counters(2), after: counters(3), originalFailure: true};
  return {thread, primary, browser, connect, evidence, files, sent, value, closed: () => closed};
}

test('thread counters bracket the same original result without changing its elapsed session', async () => {
  const f = fixture(); let calls = 0;
  const value = await timeIdle(f.primary, f.browser, async () => {calls++;return f.value;}, f.evidence, f.connect);
  assert.equal(value, f.value); assert.equal(calls, 1); assert.equal(f.closed(), 1);
  assert.deepEqual(f.sent, ['Performance.enable', 'Performance.getMetrics', 'Performance.getMetrics', 'Performance.disable']);
  const report = f.files.get('idle-timing') as {status: string; thread: {before: unknown; after: unknown}};
  assert.equal(report.status, 'complete'); assert.deepEqual(report.thread, {before: counters(1), after: counters(4)});
  assert.doesNotMatch(JSON.stringify(safeEvidence(report)), /private-canary|ws:/);
});

test('unsupported thread clocks retain the original run and cannot become complete evidence', async () => {
  const f = fixture(); const error = new Error('thread clock unsupported');
  f.thread.send = (async method => {f.sent.push(method); if (method === 'Performance.enable') throw error;}) as Cdp['send'];
  let calls = 0;
  const value = await timeIdle(f.primary, f.browser, async () => {calls++;return f.value;}, f.evidence, f.connect);
  assert.equal(value, f.value); assert.equal(calls, 1); assert.equal(f.closed(), 1);
  assert.deepEqual(f.sent, ['Performance.enable', 'Performance.disable']);
  assert.equal((f.files.get('idle-timing') as {status: string}).status, 'insufficient-evidence');
});

test('missing, reversed and nonbracketing counters never support a thread-time comparison', async () => {
  for (const bad of [{Timestamp: 2.5}, {ThreadTime: NaN}, {ScriptDuration: -1}]) {
    const f = fixture(), send = f.thread.send.bind(f.thread); let reads = 0;
    f.thread.send = (async (method, params, signal) => {
      const reply = await send(method, params, signal);
      if (method !== 'Performance.getMetrics' || reads++ !== 1) return reply;
      return {metrics: Object.entries({...counters(4), ...bad}).map(([name, value]) => ({name, value}))};
    }) as Cdp['send'];
    await timeIdle(f.primary, f.browser, async () => f.value, f.evidence, f.connect);
    assert.equal((f.files.get('idle-timing') as {status: string}).status, 'insufficient-evidence'); assert.equal(f.closed(), 1);
  }
});

test('original failures survive failed diagnostic cleanup and the secondary socket closes', async () => {
  const f = fixture(), original = new Error('Original idle failed'), send = f.thread.send.bind(f.thread);
  f.thread.send = (async (method, params, signal) => {if (method === 'Performance.disable') throw new Error('cleanup failed');return send(method, params, signal);}) as Cdp['send'];
  await assert.rejects(timeIdle(f.primary, f.browser, async () => {throw original;}, f.evidence, f.connect), error => error === original);
  assert.equal(f.closed(), 1); assert.deepEqual(f.browser.owner!.failures, ['Idle thread clock cleanup unconfirmed']);
  const report = f.files.get('idle-timing') as {cleanup: string; measurement: unknown; status: string};
  assert.equal(report.cleanup, 'incomplete'); assert.equal(report.measurement, null); assert.equal(report.status, 'insufficient-evidence');
});
