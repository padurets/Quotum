import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventCounts,type Heard} from '../stream.js';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import type {Cdp} from '../cdp.js';
import type {Reading} from '../probe.js';
import {IdleCpuDiagnostic,sourceIdentity,originalTraceProblems,ownedClockFires} from '../idleCpuDiagnostic.js';
import {numericProfile,profileWindow} from '../cpuProfile.js';
import {Evidence,safeEvidence} from '../evidence.js';
import {RunOwner} from '../runOwner.js';
import {idleWindow,idlePhaseScript,idlePhaseProblems} from '../still.js';

type Saved={name:string;value:unknown;large?:boolean};

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
  async evaluate<T>(expression:string):Promise<T>{assert.equal(arguments.length,1);this.commands.push('evaluate');assert.equal(expression,'performance.now()');return this.timestamp*1000 as T;}
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
async function originalIndex(collection:''|'trace'|'profile',boundaryFailure?:'opening'|'closing',failTraceStop=false,failProfileStop=false) {
  let wall=540_000,metricCalls=0,readingCalls=0,phaseFrom=0;
  const ledger=new EventCounts(()=>wall);
  const heard:Heard={reset:window=>{cdp.commands.push('ORIGINAL.heard-reset');ledger.reset(window);},counts:()=>ledger.counts(),boardCounts:()=>ledger.boardCounts(),calendar:()=>ledger.calendar(),contacts:()=>ledger.contacts(),hints:()=>ledger.hints(),close:()=>{}};
  const saved:Saved[]=[],evidenceSaved:Saved[]=[],cdp=new class extends CurrentCdpFake {
    override async evaluate<T>(expression:string):Promise<T>{
      if(expression==='__quotumBench.reset()'){this.commands.push('ORIGINAL.reset');return undefined as T;}
      if(expression===idlePhaseScript(300_000)){phaseFrom=wall;this.commands.push('ORIGINAL.phase-start');return undefined as T;}
      if(expression==='window.__quotumIdleRetention()'){this.commands.push('ORIGINAL.retention');return null as T;}
      if(expression==='__quotumBench.read()'){
        const stage=['opening','closing','final'][readingCalls++];this.commands.push('ORIGINAL.readout:'+stage);
        const empty={...traceReading,commits:0,renders:[],mutations:[]};
        return (stage==='opening'&&boundaryFailure!=='opening'?empty:stage==='final'&&boundaryFailure==='closing'?{...traceReading,commits:2}:traceReading) as T;
      }
      if(expression==='(()=>{const p=__quotumIdlePhase.read();__quotumIdlePhase.stop();return p;})()'){
        this.commands.push('ORIGINAL.phase-stop');
        return {from:phaseFrom,to:wall,monotonicFrom:phaseFrom,monotonicTo:wall,cellMs:300_000,starts:Array(5).fill(Math.floor(phaseFrom/300_000)),ends:Array(5).fill(Math.floor(wall/300_000)),transitions:[1,1,1,1,1]} as T;
      }
      return super.evaluate<T>(expression);
    }
  }({forbidProfiler:collection==='trace',failTraceStop,failStop:failProfileStop});
  const idleCpu=collection?new IdleCpuDiagnostic(cdp as unknown as Cdp,(name,value)=>saved.push({name,value}),client,true,collection==='trace'?'trace':'profile'):undefined;
  cdp.emit('Network.responseReceived',{type:'Script',requestId:'asset-1',response:{url:asset}});
  const source=readFileSync(new URL('../index.ts',import.meta.url),'utf8'),start=source.indexOf('    const cellMs = cellOf('),end=source.indexOf('    const measured =',start);
  assert.ok(start>=0&&end>start);
  const context={Date:class extends Date{static override now(){return wall;}},idleCpu,idleCpuMode:collection,shortIdleProfile:false,seconds:120,cdp,reading:traceReading,
    idleWindow,idlePhaseScript,idlePhaseProblems,idleRetentionProblems:()=>[],
    cellOf:()=>300_000,sleep:async(ms:number)=>{cdp.commands.push('ORIGINAL.sleep:'+ms);wall+=Math.max(0,ms);if(ms===120_000){cdp.timestamp=121;for(let i=0;i<5;i++)ledger.push('event: ping\ndata: {}\n\n');}},
    overview:async()=>[],stillProblems:()=>[],Stop:Error,say:()=>{},heard,requests:{counting:false,count:0,byPath:{}},
    metrics:async()=>{cdp.commands.push(metricCalls++?'ORIGINAL.after-metrics':'ORIGINAL.before-metrics');return metricCalls===1?traceWindow.before:traceWindow.after;},
    idleTimingDiagnostic:undefined,idleDiagnostic:undefined,traffic:undefined,
    evidence:{begin:()=>{},end:()=>{},checked:()=>{},save:(name:string,value:unknown)=>evidenceSaved.push({name,value})},coverage:{record:()=>{}},
    round:(value:number)=>value,scriptPerSecond:()=>.1,idleProblems:()=>[],saveDiagnostic:(name:string,value:unknown)=>saved.push({name,value}),finish:async()=>{},run:undefined as unknown as()=>Promise<unknown>};
  runInNewContext(ts.transpileModule(`async function run(){${source.slice(start,end)}\nreturn {from,to};}globalThis.run=run;`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,context);
  let failure:unknown;
  try{await context.run();}catch(error){failure=error;}finally{await idleCpu?.close();}
  return{cdp,saved,evidenceSaved,failure};
}
const canonicalCounterSequence=['ORIGINAL.reset','ORIGINAL.phase-start','ORIGINAL.heard-reset','ORIGINAL.before-metrics','ORIGINAL.retention','ORIGINAL.readout:opening','ORIGINAL.sleep:120000','ORIGINAL.readout:closing','ORIGINAL.retention','ORIGINAL.after-metrics','ORIGINAL.readout:final','ORIGINAL.phase-stop'];
test('actual trace index skips alignment and all geometry while preserving the original counter sequence',async()=>{
  const {cdp,saved,failure}=await originalIndex('trace');assert.equal(failure,undefined);
  assert.ok(!cdp.commands.some(command=>command.startsWith('Profiler.')));
  assert.deepEqual(cdp.commands.slice(cdp.commands.indexOf('ORIGINAL.reset'),cdp.commands.indexOf('ORIGINAL.phase-stop')+1),canonicalCounterSequence);
  assert.equal(result(saved,'idle-cpu-window').seconds,120);assert.ok(saved.some(row=>row.name==='idle-cpu-original-trace'));
});
test('actual original-profile index preserves the counter sequence and samples without alignment or geometry reads',async()=>{
  const {cdp,saved,failure}=await originalIndex('profile');assert.equal(failure,undefined);
  assert.deepEqual(cdp.commands.slice(cdp.commands.indexOf('ORIGINAL.reset'),cdp.commands.indexOf('ORIGINAL.phase-stop')+1),canonicalCounterSequence);
  assert.ok(cdp.commands.indexOf('Profiler.start')<cdp.commands.indexOf('ORIGINAL.reset'));
  assert.ok(cdp.commands.indexOf('Profiler.stop')>cdp.commands.indexOf('ORIGINAL.phase-stop'));
  assert.ok(cdp.commands.indexOf('Debugger.enable')>cdp.commands.indexOf('Profiler.stop'));
  assert.equal(result(saved,'idle-cpu-profile').samplingInterval,2000);
  assert.equal(result(saved,'idle-cpu-original-trace').profileStatus,'complete');
});
test('actual ordinary index installs no diagnostic and retains the original120s sequence',async()=>{
  const {cdp,saved,failure}=await originalIndex('');assert.equal(failure,undefined);assert.equal(saved.length,0);
  assert.ok(!cdp.commands.some(command=>/^(Profiler|Tracing|Debugger)\./.test(command)));
  assert.deepEqual(cdp.commands,['ORIGINAL.sleep:5000',...canonicalCounterSequence]);
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


// Proposed trace-only controls; these execute no browser and infer no CPU category.
const nativeMetadata=(pid=101)=>({name:'TracingStartedInBrowser',ph:'I',ts:1,pid:100,tid:100,args:{data:{frames:[{frame:'own-frame',processId:pid,isOutermostMainFrame:true,isInPrimaryMainFrame:true}]}}});
class NativeCdpFake extends CurrentCdpFake {
  inputPump=false;skipMetadata=false;loss:boolean|undefined=false;loader='loader-1';origin=1000;page=10;
  override async evaluate<T>(expression:string,signal?:AbortSignal):Promise<T>{
    signal?.throwIfAborted();this.commands.push('evaluate');
    const start=expression.includes('quotum-native-start');assert.ok(start||expression.includes('quotum-native-end'));
    const lo=this.page;this.page+=100;
    this.emit('Tracing.dataCollected',{value:[{name:'TimeStamp',ph:'I',ts:1_000_000+lo*1000,pid:101,tid:101,args:{data:{frame:'own-frame',message:start?'quotum-native-start':'quotum-native-end'}}}]});
    return {lo,hi:lo+.05,timeOrigin:this.origin} as T;
  }
  override async send<T=unknown>(method:string,params:object={},signal?:AbortSignal):Promise<T>{
    signal?.throwIfAborted();
    if(method==='Page.getFrameTree'){this.commands.push(method);return {frameTree:{frame:{id:'own-frame',loaderId:this.loader}}} as T;}
    if(method==='Tracing.start'){
      this.commands.push(method);assert.equal((params as {categories:string}).categories,'toplevel,cc,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,disabled-by-default-cc.debug.scheduler'+(this.inputPump?',input':''));
      if(!this.skipMetadata)this.emit('Tracing.dataCollected',{value:[nativeMetadata(),{name:'thread_name',ph:'M',pid:101,tid:101,args:{name:'CrRendererMain'}}]});
      return {} as T;
    }
    if(method==='Tracing.end'){this.commands.push(method);this.emit('Tracing.tracingComplete',this.loss===undefined?{}:{dataLossOccurred:this.loss});return {} as T;}
    return super.send<T>(method,params,signal);
  }
}
const nativeEvents=[
  {name:'RunTask',ph:'B',ts:1_020_000,tts:100,pid:101,tid:101},
  {name:'FunctionCall',ph:'X',ts:1_021_000,dur:1000,tts:101,tdur:500,pid:101,tid:101,args:{data:{frame:'own-frame',scriptId:'11',lineNumber:1,columnNumber:2,url:'private-canary',functionName:'private-canary'}}},
  {name:'MinorGC',ph:'X',ts:1_022_000,dur:800,tts:601,tdur:700,pid:101,tid:101,args:{private:'private-canary'}},
  {name:'Layout',ph:'X',ts:1_023_000,dur:100,pid:101,tid:101,args:{data:{frame:'own-frame',nodes:'private-canary'}}},
  {name:'FireAnimationFrame',ph:'X',ts:1_024_000,dur:200,pid:101,tid:101,args:{data:{frame:'own-frame',id:19}}},
  {name:'private-canary',ph:'B',ts:1_025_000,pid:101,tid:101},
  {ph:'E',ts:1_025_010,pid:101,tid:101},
  {name:'RunTask',ph:'E',ts:1_026_000,tts:1400,pid:101,tid:101},
  {name:'MajorGC',ph:'X',ts:1_027_000,dur:300,pid:102,tid:102},
];
async function captureNative(configure?:(cdp:NativeCdpFake)=>void,during?:(cdp:NativeCdpFake)=>void,collection:'native-trace'|'native-profile'='native-trace',inputPump=false,onTrace?:(receipt:Record<string,unknown>)=>void){
  const cdp=new NativeCdpFake({forbidProfiler:collection==='native-trace'}),saved:Saved[]=[];cdp.inputPump=inputPump;configure?.(cdp);
  const diagnostic=new IdleCpuDiagnostic(cdp as unknown as Cdp,(name,value,large)=>{saved.push({name,value,large});if(name==='native-frame-trace')onTrace?.(record(value));},client,true,collection,undefined,inputPump);
  cdp.emit('Network.responseReceived',{type:'Script',requestId:'asset-1',response:{url:asset}});
  await diagnostic.start();cdp.emit('Tracing.dataCollected',{value:nativeEvents});during?.(cdp);
  cdp.commands.push('ORIGINAL.report-frozen');await diagnostic.stop();await diagnostic.bindAndClose();await diagnostic.close();
  const receipt=record([...saved].reverse().find(row=>row.name==='native-frame-trace')!.value);
  return {cdp,saved,receipt};
}
test('native trace retains frameless work, B/E boundaries and distinct wall/thread clocks without an idle qualification',async()=>{
  const {cdp,saved,receipt}=await captureNative();
  assert.equal(receipt.status,'unqualified');assert.equal(record(receipt.capture).status,'complete');assert.equal(record(receipt.scope).status,'complete');
  assert.equal(record(receipt.clocks).status,'recorded-unqualified');
  const rows=receipt.events as any[],gc=rows.find(row=>row.name==='MinorGC');
  assert.equal(gc.frame,null);assert.equal(gc.duration,800);assert.equal(gc.threadDuration,700);
  assert.equal(rows.find(row=>row.name==='FireAnimationFrame').id,19);
  assert.ok(rows.some(row=>row.name==='other'&&row.phase==='B'));assert.ok(rows.some(row=>row.name==='other'&&row.phase==='E'));
  assert.ok(rows.some(row=>row.pid===102));assert.equal(record(receipt.scope).pid,101);
  assert.ok(!cdp.commands.some(name=>name.startsWith('Profiler.')));assert.ok(!saved.some(row=>row.name==='idle-cpu-original-trace'));
  assert.ok(cdp.commands.indexOf('Tracing.end')>cdp.commands.indexOf('ORIGINAL.report-frozen'));
  assert.ok(cdp.commands.indexOf('Debugger.enable')>cdp.commands.indexOf('Tracing.end'));
  assert.doesNotMatch(JSON.stringify(safeEvidence(receipt)),/private-canary/);
  for(const rows of cdp.listeners.values())assert.equal(rows.length,0);
});
for(const loss of [true,undefined])test('native trace keeps '+String(loss)+' data-loss state insufficient',async()=>{
  const {receipt}=await captureNative(cdp=>{cdp.loss=loss;});assert.equal(record(receipt.capture).status,'insufficient-evidence');assert.equal(receipt.status,'unqualified');
});
for(const event of ['Page.frameNavigated','Page.frameDetached','Runtime.executionContextsCleared'])test('native trace invalidates '+event+' through the drain',async()=>{
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit(event,{}));assert.equal(record(receipt.scope).status,'unknown');assert.ok((receipt.events as unknown[]).length>0);
});
test('missing metadata and changed loader keep sanitized candidates unknown',async()=>{
  for(const result of [await captureNative(cdp=>{cdp.skipMetadata=true;}),await captureNative(undefined,cdp=>{cdp.loader='loader-2';})]){
    assert.equal(record(result.receipt.scope).status,'unknown');assert.equal(record(result.receipt.clocks).status,'unknown');assert.ok((result.receipt.events as unknown[]).length>0);
  }
});
test('conflicting process binding does not borrow the first renderer',async()=>{
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:[nativeMetadata(102)]}));assert.equal(record(receipt.scope).status,'unknown');
});
test('changed timeOrigin cannot qualify native page/trace alignment',async()=>{
  const {receipt}=await captureNative(undefined,cdp=>{cdp.origin=2000;});assert.equal(record(receipt.clocks).status,'unknown');assert.equal(receipt.status,'unqualified');
});
test('already cancelled native trace starts no CDP operation',async()=>{
  const cdp=new NativeCdpFake(),abort=new AbortController();abort.abort();
  const diagnostic=new IdleCpuDiagnostic(cdp as unknown as Cdp,()=>{},client,true,'native-trace',abort.signal);
  await assert.rejects(diagnostic.start());await diagnostic.close();assert.deepEqual(cdp.commands,[]);
});


test('actual native collector releases tracing and Runtime after RunOwner abort with one independent signal',async()=>{
  const owner=new RunOwner(),saved:Saved[]=[],signals:AbortSignal[]=[];
  const cdp=new class extends NativeCdpFake {
    override async send<T=unknown>(method:string,params:object={},signal?:AbortSignal):Promise<T>{
      if(method==='Tracing.end'||method==='Runtime.disable'){
        assert.equal(owner.signal.aborted,true);assert.ok(signal);assert.notEqual(signal,owner.signal);assert.equal(signal.aborted,false);signals.push(signal);
      }
      return super.send<T>(method,params,signal);
    }
  }({forbidProfiler:true});
  const diagnostic=new IdleCpuDiagnostic(cdp as unknown as Cdp,(name,value)=>saved.push({name,value}),client,true,'native-trace',owner.signal);
  owner.resource(()=>diagnostic.close());await diagnostic.start();await owner.close();
  assert.equal(cdp.commands.filter(name=>name==='Tracing.end').length,1);assert.equal(cdp.commands.filter(name=>name==='Runtime.disable').length,1);
  assert.equal(signals.length,2);assert.equal(signals[0],signals[1]);
  const receipt=record([...saved].reverse().find(row=>row.name==='native-frame-trace')!.value);assert.equal(record(receipt.capture).cleanup,'incomplete');assert.equal(receipt.status,'unqualified');
  for(const listeners of cdp.listeners.values())assert.equal(listeners.length,0);
});
test('actual native collector still disables Runtime when Tracing.end rejects during owner cleanup',async()=>{
  const owner=new RunOwner(),traceError=Error('trace cleanup rejected');let closeError:unknown;
  const cdp=new class extends NativeCdpFake {
    override async send<T=unknown>(method:string,params:object={},signal?:AbortSignal):Promise<T>{
      if(method==='Tracing.end'){assert.equal(owner.signal.aborted,true);assert.equal(signal?.aborted,false);this.commands.push(method);throw traceError;}
      return super.send<T>(method,params,signal);
    }
  }({forbidProfiler:true});
  const diagnostic=new IdleCpuDiagnostic(cdp as unknown as Cdp,()=>{},client,true,'native-trace',owner.signal);
  owner.resource(async()=>{try{await diagnostic.close();}catch(error){closeError=error;throw error;}});
  await diagnostic.start();await assert.rejects(owner.close(),/resource cleanup failed/);
  assert.equal(closeError,traceError);assert.equal(cdp.commands.filter(name=>name==='Runtime.disable').length,1);
  for(const listeners of cdp.listeners.values())assert.equal(listeners.length,0);
});
test('native stop keeps its original error when both independent cleanup operations reject',async()=>{
  const original=Error('original clock failure'),traceError=Error('trace cleanup failure'),runtimeError=Error('Runtime cleanup failure');
  const cdp=new class extends NativeCdpFake {
    override async evaluate<T>(expression:string,signal?:AbortSignal):Promise<T>{if(expression.includes('quotum-native-end'))throw original;return super.evaluate<T>(expression,signal);}
    override async send<T=unknown>(method:string,params:object={},signal?:AbortSignal):Promise<T>{
      if(method==='Tracing.end'||method==='Runtime.disable'){assert.equal(signal?.aborted,false);this.commands.push(method);throw method==='Tracing.end'?traceError:runtimeError;}
      return super.send<T>(method,params,signal);
    }
  }({forbidProfiler:true});
  const diagnostic=new IdleCpuDiagnostic(cdp as unknown as Cdp,()=>{},client,true,'native-trace');await diagnostic.start();
  await assert.rejects(diagnostic.stop(),error=>error===original);await assert.rejects(diagnostic.close(),error=>error===traceError);
  assert.equal(cdp.commands.filter(name=>name==='Tracing.end').length,1);assert.equal(cdp.commands.filter(name=>name==='Runtime.disable').length,1);
});

test('native trace cap remains explicit through the actual artifact writer',async t=>{
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:Array.from({length:100_001},(_,i)=>({name:'RunTask',ph:'X',ts:2_000_000+i,dur:1,pid:101,tid:101}))}));
  assert.equal((receipt.events as unknown[]).length,100_000);assert.ok(Number(record(receipt.capture).omitted)>0);
  assert.equal(record(receipt.capture).status,'insufficient-evidence');
  const directory=mkdtempSync(path.join(os.tmpdir(),'quotum-native-evidence-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const evidence=new Evidence(directory);evidence.saveTrace('native-frame-trace',receipt);
  const root=path.join(directory,evidence.id),saved=JSON.parse(readFileSync(path.join(root,'native-frame-trace.json'),'utf8'));
  assert.equal(saved.events.length,100_000);assert.equal(saved.capture.omitted,record(receipt.capture).omitted);
  assert.equal(saved.capture.status,'insufficient-evidence');assert.equal(saved.status,'unqualified');
  const manifest=JSON.parse(readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.errors,[]);assert.equal(manifest.files[0].truncated,false);
});


test('native profiling is explicit, keeps signed samples and never changes the trace-only default',async()=>{
  const plain=await captureNative();assert.ok(!plain.cdp.commands.some(name=>name.startsWith('Profiler.')));assert.ok(!plain.saved.some(row=>row.name==='native-frame-profile'));
  const measured=await captureNative(undefined,undefined,'native-profile');
  for(const name of ['Profiler.enable','Profiler.setSamplingInterval','Profiler.start','Profiler.stop','Profiler.disable'])assert.equal(measured.cdp.commands.filter(value=>value===name).length,1);
  const saved=result(measured.saved,'native-frame-profile'),numeric=record(saved.profile);
  assert.equal(saved.status,'unqualified');assert.equal(saved.samplingInterval,2000);assert.equal(record(saved.capture).status,'complete');
  assert.deepEqual(numeric.timeDeltas,[2000,-50,2050]);assert.equal(numeric.reversedDeltas,1);assert.equal(measured.receipt.status,'unqualified');
});
test('native rejections keep only the first eight numeric fixed classifications without waiving invalid',async()=>{
  const bad=Array.from({length:12},(_,i)=>({name:'Layout',ph:'X',ts:2_000_000+i,pid:101,tid:101,args:{data:{frame:'own-frame',url:'private-rejected-canary',stackTrace:'private-rejected-canary'}}}));
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:bad}));
  assert.equal(record(receipt.capture).invalid,12);assert.equal(record(receipt.capture).status,'insufficient-evidence');assert.equal(receipt.omittedRejections,4);
  const rejected=receipt.rejected as Record<string,unknown>[];assert.equal(rejected.length,8);
  assert.deepEqual(rejected[0],{name:'Layout',kind:'known',phase:'X',pid:101,tid:101,ts:2_000_000,frame:1,reason:'duration'});
  assert.doesNotMatch(JSON.stringify(safeEvidence(receipt)),/private-rejected-canary/);
});
test('only fixed rendering, animation, lifecycle and commit-wait envelopes join the native whitelist',async()=>{
  const names=['PrePaint','Paint','Layerize','CompositeLayers','PageAnimator::serviceScriptedAnimations',
    'WebFrameWidgetImpl::UpdateLifecycle','LayerTreeHost::WaitForCommitCompletion'];
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:[...names,'private-extra-canary'].map(name=>({name,ph:'X',ts:2_000_000,dur:20,pid:101,tid:101}))}));
  for(const name of names)assert.equal((receipt.events as any[]).filter(row=>row.name===name).length,1);
  assert.doesNotMatch(JSON.stringify(receipt),/private-extra-canary/);assert.equal(receipt.status,'unqualified');
});
test('native raster observations preserve fixed envelopes and numeric preparation fields only',async()=>{
  const names=['TileManager::PrepareTiles','TileManager::ScheduleTasks','RasterizerTaskImpl::RunOnWorkerThread',
    'TileManager::DidFinishRunningTileTasksRequiredForActivation','TileManager::CheckPendingGpuWorkAndIssueSignals','LayerTreeHostImpl::ActivateSyncTree'];
  const args={prepare_tiles_id:7,source_prepare_tiles_id:7,count:12,pending_gpu_work_tiles:0,private:'private-raster-canary'};
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:[...names,'private-raster-canary'].map(name=>({name,ph:'X',ts:2_000_000,dur:20,pid:101,tid:105,args}))}));
  const rows=(record(safeEvidence(receipt)).events as any[]).filter(row=>names.includes(row.name));
  assert.equal(rows.length,6);assert.ok(rows.every(row=>row.duration===20&&row.pid===101&&row.tid===105));
  assert.deepEqual(rows.map(row=>[row.prepareId??null,row.rasterTasks??null,row.pendingGpuTasks??null]),
    [[7,null,null],[null,12,null],[7,null,null],[null,null,null],[null,null,0],[null,null,null]]);
  assert.doesNotMatch(JSON.stringify(receipt),/private-raster-canary/);assert.equal(receipt.status,'unqualified');
  const invalid=[undefined,-1,.5,'7',Number.MAX_SAFE_INTEGER+1,Infinity];
  const {receipt:missing}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:invalid.flatMap(value=>names.slice(0,3).map(name=>({name,ph:'X',ts:2_000_000,dur:20,pid:101,tid:105,args:{prepare_tiles_id:value,source_prepare_tiles_id:value,count:value}})))}));
  const unknown=(missing.events as any[]).filter(row=>names.includes(row.name));
  assert.equal(unknown.length,18);assert.ok(unknown.every(row=>row.prepareId===null||row.rasterTasks===null));
});
test('native commit observations keep exact exported edge IDs and host numbers without rounded uint64 IDs',async()=>{
  const names=['ProxyMain::BeginMainFrame','ProxyMain::BeginMainFrame::commit','ProxyImpl::ReadyToCommit','ProxyImpl::Commit'];
  const slices=names.map((name,i)=>({name,ph:'X',pid:101,tid:i<2?101:105,ts:2_000_000+i*100,dur:90,
    args:{main_frame_pipeline:{main_frame_id:Number.MAX_SAFE_INTEGER+1},private:'private-commit-canary'}}));
  const flows=names.slice(0,-1).flatMap((name,i)=>[
    {name,ph:'s',id:i+7,pid:101,tid:slices[i].tid,ts:slices[i].ts},
    {name,ph:'f',id:i+7,bp:'e',pid:101,tid:slices[i+1].tid,ts:slices[i+1].ts},
  ]);
  const host={name:'BeginMainThreadFrame',ph:'I',pid:101,tid:101,ts:2_000_010,args:{layerTreeId:19,data:{frameId:0,private:'private-commit-canary'}}};
  const held=['HoldCommit','ReleaseCommitbyActivation'].map(name=>({name,ph:'I',pid:101,tid:105,ts:2_000_350}));
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:[...slices,...flows,host,...held]}));
  const rows=receipt.events as any[];
  const retained=record(safeEvidence(receipt)).events as any[];
  assert.deepEqual(retained.filter(row=>row.flowId!==undefined).map(row=>[row.name,row.phase,row.flowId,row.flowEnd??false,row.ts,row.tid]),
    flows.map(row=>[row.name,row.ph,row.id,row.ph==='f',row.ts,row.tid]));
  for(const name of names)assert.equal(rows.filter(row=>row.name===name&&row.phase==='X').length,1);
  const saved=rows.find(row=>row.name==='BeginMainThreadFrame');assert.equal(saved.hostId,19);assert.equal(saved.sourceFrame,0);
  for(const {name} of held)assert.ok(rows.some(row=>row.name===name));
  assert.equal(record(receipt.capture).invalid,0);assert.doesNotMatch(JSON.stringify(safeEvidence(receipt)),/private-commit-canary|main_frame_id|pipelineId/);
});
test('unsafe flow and host observations fail closed without borrowing nearby numeric IDs',async()=>{
  const base={name:'ProxyMain::BeginMainFrame',ph:'s',pid:101,tid:101,ts:2_000_000};
  const bad=[...['7',-1,1.5,Number.MAX_SAFE_INTEGER+1,undefined].map(id=>({...base,id})),
    {...base,ph:'f',id:7},
    ...[0,'19',Number.MAX_SAFE_INTEGER+1].map(layerTreeId=>({...base,name:'BeginMainThreadFrame',ph:'I',args:{layerTreeId,data:{frameId:0}}})),
    {...base,name:'BeginMainThreadFrame',ph:'I',args:{layerTreeId:19,data:{frameId:'0'}}}];
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:bad}));
  assert.equal(record(receipt.capture).invalid,bad.length);assert.equal(record(receipt.capture).status,'insufficient-evidence');
  assert.ok(!(receipt.events as any[]).some(row=>row.flowId!==undefined||row.hostId!==undefined));
  assert.ok((receipt.rejected as any[]).every(row=>row.reason==='commit-metadata'));
});
const schedulerFields=['has_pending_tree','pending_tree_is_ready_for_activation','active_tree_needs_first_draw','active_tree_is_ready_to_draw',
  'processing_animation_worklets_for_pending_tree','processing_paint_worklets_for_pending_tree','current_pending_tree_is_impl_side','can_draw'];
test('scheduler snapshots retain exact booleans through evidence and keep boundary scopes without invented states',async()=>{
  const state=Object.fromEntries(schedulerFields.map((key,i)=>[key,i%2===0]));
  const base={name:'SchedulerStateMachine',pid:101,tid:105,ts:2_000_000};
  const snapshot={...base,ph:'X',dur:20,args:{cc_scheduler_state:{state_machine:{minor_state:{...state,private:'private-scheduler-canary'}}},private:'private-scheduler-canary'}};
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:[snapshot,{...base,ph:'B'},{...base,ph:'E',ts:2_000_100}]}));
  const rows=record(safeEvidence(receipt)).events as any[],saved=rows.filter(row=>row.name==='SchedulerStateMachine');
  assert.deepEqual(saved.map(row=>row.scheduler??null),[state,null,null]);assert.equal(record(receipt.capture).invalid,0);
  assert.doesNotMatch(JSON.stringify(safeEvidence(receipt)),/private-scheduler-canary|cc_scheduler_state|minor_state/);
});
test('missing and nonboolean scheduler fields fail closed rather than becoming false',async()=>{
  const state=Object.fromEntries(schedulerFields.map(key=>[key,false])),base={name:'SchedulerStateMachine',ph:'X',pid:101,tid:105,ts:2_000_000,dur:20};
  const values=[...schedulerFields.map(key=>{const missing={...state};delete missing[key];return missing;}),
    ...[null,0,'false',undefined].map(value=>({...state,has_pending_tree:value}))];
  const bad=values.map(minor_state=>({...base,args:{cc_scheduler_state:{state_machine:{minor_state}}}}));
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:bad}));
  assert.equal(record(receipt.capture).invalid,bad.length);assert.equal(record(receipt.capture).status,'insufficient-evidence');
  assert.ok(!(receipt.events as any[]).some(row=>row.name==='SchedulerStateMachine'));assert.ok((receipt.rejected as any[]).every(row=>row.reason==='scheduler-metadata'));
});
test('native-profile stop failure retains its first error, signed cleanup profile and all owned releases',async()=>{
  const owner=new RunOwner(),original=Error('original native profile stop'),saved:Saved[]=[];let attempts=0;
  const cdp=new class extends NativeCdpFake {
    override async send<T=unknown>(method:string,params:object={},signal?:AbortSignal):Promise<T>{
      if(method==='Profiler.stop'&&attempts++===0){this.commands.push(method);throw original;}
      return super.send<T>(method,params,signal);
    }
  }();
  const diagnostic=new IdleCpuDiagnostic(cdp as unknown as Cdp,(name,value)=>saved.push({name,value}),client,true,'native-profile',owner.signal);
  owner.resource(()=>diagnostic.close());await diagnostic.start();await assert.rejects(diagnostic.stop(),error=>error===original);await owner.close();
  for(const name of ['Tracing.end','Runtime.disable','Profiler.disable'])assert.equal(cdp.commands.filter(value=>value===name).length,1);
  assert.equal(cdp.commands.filter(value=>value==='Profiler.stop').length,2);
  const receipt=result(saved,'native-frame-profile');assert.equal(record(receipt.capture).status,'insufficient-evidence');assert.deepEqual(record(receipt.profile).timeDeltas,[2000,-50,2050]);
  for(const listeners of cdp.listeners.values())assert.equal(listeners.length,0);
});
test('native-profile owner abort still attempts Profiler.disable when Profiler.stop rejects',async()=>{
  const owner=new RunOwner(),stopped=Error('profile cleanup stop rejected'),signals:AbortSignal[]=[];
  const cdp=new class extends NativeCdpFake {
    override async send<T=unknown>(method:string,params:object={},signal?:AbortSignal):Promise<T>{
      if(['Tracing.end','Runtime.disable','Profiler.stop','Profiler.disable'].includes(method)){
        assert.equal(owner.signal.aborted,true);assert.ok(signal);assert.equal(signal.aborted,false);assert.notEqual(signal,owner.signal);signals.push(signal);
      }
      if(method==='Profiler.stop'){this.commands.push(method);throw stopped;}return super.send<T>(method,params,signal);
    }
  }();
  const diagnostic=new IdleCpuDiagnostic(cdp as unknown as Cdp,()=>{},client,true,'native-profile',owner.signal);owner.resource(()=>diagnostic.close());await diagnostic.start();
  await assert.rejects(owner.close(),/resource cleanup failed/);
  for(const name of ['Tracing.end','Runtime.disable','Profiler.stop','Profiler.disable'])assert.equal(cdp.commands.filter(value=>value===name).length,1);
  assert.equal(signals.length,4);assert.ok(signals.every(signal=>signal===signals[0]));
  for(const listeners of cdp.listeners.values())assert.equal(listeners.length,0);
});

test('quota24 input pump trace retains only the fixed numeric event across distinct processes',async()=>{
  const pump={name:'SyntheticGestureController::Flush',ph:'X',ts:1_030_000,dur:600,pid:100,tid:109,tts:2,tdur:3,args:{data:{frame:'own-frame',id:7,message:'quotum-native-start'},role:'private-canary',url:'private-canary'}};
  const result=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:[pump,{...pump,name:'SyntheticGestureController::private-canary'},{...pump,pid:NaN}]}),'native-trace',true);
  const rows=result.receipt.events as any[],row=rows.find(row=>row.name===pump.name);assert.ok(row);
  assert.deepEqual([row.phase,row.ts,row.duration,row.threadTs,row.threadDuration,row.pid,row.tid],['X',1030000,600,2,3,100,109]);
  assert.equal(row.frame,null);assert.equal(row.id,null);assert.equal(row.marker,null);assert.equal(row.source,null);
  assert.equal(record(result.receipt.scope).pid,101,'pump PID never replaces the actual renderer binding');assert.equal(record(result.receipt.scope).status,'complete');
  assert.doesNotMatch(JSON.stringify(result.receipt),/private-canary/);assert.equal(record(result.receipt.capture).status,'insufficient-evidence','invalid pump identity stays rejected');
  const legacy=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:[pump]}));assert.ok(!(legacy.receipt.events as any[]).some(row=>row.name===pump.name));
  assert.throws(()=>new IdleCpuDiagnostic(new NativeCdpFake() as unknown as Cdp,()=>{},client,true,'native-profile',undefined,true),/requires native-trace/);
});

const idleMetadata={name:'thread_name',ph:'M',cat:'__metadata',pid:0,tid:0,ts:0,args:{name:'swapper'}};
const activationFlow={name:'LayerTreeHostImpl::ActivateSyncTree',cat:'cc,benchmark',ph:'s',pid:101,tid:105,ts:2_000_000,id:0};
test('source-shaped activation flow keeps edge zero and its finish without changing the timed scope',async()=>{
  const events=[activationFlow,{...activationFlow,ph:'f',bp:'e',ts:2_000_100},{...activationFlow,ph:'X',dur:90}];
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:events}));
  assert.equal(record(receipt.capture).invalid,0,JSON.stringify(receipt.rejected));
  const rows=(receipt.events as any[]).filter(row=>row.name===activationFlow.name);
  assert.deepEqual(rows.map(row=>[row.phase,row.flowId??null,row.flowEnd??false,row.duration]),[['s',0,false,null],['f',0,true,null],['X',null,false,90]]);
  assert.equal(record(receipt.capture).status,'complete');assert.equal(record(receipt.scope).pid,101);assert.equal(record(receipt.scope).tid,101);
});
test('source-shaped idle metadata is counted without entering events or owner and clock binding',async()=>{
  const plain=await captureNative(),withIdle=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:[idleMetadata]}));
  assert.equal(record(withIdle.receipt.capture).invalid,0,JSON.stringify(withIdle.receipt.rejected));
  assert.equal(record(withIdle.receipt.capture).ignoredIdleMetadata,1);assert.equal(record(withIdle.receipt.capture).status,'complete');
  assert.deepEqual(withIdle.receipt.events,plain.receipt.events);assert.deepEqual(withIdle.receipt.scope,plain.receipt.scope);assert.deepEqual(withIdle.receipt.clocks,plain.receipt.clocks);
  assert.doesNotMatch(JSON.stringify(withIdle.receipt),/swapper|__metadata/);
});

test('idle metadata discard requires every exact typed field and cannot spoof a renderer',async()=>{
  const variants=[
    ...[undefined,'TracingStartedInBrowser'].map(name=>({...idleMetadata,name})),
    ...[undefined,'I',0].map(ph=>({...idleMetadata,ph})),
    ...[undefined,'metadata',0,['__metadata']].map(cat=>({...idleMetadata,cat})),
    ...[undefined,'0',false,1,NaN].map(pid=>({...idleMetadata,pid})),
    ...[undefined,'0',false,1,NaN].map(tid=>({...idleMetadata,tid})),
    ...[undefined,'0',false,1,NaN].map(ts=>({...idleMetadata,ts})),
    ...[undefined,null,{}, {name:'CrRendererMain'},{name:'private-idle-canary'},{name:0}].map(args=>({...idleMetadata,args})),
  ];
  // An actually unknown M name keeps the old skip; recognized zero shapes remain invalid.
  const unknown=variants.shift()!;
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:[unknown,...variants,{...idleMetadata,name:'process_name'}]}));
  const capture=record(receipt.capture);assert.equal(capture.ignoredIdleMetadata,0);assert.equal(capture.invalid,variants.length);assert.equal(capture.status,'insufficient-evidence');
  assert.equal(record(capture.rejectionReasons).identity,variants.length);assert.equal(record(receipt.scope).pid,101);assert.equal(record(receipt.scope).tid,101);
  assert.ok((receipt.events as any[]).every(row=>row.pid>0&&row.tid>0));assert.doesNotMatch(JSON.stringify(receipt),/private-idle-canary|swapper|__metadata/);
  const unbound=await captureNative(cdp=>{cdp.skipMetadata=true;},cdp=>cdp.emit('Tracing.dataCollected',{value:[idleMetadata]}));
  assert.equal(record(unbound.receipt.capture).ignoredIdleMetadata,1);assert.equal(record(unbound.receipt.scope).status,'unknown');assert.equal(record(unbound.receipt.clocks).status,'unknown');
  assert.ok(!(unbound.receipt.events as any[]).some(row=>row.name==='thread_name'||row.name==='TracingStartedInBrowser'));
});
test('activation flows reject malformed IDs, finish bindings, clocks and unrelated phases',async()=>{
  const ids=[undefined,null,'0','0x0',-1,.5,Number.MAX_SAFE_INTEGER+1,Infinity,NaN,{}];
  const bad=[...ids.map(id=>({...activationFlow,id})),
    ...[undefined,'s',0,false].map(bp=>({...activationFlow,ph:'f',bp})),
    ...['t','b','e'].map(ph=>({...activationFlow,ph,id:0})),
    ...[0,NaN,'101'].map(pid=>({...activationFlow,pid})),
    ...[0,NaN,'105'].map(tid=>({...activationFlow,tid})),
    ...[undefined,-1,NaN,'2000000'].map(ts=>({...activationFlow,ts})),
    {...activationFlow,name:'Layout'},
  ];
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:bad}));
  const capture=record(receipt.capture),reasons=record(capture.rejectionReasons);
  assert.equal(capture.invalid,bad.length);assert.equal(capture.status,'insufficient-evidence');
  assert.deepEqual(reasons,{identity:6,timestamp:4,phase:4,duration:0,'frame-metadata':0,'commit-metadata':14,'scheduler-metadata':0});
  assert.ok(!(receipt.events as any[]).some(row=>row.flowId!==undefined));
});
test('all seven rejection counters count beyond eight examples and exported snapshots cannot mutate the collector',async()=>{
  const base={name:'Layout',ph:'X',pid:101,tid:101,ts:2_000_000,dur:1,args:{data:{frame:'own-frame',url:'https://private-reason-canary.invalid'}}};
  const failures=[{...base,pid:0},{...base,ts:NaN},{...base,ph:'s'},{...base,dur:undefined},
    {...base,name:'TracingStartedInBrowser',ph:'I'},
    {...activationFlow,ph:'f'},
    {...base,name:'SchedulerStateMachine'}];
  const bad=failures.flatMap(row=>Array.from({length:3},()=>row));let first:Record<string,unknown>|undefined;
  const {receipt}=await captureNative(undefined,cdp=>cdp.emit('Tracing.dataCollected',{value:[idleMetadata,...bad]}),'native-trace',false,value=>{
    const counts=record(record(value.capture).rejectionReasons);
    if(!first){first=counts;counts.identity=999;}
  });
  const capture=record(receipt.capture),counts=record(capture.rejectionReasons);
  assert.deepEqual(counts,{identity:3,timestamp:3,phase:3,duration:3,'frame-metadata':3,'commit-metadata':3,'scheduler-metadata':3});
  assert.notEqual(counts,first);assert.equal(first!.identity,999);assert.equal(Object.values(counts).reduce<number>((sum,value)=>sum+Number(value),0),capture.invalid);
  assert.equal(capture.invalid,21);assert.equal(capture.ignoredIdleMetadata,1);assert.equal(capture.status,'insufficient-evidence');assert.equal((receipt.rejected as unknown[]).length,8);assert.equal(receipt.omittedRejections,13);
  assert.equal((receipt.rejected as any[]).filter(row=>row.reason==='phase').length,2,'later rejection classes have no example slots');
  const exported=record(record(safeEvidence(receipt)).capture);assert.deepEqual(exported.rejectionReasons,counts);assert.doesNotMatch(JSON.stringify(receipt),/private-reason-canary|swapper|__metadata/);
});
