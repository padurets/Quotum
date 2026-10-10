import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bounded, observeReversal} from '../reversalDiagnostic.js';
import {Cdp, attachedChrome} from '../cdp.js';

const flush = async () => {await new Promise<void>(resolve => setImmediate(resolve));};
function pageFixture(send: (method: string, signal?: AbortSignal) => Promise<unknown> = async () => ({})) {
  const commands: string[] = [];
  return {commands, page: {
    snapshot: () => ({pending: [{id: 1, method: 'Input.dispatchMouseEvent', started: 1, deadline: 30001}]}),
    send: async (method: string, _params: object, signal?: AbortSignal) => {commands.push(method); return send(method, signal);},
    evaluate: async (_expression: string, signal?: AbortSignal) => send('Runtime.evaluate', signal),
    close() {},
  } as unknown as Cdp};
}

test('a diagnostic deadline cancels its child operation and releases the timer', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let aborted = false;
  const failed = assert.rejects(bounded('page pause', signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {aborted = true; reject(signal.reason);}, {once: true});
  })), /diagnostic deadline/);
  t.mock.timers.tick(5000); await failed; assert.equal(aborted, true);
});

test('canonical commands acknowledged after five seconds retain the thirty-second gate without intervention', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {page, commands} = pageFixture();
  t.mock.method(globalThis, 'fetch', async () => {throw new Error('no network diagnostics before command failure');});
  const observer = await observeReversal(page, attachedChrome('http://fixture.invalid'));
  let release!: () => void;
  const result = observer.watch('slow acknowledgement', () => new Promise<void>(resolve => {release = resolve;}));
  t.mock.timers.tick(6000); release(); await result; await observer.close();
  assert.deepEqual(commands, []);
});

test('failed canonical input retains its error and bounds probes without debugger or foreign process inspection', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const signals: AbortSignal[] = [], logs: string[] = [];
  t.mock.method(console, 'error', (text: string) => logs.push(text));
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({Browser: 'Chrome/fixture', webSocketDebuggerUrl: 'ws://fixture.invalid'})));
  t.mock.method(Cdp, 'connect', async () => {throw new Error('attached browser control is forbidden');});
  const {page, commands} = pageFixture(async (_method, signal) => new Promise((_, reject) => {
    signals.push(signal!); signal!.addEventListener('abort', () => reject(signal!.reason), {once: true});
  }));
  const observer = await observeReversal(page, attachedChrome('http://fixture.invalid'));
  const original = new Error('original input timeout');
  const failure = assert.rejects(observer.watch('reversal', async () => {throw original;}), error => error === original);
  await flush(); t.mock.timers.tick(2000); await failure; await observer.close();
  assert.ok(signals.every(signal => signal.aborted));
  assert.deepEqual(commands, []);
  assert.ok(logs.some(line => line.includes('"browserAlive":true')));
  assert.ok(logs.some(line => line.includes('unavailable for attached browser')));
});

test('a diagnostic pause with a lost reply still resumes and uses one collection deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const {page, commands} = pageFixture(async (method, signal) => {
    if (method === 'Debugger.pause') return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
    return {};
  });
  let closes = 0;
  const observer = await observeReversal(page, attachedChrome('http://fixture.invalid'), {mode: 'diagnostic', closeTarget: async () => {closes++;}});
  const original = new Error('input timeout');
  const failed = assert.rejects(observer.watch('reversal', async () => {throw original;}), error => error === original);
  await flush(); assert.ok(commands.includes('Debugger.pause'));
  t.mock.timers.tick(5000); await failed; await observer.close();
  assert.ok(commands.includes('Debugger.resume')); assert.equal(closes, 0);
});

test('unconfirmed resume closes only the owned diagnostic target', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const {page} = pageFixture(async (method, signal) => {
    if (method === 'Debugger.pause') throw new Error('lost pause acknowledgement');
    if (method === 'Debugger.resume') return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
    return {};
  });
  let closes = 0;
  const observer = await observeReversal(page, attachedChrome('http://fixture.invalid'), {mode: 'diagnostic', closeTarget: async () => {closes++;}});
  const failure = assert.rejects(observer.watch('reversal', async () => {throw new Error('original');}), /original/);
  await flush(); t.mock.timers.tick(2000); await failure; await observer.close();
  assert.equal(closes, 1);
});
