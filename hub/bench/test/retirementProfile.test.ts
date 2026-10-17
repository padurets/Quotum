import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import type {Browser,Cdp} from '../cdp.js';
import {RunOwner} from '../runOwner.js';
import {profileInterval} from '../cpuProfile.js';
import {bounded} from '../reversalDiagnostic.js';
import {retirementProfile,retirementReadScript} from '../idleCpuDiagnostic.js';
import {idleRetentionProblems,type IdleRetention} from '../idleRetention.js';
import {safeEvidence} from '../evidence.js';

// Run the actual helper with controlled transport and wall waits, retaining the real
// owner, profiler lifecycle, profile sanitizer and storage guards.
const source=ts.createSourceFile('idleCpuDiagnostic.ts',readFileSync(new URL('../idleCpuDiagnostic.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const declaration=source.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='retirementProfile');
assert.ok(declaration);
const code=ts.transpileModule(declaration.getText(source).replace(/^export /,'')+'\nglobalThis.capture=retirementProfile;',{
  compilerOptions:{target:ts.ScriptTarget.ES2022},
}).outputText;
type Fault='missing'|'partial'|'basis'|'prefix'|'late-before'|'unsettled-after'|'clock'|'empty-profile'|'sample-cap'|'runtime'|'write'|'start'|'stop'|'disable'|'primary-and-stop'|'snapshot-cancel';
async function capture(fault?:Fault,cancelWait?:number,lead=10_001){
  const from=1_800_000_240_000,R=from+lead,to=from+120_000,periodMs=86_400_000,second=R-periodMs-1;
  const opening:IdleRetention={at:from,evaluatedAt:from,identity:'private-canary',generation:1,revision:1,proofEpoch:1,scopeKey:'private-canary',
    selection:{mode:'live',periodMs},settled:true,retirementAt:R,
    quota:{from:from-periodMs,cut:from,cursor:'private-canary',rows:['a','b'].map(sourceId=>({sourceId,windowId:'weekly',count:3,first:second-300_000,second,third:second+300_000,last:second+300_000}))}};
  let now=from,waits=0,reads=0,closed=0,start=0,closing:Promise<void>|undefined;
  const owner=new RunOwner(),commands:string[]=[],saved=new Map<string,any>();
  const browser:Browser={owned:true,owner,endpoint:'fixture',close:async()=>{closed++;}};
  const retention=(retired:boolean)=>{
    const value=structuredClone(opening);value.at=value.evaluatedAt=now;
    if(retired){value.retirementAt=R+300_000;for(const row of value.quota!.rows){row.count--;row.first=row.second;row.second=row.third;row.third=null;}}
    return value;
  };
  const original=Error('original retirement failure');
  const cdp={send:async(method:string,params:object,signal?:AbortSignal)=>{
    signal?.throwIfAborted();commands.push(method);assert.ok(!/^(Tracing|HeapProfiler)\./.test(method));
    if(method==='Browser.getVersion'){now++;return {product:fault==='runtime'?'private-canary':'Chrome/155.0.8059.39',jsVersion:'15.5.1',protocolVersion:'1.3',revision:'@'+'1'.repeat(40)};}
    if(method==='Performance.getMetrics')return{metrics:[{name:'Timestamp',value:now/1000+(fault==='clock'&&reads>0?10:0)}]};
    if(method==='Profiler.setSamplingInterval')assert.deepEqual(params,{interval:250});
    if(method==='Profiler.start'){start=now;if(fault==='start')throw original;}
    if(method==='Profiler.disable'&&fault==='disable')throw Error('lost disable');
    if(method==='Profiler.stop'){
      if(fault==='stop'||fault==='primary-and-stop')throw Error('lost stop');
      const samples=fault==='empty-profile'?[]:fault==='sample-cap'?Array(100_001).fill(2):[2,2,2];
      return{profile:{startTime:start*1000,endTime:now*1000,nodes:[{id:1,children:[2],callFrame:{functionName:'(root)',scriptId:'0',url:'',lineNumber:0,columnNumber:0}},
        {id:2,children:[],callFrame:{functionName:'private-canary',scriptId:'11',url:'https://private-canary/assets/index-test.js',lineNumber:0,columnNumber:3}}],
        samples,timeDeltas:samples.length===3?[250,-2,252]:Array(samples.length).fill(250)}};
    }
    return {};
  },evaluate:async(expression:string,signal?:AbortSignal)=>{
    signal?.throwIfAborted();
    if(expression==='performance.now()')return now;
    assert.equal(expression,retirementReadScript);assert.equal(signal,owner.signal);
    commands.push('snapshot-'+(++reads));
    if(fault==='snapshot-cancel'){
      return new Promise((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});closing=owner.close();});
    }
    if(fault==='primary-and-stop')throw original;
    if(fault==='missing')return{monotonicFrom:now,monotonicTo:now,retention:null};
    if(fault==='late-before'&&reads===1)now=R+1;
    const value=retention(reads===2&&fault!=='late-before');
    if(fault==='partial'&&reads===2)value.quota!.rows[1]=retention(false).quota!.rows[1];
    if(fault==='basis')value.scopeKey='different';
    if(fault==='prefix'&&reads===1)value.quota!.rows[1].first=value.quota!.rows[1].first!-1;
    if(fault==='unsettled-after'&&reads===2)value.settled=false;
    return{monotonicFrom:now,monotonicTo:now,retention:value};
  }} as unknown as Cdp;
  const context={Buffer,Date:{now:()=>now},profileInterval,bounded,idleRetentionProblems,safeEvidence,retirementReadScript,finite:(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0,
    wait:async(ms:number,_value:unknown,{signal}:{signal:AbortSignal})=>{
      signal.throwIfAborted();waits++;
      if(waits===cancelWait){closing=owner.close();signal.throwIfAborted();}
      now+=Math.max(0,ms);
    },capture:undefined as typeof retirementProfile|undefined};
  runInNewContext(code,context);assert.ok(context.capture);
  let receipt:Awaited<ReturnType<typeof retirementProfile>>|undefined,failure:unknown;
  try{receipt=await context.capture(cdp,browser,{from,to,quotaBoundary:R},opening,(name,value)=>{
    if(fault==='write')throw Error('write unavailable');saved.set(name,value);
  });}catch(error){failure=error;}
  await closing;
  return{receipt,failure,original,saved,commands,waits,closed,owner,from,to,R};
}

test('retirement snapshots passively bracket the existing getter in page time',()=>{
  const calls:string[]=[];let now=1;
  const value=runInNewContext(retirementReadScript,{performance:{now:()=>{calls.push('clock');return now++;}},window:{__quotumIdleRetention:()=>{calls.push('retention');return{at:1};}}});
  assert.deepEqual(calls,['clock','retention','clock']);assert.equal(value.monotonicFrom,1);assert.equal(value.monotonicTo,2);
});
test('one natural retirement records complete storage and signed samples inside confirmed recording',async()=>{
  const f=await capture();assert.equal(f.failure,undefined);assert.equal(f.receipt?.status,'complete');assert.equal(f.waits,2);
  const before=f.commands.indexOf('snapshot-1'),after=f.commands.indexOf('snapshot-2');
  assert.ok(f.commands.indexOf('Profiler.start')<before&&before<after&&after<f.commands.indexOf('Profiler.stop'));
  assert.equal(f.commands.at(-1),'Profiler.disable');assert.equal(f.closed,0);
  const profile=f.saved.get('idle-cpu-retirement-profile');assert.equal(profile.status,'complete');assert.deepEqual(profile.profile.timeDeltas,[250,-2,252]);
  assert.equal(f.receipt?.expectedRDue.length,2);assert.equal(f.receipt?.actual.snapshotFrom,f.R-5000);assert.equal(f.receipt?.actual.snapshotTo,f.R+5000);
  assert.doesNotMatch(JSON.stringify([...f.saved]),/private-canary|https:|functionName/);
});
test('an existing earliest canonical window tolerates entry latency without selecting another window',async()=>{
  const f=await capture(undefined,undefined,4999);assert.equal(f.failure,undefined);assert.equal(f.receipt?.status,'complete');assert.equal(f.waits,2);
  assert.equal(f.receipt?.actual.snapshotFrom,f.from+1);assert.ok(f.receipt!.actual.snapshotFrom!<f.R);
  assert.equal(f.receipt?.actual.snapshotTo,f.R+5000);
});
for(const fault of ['missing','partial','basis','prefix','late-before','unsettled-after','clock','empty-profile','sample-cap','runtime','write'] as const)test(`retirement evidence rejects ${fault} without another window`,async()=>{
  const f=await capture(fault);assert.equal(f.failure,undefined);assert.equal(f.receipt?.status,'insufficient-evidence');assert.equal(f.waits,2);
  assert.equal(f.commands.filter(name=>name==='Profiler.start').length,1);assert.equal(f.commands.filter(name=>name==='Profiler.stop').length,1);
});
for(const cancelWait of [1,2])test(`cancelling retirement wait ${cancelWait} joins cleanup and cannot start late`,async()=>{
  const f=await capture(undefined,cancelWait);assert.ok(f.failure);assert.ok(f.owner.signal.aborted);assert.equal(f.owner.failures.length,0);
  assert.equal(f.commands.includes('Profiler.enable'),cancelWait===2);assert.equal(f.commands.includes('Profiler.stop'),cancelWait===2);
  assert.equal(f.commands.some(name=>name==='snapshot-2'),false);
});
test('cancellation releases a pending snapshot and keeps its original owner error',async()=>{
  const f=await capture('snapshot-cancel');assert.equal(f.failure,f.owner.signal.reason);assert.equal(f.owner.failures.length,0);
  assert.ok(f.commands.includes('Profiler.stop'));assert.ok(f.commands.includes('Profiler.disable'));
});
for(const fault of ['start','stop','disable','primary-and-stop'] as const)test(`lost ${fault} never claims complete recording or hides the first error`,async()=>{
  const f=await capture(fault);assert.ok(f.failure);assert.equal(f.saved.get('idle-cpu-retirement-result').status,'insufficient-evidence');
  if(fault==='start'||fault==='primary-and-stop')assert.equal(f.failure,f.original);
  if(fault!=='start'){assert.equal(f.closed,1);assert.ok(f.owner.failures.includes('CPU profile cleanup unconfirmed'));}
});
test('retirement profiling rejects an attached browser before any command',async()=>{
  let commands=0;await assert.rejects(retirementProfile({send:async()=>{commands++;}} as unknown as Cdp,{owned:false,endpoint:'fixture',close:async()=>{}},{from:0,to:120_000,quotaBoundary:60_000},null,()=>{}),/owned synthetic/);
  assert.equal(commands,0);
});
