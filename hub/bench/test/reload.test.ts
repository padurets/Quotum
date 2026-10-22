import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Cdp} from '../cdp.js';
import {reload} from '../reload.js';
import {panning} from '../panning.js';

test('reload releases its load subscription on success, failure and a silent command', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const mode of ['loaded', 'failed', 'silent']) {
    let listener: (() => void) | undefined, cancelled = false;
    const cdp = {
      on: (_method: string, callback: () => void) => {listener = callback;},
      off: () => {listener = undefined;},
      send: async (_method: string, _params: object, signal: AbortSignal) => {
        if (mode === 'loaded') {listener?.(); return;}
        if (mode === 'failed') throw new Error('reload failed');
        return new Promise((_, reject) => signal.addEventListener('abort', () => {cancelled = true; reject(signal.reason);}, {once: true}));
      },
    } as unknown as Cdp;
    const result = mode === 'loaded' ? reload(cdp) : assert.rejects(reload(cdp), mode === 'failed' ? /reload failed/ : /deadline/);
    if (mode === 'silent') t.mock.timers.tick(5000);
    await result;
    assert.equal(listener, undefined);
    assert.equal(cancelled, mode === 'silent');
  }
});

test('a failed panning scenario saves its original command before partial evidence and failed cleanup', async () => {
  const error = new Error('original scenario failure'), files = new Map<string, unknown>(), events: string[] = [];
  let first = true, loaded = () => {}, context = '', id = 0;
  type Ack = {id: number; method: string};
  let lastReply: Ack | null = null, failedAck: Ack | null = null, failedContext = '';
  const cdp = {
    at: (value: string) => {context = value; if (value.endsWith('/cleanup')) events.push('cleanup');},
    snapshot: () => {events.push('snapshot'); return {context, lastReply};},
    on: (method: string, callback: () => void) => {if(method==='Page.loadEventFired')loaded = callback;}, off: () => {},
    send: async (method: string) => {lastReply = {id: ++id, method}; if (method === 'Page.reload') loaded(); if (method === 'Emulation.setCPUThrottlingRate') throw new Error('cleanup failed');},
    evaluate: async (source: string) => {
      lastReply = {id: ++id, method: 'Runtime.evaluate'};
      if (first) {first = false; return 'auto';}
      if (source.includes("status:'partial'")) {events.push('partial'); return {inputs: 17};}
      events.push('original-failure'); failedAck = lastReply; failedContext = context;
      throw error;
    },
  } as unknown as Cdp;
  await assert.rejects(panning(cdp, undefined, {save: (name, value) => {events.push('save:' + name); files.set(name, value);}}), value => value === error);
  assert.ok(files.has('panning-failure') && files.has('panning-partial') && files.has('panning-cleanup'));
  assert.match(JSON.stringify(files.get('panning-partial')), /17/);
  const failure = files.get('panning-failure') as {command: {context: string; lastReply: typeof lastReply}};
  assert.deepEqual(failure.command, {context: failedContext, lastReply: failedAck});
  assert.equal(failure.command.context, 'native/quota/charts-open');
  assert.notDeepEqual(failure.command.lastReply, lastReply, 'partial and cleanup must actually replace the current command');
  assert.deepEqual(events.slice(events.indexOf('original-failure') + 1, events.indexOf('partial') + 1), ['snapshot', 'save:panning-failure', 'partial']);
  assert.ok(events.indexOf('partial') < events.indexOf('cleanup'));
});
