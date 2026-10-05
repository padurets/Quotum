import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {attachedChrome, Cdp, openTab,nativeProcesses,launchedChrome} from '../cdp.js';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
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
  ignoreKill = false;
  closePipes = true;
  unref() {return this;}
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.kills.push(signal);
    if ((signal === 'SIGTERM' && !this.ignoreTerm) || (signal === 'SIGKILL' && !this.ignoreKill)) this.leave(null, signal);
    return true;
  }
  leave(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code; this.signalCode = signal; this.emit('exit', code, signal);
    if (this.closePipes) this.emit('close', code, signal);
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
  const states: string[] = [];
  t.mock.method(console, 'error', (message: string) => {states.push(message);});
  t.mock.method(globalThis, 'fetch', async () => {requests++; return versionReply();});
  const failed = assert.rejects(launchedChrome(asChild(child), profile), /DevTools was not ready/);
  try {
    await turnsUntil(() => requests > 0 || states.some(value => value.includes('"activePort":"invalid"')));
    assert.equal(requests, 0); assert.ok(states.some(value => value.includes('"activePort":"invalid"')));
  } finally {t.mock.timers.tick(20_000); await failed;}
  assert.equal(existsSync(profile), false);
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

test('exited owners do not wait for pipes retained by an escaped descendant', async t => {
  const profile = startingProfile(t), child = new StartingChrome(); child.closePipes = false;
  const pending = launchedChrome(asChild(child), profile);
  const failed = assert.rejects(pending, /exited before DevTools/);
  child.leave(7); await failed;
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  assert.equal(existsSync(profile), false);
});

test('unreaped owners produce a bounded cleanup failure instead of hiding the startup failure', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const profile = startingProfile(t), child = new StartingChrome();
  child.ignoreTerm = true; child.ignoreKill = true;
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => {messages.push(message);});
  const failed = assert.rejects(launchedChrome(asChild(child), profile), error =>
    /DevTools was not ready/.test(String(error)) && /did not exit after termination and kill/.test(String(error)));
  t.mock.timers.tick(20_000); await turnsUntil(() => child.kills.length === 1);
  t.mock.timers.tick(7_000); await failed;
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  assert.ok(messages.some(value => value.startsWith('bench: Chrome cleanup failed ')
    && value.includes('did not exit after termination and kill')));
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  assert.ok(existsSync(profile), 'a still-running owner must not lose its profile');
});

test('cancelling pending startup aborts its request and reaps its owner before settling', async t => {
  const profile = startingProfile(t), child = new StartingChrome(); publishPort(profile);
  const controller = new AbortController();
  let request: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    request = init.signal!;
    request.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
  }));
  const failed = assert.rejects(launchedChrome(asChild(child), profile, false, controller.signal), /startup cancelled/);
  await turnsUntil(() => Boolean(request)); controller.abort(); await failed;
  assert.equal(request?.aborted, true); assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(existsSync(profile), false);
});

test('a cancellation after readiness keeps ownership with the returned browser', async t => {
  const profile = startingProfile(t), child = new StartingChrome(); publishPort(profile);
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => versionReply());
  const browser = await launchedChrome(asChild(child), profile, false, controller.signal);
  controller.abort(); assert.deepEqual(child.kills, []); assert.ok(existsSync(profile));
  await browser.close(); assert.deepEqual(child.kills, ['SIGTERM']); assert.equal(existsSync(profile), false);
});

test('a redirect cannot leave the published DevTools port or grant readiness through its body', async t => {
  const profile = startingProfile(t), child = new StartingChrome(), controller = new AbortController();
  let firstHits = 0, otherHits = 0;
  let firstPort = 0;
  const other = createServer((_req, res) => {
    otherHits++; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({webSocketDebuggerUrl: 'ws://127.0.0.1:' + firstPort + '/devtools/browser/fixture'}));
  });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  const otherPort = (other.address() as {port: number}).port;
  const first = createServer((_req, res) => {
    firstHits++; res.writeHead(302, {Location: 'http://127.0.0.1:' + otherPort + '/json/version'}); res.end();
  });
  await new Promise<void>(resolve => first.listen(0, '127.0.0.1', resolve));
  firstPort = (first.address() as {port: number}).port;
  t.after(async () => {
    first.closeAllConnections(); other.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => first.close(() => resolve())), new Promise<void>(resolve => other.close(() => resolve()))]);
  });
  publishPort(profile, firstPort + '\n/devtools/browser/fixture\n');
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => {messages.push(message);});
  let received: Awaited<ReturnType<typeof launchedChrome>> | undefined;
  const settling = launchedChrome(asChild(child), profile, false, controller.signal).then(value => {received = value; return null;}, error => error as Error);
  try {
    await turnsUntil(() => otherHits > 0 || messages.some(value => value.startsWith('bench: Chrome probe ')));
    assert.equal(firstHits, 1); assert.equal(otherHits, 0); assert.equal(received, undefined);
  } finally {
    controller.abort(); const error = await settling;
    await received?.close();
    assert.match(String(error), /startup cancelled/);
  }
  assert.equal(existsSync(profile), false);
});

test('interrupting the actual entry point during startup reaps its detached browser and removes its profile',
  {skip: process.platform === 'win32'}, async t => {
    const root = mkdtempSync(path.join(tmpdir(), 'quotum-test-bench-signal-'));
    const recordFile = path.join(root, 'started.json'), executable = path.join(root, 'chrome');
    writeFileSync(executable, '#!/usr/bin/env node\n'
      + "const fs=require('node:fs');\n"
      + "const profile=process.argv.find(value=>value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);\n"
      + "fs.writeFileSync(process.env.QUOTUM_BENCH_TEST_RECORD,JSON.stringify({pid:process.pid,profile}));\n"
      + "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n", {mode: 0o755});
    const env = {...process.env};
    for (const key of Object.keys(env)) if (key.startsWith('QUOTUM_')) delete env[key];
    env.QUOTUM_CHROME = executable; env.QUOTUM_BENCH_TEST_RECORD = recordFile; env.CI = '1';
    const bench = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/starting-bench.mjs', import.meta.url))], {
      cwd: new URL('../../', import.meta.url), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', owned: {pid: number; profile: string} | undefined;
    bench.stdout.on('data', value => {output += value;}); bench.stderr.on('data', value => {output += value;});
    const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve =>
      bench.once('exit', (code, signal) => resolve({code, signal})));
    const signal = (pid: number) => {try {process.kill(-pid, 'SIGKILL');} catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }};
    t.after(async () => {
      if (!owned && existsSync(recordFile)) owned = JSON.parse(readFileSync(recordFile, 'utf8'));
      if (owned) {signal(owned.pid); rmSync(owned.profile, {recursive: true, force: true});}
      if (bench.exitCode === null && bench.signalCode === null) {signal(bench.pid!); await exited;}
      rmSync(root, {recursive: true, force: true});
    });
    const startedBy = Date.now() + 5_000;
    while (!existsSync(recordFile) && Date.now() < startedBy) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(recordFile), output);
    owned = JSON.parse(readFileSync(recordFile, 'utf8'));
    process.kill(-bench.pid!, 'SIGINT');
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('benchmark cancellation did not finish\n' + output)), 9_000);
    })]).finally(() => clearTimeout(deadline));
    assert.equal(result.code, 1, output);
    assert.throws(() => process.kill(owned!.pid, 0), {code: 'ESRCH'});
    assert.equal(existsSync(owned!.profile), false, output);
  });
