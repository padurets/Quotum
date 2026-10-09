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

test('a failed panning scenario saves its partial evidence and survives failed cleanup', async () => {
  const error = new Error('original scenario failure'), files = new Map<string, unknown>();
  let first = true, loaded = () => {};
  const cdp = {
    on: (_method: string, callback: () => void) => {loaded = callback;}, off: () => {},
    send: async (method: string) => {if (method === 'Page.reload') loaded(); if (method === 'Emulation.setCPUThrottlingRate') throw new Error('cleanup failed');},
    evaluate: async (source: string) => {
      if (first) {first = false; return 'auto';}
      if (source.includes("status:'partial'")) return {inputs: 17, timeline: {status: 'complete'}};
      throw error;
    },
  } as unknown as Cdp;
  await assert.rejects(panning(cdp, undefined, {save: (name, value) => {files.set(name, value);}}), value => value === error);
  assert.ok(files.has('panning-failure') && files.has('panning-partial') && files.has('panning-cleanup'));
  assert.match(JSON.stringify(files.get('panning-partial')), /17/);
});
