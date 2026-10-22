import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bounded, observeReversal} from '../reversalDiagnostic.js';
import {Cdp, attachedChrome} from '../cdp.js';
import type {ProcessIdentity} from '../browserProcess.js';

const flush = async () => {await new Promise<void>(resolve => setImmediate(resolve));};
function pageFixture(send: (method: string, signal?: AbortSignal) => Promise<unknown> = async () => ({})) {
  const commands: string[] = [];
  return {commands, page: {
    snapshot: () => ({pending: [{id: 1, method: 'Input.dispatchMouseEvent', started: 1, deadline: 30001}]}),
    send: async (method: string, _params: object, signal?: AbortSignal) => {commands.push(method); return send(method, signal);},
    evaluate: async (_expression: string, signal?: AbortSignal) => send('Runtime.evaluate', signal),
    on() {},close() {},
  } as unknown as Cdp};
}
const processRow = (pid: number, ticks: number): ProcessIdentity => ({pid, parent: 1, group: 100, session: 100, birth: '42', state: 'S',
  userTicks: ticks, systemTicks: 2, minorFaults: 3, majorFaults: 0, blockIoTicks: 0});

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

test('a passive owned read cannot turn a successful slow command into an intervention failure', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {page, commands} = pageFixture(), reads: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', async () => {throw new Error('no browser probe before failure');});
  const observer = await observeReversal(page, {owned: true, endpoint: 'fixture', close: async () => {}, observeProcesses: async signal => {
    reads.push(signal); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
  }});
  let release!: () => void;
  const result = observer.watch('slow success', () => new Promise<void>(resolve => {release = resolve;}));
  t.mock.timers.tick(5000); await flush(); assert.equal(reads.length, 1);
  t.mock.timers.tick(1000); await flush(); assert.equal(reads[0].aborted, true);
  release(); await result; await observer.close(); assert.deepEqual(commands, []);
});

test('original failure retains matching in-flight counters and bounded postfailure counters before debugger commands', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const logs: string[] = [], order: string[] = [];
  t.mock.method(console, 'error', (line: string) => logs.push(line));
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const {page} = pageFixture(async (method, signal) => {
    order.push(method);
    if (method === 'Runtime.evaluate') return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
    return method === 'Profiler.stop' ? {profile: {}} : {};
  });
  let reads = 0, reject!: (error: Error) => void;
  const observer = await observeReversal(page, {owned: true, endpoint: 'fixture', close: async () => {}, observeProcesses: async () => {
    order.push('process read'); return Array.from({length: ++reads === 1 ? 1 : 35}, (_, i) => processRow(100 + i, reads === 1 ? 10 : 20));
  }}, {postmortem: true});
  const original = new Error('original gesture timeout');
  const failed = assert.rejects(observer.watch('warm return', () => new Promise<never>((_, fail) => {reject = fail;})), error => error === original);
  t.mock.timers.tick(5000); await flush(); assert.deepEqual(order, ['process read']);
  t.mock.timers.tick(25000); page.snapshot = () => ({failure: {method: 'Input.synthesizeScrollGesture'}}) as ReturnType<Cdp['snapshot']>;
  reject(original); await flush(); t.mock.timers.tick(2000); await failed; await observer.close();
  assert.ok(order.lastIndexOf('process read') < order.indexOf('Debugger.enable'));
  const report = JSON.parse(logs.at(-1)!.slice('reversal diagnostic '.length));
  assert.equal(report.waitingProcesses.scenario, 'warm return');
  assert.equal(report.waitingProcesses.command.pending[0].id, 1);
  assert.equal(report.waitingProcesses.sample.processes[0].userTicks, 10);
  assert.equal(report.failedProcesses.processes[0].userTicks, 20);
  assert.equal(report.failedProcesses.processes.length, 32); assert.equal(report.failedProcesses.omitted, 3);
  for (const sample of [report.waitingProcesses.sample, report.failedProcesses]) {
    assert.equal(sample.status, 'observed'); assert.ok(sample.toMs >= sample.fromMs);
    assert.equal(sample.processes[0].birth, '42');
  }
});

test('success cancels its unfinished process read and a later command cannot inherit that sample', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const logs: string[] = [], signals: AbortSignal[] = [];
  t.mock.method(console, 'error', (line: string) => logs.push(line));
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const {page, commands} = pageFixture();
  let late!: (rows: ProcessIdentity[]) => void, release!: () => void;
  const observer = await observeReversal(page, {owned: true, endpoint: 'fixture', close: async () => {}, observeProcesses: async signal => {
    signals.push(signal); return signals.length === 1 ? new Promise(resolve => {late = resolve;}) : [processRow(100, 30)];
  }});
  const success = observer.watch('earlier command', () => new Promise<void>(resolve => {release = resolve;}));
  t.mock.timers.tick(5000); await flush(); release(); await success;
  assert.equal(signals[0].aborted, true);
  late([processRow(100, 999)]); await flush();
  const original = new Error('later command failed');
  await assert.rejects(observer.watch('later command', async () => {throw original;}), error => error === original);
  await observer.close();
  const report = JSON.parse(logs.at(-1)!.slice('reversal diagnostic '.length));
  assert.equal(report.scenario, 'later command'); assert.equal(report.waiting, undefined); assert.equal(report.waitingProcesses, undefined);
  assert.equal(report.failedProcesses.processes[0].userTicks, 30); assert.deepEqual(commands, []);
});

test('a missing postfailure process read is cancelled inside collection and preserves the command error', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const logs: string[] = [], signals: AbortSignal[] = [];
  t.mock.method(console, 'error', (line: string) => logs.push(line));
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const {page} = pageFixture();
  const observer = await observeReversal(page, {owned: true, endpoint: 'fixture', close: async () => {}, observeProcesses: async signal => {
    signals.push(signal); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('secret-canary')), {once: true}));
  }});
  const original = new Error('original error'); let finished = false;
  const failed = assert.rejects(observer.watch('failed command', async () => {throw original;}), error => error === original).then(() => {finished = true;});
  await flush(); assert.equal(finished, false);
  t.mock.timers.tick(1000); await failed; await observer.close();
  assert.equal(signals[0].aborted, true);
  const report = JSON.parse(logs.at(-1)!.slice('reversal diagnostic '.length));
  assert.equal(report.failedProcesses.status, 'unavailable'); assert.doesNotMatch(logs.join(''), /secret-canary/);
});

test('an attached browser cannot grant process observation even if a reader is supplied', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  let reads = 0;
  const {page} = pageFixture();
  const observer = await observeReversal(page, {...attachedChrome('fixture'), observeProcesses: async () => {reads++; return [processRow(100, 1)];}});
  await assert.rejects(observer.watch('attached failure', async () => {throw new Error('original');}), /original/);
  await observer.close(); assert.equal(reads, 0);
});

for(const method of ['Runtime.evaluate','Input.synthesizeScrollGesture'])test('an owned unresponsive page is inspected after '+method+' fails and always released',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const logs:string[]=[];t.mock.method(console,'error',(line:string)=>logs.push(line));
  t.mock.method(globalThis,'fetch',async()=>new Response('{}'));
  const listeners=new Map<string,(event:unknown)=>void>();let reject!:(error:Error)=>void;
  const {page,commands}=pageFixture(async(method,signal)=>{
    if(method==='Runtime.evaluate')return new Promise((_,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));
    if(method==='Debugger.enable')listeners.get('Debugger.scriptParsed')?.({scriptId:'7',url:'https://private-canary.invalid/assets/index-fixture.js',hash:'a'.repeat(64),length:1000});
    if(method==='Debugger.pause')listeners.get('Debugger.paused')?.({reason:'debugCommand',callFrames:[{location:{scriptId:'7',lineNumber:12,columnNumber:34},url:'https://private-canary.invalid',functionName:'private-canary'}]});
    return method==='Profiler.stop'?{profile:{samples:[1],timeDeltas:[1000]}}:{};
  });
  page.on=(method,listener)=>{listeners.set(method,listener as (event:unknown)=>void);};
  const original=new Error('original command deadline');
  const observer=await observeReversal(page,{owned:true,endpoint:'fixture',close:async()=>{}},{postmortem:true});
  const pending=new Promise<never>((_,fail)=>{reject=fail;});
  const failed=assert.rejects(observer.watch('first delivery',()=>pending),error=>error===original);
  t.mock.timers.tick(5000);await flush();assert.deepEqual(commands,[]);
  t.mock.timers.tick(25000);page.snapshot=()=>({failure:{method}}) as ReturnType<Cdp['snapshot']>;reject(original);
  await flush();t.mock.timers.tick(2000);await failed;await observer.close();
  assert.deepEqual(commands,['Debugger.enable','Profiler.enable','Profiler.start','Debugger.pause','Profiler.stop','Debugger.resume','Profiler.stop','Debugger.disable']);
  const report=JSON.parse(logs.at(-1)!.slice('reversal diagnostic '.length));
  assert.equal(report.postmortem,true);assert.equal(report.resumed,true);
  assert.deepEqual(report.pause,{reason:'debugCommand',frames:[{scriptId:'7',lineNumber:12,columnNumber:34}],omitted:0});
  assert.deepEqual(report.sources,[{scriptId:'7',sourceHash:'a'.repeat(64),sourceLength:1000}]);
  assert.doesNotMatch(logs.join(''),/private-canary/);
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

test('a late connection after reload cancellation cannot inspect processes or remain open',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});t.mock.method(console,'error',()=>{});
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({webSocketDebuggerUrl:'ws://fixture.invalid'})));
  let connected=()=>{},release!:(value:Cdp)=>void,closed=0,inspected=0;
  const waiting=new Promise<void>(resolve=>{connected=resolve;});
  t.mock.method(Cdp,'connect',async()=>{connected();return new Promise<Cdp>(resolve=>{release=resolve;});});
  const {page,commands}=pageFixture(),controller=new AbortController(),reason=new Error('reload observer canceled');
  const observer=await observeReversal(page,{owned:true,endpoint:'fixture',close:async()=>{}},{signal:controller.signal});
  const result=assert.rejects(observer.diagnose('native/quota/reload'),value=>value===reason);
  await waiting;controller.abort(reason);await result;await observer.close();
  release({send:async()=>{inspected++;return {};},close:()=>{closed++;}}as unknown as Cdp);await flush();
  assert.equal(closed,1);assert.equal(inspected,0);assert.deepEqual(commands,[]);
});

test('canonical reload collection retains its original navigation without debugger or raw page fields',async t=>{
  const logs:string[]=[],{page,commands}=pageFixture(async()=>({ready:'complete',url:'https://private-canary.invalid'}));
  t.mock.method(console,'error',(line:string)=>logs.push(line));
  t.mock.method(globalThis,'fetch',async()=>new Response('{}'));
  const observer=await observeReversal(page,attachedChrome('http://fixture.invalid'),{origin:{startedAt:1000,navigation:()=>({requested:{atMs:1,frame:'frame-1',loader:'loader-1'},committed:{atMs:2,frame:'frame-1',loader:'loader-2'},loadAtMs:3})}});
  await observer.diagnose('native/quota/reload');await observer.close();
  const report=JSON.parse(logs.at(-1)!.slice('reversal diagnostic '.length));
  assert.equal(report.mode,'canonical');assert.equal(report.startedAt,1000);assert.equal(report.navigation.requested.loaderId,'loader-1');assert.equal(report.navigation.committed.loaderId,'loader-2');assert.equal(report.navigation.loadAtMs,3);
  assert.deepEqual(commands,[]);assert.doesNotMatch(logs.join(''),/private-canary|Debugger|Profiler/);
});

for(const outcome of ['reply','connect timeout','evaluate timeout'] as const)test('a failed owned page compares its session with a fresh connection: '+outcome,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const logs:string[]=[],expressions:string[]=[],signals:AbortSignal[]=[];
  t.mock.method(console,'error',(line:string)=>logs.push(line));
  t.mock.method(globalThis,'fetch',async()=>new Response('{}'));
  const {page}=pageFixture(),endpoint='ws://private-canary.invalid/original-target';
  Object.defineProperty(page,'endpoint',{value:endpoint});
  const wait=(signal:AbortSignal)=>new Promise<never>((_,reject)=>{signals.push(signal);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  page.evaluate=async(expression,signal)=>{expressions.push(expression);return wait(signal!);};
  let connections=0,closed=0,reject!:(error:Error)=>void;
  t.mock.method(Cdp,'connect',async(url:string,signal?:AbortSignal)=>{
    assert.equal(url,endpoint);connections++;
    if(outcome==='connect timeout')return wait(signal!);
    return {evaluate:async(expression:string,signal:AbortSignal)=>{
      expressions.push(expression);return outcome==='evaluate timeout'?wait(signal):{private:'private-canary'};
    },close:()=>{closed++;}} as unknown as Cdp;
  });
  const observer=await observeReversal(page,{owned:true,endpoint:'fixture',close:async()=>{}});
  const original=new Error('original gesture timeout');
  const failed=assert.rejects(observer.watch('warm return',()=>new Promise<never>((_,fail)=>{reject=fail;})),error=>error===original);
  t.mock.timers.tick(6000);await flush();assert.equal(connections,0);
  page.snapshot=()=>({failure:{id:196,method:'Input.synthesizeScrollGesture'}}) as ReturnType<Cdp['snapshot']>;
  reject(original);await flush();t.mock.timers.tick(2000);await failed;await observer.close();
  assert.equal(connections,1);assert.ok(signals.every(signal=>signal.aborted));
  assert.equal(closed,outcome==='connect timeout'?0:1);
  if(outcome!=='connect timeout')assert.equal(expressions[0],expressions[1]);
  const report=JSON.parse(logs.at(-1)!.slice('reversal diagnostic '.length));
  assert.equal(report.page,'unresponsive');
  assert.equal(report.freshPage.status,outcome==='reply'?'responded':outcome==='connect timeout'?'unavailable':'unresponsive');
  assert.equal(report.freshPage.connected,outcome!=='connect timeout');
  assert.ok(report.freshPage.toMs>=report.freshPage.fromMs);
  assert.equal(report.command.failure.id,196);assert.doesNotMatch(logs.join(''),/private-canary|document\.visibilityState/);
});

test('a fresh page connection arriving after cancellation is closed without evaluating',async t=>{
  t.mock.method(console,'error',()=>{});t.mock.method(globalThis,'fetch',async()=>new Response('{}'));
  const {page}=pageFixture();Object.defineProperty(page,'endpoint',{value:'ws://private-canary.invalid/owned'});
  page.snapshot=()=>({failure:{id:196}}) as ReturnType<Cdp['snapshot']>;
  let release!:(value:Cdp)=>void,connected=()=>{},closed=0,evaluated=0;
  const started=new Promise<void>(resolve=>{connected=resolve;});
  t.mock.method(Cdp,'connect',async()=>{connected();return new Promise<Cdp>(resolve=>{release=resolve;});});
  const controller=new AbortController(),original=new Error('original gesture timeout');
  const observer=await observeReversal(page,{owned:true,endpoint:'fixture',close:async()=>{}},{signal:controller.signal});
  const failed=assert.rejects(observer.watch('warm return',async()=>{throw original;}),error=>error===original);
  await started;controller.abort();await failed;await observer.close();
  release({evaluate:async()=>{evaluated++;},close:()=>{closed++;}} as unknown as Cdp);await flush();
  assert.equal(closed,1);assert.equal(evaluated,0);
});

for(const owned of [false,true])test('a page probe cannot create another session without both ownership and its exact endpoint: '+owned,async t=>{
  t.mock.method(console,'error',()=>{});t.mock.method(globalThis,'fetch',async()=>new Response('{}'));
  const {page}=pageFixture();if(!owned)Object.defineProperty(page,'endpoint',{value:'ws://private-canary.invalid/foreign'});
  page.snapshot=()=>({failure:{id:196}}) as ReturnType<Cdp['snapshot']>;
  let connections=0;t.mock.method(Cdp,'connect',async()=>{connections++;throw new Error('unexpected connection');});
  const observer=await observeReversal(page,{owned,endpoint:'fixture',close:async()=>{}}),original=new Error('original');
  await assert.rejects(observer.watch('failed',async()=>{throw original;}),error=>error===original);await observer.close();assert.equal(connections,0);
});
