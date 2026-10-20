import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {attachedChrome, Cdp, openTab,nativeProcesses, threadWait,threadCall} from '../cdp.js';
import {Requests} from '../index.js';
import {safeEvidence} from '../evidence.js';
import {HISTORY_BYTES_PER_MEASUREMENT,renderProblems} from '../budget.js';

/** Stands in for what the benchmark hears of the browser: events by name, emitted by the test. */
function browser() {
  const listeners = new Map<string, ((params: unknown) => void)[]>();
  return {
    on: (method: string, listener: (params: unknown) => void) => void listeners.set(method, [...(listeners.get(method) ?? []), listener]),
    emit: (method: string, params: unknown) => listeners.get(method)?.forEach(listener => listener(params)),
  };
}

test('native wait evidence keeps syscall numbers and distinguishes missing kernel symbols',()=>{
  assert.deepEqual(threadWait('0\n'),{kind:'unavailable'});
  assert.deepEqual(threadWait('futex_wait_queue\n'),{kind:'futex'});
  assert.deepEqual(threadCall('202 0x12345678 0x80 0x0 0x0 0x0 0x0 0x7fff 0xabc\n'),{status:'available',number:202});
  assert.deepEqual(threadCall('-1 0x7fff 0xabc'),{status:'available',number:-1});
  assert.deepEqual(threadCall('running'),{status:'running'});
  for(const value of ['unavailable','202','202 token=private 0x80 0x0 0x0 0x0 0x0 0x7fff 0xabc','123456789 0x1 0x2 0x3 0x4 0x5 0x6 0x7 0x8'])assert.deepEqual(threadCall(value),{status:'unavailable'});
  const saved=safeEvidence({call:threadCall('202 0x12345678 0x80 0x0 0x0 0x0 0x0 0x7fff 0xabc')});
  assert.deepEqual(saved,{call:{status:'available',number:202}});
});

test('native diagnostics inspect an owned process and exclude a process outside its ancestry',{skip:process.platform!=='linux'},async()=>{
  const owned=await nativeProcesses(process.pid,[process.pid,999999999]);
  assert.equal(owned.length,1);assert.equal(owned[0].pid,process.pid);
  assert.ok(owned[0].threads.length>0);
  assert.deepEqual(await nativeProcesses(999999999,[process.pid]),[]);
});

test('an owned blocked thread keeps its wait category in the saved evidence', {skip: process.platform !== 'linux'}, async t => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);'], {stdio: ['ignore', 'pipe', 'ignore']});
  const closed = once(child, 'close');
  t.after(async () => {if (child.exitCode === null && child.signalCode === null) child.kill(); await closed;});
  assert.ok(child.pid);
  await Promise.race([once(child.stdout!, 'data'), closed.then(() => {throw new Error('the stand-in exited before its wait');})]);
  const end = Date.now() + 5_000;
  for (;;) {
    const processes = await nativeProcesses(process.pid, [child.pid]);
    const thread = processes[0]?.threads.find(row => row.id === child.pid);
    const saved = safeEvidence({processes}) as {processes: {threads: {id: number; wait: {kind: string}}[]}[]};
    if (thread?.state.some(line => line.startsWith('State:\tS'))) {
      const wait = saved.processes[0].threads.find(row => row.id === child.pid)?.wait;
      assert.ok(wait && ['futex', 'poll', 'timer', 'pipe', 'child', 'io', 'unknown', 'unavailable'].includes(wait.kind));
      assert.deepEqual(wait, thread.wait, 'serialization must retain the observed category even when the kernel symbol is unavailable');
      break;
    }
    assert.ok(Date.now() < end, 'the stand-in must reach its blocking wait');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
});

test('known native waits keep fixed categories while unknown symbols expose no raw text', () => {
  assert.deepEqual(safeEvidence({wait: threadWait('futex_wait_queue')}), {wait: {kind: 'futex'}});
  assert.deepEqual(safeEvidence({wait: threadWait('ep_poll')}), {wait: {kind: 'poll'}});
  assert.deepEqual(safeEvidence({wait: threadWait('0')}), {wait: {kind: 'unavailable'}});
  assert.deepEqual(safeEvidence({wait: threadWait('unavailable')}), {wait: {kind: 'unavailable'}});
  const saved = safeEvidence({wait: threadWait('/private-canary/kernel-symbol')});
  assert.deepEqual(saved, {wait: {kind: 'unknown'}}); assert.doesNotMatch(JSON.stringify(saved), /private-canary|kernel-symbol/);
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
  reject(id: number, message: string) {this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({id, error: {message}})}));}
  emit(method: string, params: object = {}) {this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({method, params})}));}
  close() {this.readyState = WebSocket.CLOSED;}
}
const connection = (socket: Socket) => new (Cdp as unknown as new (socket: unknown) => Cdp)(socket);

test('a protocol rejection keeps its original command through cleanup without retaining browser text', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  t.mock.method(performance,'now',()=>10000+2/7);
  for (const method of ['Runtime.evaluate', 'Network.getResponseBody']) {
    const socket = new Socket(), cdp = connection(socket);
    try {
      cdp.at('board/open');
      const failed = assert.rejects(cdp.send(method, {expression: 'private-expression-canary'}), /private-protocol-text-canary/);
      cdp.at('cleanup'); socket.reject(1, 'private-protocol-text-canary'); await failed;
      const original = cdp.snapshot().failure;
      assert.ok(original);
      assert.equal(original.id, 1); assert.equal(original.method, method); assert.equal(original.context, 'board/open');
      assert.equal(original.reason, 'the browser rejected the command');
      // Subtracting fractional timestamps can round the interval in either direction.
      assert.ok(Number.isFinite(original.elapsedMs)); assert.ok(Number.isFinite(original.started));
      assert.equal(original.deadline, original.started + 30_000);
      const cleanup = cdp.send('Emulation.setCPUThrottlingRate', {rate: 1}); socket.answer(2, {}); await cleanup;
      assert.equal(cdp.snapshot().lastAck?.id, 2);
      const timed = assert.rejects(cdp.send('Performance.getMetrics'), /no browser response/);
      t.mock.timers.tick(30_000); await timed;
      socket.reject(1, 'private-late-error-canary'); socket.reject(999, 'private-unknown-error-canary');
      assert.deepEqual(cdp.snapshot().failure, original); assert.deepEqual(cdp.snapshot().pending, []);
      assert.doesNotMatch(JSON.stringify(cdp.snapshot()), /private-|expression|message/);
    } finally {cdp.close();}
  }
});

test('a rejection for an unknown or cancelled command cannot invent another command failure', async () => {
  const socket = new Socket(), cdp = connection(socket), abort = new AbortController();
  try {
    socket.reject(999, 'private-unknown-error-canary');
    assert.equal(cdp.snapshot().failure, null);
    const cancelled = assert.rejects(cdp.send('Runtime.evaluate', {expression: 'private-expression-canary'}, abort.signal), /cancelled/);
    abort.abort(); await cancelled; socket.reject(1, 'private-cancelled-error-canary');
    assert.equal(cdp.snapshot().failure, null);
    cdp.at('board/open'); const failed = assert.rejects(cdp.send('Network.getResponseBody'), /private-protocol-text-canary/);
    socket.reject(1, 'private-stale-error-canary'); assert.equal(cdp.snapshot().failure, null);
    socket.reject(2, 'private-protocol-text-canary'); await failed;
    assert.equal(cdp.snapshot().failure?.id, 2); assert.equal(cdp.snapshot().failure?.method, 'Network.getResponseBody');
    assert.equal(cdp.snapshot().failure?.context, 'board/open'); assert.deepEqual(cdp.snapshot().pending, []);
    assert.doesNotMatch(JSON.stringify(cdp.snapshot()), /private-|expression|message/);
  } finally {cdp.close();}
});

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

test('canceling a pending diagnostic connection closes its socket and ignores late open or error events',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const sockets:ConnectingSocket[]=[];
  class ConnectingSocket extends EventTarget {
    closes=0;
    constructor(){super();sockets.push(this);}
    close(){this.closes++;}
  }
  t.mock.property(globalThis,'WebSocket',ConnectingSocket as unknown as typeof WebSocket);
  const controller=new AbortController(),reason=new Error('diagnostic canceled');
  const failed=assert.rejects(Cdp.connect('ws://fixture.invalid',controller.signal),error=>error===reason);
  assert.equal(sockets.length,1);controller.abort(reason);await failed;
  sockets[0].dispatchEvent(new Event('open'));sockets[0].dispatchEvent(new Event('error'));
  t.mock.timers.tick(30000);assert.equal(sockets[0].closes,1);
  await assert.rejects(Cdp.connect('ws://unused.invalid',controller.signal),error=>error===reason);
  assert.equal(sockets.length,1,'an already canceled connection never opens a socket');
});

test('a settled diagnostic connection removes its abort handler and connection deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const sockets:ConnectingSocket[]=[];
  class ConnectingSocket extends EventTarget {
    closes=0;
    constructor(){super();sockets.push(this);}
    close(){this.closes++;}
  }
  t.mock.property(globalThis,'WebSocket',ConnectingSocket as unknown as typeof WebSocket);
  const controller=new AbortController(),opening=Cdp.connect('ws://fixture.invalid',controller.signal);
  sockets[0].dispatchEvent(new Event('open'));const cdp=await opening;
  controller.abort();sockets[0].dispatchEvent(new Event('error'));t.mock.timers.tick(30000);
  assert.equal(sockets[0].closes,0,'after opening, its owner controls the CDP lifetime');
  cdp.close();assert.equal(sockets[0].closes,1);
  const failedController=new AbortController(),failed=assert.rejects(Cdp.connect('ws://fixture.invalid',failedController.signal),/cannot reach the browser/);
  sockets[1].dispatchEvent(new Event('error'));await failed;
  failedController.abort();t.mock.timers.tick(30000);assert.equal(sockets[1].closes,1);
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

test('work diagnostics partition the original compact body without changing physical traffic or exporting its contents',async()=>{
  const events=browser(),calls:string[]=[];
  const body='{"basis":{"evidenceCut":3e3,"run":"private-run"},"sessions":{"state":"delta","value":{"cursor":"private-cursor","refs":["private-ref"]}},"calendar":{"value":{"updates":[[0,3e3]]}},"private-key":[1,2]}';
  const cdp={...events,send:async<T>(method:string)=>{calls.push(method);return {body,base64Encoded:false} as T;}};
  const requests=new Requests(cdp as unknown as Cdp,true);requests.counting=true;
  const postData=JSON.stringify({selection:{mode:'live',periodMs:86400000,private:'private-selection'},evaluatedAt:3000,quota:{from:'0',to:'3000',cell:'1000',cells:'skip',evidence:'private-evidence'},sessions:{cursor:'private-cursor'},calendar:{zone:'private-zone',cursor:'private-calendar'}});
  cdp.emit('Network.requestWillBeSent',{requestId:'private-request',type:'Fetch',request:{url:'http://localhost/api/boards/private-board/period',postData}});
  cdp.emit('Network.responseReceived',{requestId:'private-request',response:{status:200,headers:{'Content-Encoding':'gzip','Content-Length':'4300',Authorization:'private-header'}}});
  cdp.emit('Network.dataReceived',{requestId:'private-request',encodedDataLength:4200,dataLength:Buffer.byteLength(body)});
  requests.counting=false;
  cdp.emit('Network.loadingFinished',{requestId:'private-request',encodedDataLength:4712});
  assert.deepEqual(calls,[],'the measurement sends no body command');
  assert.equal(requests.historyBytes,4712);assert.equal(requests.historyRequests,1);assert.equal(requests.historyPending,0);
  const result=await requests.diagnose(cdp);assert.equal(result.status,'complete');assert.ok('body' in result);
  assert.equal(result.body.partition,Buffer.byteLength(body));assert.equal(result.body.decodedBytes,Buffer.byteLength(body));
  assert.equal(result.body.sections.basis,Buffer.byteLength('{"evidenceCut":3e3,"run":"private-run"}'));
  assert.deepEqual(result.body.sectionStates.sessions,{state:'delta',arrays:{refs:1}});
  assert.deepEqual(result.body.sectionStates.calendar,{state:null,arrays:{updates:1}});
  assert.deepEqual(result.body.unknown,{count:1,bytes:5});assert.equal(result.body.headerBytes,null);
  assert.equal(result.reads[0].encodedTotal,4712);assert.equal(result.reads[0].encodedBodyLower,4200);assert.equal(result.reads[0].contentLength,4300);
  assert.equal(requests.historyBytes,4712,'decoded and encoded body observations cannot replace the original budget');
  assert.deepEqual(calls,['Network.getResponseBody']);assert.doesNotMatch(JSON.stringify(safeEvidence(result)),/private-/);
});

test('ambiguous, cancelled and omitted work reads cannot cause speculative response-body commands',async()=>{
  for(const count of [1,2,9]){
    const events=browser(),cdp={...events,send:async()=>{throw Error('unexpected diagnostic body request');}};
    const requests=new Requests(cdp as unknown as Cdp,true);requests.counting=true;
    for(let i=0;i<count;i++){
      const requestId=String(i);cdp.emit('Network.requestWillBeSent',{requestId,type:'Fetch',request:{url:'http://localhost/api/boards/b/period'}});
      cdp.emit('Network.dataReceived',{requestId,encodedDataLength:123});
      cdp.emit(count===1?'Network.loadingFailed':'Network.loadingFinished',{requestId,encodedDataLength:4712});
    }
    const before=requests.historyBytes,result=await requests.diagnose(cdp);
    assert.equal(result.status,'insufficient-evidence');assert.equal(requests.historyBytes,before);
    assert.equal(result.omitted,count===9?1:0);assert.equal(result.reads.length,Math.min(8,count));
    if(count===1){assert.equal(before,123);assert.equal(result.reads[0].request,null);}
  }
});

test('the actual work phase freezes all three original verdicts before body diagnostics, whose failure cannot erase the budget failure',async()=>{
  const source=readFileSync(new URL('../index.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
  const node=ast.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='work')!;
  const code=ts.transpileModule('('+node.getText(ast)+')',{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
  for(const overBudget of [false,true])for(const failedBody of [false,true]){
    const events=browser(),order:string[]=[],saved:unknown[]=[],originalFailure={method:'Original.command',id:99};let reports=0,calendar=0;
    const cdp={...events,evaluate:async(expression:string)=>expression.startsWith('Array.from')?++calendar:expression==='__quotumBench.read()'?{renders:[],mutations:[]}:undefined,
      snapshot:()=>({failure:originalFailure}),at:(stage:string)=>order.push(stage),send:async<T>(method:string)=>{order.push(method);if(failedBody)throw Error('private-response-error');return {body:'{"sessions":{"state":"delta","value":[]}}',base64Encoded:false} as T;}};
    const demo={work:()=>{},nextReport:async()=>{order.push('report'+(++reports));if(reports>1){const requestId=String(reports),bytes=overBudget&&reports===2?4712:3842;
      events.emit('Network.requestWillBeSent',{requestId,type:'Fetch',request:{url:'http://localhost/api/boards/b/period',postData:'{"selection":{"mode":"live","periodMs":86400000}}'}});
      events.emit('Network.loadingFinished',{requestId,encodedDataLength:bytes});}return reports*1000;}};
    const work=runInNewContext(code,{Requests,Date,MEASURED:'measured',HISTORY_BYTES_PER_MEASUREMENT,renderProblems,sleep:async()=>{},drain:async(requests:Requests)=>assert.equal(requests.historyPending,0)});
    const result=await work(demo,{sources:new Map([['measured','source']])},cdp,{save:(_name:string,value:unknown)=>{order.push('save');saved.push(JSON.parse(JSON.stringify(value)));}});
    assert.equal(result.reports.length,3);assert.equal(saved.length,1);
    assert.deepEqual(Array.from(result.reports,(row:{bytes:number})=>row.bytes),overBudget?[4712,3842,3842]:[3842,3842,3842]);
    assert.equal(result.problems.length,overBudget?1:0);
    assert.equal(order.filter(value=>value==='Network.getResponseBody').length,3);
    if(overBudget)assert.equal(result.problems[0],'work report read history 1 times, 4712 bytes');
    assert.ok(order.indexOf('Network.getResponseBody')>order.indexOf('report4'));assert.ok(order.indexOf('save')<order.indexOf('Network.getResponseBody'));assert.deepEqual(result.traffic.originalCommandFailure,originalFailure);assert.ok(result.traffic.reports.every((row:{status:string})=>row.status===(failedBody?'insufficient-evidence':'complete')));
    const original=saved[0] as {reports:unknown;problems:unknown};
    assert.deepEqual(JSON.parse(JSON.stringify({reports:result.reports,problems:result.problems})),{reports:original.reports,problems:original.problems});
  }
});

test('composite and detail attempts stay in the accounting budget after cancellation and the measurement window',()=>{
  const cdp=browser(),requests=new Requests(cdp as unknown as Cdp);requests.counting=true;
  for(const [requestId,path] of [['period','/api/boards/b/period'],['detail','/api/boards/b/period/sessions']])cdp.emit('Network.requestWillBeSent',{requestId,type:'Fetch',request:{url:'http://localhost'+path}});
  assert.equal(requests.historyPending,2);assert.equal(requests.historyRequests,2);
  requests.counting=false;
  cdp.emit('Network.dataReceived',{requestId:'detail',encodedDataLength:123});
  cdp.emit('Network.loadingFailed',{requestId:'detail',canceled:true});
  cdp.emit('Network.loadingFinished',{requestId:'period',encodedDataLength:2345});
  assert.equal(requests.historyPending,0);assert.equal(requests.historyBytes,2468);
});
