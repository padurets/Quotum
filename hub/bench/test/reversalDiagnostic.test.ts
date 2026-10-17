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
    on() {},close() {},
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
