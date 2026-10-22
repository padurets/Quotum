import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attachedChrome, Cdp, openTab} from '../cdp.js';
import {RunOwner} from '../runOwner.js';
import {historyProxy} from '../historyProxy.js';

test('a browser arriving concurrently with cancellation transfers to the run for cleanup', async () => {
  const owner = new RunOwner();
  let deliver!: (browser: ReturnType<typeof attachedChrome>) => void, closes = 0;
  const started = assert.rejects(owner.start(() => new Promise(resolve => {deliver = resolve;})), /cancelled/);
  const closing = owner.close();
  deliver({endpoint: 'http://fixture.invalid', close: async () => {closes++;}});
  await started; await closing; await owner.close();
  assert.equal(closes, 1);
  assert.throws(() => owner.operation(async () => {}), /cancelled/);
});

test('a late target creation reply closes that target and leaves the attached browser alone', async t => {
  const owner = new RunOwner(), browser = await owner.start(async () => attachedChrome('http://fixture.invalid'));
  let deliver!: (reply: Response) => void;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    if (url.includes('/json/new')) return new Promise<Response>(resolve => {deliver = resolve;});
    return new Response('Target closed');
  });
  const opened = assert.rejects(openTab(browser), /cancelled/);
  const closing = owner.close();
  deliver(new Response(JSON.stringify({id: 'owned', webSocketDebuggerUrl: 'ws://fixture.invalid/owned'})));
  await opened; await closing;
  assert.deepEqual(calls, ['http://fixture.invalid/json/new?about:blank', 'http://fixture.invalid/json/close/owned']);
});

test('a lost create reply reports unknown ownership without listing or closing foreign tabs', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const owner = new RunOwner(), browser = await owner.start(async () => attachedChrome('http://fixture.invalid'));
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push(url);
    return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('cancelled')), {once: true}));
  });
  const opened = assert.rejects(openTab(browser), /outcome unknown \(target creation cancelled\)/);
  const closing = assert.rejects(owner.close(), /tab creation outcome unknown/);
  t.mock.timers.tick(5_000);
  await opened; await closing;
  assert.deepEqual(calls, ['http://fixture.invalid/json/new?about:blank']);
});

test('cancellation disconnects pending connections and closes every auxiliary target exactly once', async t => {
  const owner = new RunOwner(), browser = await owner.start(async () => attachedChrome('http://fixture.invalid'));
  const closed: string[] = [];
  let serial = 0, disconnected = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('/json/new')) return new Response(JSON.stringify({id: `own-${++serial}`, webSocketDebuggerUrl: 'ws://fixture.invalid'}));
    closed.push(url); return new Response('Target closed');
  });
  t.mock.method(Cdp, 'connect', async () => ({close: () => {disconnected++;}} as Cdp));
  const first = await openTab(browser), second = await openTab(browser);
  await first.close(); await owner.close(); await second.close();
  assert.equal(closed.length, 2); assert.equal(new Set(closed).size, 2); assert.ok(disconnected >= 2);
});

test('the run closes a real auxiliary proxy even when its caller has not reached finally', async () => {
  const owner = new RunOwner();
  const proxy = await historyProxy('http://127.0.0.1:1', owner);
  await owner.close(); await proxy.close();
  await assert.rejects(fetch(proxy.url));
});

test('a malformed creation identity cannot turn into an invented target to close', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {calls.push(url); return new Response('{}');});
  await assert.rejects(openTab(attachedChrome('http://fixture.invalid')), /outcome unknown \(DevTools returned no target identity\)/);
  assert.deepEqual(calls, ['http://fixture.invalid/json/new?about:blank']);
});

for (const [name, reply, reason] of [
  ['HTTP failure', () => new Response('private-reply-canary', {status: 500}), 'DevTools HTTP 500'],
  ['invalid JSON', () => new Response('private-reply-canary'), 'DevTools invalid JSON'],
  ['empty reply', () => new Response(null), 'DevTools empty reply'],
  ['oversized reply', () => new Response('private-reply-canary'.repeat(1_000)), 'DevTools reply exceeds 16 KiB'],
  ['transport failure', () => {throw new Error('private-endpoint-canary', {cause: new Error('private-reply-canary')});}, 'DevTools transport failed'],
] as const) test(`target creation retains a safe ${name} without inventing ownership`, async t => {
  const owner = new RunOwner(), browser = await owner.start(async () => attachedChrome('http://private-endpoint-canary.invalid'));
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {calls.push(url); return reply();});
  await assert.rejects(openTab(browser), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `tab creation outcome unknown (${reason}); no foreign targets were closed`);
    assert.doesNotMatch(String(error.stack), /private-(?:reply|endpoint)-canary/);
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(owner.close(), /tab creation outcome unknown/);
  assert.deepEqual(owner.failures, ['tab creation outcome unknown']);
  assert.deepEqual(calls, ['http://private-endpoint-canary.invalid/json/new?about:blank']);
});

test('target creation retains its original ten-second deadline and unknown ownership', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const calls: string[] = [];
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push(url);
    return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => {
      aborted = true; reject(new Error('private-endpoint-canary'));
    }, {once: true}));
  });
  const opened = assert.rejects(openTab(attachedChrome('http://fixture.invalid')), /outcome unknown \(deadline exceeded\)/);
  t.mock.timers.tick(9_999); await Promise.resolve(); assert.equal(aborted, false);
  t.mock.timers.tick(1); await opened; assert.equal(aborted, true);
  assert.deepEqual(calls, ['http://fixture.invalid/json/new?about:blank']);
});
