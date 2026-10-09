import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attachedChrome, Cdp, openTab,nativeProcesses} from '../cdp.js';
import {Requests} from '../index.js';

/** Stands in for what the benchmark hears of the browser: events by name, emitted by the test. */
function browser() {
  const listeners = new Map<string, ((params: unknown) => void)[]>();
  return {
    on: (method: string, listener: (params: unknown) => void) => void listeners.set(method, [...(listeners.get(method) ?? []), listener]),
    emit: (method: string, params: unknown) => listeners.get(method)?.forEach(listener => listener(params)),
  };
}

test('native diagnostics inspect an owned process and exclude a process outside its ancestry',{skip:process.platform!=='linux'},async()=>{
  const owned=await nativeProcesses(process.pid,[process.pid,999999999]);
  assert.equal(owned.length,1);assert.equal(owned[0].pid,process.pid);
  assert.ok(owned[0].threads.length>0);
  assert.deepEqual(await nativeProcesses(999999999,[process.pid]),[]);
});

test('what the idle page asks is counted, a stream of events opened meanwhile too; not the one it opened before, nor its images', () => {
  const cdp = browser();
  const requests = new Requests(cdp as unknown as Cdp);
  const asked = (requestId: string, type: string, url: string) => cdp.emit('Network.requestWillBeSent', {requestId, type, request: {url}});
  asked('1', 'Fetch', 'http://127.0.0.1:8080/api/events?board=b');
  requests.counting = true;
  asked('2', 'Image', 'http://127.0.0.1:8080/logo.svg');
  asked('3', 'Fetch', 'http://127.0.0.1:8080/api/events?board=b');
  asked('4', 'Fetch', 'http://127.0.0.1:8080/api/events?board=b&mode=poll');
  cdp.emit('Network.loadingFinished', {requestId: '4', encodedDataLength: 120});
  cdp.emit('Network.loadingFinished', {requestId: '1', encodedDataLength: 999});
  assert.deepEqual({count: requests.count, bytes: requests.bytes, byPath: requests.byPath}, {count: 2, bytes: 120, byPath: {'/api/events': 2}});
});

test('a browser gone meanwhile answers nothing: a command is refused at once, not waited for', async () => {
  const closed = {readyState: WebSocket.CLOSED, addEventListener() {}, send() {}, close() {}};
  const cdp = new (Cdp as unknown as new (socket: unknown) => Cdp)(closed);
  const waited = new Promise((_, reject) => setTimeout(() => reject(new Error('still waiting')), 1000).unref());
  await assert.rejects(Promise.race([cdp.send('Performance.getMetrics'), waited]), /Performance.getMetrics: the browser closed the connection/);
});

/** Keeps the socket open even when a renderer promise never answers. */
class Socket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  readonly commands: {id: number; method: string}[] = [];
  send(value: string) {this.commands.push(JSON.parse(value));}
  answer(id: number, result: unknown) {this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({id, result})}));}
  emit(method: string, params: object = {}) {this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({method, params})}));}
  close() {this.readyState = WebSocket.CLOSED;}
}
const connection = (socket: Socket) => new (Cdp as unknown as new (socket: unknown) => Cdp)(socket);

test('a page exception keeps its original command through later cleanup failures without retaining page text', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const socket = new Socket(), cdp = connection(socket);
  t.after(() => cdp.close());
  cdp.at('panning/quota/30d/setup');
  const failed = assert.rejects(cdp.evaluate('private-expression-canary'), /private-page-error-canary/);
  cdp.at('cleanup');
  socket.answer(1, {result: {type: 'object'}, exceptionDetails: {text: 'private-page-error-canary', exception: {description: 'private-page-error-canary'}}});
  await failed;
  const original = cdp.snapshot().failure;
  assert.ok(original);
  assert.equal(original?.id, 1);
  assert.equal(original?.method, 'Runtime.evaluate');
  assert.equal(original?.context, 'panning/quota/30d/setup');
  assert.equal(original?.reason, 'a page evaluation failed');
  assert.ok(Number.isFinite(original.elapsedMs));
  const cleanup = assert.rejects(cdp.send('Emulation.clearDeviceMetricsOverride'), /no browser response/);
  t.mock.timers.tick(30_000); await cleanup;
  const crash = assert.rejects(cdp.send('Performance.getMetrics'), /renderer crashed/);
  socket.emit('Inspector.targetCrashed'); await crash;
  assert.deepEqual(cdp.snapshot().failure, original);
  assert.equal(cdp.snapshot().terminal?.method, 'Inspector.targetCrashed');
  assert.deepEqual(cdp.snapshot().pending, []);
  assert.equal(socket.commands.length, 3);
  assert.doesNotMatch(JSON.stringify(cdp.snapshot()), /private-expression-canary|private-page-error-canary|description|expression/);
});

test('an exceptionDetails field returned as ordinary page data is not a failed evaluation', async () => {
  const socket = new Socket(), cdp = connection(socket);
  try {
    const result = cdp.evaluate('ordinary page data');
    socket.answer(1, {result: {value: {exceptionDetails: 'ordinary page data'}}});
    assert.deepEqual(await result, {exceptionDetails: 'ordinary page data'});
    assert.equal(cdp.snapshot().failure, null);
  } finally {cdp.close();}
});

for (const [event, reason] of [['Inspector.targetCrashed', 'the renderer crashed'], ['Inspector.detached', 'the browser detached the target']]) {
  test(`${event} rejects open-socket waiters and prevents cleanup commands from hiding the cause`, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const socket = new Socket(), cdp = connection(socket);
    t.after(() => cdp.close());
    cdp.at('quota/24h/return');
    const pending = [cdp.evaluate('private-canary'), cdp.send('Input.dispatchMouseEvent', {x: 123})]
      .map(promise => promise.then(() => 'unexpected success', error => String(error.message)));
    cdp.at('cleanup');
    socket.emit(event, {reason: 'private-detach-canary'});
    // The original deadlines do not advance; the event itself must settle both calls.
    await new Promise(resolve => setImmediate(resolve));
    for (const promise of pending) assert.match(await Promise.race([promise, Promise.resolve('still waiting')]), new RegExp('quota/24h/return: .*: ' + reason));
    assert.deepEqual(cdp.snapshot().pending, []);
    assert.equal(cdp.snapshot().failure?.context, 'quota/24h/return');
    assert.equal(cdp.snapshot().failure?.reason, reason);
    assert.equal(cdp.snapshot().terminal?.method, event);
    const after = cdp.send('Emulation.setCPUThrottlingRate', {rate: 1}).then(() => 'unexpected success', error => String(error.message));
    await Promise.resolve();
    assert.match(await Promise.race([after, Promise.resolve('still waiting')]), new RegExp(reason));
    assert.equal(socket.commands.length, 2);
    t.mock.timers.tick(30_000);
    assert.equal(cdp.snapshot().failure?.reason, reason);
    assert.doesNotMatch(JSON.stringify(cdp.snapshot()), /private-canary|private-detach-canary|expression|"x"/);
  });
}

test('a crash reload event permits new work without reviving old commands or retrying them', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const socket = new Socket(), cdp = connection(socket);
  t.after(() => cdp.close());
  const original = cdp.send('Performance.getMetrics').then(() => 'unexpected success', error => String(error.message));
  socket.emit('Inspector.targetCrashed');
  await Promise.resolve();
  assert.match(await Promise.race([original, Promise.resolve('still waiting')]), /renderer crashed/);
  socket.emit('Inspector.targetReloadedAfterCrash');
  const next = cdp.send('Performance.getMetrics');
  socket.answer(1, {metrics: ['stale']});
  socket.answer(2, {metrics: ['new']});
  assert.deepEqual(await next, {metrics: ['new']});
  assert.equal(cdp.snapshot().terminal, null);
  assert.equal(cdp.snapshot().failure?.reason, 'the renderer crashed');
  assert.deepEqual(socket.commands.map(command => command.id), [1, 2]);
});

test('a silent open browser has a Node deadline even when the page RAF never advances', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const socket = new Socket(), cdp = connection(socket);
  cdp.at('browser/1d/reversal/reversal frame');
  const failed = assert.rejects(cdp.evaluate('new Promise(requestAnimationFrame)'), /browser\/1d\/reversal\/reversal frame: Runtime.evaluate: no browser response in 30 s/);
  t.mock.timers.tick(30_000);
  await failed; cdp.close();
});

test('completed and late CDP replies do not retain deadlines or settle another command', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const socket = new Socket(), cdp = connection(socket);
  const first = cdp.send('Performance.getMetrics');
  socket.answer(1, {metrics: []});
  assert.deepEqual(await first, {metrics: []});
  const failed = assert.rejects(cdp.send('Network.getResponseBody'), /Network.getResponseBody: no browser response/);
  t.mock.timers.tick(30_000); await failed;
  const next = cdp.send('Performance.getMetrics');
  socket.answer(2, {body: 'late'});
  socket.answer(3, {metrics: ['current']});
  assert.deepEqual(await next, {metrics: ['current']});
  t.mock.timers.tick(30_000); cdp.close();
});

test('closing CDP rejects pending commands even without a socket close event', async () => {
  const cdp = connection(new Socket());
  const first = assert.rejects(cdp.send('Input.dispatchKeyEvent'), /the browser closed the connection/);
  const second = assert.rejects(cdp.evaluate('new Promise(requestAnimationFrame)'), /the browser closed the connection/);
  cdp.close(); await Promise.all([first, second]);
});

test('cancelled CDP waiters ignore late replies and retain safe failure identity without parameters', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const socket = new Socket(), cdp = connection(socket), controller = new AbortController();
  const cancelled = assert.rejects(cdp.send('Runtime.evaluate', {expression: 'secret-canary'}, controller.signal), /cancelled/);
  controller.abort(); await cancelled;
  assert.deepEqual(cdp.snapshot().pending, []);
  socket.answer(1, {result: {value: 'late'}});
  cdp.at('quota/24h/wheel');
  const timed = assert.rejects(cdp.send('Input.dispatchMouseEvent', {x: 123}), /no browser response/);
  t.mock.timers.tick(30_000); await timed;
  assert.equal(cdp.snapshot().failure?.method, 'Input.dispatchMouseEvent');
  assert.equal(cdp.snapshot().failure?.context, 'quota/24h/wheel');
  assert.doesNotMatch(JSON.stringify(cdp.snapshot()), /secret-canary|expression|"x"/);
  cdp.close();
});

test('a DevTools connection timeout closes only the tab it just created in an attached browser', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const calls:string[]=[],sockets:EventTarget[]=[];
  class ConnectingSocket extends EventTarget {
    constructor(){super();sockets.push(this);}
    close(){}
  }
  const original=globalThis.WebSocket;
  globalThis.WebSocket=ConnectingSocket as unknown as typeof WebSocket;
  t.after(()=>{globalThis.WebSocket=original;});
  t.mock.method(globalThis,'fetch',async(input:string)=>{
    calls.push(input);
    return new Response(input.includes('/json/new')?JSON.stringify({id:'owned-tab',webSocketDebuggerUrl:'ws://fixture.invalid'}):'Target closed');
  });
  const failed=assert.rejects(openTab(attachedChrome('http://fixture.invalid')),/did not open its DevTools connection/);
  for(let turn=0;!sockets.length&&turn<20;turn++)await Promise.resolve();
  assert.equal(sockets.length,1);t.mock.timers.tick(30000);await failed;
  assert.deepEqual(calls,['http://fixture.invalid/json/new?about:blank','http://fixture.invalid/json/close/owned-tab']);
});

test('history bytes are counted by path after reads finish, separately from other traffic', () => {
  const cdp = browser();
  const requests = new Requests(cdp as unknown as Cdp);
  requests.counting = true;
  cdp.emit('Network.requestWillBeSent', {requestId: 'history', type: 'Fetch', request: {url: 'http://localhost/api/history?cell=60000'}});
  cdp.emit('Network.requestWillBeSent', {requestId: 'session', type: 'Fetch', request: {url: 'http://localhost/api/session'}});
  assert.equal(requests.historyPending, 1);
  cdp.emit('Network.loadingFinished', {requestId: 'session', encodedDataLength: 999});
  cdp.emit('Network.loadingFinished', {requestId: 'history', encodedDataLength: 2345});
  assert.equal(requests.historyPending, 0);
  assert.equal(requests.bytesByPath['/api/history'], 2345);
});
