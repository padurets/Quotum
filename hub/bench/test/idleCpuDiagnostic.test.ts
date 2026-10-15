import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import type {Cdp} from '../cdp.js';
import type {Reading} from '../probe.js';
import {IdleCpuDiagnostic,sourceIdentity,idleEdgeProblems,originalTraceProblems,ownedClockFires,planIdleEdge,idleCommittedScript,type IdleGeometry} from '../idleCpuDiagnostic.js';
import {numericProfile,profileWindow} from '../cpuProfile.js';
import {idleWindow,idlePhaseScript,idlePhaseProblems} from '../still.js';
import {encodeSamples} from '../../server/domain/periodTape.js';
import {safeEvidence} from '../evidence.js';
import {fixture,flush,NOW,H,M} from '../../ui/test/periodRuntimeFixture.js';

type Saved={name:string;value:unknown;large?:boolean};

function committedReader(pool?:unknown) {
  let clock=0;
  const forbidden=()=>{throw Error('snapshot scheduled work');};
  const context:Record<string,any>={exports:{},Map,Set,WeakMap,Date,performance:{now:()=>++clock},setTimeout:forbidden,setInterval:forbidden,requestAnimationFrame:forbidden,queueMicrotask:forbidden};
  runInNewContext('window=globalThis;'+idleCommittedScript(),context);
  if(pool)context.__quotumInspectHistoryPool(pool);
  return {context,attach:context.__quotumInspectHistoryPool,read:()=>JSON.parse(JSON.stringify(safeEvidence(context.__quotumIdleCommitted.read())))};
}

test('committed snapshots distinguish real work-only sharing from measurement-prefix replacement',async t=>{
  const start=NOW-24*H;let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({personal:true,periodName:'24h',clocked:true,creditFrom:start+2*M,creditTo:start+5*M});
  try{
    const source=h.store.source('codex','d'.repeat(24),start-H);h.store.hold(source,h.alice.id,start-H);
    for(let i=0;i<12;i++)h.store.record(source,{observedAt:start+M+i*10*M,plan:'',resets:null,staleAfterMs:48*H,windows:['w','PRIVATE_CANARY'].map(id=>({id,kind:'weekly',label:null,minutes:10080,used:10+i*.1,remaining:90-i*.1,resetAt:NOW+24*H}))});
    for(const [id,from,to] of [['d',start+2*M,start+5*M],['d',start+H+10*M,start+H+30*M]] as const)h.store.creditWork(h.device,from,to,[{source,client:'codex',origin:'terminal',startedAt:start-H,project:'PRIVATE_CANARY',folder:'PRIVATE_CANARY',identity:{kind:'stable',sessionId:id.repeat(32)}}]);
    h.events.flush();await flush();
    const reader=committedReader(h.pool),before=reader.read(),again=reader.read();
    assert.equal(before.status,'complete');assert.equal(before.rows.length,3);assert.equal(new Set(before.rows.map((row:number[])=>row[0])).size,3);
    assert.deepEqual(again.rows,before.rows);assert.equal(again.ownerId,before.ownerId);
    const requests=h.requests.length;
    now=NOW+5*M;h.jump(now);await flush();const workOnly=reader.read();assert.equal(workOnly.status,'complete');
    assert.equal(workOnly.ownerId,before.ownerId);assert.notEqual(workOnly.workIndexId,before.workIndexId);
    for(const old of before.rows){const row=workOnly.rows.find((r:number[])=>r[0]===old[0]);assert.equal(row[1],old[1]);assert.notEqual(row[5],old[5]);for(const column of [6,7,8,9])assert.equal(row[column],old[column]);}
    now=NOW+12*M;h.jump(now);await flush();const trimmed=reader.read();assert.equal(trimmed.status,'complete');
    const replaced=trimmed.rows.filter((row:number[])=>row[2]!==workOnly.rows.find((r:number[])=>r[0]===row[0])[2]);assert.equal(replaced.length,2);
    for(const row of replaced){const old=workOnly.rows.find((r:number[])=>r[0]===row[0]);assert.notEqual(row[1],old[1]);assert.ok(row[3]<old[3]);for(const column of [5,7,8,9])assert.notEqual(row[column],old[column]);}
    assert.equal(h.requests.length,requests);assert.ok(!JSON.stringify([before,workOnly,trimmed]).includes('PRIVATE_CANARY'));assert.ok(!JSON.stringify(trimmed).includes(source));
    const integrated=committedReader(),module=readFileSync(new URL('../../ui/lib/historyPool.ts',import.meta.url),'utf8');
    runInNewContext(ts.transpileModule(module,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,integrated.context);
    assert.equal(integrated.read().status,'insufficient-evidence');integrated.context.exports.historyPool.register(h.period);
    const singleton=integrated.read();assert.equal(singleton.status,'complete');assert.equal(singleton.rows.length,trimmed.rows.length);
  }finally{await h.close();}
});

test('committed snapshots reject incomplete ownership and private shapes without invoking getters',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true});
  try{
    const reader=committedReader();assert.equal(reader.read().status,'insufficient-evidence');reader.attach(h.pool);assert.equal(reader.read().status,'complete');
    const entry=h.period.tapes.get('quota'),series=entry.tape.quota[0],indices=entry.accounting.quota,key=series.source+'\n'+series.window,index=indices.get(key);
    indices.delete(key);assert.equal(reader.read().status,'insufficient-evidence');indices.set(key,index);
    const descriptor=Object.getOwnPropertyDescriptor(series,'samples')!;let invoked=0;
    Object.defineProperty(series,'samples',{configurable:true,get:()=>{invoked++;throw Error('PRIVATE_CANARY');}});
    assert.equal(reader.read().status,'insufficient-evidence');assert.equal(invoked,0);Object.defineProperty(series,'samples',descriptor);
    const rows=entry.tape.quota;entry.tape.quota=Array(129).fill(series);assert.equal(reader.read().status,'insufficient-evidence');entry.tape.quota=rows;
    h.period.retiring=true;assert.equal(reader.read().status,'insufficient-evidence');h.period.retiring=false;
    const known=index.known;for(const [value,kind] of [[Infinity,1],[-Infinity,2],[NaN,3]]){index.known=value;const snapshot=reader.read();assert.equal(snapshot.status,'complete');assert.deepEqual(snapshot.rows[0].slice(14),[kind,null]);}index.known=known;
    const extra={tapes:new Map(),transport:{}};h.pool.register(extra as any);assert.equal(reader.read().status,'insufficient-evidence');(h.pool as any).members.delete(extra);
    reader.attach(h.pool);assert.equal(reader.read().status,'insufficient-evidence');
  }finally{await h.close();}
});
test('manual control reports its checked out source separately from the workflow event',()=>{
  const source='1'.repeat(40),event='2'.repeat(40),receipt=sourceIdentity({QUOTUM_BENCH_SOURCE_SHA:source,GITHUB_SHA:event},()=>source);
  assert.equal(receipt.status,'complete');assert.equal(receipt.sourceHead,source);assert.equal(receipt.checkoutSha,source);assert.equal(receipt.eventSha,event);
});
test('unavailable checkout never borrows the event SHA as source evidence',()=>{
  const env={GITHUB_SHA:'2'.repeat(40)};
  for(const read of [()=>{throw Error('unavailable');},()=> 'invalid']){
    const receipt=sourceIdentity(env,read);assert.equal(receipt.status,'insufficient-evidence');assert.equal(receipt.checkoutSha,null);assert.equal(receipt.eventSha,env.GITHUB_SHA);
  }
});
type Options={wrongHash?:boolean;missingClockSource?:boolean;failStop?:boolean;failTraceStop?:boolean;forbidProfiler?:boolean};
type RawProfile=Parameters<typeof numericProfile>[0];
type Clock=Parameters<typeof profileWindow>[1][number];
const body='console.log(1);',hash=createHash('sha256').update(body).digest('hex');
const client={status:'available' as const,name:'index-test.js',bytes:Buffer.byteLength(body),sha256:hash};
const asset='https://example.test/assets/index-test.js';
const profile:RawProfile={startTime:1_000_000,endTime:121_010_000,nodes:[
  {id:1,children:[2],callFrame:{functionName:'(root)',scriptId:'11',url:asset,lineNumber:0,columnNumber:0}},
  {id:2,children:[],callFrame:{functionName:'project',scriptId:'11',url:asset,lineNumber:0,columnNumber:1}},
],samples:[2,2,2],timeDeltas:[2000,-50,2050]};

/** The current transport surface; no browser, accounts, network or replacement helper. */
class CurrentCdpFake {
  readonly commands:string[]=[];
  readonly listeners=new Map<string,((value:unknown)=>void)[]>();
  timestamp=1;
  stopCalls=0;
  traceStopCalls=0;
  readonly responseBodies=new Map<string,string>();
  readonly responseReads:string[]=[];
  constructor(readonly options:Options={}){}
  on<T>(name:string,listener:(value:T)=>void){const rows=this.listeners.get(name)??[];rows.push(listener as (value:unknown)=>void);this.listeners.set(name,rows);}
  off<T>(name:string,listener:(value:T)=>void){this.listeners.set(name,(this.listeners.get(name)??[]).filter(value=>value!==listener));}
  emit(name:string,value:unknown){for(const listener of this.listeners.get(name)??[])listener(value);}
  async evaluate<T>(expression:string):Promise<T>{assert.equal(arguments.length,1);if(expression.startsWith('window.__quotumIdleCommitted?')){this.commands.push('committed-snapshot');return {status:'insufficient-evidence'} as T;}this.commands.push('evaluate');assert.equal(expression,'performance.now()');return this.timestamp*1000 as T;}
  async send<T=unknown>(method:string,params:object={},signal?:AbortSignal):Promise<T>{
    assert.ok(arguments.length<=3);if(signal)assert.equal(signal.aborted,false);this.commands.push(method);
    if(this.options.forbidProfiler)assert.ok(!method.startsWith('Profiler.'),'trace-only must never send a profiler command');
    let value:unknown={};
    if(method==='Performance.getMetrics')value={metrics:[{name:'Timestamp',value:this.timestamp},{name:'ScriptDuration',value:.08}]};
    if(method==='Page.getFrameTree')value={frameTree:{frame:{id:'own-frame'}}};
    if(method==='Profiler.setSamplingInterval')assert.equal((params as {interval:number}).interval,2000);
    if(method==='Profiler.stop'){
      if(this.options.failStop&&this.stopCalls++===0)throw Error('synthetic stop failure');
      value={profile};
    }
    if(method==='Tracing.end'){
      if(this.options.failTraceStop&&this.traceStopCalls++===0)throw Error('synthetic trace stop failure');
      this.emit('Tracing.tracingComplete',{});
    }
    if(method==='Network.getResponseBody'){const id=(params as {requestId:string}).requestId;this.responseReads.push(id);value={body:this.responseBodies.get(id)??body,base64Encoded:false};}
    if(method==='Debugger.enable')this.emit('Debugger.scriptParsed',{url:asset,scriptId:'11',hash:this.options.wrongHash?'0'.repeat(64):hash});
    return value as T;
  }
}

const ownEvents=[
  {name:'TimerFire',ph:'X',ts:2_000_000,dur:8000,pid:1,tid:2,args:{data:{frame:'own-frame',timerId:10}}},
  {name:'FunctionCall',ph:'X',ts:2_000_001,dur:7000,pid:1,tid:2,args:{data:{frame:'own-frame',scriptId:'11',lineNumber:1,columnNumber:2}}},
  {name:'TimerFire',ph:'X',ts:2_000_000,dur:999999,pid:3,tid:4,args:{data:{frame:'foreign-frame',timerId:99}}},
  {name:'FunctionCall',ph:'X',ts:2_000_002,dur:7000,pid:1,tid:2,args:{data:{scriptId:'11',lineNumber:1,columnNumber:2}}},
];
const record=(value:unknown):Record<string,unknown>=>{assert.ok(value&&typeof value==='object');return value as Record<string,unknown>;};
const result=(saved:Saved[],name:string)=>{const found=saved.find(row=>row.name===name);assert.ok(found);return record(found.value);};

async function capture(options:Options={},collection:'profile'|'trace'='profile'){
  const cdp=new CurrentCdpFake(options),saved:Saved[]=[];
  const diagnostic=new IdleCpuDiagnostic(cdp as unknown as Cdp,(name,value,large)=>saved.push({name,value,large}),client,true,collection);
  cdp.emit('Network.responseReceived',{type:'Script',requestId:'asset-1',response:{url:asset}});
  await diagnostic.start();
  assert.ok(!cdp.commands.includes('Debugger.enable'),'source binding does not activate the debugger during measurement');
  cdp.commands.push('ORIGINAL.before-metrics');cdp.timestamp=121;cdp.commands.push('ORIGINAL.after-metrics','ORIGINAL.readout');
  cdp.emit('Tracing.dataCollected',{value:options.missingClockSource?ownEvents.filter(event=>event.name!=='FunctionCall'):ownEvents});
  let failure:unknown;
  try{await diagnostic.stop({before:{Timestamp:1,ScriptDuration:0},after:{Timestamp:121,ScriptDuration:.08},instrumentMs:1,seconds:120});}catch(error){failure=error;}
  await diagnostic.bindAndClose();await diagnostic.close();
  return{cdp,saved,failure,diagnostic};
}

test('idle CPU diagnostics refuse an attached target',()=>{
  assert.throws(()=>new IdleCpuDiagnostic(new CurrentCdpFake() as unknown as Cdp,()=>{},client,false),/owned synthetic/);
  assert.throws(()=>new IdleCpuDiagnostic(new CurrentCdpFake() as unknown as Cdp,()=>{},client,false,'trace'),/owned synthetic/);
});
test('idle CPU diagnostics preserve signed samples and original120s counters',async()=>{
  const {saved}=await capture(),numeric=record(result(saved,'idle-cpu-profile').profile);
  assert.equal(numeric.reversedDeltas,1);assert.deepEqual(numeric.timeDeltas,[2000,-50,2050]);
  assert.equal(result(saved,'idle-cpu-window').seconds,120);
});
test('idle CPU diagnostics serialize after original counters and readout',async()=>{
  const {cdp}=await capture();
  assert.ok(cdp.commands.indexOf('Profiler.stop')>cdp.commands.indexOf('ORIGINAL.readout'));
  assert.ok(cdp.commands.indexOf('Debugger.enable')>cdp.commands.indexOf('Profiler.stop'));
  assert.ok(!cdp.commands.includes('Performance.enable'),'the original metric domain stays unchanged');
});
test('original period input capture keeps the latest resource replies outside the counters and excludes private fields',async()=>{
  const cdp=new CurrentCdpFake(),saved:Saved[]=[];
  const diagnostic=new IdleCpuDiagnostic(cdp as unknown as Cdp,(name,value)=>saved.push({name,value:safeEvidence(value)}),client,true,'profile',{base:'https://example.test',fixtureStart:300_000});
  const basis={run:'PRIVATE_CANARY',revision:'PRIVATE_CANARY',evaluatedAt:400_000,evidenceCut:300_000,range:{from:100_000,to:400_000}};
  const samples=encodeSamples([10,20,30].map(at=>({at,used:99,resetAt:null,staleAfterMs:60_000})));
  const section={state:'complete',basis,value:{tape:{from:10,cut:30,replaceFrom:10,cursor:'PRIVATE_CANARY',quota:[{source:'PRIVATE_CANARY',window:'PRIVATE_CANARY',samples,samplesEncoding:'delta'}],money:[]}}};
  const initial={basis,quota:section,budget:section,funds:section,sessions:{state:'complete',basis,value:{anchor:10,cut:30,knownFrom:10,refs:[{project:'PRIVATE_CANARY'}],spans:[]}}};
  const request=(id:string,scopes:object,origin='https://example.test',finish=true)=>{
    cdp.responseBodies.set(id,JSON.stringify(initial));
    cdp.emit('Network.requestWillBeSent',{requestId:id,request:{url:origin+'/api/boards/PRIVATE_CANARY/period',postData:JSON.stringify({version:1,selection:{mode:'live',periodMs:900_000},evaluatedAt:400_000,...scopes})}});
    if(finish)cdp.emit('Network.loadingFinished',{requestId:id});
  };
  request('initial-private-id',{quota:{},budget:{},funds:{},sessions:{}});
  for(let i=0;i<10;i++)request('quota-private-'+i,{quota:{}});
  request('drawing-private-id',{quota:{evidence:'skip'}});
  cdp.responseBodies.set('drawing-private-id',JSON.stringify({basis,quota:{state:'complete',basis,value:{chunks:[]}}}));
  request('foreign-private-id',{quota:{}},'https://foreign.test');
  await diagnostic.start();
  request('during-counter-private-id',{quota:{}});
  await diagnostic.stop({before:{Timestamp:1},after:{Timestamp:121},instrumentMs:0,seconds:120});
  assert.deepEqual(cdp.responseReads,[]);
  await diagnostic.captureInputs();
  assert.deepEqual(cdp.responseReads,['quota-private-9','initial-private-id']);
  const snapshot=result(saved,'idle-cpu-main-period-inputs');
  assert.equal(snapshot.status,'complete');assert.equal(snapshot.fixtureStart,300_000);
  assert.deepEqual((snapshot.rows as unknown[]).map(row=>record(row).resource),[0,1,2,3]);
  assert.equal(record((snapshot.rows as unknown[])[3]).status,'complete');
  assert.deepEqual(record(record((snapshot.rows as unknown[])[0]).value).quota,[{samples:3,first:10,next:20,last:30}]);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_CANARY'));
  assert.ok(!JSON.stringify(snapshot).includes('private-id'));assert.ok(!JSON.stringify(snapshot).includes('foreign.test'));
  await diagnostic.close();
});
test('missing, unfinished or unreadable original inputs stay explicit and never fall back to older replies',async()=>{
  const cdp=new CurrentCdpFake(),saved:Saved[]=[];
  const diagnostic=new IdleCpuDiagnostic(cdp as unknown as Cdp,(name,value)=>saved.push({name,value}),client,true,'trace',{base:'https://example.test',fixtureStart:0});
  const event=(id:string,postData?:string)=>cdp.emit('Network.requestWillBeSent',{requestId:id,request:{url:'https://example.test/api/boards/private/period',postData}});
  event('missing');event('old',JSON.stringify({selection:{mode:'live',periodMs:900_000},quota:{},budget:{}}));cdp.emit('Network.loadingFinished',{requestId:'old'});
  event('unfinished',JSON.stringify({selection:{mode:'live',periodMs:900_000},quota:{}}));
  await diagnostic.start();await diagnostic.stop({before:{Timestamp:1},after:{Timestamp:121},instrumentMs:0,seconds:120});
  await diagnostic.captureInputs();
  const snapshot=result(saved,'idle-cpu-main-period-inputs');assert.equal(snapshot.status,'insufficient-evidence');assert.equal(snapshot.missingInputRequests,1);
  assert.deepEqual(cdp.responseReads,['old']);
  assert.deepEqual(snapshot.rows,[0,1,2,3].map(resource=>({resource,status:'unavailable'})));
  assert.ok(!JSON.stringify(snapshot).includes('console.log'));await diagnostic.close();
});
test('synchronous original input work cannot claim complete evidence after the existing5s deadline',async t=>{
  const cdp=new CurrentCdpFake(),saved:Saved[]=[];
  const diagnostic=new IdleCpuDiagnostic(cdp as unknown as Cdp,(name,value)=>saved.push({name,value}),client,true,'trace',{base:'https://example.test',fixtureStart:0});
  const basis={evaluatedAt:1,evidenceCut:1,range:{from:0,to:1}},section={state:'complete',basis,value:{tape:{from:0,cut:1,replaceFrom:0,quota:[],money:[]}}};
  cdp.responseBodies.set('input',JSON.stringify({basis,quota:section,budget:section,funds:section,sessions:{state:'complete',basis,value:{anchor:0,knownFrom:0,refs:[],spans:[]}}}));
  cdp.emit('Network.requestWillBeSent',{requestId:'input',request:{url:'https://example.test/api/boards/private/period',postData:JSON.stringify({selection:{mode:'live',periodMs:900_000},quota:{},budget:{},funds:{},sessions:{}})}});
  cdp.emit('Network.loadingFinished',{requestId:'input'});
  await diagnostic.start();await diagnostic.stop({before:{Timestamp:1},after:{Timestamp:121},instrumentMs:0,seconds:120});
  let now=0;t.mock.method(performance,'now',()=>now);
  const send=cdp.send.bind(cdp);
  t.mock.method(cdp,'send',async<T=unknown>(method:string,params:object={},signal?:AbortSignal):Promise<T>=>{const value=await send<T>(method,params,signal);if(method==='Network.getResponseBody')now=5001;return value;});
  await diagnostic.captureInputs();assert.equal(result(saved,'idle-cpu-main-period-inputs').status,'insufficient-evidence');
  assert.deepEqual(cdp.responseReads,['input']);await diagnostic.close();
});
test('idle CPU diagnostics exclude foreign and unscoped callbacks',async()=>{
  const {saved}=await capture(),timers=result(saved,'idle-cpu-timers');
  assert.equal(timers.status,'complete');assert.equal((timers.events as unknown[]).length,2);
  assert.equal(timers.rejectedForeign,1);assert.equal(timers.unscoped,1);
});
test('idle CPU diagnostics bind received bytes to parsed script IDs',async()=>{
  const {saved}=await capture(),binding=result(saved,'idle-cpu-source-family-1');
  assert.equal(binding.status,'complete');assert.equal(record((binding.owners as unknown[])[0]).scriptId,11);
});
test('idle CPU diagnostics preserve mismatched source hashes',async()=>{
  const {saved}=await capture({wrongHash:true});assert.equal(result(saved,'idle-cpu-source-family-1').status,'mismatch');
});
test('idle timer evidence needs an owned source callback',async()=>{
  const {saved}=await capture({missingClockSource:true});assert.equal(result(saved,'idle-cpu-timers').status,'insufficient-evidence');
});
test('idle CPU stop failure keeps the original window and incomplete result',async()=>{
  const {saved,failure}=await capture({failStop:true});assert.ok(failure);
  assert.equal(result(saved,'idle-cpu-profile').status,'insufficient-evidence');assert.equal(result(saved,'idle-cpu-window').seconds,120);
});
test('idle CPU cleanup unsubscribes the current transport',async()=>{
  const {cdp}=await capture();for(const listeners of cdp.listeners.values())assert.equal(listeners.length,0);
});

test('trace-only never enables, samples, starts or stops the Profiler',async()=>{
  const {cdp,saved}=await capture({forbidProfiler:true},'trace'),profile=result(saved,'idle-cpu-profile');
  assert.ok(!cdp.commands.some(command=>command.startsWith('Profiler.')));
  assert.equal(profile.status,'not-collected-by-design');assert.equal(profile.samplingInterval,null);assert.equal(profile.profile,null);
  assert.equal(profile.cleanup,'complete');assert.equal(result(saved,'idle-cpu-window').seconds,120);
});
test('trace-only starts before counters and stops and binds after the frozen readout',async()=>{
  const {cdp}=await capture({forbidProfiler:true},'trace');
  assert.ok(cdp.commands.indexOf('Tracing.start')<cdp.commands.indexOf('ORIGINAL.before-metrics'));
  assert.ok(cdp.commands.indexOf('Tracing.end')>cdp.commands.indexOf('ORIGINAL.readout'));
  assert.ok(cdp.commands.indexOf('Debugger.enable')>cdp.commands.indexOf('Tracing.end'));
  const interval=cdp.commands.slice(cdp.commands.indexOf('ORIGINAL.before-metrics'),cdp.commands.indexOf('ORIGINAL.readout')+1);
  assert.deepEqual(interval,['ORIGINAL.before-metrics','ORIGINAL.after-metrics','ORIGINAL.readout']);
  assert.ok(!cdp.commands.includes('Performance.enable'));
});
test('trace-only retains source mismatch and removes every current listener',async()=>{
  const {cdp,saved}=await capture({forbidProfiler:true,wrongHash:true},'trace');
  assert.equal(result(saved,'idle-cpu-source-family-1').status,'mismatch');
  for(const listeners of cdp.listeners.values())assert.equal(listeners.length,0);
});
test('trace cleanup failure cannot turn an uncollected profile into complete evidence',async()=>{
  const {saved,failure,diagnostic}=await capture({forbidProfiler:true,failTraceStop:true},'trace');assert.ok(failure);
  const profile=result(saved,'idle-cpu-profile');assert.equal(profile.status,'not-collected-by-design');assert.equal(profile.cleanup,'incomplete');
  const receipt=diagnostic.traceReceipt(540_000,660_000,300_000,traceWindow,traceReading);
  assert.equal(receipt.status,'insufficient-evidence');assert.ok(receipt.problems.some(problem=>problem.includes('incomplete')));
});

const traceWindow={before:{Timestamp:1,ScriptDuration:0},after:{Timestamp:121,ScriptDuration:.05},instrumentMs:.5,seconds:120};
const traceRows:Reading['renders']=(['quota','session','activity','budget','funds'] as const).map(widget=>({node:widget,time:true,kind:'chart',region:'analytics',widget,count:1}));
const traceReading:Reading={instrumentMs:.5,commits:1,cardChanged:{},renders:traceRows,mutations:traceRows};
const traceFires=[{timerId:10,ts:2_000_000,duration:8000,pid:1,tid:2,source:{sha256:hash,lineNumber:9,columnNumber:250_437},threadTs:1000,threadDuration:5000}];
test('original trace accepts chart commits and separate thread timing without a geometry claim',()=>{
  assert.deepEqual(originalTraceProblems(540_000,660_000,300_000,traceWindow,traceReading,traceFires),[]);
  assert.notEqual(traceFires[0].duration,traceFires[0].threadDuration);
});
test('original trace preserves a missed edge, missing chart and unavailable thread clock',()=>{
  assert.ok(originalTraceProblems(610_000,730_000,300_000,traceWindow,traceReading,traceFires).some(problem=>problem.includes('missed')));
  assert.ok(originalTraceProblems(540_000,660_000,300_000,traceWindow,{...traceReading,mutations:[]},traceFires).some(problem=>problem.includes('mutation')));
  assert.ok(originalTraceProblems(540_000,660_000,300_000,traceWindow,traceReading,[]).some(problem=>problem.includes('source-bound')));
  assert.ok(originalTraceProblems(540_000,660_000,300_000,traceWindow,traceReading,[{...traceFires[0],threadDuration:null}]).some(problem=>problem.includes('thread')));
});

/** Execute the actual index interval with the real collector and a passive transport. */
async function originalIndex(collection:''|'1'|'trace'|'profile',boundaryFailure?:'opening'|'closing',failTraceStop=false,failProfileStop=false) {
  let wall=540_000,plans=0,geometry=0,metricCalls=0,readingCalls=0,phaseFrom=0;
  const saved:Saved[]=[],evidenceSaved:Saved[]=[],cdp=new class extends CurrentCdpFake {
    override async evaluate<T>(expression:string):Promise<T>{
      if(expression==='__quotumBench.reset()'){this.commands.push('ORIGINAL.reset');return undefined as T;}
      if(expression===idlePhaseScript(300_000)){phaseFrom=wall;this.commands.push('ORIGINAL.phase-start');return undefined as T;}
      if(expression==='__quotumBench.read()'){
        const stage=['opening','closing','final'][readingCalls++];this.commands.push('ORIGINAL.readout:'+stage);
        const empty={...traceReading,commits:0,renders:[],mutations:[]};
        return (stage==='opening'&&boundaryFailure!=='opening'?empty:stage==='final'&&boundaryFailure==='closing'?{...traceReading,commits:2}:traceReading) as T;
      }
      if(expression==='(()=>{const p=__quotumIdlePhase.read();__quotumIdlePhase.stop();return p;})()'){
        this.commands.push('ORIGINAL.phase-stop');
        return {from:phaseFrom,to:wall,monotonicFrom:phaseFrom,monotonicTo:wall,cellMs:300_000,starts:Array(4).fill(Math.floor(phaseFrom/300_000)),ends:Array(4).fill(Math.floor(wall/300_000)),transitions:[1,1,1,1]} as T;
      }
      return super.evaluate<T>(expression);
    }
  }({forbidProfiler:collection==='trace',failTraceStop,failStop:failProfileStop});
  const idleCpu=collection?new IdleCpuDiagnostic(cdp as unknown as Cdp,(name,value)=>saved.push({name,value}),client,true,collection==='trace'?'trace':'profile'):undefined;
  cdp.emit('Network.responseReceived',{type:'Script',requestId:'asset-1',response:{url:asset}});
  const source=readFileSync(new URL('../index.ts',import.meta.url),'utf8'),start=source.indexOf('    let edgePlan:'),end=source.indexOf('    const measured =',start);
  assert.ok(start>=0&&end>start);
  const context={Date:class extends Date{static override now(){return wall;}},idleCpu,idleCpuMode:collection,seconds:120,cdp,reading:traceReading,
    planIdleEdge:(...args:Parameters<typeof planIdleEdge>)=>{plans++;return planIdleEdge(...args);},idleGeometry:async()=>{geometry++;return edgeGeometry(geometry>1);},
    idleWindow,idlePhaseScript,idlePhaseProblems,
    cellOf:()=>300_000,sleep:async(ms:number)=>{cdp.commands.push('ORIGINAL.sleep:'+ms);wall+=Math.max(0,ms);if(ms===120_000)cdp.timestamp=121;},
    overview:async()=>[],stillProblems:()=>[],Stop:Error,say:()=>{},heard:{reset:()=>{cdp.commands.push('ORIGINAL.heard-reset');},counts:()=>({ping:5})},requests:{counting:false,count:0,byPath:{}},
    metrics:async()=>{cdp.commands.push(metricCalls++?'ORIGINAL.after-metrics':'ORIGINAL.before-metrics');return metricCalls===1?traceWindow.before:traceWindow.after;},
    idleTimingDiagnostic:undefined,idleDiagnostic:undefined,traffic:undefined,
    evidence:{begin:()=>{},save:(name:string,value:unknown)=>evidenceSaved.push({name,value})},
    round:(value:number)=>value,scriptPerSecond:()=>.1,idleProblems:()=>[],saveDiagnostic:(name:string,value:unknown)=>saved.push({name,value}),finish:async()=>{},run:undefined as unknown as()=>Promise<unknown>};
  runInNewContext(ts.transpileModule(`async function run(){${source.slice(start,end)}\nreturn {from,to};}globalThis.run=run;`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,context);
  let failure:unknown;
  try{await context.run();}catch(error){failure=error;}finally{await idleCpu?.close();}
  return{cdp,plans,geometry,saved,evidenceSaved,failure};
}
const canonicalCounterSequence=['ORIGINAL.reset','ORIGINAL.phase-start','ORIGINAL.heard-reset','ORIGINAL.before-metrics','ORIGINAL.readout:opening','ORIGINAL.sleep:120000','ORIGINAL.readout:closing','ORIGINAL.after-metrics','ORIGINAL.readout:final','ORIGINAL.phase-stop'];
test('actual trace index skips alignment and all geometry while preserving the original counter sequence',async()=>{
  const {cdp,plans,geometry,saved,failure}=await originalIndex('trace');assert.equal(failure,undefined);assert.equal(plans,0);assert.equal(geometry,0);
  assert.ok(!cdp.commands.some(command=>command.startsWith('Profiler.')));
  assert.deepEqual(cdp.commands.slice(cdp.commands.indexOf('ORIGINAL.reset'),cdp.commands.indexOf('ORIGINAL.phase-stop')+1),canonicalCounterSequence);
  assert.equal(result(saved,'idle-cpu-window').seconds,120);assert.ok(saved.some(row=>row.name==='idle-cpu-original-trace'));
});
test('actual original-profile index preserves the counter sequence and samples without alignment or geometry reads',async()=>{
  const {cdp,plans,geometry,saved,failure}=await originalIndex('profile');assert.equal(failure,undefined);assert.equal(plans,0);assert.equal(geometry,0);
  assert.deepEqual(cdp.commands.slice(cdp.commands.indexOf('ORIGINAL.reset'),cdp.commands.indexOf('ORIGINAL.phase-stop')+1),canonicalCounterSequence);
  assert.ok(cdp.commands.indexOf('Profiler.start')<cdp.commands.indexOf('ORIGINAL.reset'));
  assert.ok(cdp.commands.indexOf('Profiler.stop')>cdp.commands.indexOf('ORIGINAL.phase-stop'));
  assert.ok(cdp.commands.indexOf('Debugger.enable')>cdp.commands.indexOf('Profiler.stop'));
  assert.equal(cdp.commands.filter(command=>command==='committed-snapshot').length,2);
  assert.ok(cdp.commands.indexOf('committed-snapshot')<cdp.commands.indexOf('Profiler.enable'));
  assert.ok(cdp.commands.lastIndexOf('committed-snapshot')>cdp.commands.indexOf('Tracing.end'));
  assert.equal(record(result(saved,'idle-cpu-committed-before').value).status,'insufficient-evidence');
  assert.equal(record(result(saved,'idle-cpu-committed-after').value).status,'insufficient-evidence');
  assert.equal(result(saved,'idle-cpu-profile').samplingInterval,2000);
  assert.equal(result(saved,'idle-cpu-original-trace').profileStatus,'complete');
});
test('actual ordinary index installs no diagnostic and retains the original120s sequence',async()=>{
  const {cdp,plans,geometry,saved,failure}=await originalIndex('');assert.equal(failure,undefined);assert.equal(plans,0);assert.equal(geometry,0);assert.equal(saved.length,0);
  assert.ok(!cdp.commands.some(command=>/^(Profiler|Tracing|Debugger)\./.test(command)));
  assert.deepEqual(cdp.commands,['ORIGINAL.sleep:5000',...canonicalCounterSequence]);
});
test('actual mode1 index retains aligned geometry and the existing2ms profiler',async()=>{
  const {cdp,plans,geometry,saved,failure}=await originalIndex('1');assert.equal(failure,undefined);assert.equal(plans,1);assert.equal(geometry,2);
  assert.ok(cdp.commands.includes('Profiler.start'));assert.ok(cdp.commands.includes('Profiler.stop'));
  assert.equal(result(saved,'idle-cpu-profile').samplingInterval,2000);assert.ok(saved.some(row=>row.name==='idle-cpu-edge'));
});
for(const boundary of ['opening','closing'] as const)test(`actual index retains ${boundary} measurement-boundary failures before trace cleanup`,async()=>{
  const {saved,evidenceSaved,failure}=await originalIndex('trace',boundary,true);assert.ok(failure);
  assert.equal((failure as Error).message,'synthetic trace stop failure');
  const original=record(result(saved,'idle-cpu-result').original);
  assert.ok((original.problems as string[]).some(problem=>problem.includes(boundary+' measurement boundary')));
  const idle=result(evidenceSaved,'idle');assert.equal(idle.actualSeconds,120);
  assert.ok((idle.phaseProblems as string[]).some(problem=>problem.includes(boundary+' measurement boundary')));
});
for(const boundary of ['opening','closing'] as const)test(`original-profile index retains ${boundary} measurement-boundary failures when profiler stop fails`,async()=>{
  const {saved,evidenceSaved,failure}=await originalIndex('profile',boundary,false,true);assert.ok(failure);
  assert.equal((failure as Error).message,'synthetic stop failure');
  assert.equal(result(saved,'idle-cpu-profile').status,'insufficient-evidence');
  assert.ok((record(result(saved,'idle-cpu-result').original).problems as string[]).some(problem=>problem.includes(boundary+' measurement boundary')));
  assert.ok((result(evidenceSaved,'idle').phaseProblems as string[]).some(problem=>problem.includes(boundary+' measurement boundary')));
});

const numericBase:RawProfile={...profile,startTime:2_000_000,endTime:2_006_000};
const clocks:Clock[]=[{stage:'start',before:2000,page:1000,after:2002,valid:true},{stage:'end',before:3000,page:2000,after:3002,valid:true}];
test('numeric profiles retain signed sample positions',()=>{
  const value=numericProfile(numericBase);assert.equal(value.status,'complete');assert.ok('timeDeltas'in value);
  assert.equal(value.reversedDeltas,1);assert.deepEqual(value.timeDeltas,[2000,-50,2050]);
});
test('whole120s at2ms stays within the original sample bound',()=>{
  const value=numericProfile({...numericBase,startTime:0,endTime:120_000_000,samples:Array(60_000).fill(2),timeDeltas:Array(60_000).fill(2000)});
  assert.equal(value.status,'complete');assert.ok('samples'in value);assert.equal(value.samples.length,60_000);
});
test('whole120s at1ms cannot silently truncate',()=>{
  const value=numericProfile({...numericBase,startTime:0,endTime:120_000_000,samples:Array(120_000).fill(2),timeDeltas:Array(120_000).fill(1000)});
  assert.equal(value.status,'insufficient-evidence');assert.ok('omittedSamples'in value);assert.equal(value.omittedSamples,20_000);
});
test('numeric profiles reject unknown sampled nodes',()=>{assert.equal(numericProfile({...numericBase,samples:[999,2,2]}).status,'insufficient-evidence');});
test('numeric profiles reject invalid time bounds',()=>{assert.equal(numericProfile({...numericBase,endTime:1}).status,'insufficient-evidence');});
test('numeric profiles reject omitted child locations',()=>{
  const nodes=numericBase.nodes.map(node=>node.id===1?{...node,children:[999]}:node);
  assert.equal(numericProfile({...numericBase,nodes}).status,'insufficient-evidence');
});
test('profile clock brackets keep certain and possible samples separate',()=>{
  const value=profileWindow(numericProfile(numericBase),clocks,1000,1004);
  assert.equal(value.status,'observed');assert.ok('certainFunctionSamples'in value);
  assert.equal(value.certainFunctionSamples,2);assert.equal(value.possibleFunctionSamples,3);
});
test('profile windows reject a missing clock bridge',()=>{assert.equal(profileWindow(numericProfile(numericBase),clocks.slice(0,1),1000,1004).status,'insufficient-evidence');});
test('profile windows reject incompatible clock brackets',()=>{
  const incompatible=[clocks[0],{...clocks[1],before:5000,after:5002}];
  assert.equal(profileWindow(numericProfile(numericBase),incompatible,1000,1004).status,'insufficient-evidence');
});

const edgePlan=planIdleEdge(500_000,120,300_000);
const edgeGeometry=(after=false):IdleGeometry=>({now:after?660_000:540_000,selected:false,charts:(['quota','session','activity','budget','funds'] as const).map(widget=>({widget,count:1,axisEnd:after?600_000:540_000,from:0,to:86_400_000,ready:true,panning:false,visibleFrom:after?60_000:0,visibleTo:after?86_460_000:86_400_000}))});
const edgeProblems=(before=edgeGeometry(),after=edgeGeometry(true),counterFrom=540_010,counterTo=660_000)=>idleEdgeProblems(edgePlan,540_000,660_000,counterFrom,counterTo,before,after);
test('aligned idle planning selects a future start and centres the existing120s window',()=>{
  assert.deepEqual(edgePlan,{boundary:600_000,from:540_000,to:660_000,cellMs:300_000,seconds:120,marginMs:30_000});
  for(const now of [0,1,239_999,240_000,299_999,500_000,539_999,540_000,599_999]){
    const plan=planIdleEdge(now,120,300_000);assert.ok(plan.from>now);assert.ok(plan.from-now<=300_000);assert.equal(plan.to-plan.from,120_000);assert.equal(plan.boundary%300_000,0);
  }
  assert.throws(()=>planIdleEdge(1,300,300_000));assert.throws(()=>planIdleEdge(1,120,60_000));
});
test('natural idle edge needs actual movement with a stable drawing basis',()=>{assert.deepEqual(edgeProblems(),[]);});
test('a late start or early finish cannot credit the planned edge',()=>{
  assert.match(edgeProblems(undefined,undefined,570_001)[0],/margins/);
  assert.match(edgeProblems(undefined,undefined,undefined,629_999)[0],/margins/);
  assert.match(idleEdgeProblems(edgePlan,620_000,740_000,620_010,740_000,edgeGeometry(),edgeGeometry(true))[0],/margins/);
});
test('an absent or duplicate chart cannot credit four-chart movement',()=>{
  const absent=edgeGeometry(true);absent.charts=absent.charts.filter(chart=>chart.widget!=='funds');assert.ok(edgeProblems(undefined,absent).some(problem=>problem.startsWith('funds')));
  const duplicate=edgeGeometry(true);duplicate.charts.push({...duplicate.charts[0]});assert.ok(edgeProblems(undefined,duplicate).some(problem=>problem.startsWith('quota')));
});
test('wrong chart movement cannot replace the missing expected chart',()=>{
  const wrong=edgeGeometry(true);const i=wrong.charts.findIndex(chart=>chart.widget==='funds');wrong.charts[i]={...wrong.charts[i],widget:'budget'};
  assert.ok(edgeProblems(undefined,wrong).some(problem=>problem.startsWith('funds')));
});
test('render counts or shifted axis labels alone cannot prove plotted movement',()=>{
  const unchanged=edgeGeometry(true);const chart=unchanged.charts.find(chart=>chart.widget==='activity')!;chart.visibleFrom=0;chart.visibleTo=86_400_000;
  assert.ok(edgeProblems(undefined,unchanged).some(problem=>problem.startsWith('activity')));
});
test('panning, unready geometry and a non-crossed axis remain insufficient',()=>{
  for(const patch of [{panning:true},{ready:false},{axisEnd:599_999},{visibleTo:null}]){
    const after=edgeGeometry(true);Object.assign(after.charts.find(chart=>chart.widget==='budget')!,patch);assert.ok(edgeProblems(undefined,after).some(problem=>problem.startsWith('budget')));
  }
  const selected=edgeGeometry(true);selected.selected=true;assert.match(edgeProblems(undefined,selected)[0],/natural live/);
});

const clockSource={sha256:hash,lineNumber:9,columnNumber:250_437};
const clockBinding={status:'complete',receivedHash:hash,clientHash:hash,debuggerDisabled:true,owners:[{scriptId:11,parsedHash:hash,receivedAssetHashMatches:true}]};
const clockEvents=[
  {name:'TimerFire',frame:1,pid:1,tid:2,ts:2_000_000,duration:8000,source:null,timer:{id:10}},
  {name:'FunctionCall',frame:1,pid:1,tid:2,ts:2_000_001,duration:7000,source:{scriptId:11,lineNumber:9,columnNumber:250_437},timer:null},
];
test('own Clock TimerFire joins only an exact received-client callback inside counters',()=>{assert.equal(ownedClockFires(clockEvents,clockBinding,clockSource,1,3).length,1);});
test('a generic, injected, foreign or asynchronous callback cannot prove a Clock TimerFire',()=>{
  const call=clockEvents[1];
  for(const patch of [{frame:2},{pid:2},{tid:3},{ts:2_008_001},{source:{...call.source!,scriptId:3}},{source:{...call.source!,columnNumber:250_438}}])assert.equal(ownedClockFires([clockEvents[0],{...call,...patch}],clockBinding,clockSource,1,3).length,0);
  assert.equal(ownedClockFires(clockEvents,clockBinding,clockSource,3,4).length,0);
});
test('missing or mismatched source binding cannot credit Clock ownership',()=>{
  assert.equal(ownedClockFires(clockEvents,clockBinding,null,1,3).length,0);
  for(const patch of [{status:'mismatch'},{receivedHash:'0'.repeat(64)},{debuggerDisabled:false},{owners:[]}])assert.equal(ownedClockFires(clockEvents,{...clockBinding,...patch},clockSource,1,3).length,0);
});
