import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {attachedChrome, Cdp, openTab,nativeProcesses,launchedChrome} from '../cdp.js';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {ChildProcess} from 'node:child_process';
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
  close() {this.readyState = WebSocket.CLOSED;}
}
const connection = (socket: Socket) => new (Cdp as unknown as new (socket: unknown) => Cdp)(socket);

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

/** No installed browser: an owned child and the DevTools reply are controlled independently. */
class StartingChrome extends EventEmitter {
  pid: number | undefined = 999999999;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: NodeJS.Signals[] = [];
  ignoreTerm = false;
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.kills.push(signal);
    if (signal !== 'SIGTERM' || !this.ignoreTerm) this.leave(null, signal);
    return true;
  }
  leave(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code; this.signalCode = signal; this.emit('exit', code, signal); this.emit('close', code, signal);
  }
}
const startingProfile = (t: TestContext) => {
  const profile = mkdtempSync(path.join(tmpdir(), 'quotum-test-chrome-'));
  t.after(() => rmSync(profile, {recursive: true, force: true}));
  t.mock.method(console, 'error', () => {});
  return profile;
};
const publishPort = (profile: string, value = '32123\n/devtools/browser/fixture\n') =>
  writeFileSync(path.join(profile, 'DevToolsActivePort'), value);
const versionReply = (socket = 'ws://127.0.0.1:32123/devtools/browser/fixture') =>
  new Response(JSON.stringify({Browser: 'Chrome/fixture', webSocketDebuggerUrl: socket}));
const asChild = (child: StartingChrome) => child as unknown as ChildProcess;
const turnsUntil = async (ready: () => boolean) => {
  for (let i = 0; !ready() && i < 1000; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(ready(), 'the controlled startup reached its expected phase');
};

test('a silent browser is ready through its owned port file and actual DevTools response', async t => {
  const profile = startingProfile(t), child = new StartingChrome();
  publishPort(profile);
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {calls.push(url); return versionReply();});
  const browser = await launchedChrome(asChild(child), profile);
  assert.equal(browser.endpoint, 'http://127.0.0.1:32123');
  assert.deepEqual(calls, ['http://127.0.0.1:32123/json/version']);
  assert.ok(existsSync(profile));
  await browser.close(); await browser.close();
  assert.deepEqual(child.kills, ['SIGTERM']); assert.equal(existsSync(profile), false);
});

test('a stderr announcement without an owned port file cannot turn a startup timeout into readiness', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const profile = startingProfile(t), child = new StartingChrome();
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {calls.push(url); return versionReply();});
  const failed = assert.rejects(launchedChrome(asChild(child), profile), /DevTools was not ready in 20 s/);
  child.stderr.write('DevTools listening on ws://127.0.0.1:32123/devtools/browser/fixture\n');
  t.mock.timers.tick(20_000); await failed;
  assert.deepEqual(calls, []); assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(existsSync(profile), false);
});

test('an invalid port file never sends a request outside the owned loopback endpoint', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const profile = startingProfile(t), child = new StartingChrome();
  publishPort(profile, '65536\n/devtools/browser/fixture\n');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {requests++; return versionReply();});
  const failed = assert.rejects(launchedChrome(asChild(child), profile), /DevTools was not ready/);
  t.mock.timers.tick(20_000); await failed;
  assert.equal(requests, 0); assert.equal(existsSync(profile), false);
});

test('a wrong browser reply cannot satisfy readiness for the published browser', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const profile = startingProfile(t), child = new StartingChrome(); publishPort(profile);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {requests++; return versionReply('ws://other.invalid:32123/devtools/browser/fixture');});
  const failed = assert.rejects(launchedChrome(asChild(child), profile), /DevTools was not ready/);
  await turnsUntil(() => requests === 1); await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(20_000); await failed;
  assert.deepEqual(child.kills, ['SIGTERM']); assert.equal(existsSync(profile), false);
});

test('a silent HTTP probe is aborted at the same startup deadline and the owned child is reaped', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const profile = startingProfile(t), child = new StartingChrome(); publishPort(profile);
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = init.signal!;
    signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
  }));
  const failed = assert.rejects(launchedChrome(asChild(child), profile), /DevTools was not ready/);
  await turnsUntil(() => Boolean(signal)); t.mock.timers.tick(20_000); await failed;
  assert.equal(signal?.aborted, true); assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(existsSync(profile), false);
});

test('early exit and spawn errors clean the profile without waiting for the startup deadline', async t => {
  for (const mode of ['exit', 'error']) {
    const profile = startingProfile(t), child = new StartingChrome();
    if (mode === 'error') child.pid = undefined;
    const failed = assert.rejects(launchedChrome(asChild(child), profile), mode === 'exit' ? /exited before DevTools/ : /could not start: ENOENT/);
    if (mode === 'exit') child.leave(7); else child.emit('error', new Error('ENOENT'));
    await failed; assert.deepEqual(child.kills, []); assert.equal(existsSync(profile), false);
  }
});

test('a startup timeout escalates an owned child that ignores termination and removes its profile', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const profile = startingProfile(t), child = new StartingChrome(); child.ignoreTerm = true;
  const failed = assert.rejects(launchedChrome(asChild(child), profile), /DevTools was not ready/);
  t.mock.timers.tick(20_000); await turnsUntil(() => child.kills.length === 1);
  assert.ok(existsSync(profile)); t.mock.timers.tick(5_000); await failed;
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']); assert.equal(existsSync(profile), false);
});

test('closing an exclusively owned process group also stops workers after the browser exits', async t => {
  const profile = startingProfile(t), child = new StartingChrome(); publishPort(profile);
  t.mock.method(globalThis, 'fetch', async () => versionReply());
  const signals: {pid: number; signal: NodeJS.Signals}[] = [];
  t.mock.method(process, 'kill', (pid: number, signal: NodeJS.Signals) => {
    signals.push({pid, signal});
    if (signal === 'SIGTERM') child.leave(0);
    return true;
  });
  const browser = await launchedChrome(asChild(child), profile, true);
  await browser.close(); await browser.close();
  assert.deepEqual(signals, [{pid: -child.pid!, signal: 'SIGTERM'}, {pid: -child.pid!, signal: 'SIGKILL'}]);
  assert.deepEqual(child.kills, []); assert.equal(existsSync(profile), false);
});
