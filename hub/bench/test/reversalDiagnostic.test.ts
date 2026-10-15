import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {bounded,observeReversal} from '../reversalDiagnostic.js';
import {Cdp,attachedChrome} from '../cdp.js';

const flush=async()=>{for(let turn=0;turn<60;turn++)await Promise.resolve();};
function diagnosticFixture(t:TestContext,stalled:string|string[]=''){
  const commands:string[]=[],logs:string[]=[];
  let controlClosed=false,independentClosed=false,pageClosed=false,release!:(value:unknown)=>void,paused:((event:{callFrames:[]})=>void)|undefined,reads=0;
  const pending=new Promise<unknown>(resolve=>{release=resolve;});
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({webSocketDebuggerUrl:'ws://control.invalid'})));
  t.mock.method(console,'error',(line:string)=>logs.push(line));
  const control={send:async()=>{commands.push('SystemInfo.getProcessInfo');return {processInfo:[{type:'renderer',id:17,cpuTime:++reads}]};},close:()=>{controlClosed=true;}};
  const independent={evaluate:async()=>{commands.push('independent state');return stalled==='independent state'?pending:{responsive:true};},close:()=>{independentClosed=true;}};
  t.mock.method(Cdp,'connect',async(url:string)=>(url==='ws://page.invalid'?independent:control) as unknown as Cdp);
  const page={endpoint:'ws://page.invalid',close:()=>{pageClosed=true;},on:(_method:string,listener:typeof paused)=>{paused=listener;},send:async(method:string)=>{
    commands.push(method);if(Array.isArray(stalled)?stalled.includes(method):method===stalled)return pending;
    if(method==='Runtime.evaluate')return {result:{value:{ready:'loading'}}};
    if(method==='Debugger.pause')paused?.({callFrames:[]});
    if(method==='Profiler.stop')return {profile:{nodes:[],samples:[],timeDeltas:[]}};
    return {};
  }} as unknown as Cdp;
  const browser={...attachedChrome('http://fixture.invalid'),diagnostics:async(pids:number[],candidate?:number)=>{commands.push('native');return {pids,candidate};}};
  return {page,browser,commands,logs,release,closed:()=>({control:controlClosed,independent:independentClosed,page:pageClosed})};
}

test('diagnostic waiting is bounded independently of a silent page response',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const failed=assert.rejects(bounded('page pause',new Promise(()=>{})),/page pause: diagnostic deadline/);
  t.mock.timers.tick(5000);await failed;
});

test('a responsive diagnostic preserves its result or error and releases its deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  assert.deepEqual(await bounded('browser',Promise.resolve({responded:true})),{responded:true});
  const error=new Error('original failure');await assert.rejects(bounded('browser',Promise.reject(error)),candidate=>candidate===error);
  t.mock.timers.tick(5000);
});

test('canceling a diagnostic step releases its deadline and preserves the cancellation reason',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const controller=new AbortController(),reason=new Error('whole observer deadline');
  let release!:(value:string)=>void;
  const pending=new Promise<string>(resolve=>{release=resolve;});
  const failed=assert.rejects(bounded('page pause',pending,5000,controller.signal),error=>error===reason);
  controller.abort(reason);await failed;release('late reply');t.mock.timers.tick(5000);
});

test('native evidence starts before a silent renderer and independent state does not wait for it',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const f=diagnosticFixture(t,'Runtime.evaluate'),controller=new AbortController();
  const observer=await observeReversal(f.page,f.browser,false,controller.signal);
  assert.deepEqual(f.commands,['SystemInfo.getProcessInfo']);
  const diagnosed=observer.diagnose('native/budget/reload');await flush();
  assert.ok(f.commands.indexOf('native')<f.commands.indexOf('Runtime.evaluate'));
  assert.ok(f.commands.includes('independent state'),'the second socket runs while the first remains silent');
  t.mock.timers.tick(5000);await diagnosed;await observer.close();
  const result=JSON.parse(f.logs[0].slice('reversal diagnostic '.length));
  assert.equal(result.elapsedMs,5000);assert.equal(result.cpuElapsedMs,5000);assert.match(result.pageState,/diagnostic deadline/);
  assert.deepEqual(result.native,{pids:[17],candidate:17});assert.deepEqual(result.independentState,{responsive:true});
  assert.equal(result.browserCpu[0].cpuDeltaSeconds,1);
  assert.equal(result.timing.nativeStarted.atMs,0);assert.equal(result.timing.nativeFinished.atMs,0);
  assert.equal(result.timing.pageFinished.atMs,5000);assert.equal(result.timing.processBefore.atMs,0);assert.equal(result.timing.processAfter.atMs,5000);
  assert.ok(f.commands.indexOf('native')<f.commands.indexOf('Debugger.enable'));
  assert.ok(f.commands.lastIndexOf('SystemInfo.getProcessInfo')>f.commands.indexOf('independent state'),'CPU delta spans the bounded page probes');
  assert.deepEqual(f.closed(),{control:true,independent:true,page:false});
});

test('all reported browser processes reach the ownership guard and late V8 capture has its own loader context',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const f=diagnosticFixture(t,'Runtime.evaluate'),controller=new AbortController();
  const processes=[{type:'renderer',id:17,cpuTime:1},{type:'browser',id:11,cpuTime:1},{type:'GPU',id:12,cpuTime:1},{type:'network',id:13,cpuTime:1}];
  const connect=Cdp.connect;
  t.mock.method(Cdp,'connect',async(url:string,signal?:AbortSignal)=>{
    const connection=await connect(url,signal);
    if(url!=='ws://page.invalid')t.mock.method(connection,'send',async()=>({processInfo:processes}));
    return connection;
  });
  let committed:{atMs:number;frame:string;loader:string}|undefined;
  const origin={startedAt:Date.now(),navigation:()=>({requested:{atMs:10,frame:'frame',loader:'new'},committed,loadAtMs:committed?8304:null})};
  t.mock.timers.tick(5000);
  const observer=await observeReversal(f.page,f.browser,false,controller.signal,origin);
  const diagnosed=observer.diagnose('native/budget/reload');await flush();
  committed={atMs:8263,frame:'frame',loader:'new'};t.mock.timers.tick(4000);
  f.release({result:{value:{ready:'complete',timeOrigin:8000}}});await diagnosed;await observer.close();
  const result=JSON.parse(f.logs[0].slice('reversal diagnostic '.length));
  assert.deepEqual(result.native,{pids:[17,11,12,13],candidate:17});
  assert.equal(result.timing.nativeStarted.atMs,5000);assert.equal(result.timing.nativeStarted.navigation.committed,undefined);
  assert.equal(result.timing.profileStarted.atMs,9000);assert.deepEqual(result.timing.profileStarted.navigation.committed,committed);
  assert.equal(result.timing.paused.atMs,9000);assert.equal(result.pageState.timeOrigin,8000);
});

test('a slow native capture does not block either renderer probe and cancellation sends no late V8 commands',async t=>{
  const f=diagnosticFixture(t),controller=new AbortController(),reason=new Error('whole observer deadline');
  let release!:()=>void;
  t.mock.method(f.browser,'diagnostics',async()=>{f.commands.push('native');return new Promise<void>(resolve=>{release=resolve;});});
  const observer=await observeReversal(f.page,f.browser,false,controller.signal);
  const failed=assert.rejects(observer.diagnose('native/budget/reload'),error=>error===reason);
  await flush();assert.ok(f.commands.includes('Runtime.evaluate'));assert.ok(f.commands.includes('independent state'));
  controller.abort(reason);await failed;await observer.close();
  const sent=f.commands.slice();release();await flush();assert.deepEqual(f.commands,sent);
  assert.equal(sent.some(command=>command.startsWith('Debugger.')||command.startsWith('Profiler.')),false);
});

for(const stalled of ['Debugger.enable','Profiler.enable','Profiler.start','Debugger.pause'])test(`cancellation cleans up requested ${stalled} before its late acknowledgement`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=diagnosticFixture(t,stalled),controller=new AbortController(),reason=new Error('whole observer deadline');
  const observer=await observeReversal(f.page,f.browser,false,controller.signal);
  const failed=assert.rejects(observer.diagnose('native/budget/reload'),error=>error===reason);
  await flush();assert.ok(f.commands.includes(stalled));controller.abort(reason);await failed;await observer.close();
  const sent=f.commands.slice();
  const cleanup=stalled==='Debugger.enable'?['Debugger.resume','Debugger.disable']:stalled==='Profiler.enable'?['Debugger.resume','Profiler.disable','Debugger.disable']:['Debugger.resume','Profiler.stop','Profiler.disable','Debugger.disable'];
  assert.deepEqual(sent.slice(-cleanup.length),cleanup,'cleanup accounts for requests whose replies never arrived');
  f.release({});await flush();t.mock.timers.tick(30000);await flush();
  assert.deepEqual(f.commands,sent,'no late continuation may enable or pause the page');
  assert.deepEqual(f.closed(),{control:true,independent:true,page:false});
  assert.ok(f.logs[0].includes('"aborted":true'));assert.ok(f.logs[0].includes('"native":{"pids":[17],"candidate":17}'));
});

test('canceling a pending independent page probe closes only diagnostic connections and never starts V8',async t=>{
  const f=diagnosticFixture(t,'independent state'),controller=new AbortController(),reason=new Error('whole observer deadline');
  const observer=await observeReversal(f.page,f.browser,false,controller.signal);
  const failed=assert.rejects(observer.diagnose('native/budget/reload'),error=>error===reason);
  await flush();assert.ok(f.commands.includes('independent state'));controller.abort(reason);await failed;await observer.close();
  const sent=f.commands.slice();f.release({responsive:true});await flush();assert.deepEqual(f.commands,sent);
  assert.equal(f.commands.some(method=>method.startsWith('Debugger.')||method.startsWith('Profiler.')),false);
  assert.deepEqual(f.closed(),{control:true,independent:true,page:false});
});

test('canceled V8 cleanup has a four-second bound even when none of its requests are acknowledged',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const cleanup=['Debugger.resume','Profiler.stop','Profiler.disable','Debugger.disable'];
  const f=diagnosticFixture(t,['Profiler.start',...cleanup]),controller=new AbortController(),reason=new Error('whole observer deadline');
  const observer=await observeReversal(f.page,f.browser,false,controller.signal);
  const failed=assert.rejects(observer.diagnose('native/budget/reload'),error=>error===reason);
  await flush();controller.abort(reason);await failed;
  let closed=false;const closing=observer.close().then(()=>{closed=true;});await flush();
  for(let second=0;second<4;second++){assert.equal(closed,false);t.mock.timers.tick(1000);await flush();}
  await closing;assert.deepEqual(f.commands.slice(-4),cleanup);assert.equal(f.closed().page,false);
  const sent=f.commands.slice();f.release({});await flush();assert.deepEqual(f.commands,sent);
});

test('the original stalled page is diagnosed without pre-enabling V8 and a recovered input cannot pass',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({webSocketDebuggerUrl:'ws://fixture.invalid'})));
  let controlClosed=false,independentClosed=false;
  const control={send:async()=>({processInfo:[{type:'renderer',id:1,cpuTime:1}]}),close:()=>{controlClosed=true;}};
  const independent={evaluate:async()=>({responsive:true}),close:()=>{independentClosed=true;}};
  t.mock.method(Cdp,'connect',async(url:string)=>(url==='ws://page.invalid'?independent:control) as unknown as Cdp);
  const messages:unknown[]=[],commands:string[]=[];
  t.mock.method(console,'error',(message:unknown)=>{messages.push(message);});
  let paused:((event:{callFrames:[]})=>void)|undefined,releaseInput!:()=>void;
  const input=new Promise<void>(resolve=>{releaseInput=resolve;});
  const page={endpoint:'ws://page.invalid',on:(_method:string,listener:typeof paused)=>{paused=listener;},send:async(method:string)=>{
    commands.push(method);
    if(method==='Runtime.evaluate')throw new Error('stalled original session');
    if(method==='Debugger.pause')paused?.({callFrames:[]});
    if(method==='Profiler.stop'){releaseInput();return {profile:{nodes:[],samples:[],timeDeltas:[]}};}
    return {};
  }};
  const observer=await observeReversal(page as unknown as Cdp,attachedChrome('http://fixture.invalid'),false);
  assert.equal(commands.length,0,'the canonical input must start before any V8 diagnostics');
  const failed=assert.rejects(observer.watch('repeat wheel',()=>input),/response arrived after diagnostic intervention/);
  t.mock.timers.tick(5000);await failed;await observer.close();
  assert.ok(commands.includes('Debugger.pause'));
  assert.ok(messages.some(message=>String(message).includes('"activation":"after stall"')));
  assert.ok(messages.some(message=>String(message).includes('"independentState":{"responsive":true}')));
  assert.equal(independentClosed,true);
  assert.equal(controlClosed,true);
});
