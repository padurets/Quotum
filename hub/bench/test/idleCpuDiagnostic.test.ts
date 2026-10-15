import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import type {Cdp} from '../cdp.js';
import type {Reading} from '../probe.js';
import {IdleCpuDiagnostic,sourceIdentity,idleEdgeProblems,originalTraceProblems,ownedClockFires,planIdleEdge,type IdleGeometry} from '../idleCpuDiagnostic.js';
import {numericProfile,profileWindow} from '../cpuProfile.js';

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
  constructor(readonly options:Options={}){}
  on<T>(name:string,listener:(value:T)=>void){const rows=this.listeners.get(name)??[];rows.push(listener as (value:unknown)=>void);this.listeners.set(name,rows);}
  off<T>(name:string,listener:(value:T)=>void){this.listeners.set(name,(this.listeners.get(name)??[]).filter(value=>value!==listener));}
  emit(name:string,value:unknown){for(const listener of this.listeners.get(name)??[])listener(value);}
  async evaluate<T>(expression:string):Promise<T>{assert.equal(arguments.length,1);this.commands.push('evaluate');assert.equal(expression,'performance.now()');return this.timestamp*1000 as T;}
  async send<T=unknown>(method:string,params:object={}):Promise<T>{
    assert.ok(arguments.length<=2,'the current transport has no signal third argument');this.commands.push(method);
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
    if(method==='Network.getResponseBody')value={body,base64Encoded:false};
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
async function originalIndex(collection:''|'1'|'trace') {
  let wall=540_000,plans=0,geometry=0,metricCalls=0;
  const saved:Saved[]=[],cdp=new class extends CurrentCdpFake {
    override async evaluate<T>(expression:string):Promise<T>{
      if(expression==='__quotumBench.reset()'){this.commands.push('ORIGINAL.reset');return undefined as T;}
      if(expression==='__quotumBench.read()'){this.commands.push('ORIGINAL.readout');return traceReading as T;}
      return super.evaluate<T>(expression);
    }
  }({forbidProfiler:collection==='trace'});
  const idleCpu=collection?new IdleCpuDiagnostic(cdp as unknown as Cdp,(name,value)=>saved.push({name,value}),client,true,collection==='trace'?'trace':'profile'):undefined;
  cdp.emit('Network.responseReceived',{type:'Script',requestId:'asset-1',response:{url:asset}});
  const source=readFileSync(new URL('../index.ts',import.meta.url),'utf8'),start=source.indexOf('    let edgePlan:'),end=source.indexOf('    const measured =',start);
  assert.ok(start>=0&&end>start);
  const context={Date:class extends Date{static override now(){return wall;}},idleCpu,idleCpuMode:collection,seconds:120,cdp,reading:traceReading,
    planIdleEdge:(...args:Parameters<typeof planIdleEdge>)=>{plans++;return planIdleEdge(...args);},idleGeometry:async()=>{geometry++;return edgeGeometry(geometry>1);},
    cellOf:()=>300_000,sleep:async(ms:number)=>{cdp.commands.push('ORIGINAL.sleep:'+ms);wall+=Math.max(0,ms);cdp.timestamp=121;},
    overview:async()=>[],stillProblems:()=>[],Stop:Error,say:()=>{},heard:{reset:()=>{cdp.commands.push('ORIGINAL.heard-reset');},counts:()=>({ping:5})},requests:{counting:false,count:0,byPath:{}},
    metrics:async()=>{cdp.commands.push(metricCalls++?'ORIGINAL.after-metrics':'ORIGINAL.before-metrics');return metricCalls===1?traceWindow.before:traceWindow.after;},
    round:(value:number)=>value,scriptPerSecond:()=>.1,idleProblems:()=>[],saveDiagnostic:(name:string,value:unknown)=>saved.push({name,value}),finish:async()=>{},run:undefined as unknown as()=>Promise<unknown>};
  runInNewContext(ts.transpileModule(`async function run(){${source.slice(start,end)}\nreturn {from,to};}globalThis.run=run;`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,context);
  await context.run();await idleCpu?.close();return{cdp,plans,geometry,saved};
}
test('actual trace index skips alignment and all geometry while preserving the original counter sequence',async()=>{
  const {cdp,plans,geometry,saved}=await originalIndex('trace');assert.equal(plans,0);assert.equal(geometry,0);
  assert.ok(!cdp.commands.some(command=>command.startsWith('Profiler.')));
  assert.deepEqual(cdp.commands.slice(cdp.commands.indexOf('ORIGINAL.reset'),cdp.commands.indexOf('ORIGINAL.readout')+1),['ORIGINAL.reset','ORIGINAL.heard-reset','ORIGINAL.before-metrics','ORIGINAL.sleep:120000','ORIGINAL.after-metrics','ORIGINAL.readout']);
  assert.equal(result(saved,'idle-cpu-window').seconds,120);assert.ok(saved.some(row=>row.name==='idle-cpu-original-trace'));
});
test('actual ordinary index installs no diagnostic and retains the original120s sequence',async()=>{
  const {cdp,plans,geometry,saved}=await originalIndex('');assert.equal(plans,0);assert.equal(geometry,0);assert.equal(saved.length,0);
  assert.ok(!cdp.commands.some(command=>/^(Profiler|Tracing|Debugger)\./.test(command)));
  assert.deepEqual(cdp.commands,['ORIGINAL.reset','ORIGINAL.heard-reset','ORIGINAL.before-metrics','ORIGINAL.sleep:120000','ORIGINAL.after-metrics','ORIGINAL.readout']);
});
test('actual mode1 index retains aligned geometry and the existing2ms profiler',async()=>{
  const {cdp,plans,geometry,saved}=await originalIndex('1');assert.equal(plans,1);assert.equal(geometry,2);
  assert.ok(cdp.commands.includes('Profiler.start'));assert.ok(cdp.commands.includes('Profiler.stop'));
  assert.equal(result(saved,'idle-cpu-profile').samplingInterval,2000);assert.ok(saved.some(row=>row.name==='idle-cpu-edge'));
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
