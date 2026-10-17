import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PeriodAccounting} from '../../server/domain/periodAccounting.js';
import {retainTapeWithTails,type QuotaTail} from '../../server/domain/periodRetention.js';
import {packSamples,retainSamplesPrepared,type PeriodTape} from '../../server/domain/periodTape.js';
import {drain} from '../../server/domain/prepare.js';
import {safeEvidence} from '../evidence.js';
import {observePreparations,retirementRoutesScript} from '../retirementRoutes.js';

function fixture(observe=true,WeakRefType=WeakRef,changed=false,allFast=false){
  const before:PeriodTape={from:0,cut:33_000,replaceFrom:0,cursor:'private cursor',quota:[false,!allFast,false].map((spent,n)=>({source:'private source '+n,window:'w',samples:drain(retainSamplesPrepared(packSamples(Array.from({length:32},(_,i)=>({at:i*1000+(n===2?1000:0),used:10+(spent?i*.125:0),resetAt:100_000,staleAfterMs:5000})))))})),money:[]};
  const prior=new PeriodAccounting(before,null),tails=new Map<PeriodTape['quota'][number],QuotaTail>();
  const after=drain(retainTapeWithTails(before,1001,()=>{},(a,b)=>tails.set(b,{before:a,after:b,removed:1})));
  assert.equal(tails.size,2);
  const member={active:true,retiring:false,retirementPreparing:false,workNeeded:false,dirtyScopes:new Set(),transport:{flights:new Set(),queue:[]},
    identity:'private identity',generation:1,revision:2,proofEpoch:3,scopeKeys:{quota:'private scope'},selection:{mode:'live',periodMs:86_400_000},projectionErrors:{},get:()=>({loading:false,error:null}),
    tapes:new Map([['quota',{tape:before,accounting:prior}]])};
  const pool={members:new Set([member])};
  const probe=observe?new Function('WeakRef','return ('+retirementRoutesScript()+')')(WeakRefType)(pool):null;
  const quotaCtor=[...(prior as any).quota.values()][0].constructor;
  const targets:[[any,string],[any,string],[any,string],[any,string]]=[[PeriodAccounting,'prepareRetirement'],[PeriodAccounting,'prepare'],[quotaCtor,'retire'],[quotaCtor,'prepare']];
  const descriptors=targets.map(([target,name])=>Object.getOwnPropertyDescriptor(target,name));
  const restored=()=>targets.forEach(([target,name],i)=>assert.deepEqual(Object.getOwnPropertyDescriptor(target,name),descriptors[i]));
  const progress:number[]=[];
  const create=(tape=after,charge:(n:number)=>void=n=>progress.push(n))=>PeriodAccounting.prepareRetirement(tape,null,undefined,prior,new Set(changed?['private source 2']:[]),charge,tails);
  const run=()=>{
    member.retiring=member.retirementPreparing=true;
    try{const value=drain(create());member.tapes.set('quota',{tape:after,accounting:value});return value;}
    finally{member.retiring=member.retirementPreparing=false;}
  };
  return {before,after,prior,tails,member,pool,probe,targets,descriptors,restored,progress,create,run};
}

test('real retirement routes distinguish one incremental index from one complete rebuild',()=>{
  const baseline=fixture(false),expected=baseline.run(),observed=fixture();
  observed.probe.start();let report:any;
  try{
    const value=observed.run();
    assert.deepEqual(observed.progress,baseline.progress,'factory observation changes no reservation operations');
    assert.equal(value.bytes,expected.bytes);
    for(const range of [{from:1001,to:32000},{from:1001,to:2001},{from:17000,to:20000}])for(const source of ['private source 0','private source 1'])
      assert.deepEqual(value.quotaSummary(source,'w',range),expected.quotaSummary(source,'w',range));
    report=observed.probe.stop();
  }finally{if(!report)observed.probe.stop();}
  observed.restored();assert.equal(report.status,'complete');assert.equal(report.retirementCalls,1);assert.equal(report.tails,2);
  assert.equal(report.tailIncrementalRows,1);assert.equal(report.tailFullBuilds,1);assert.equal(report.fallbackCalls,1);
  assert.deepEqual(report.rows.map((r:any)=>({samples:r.samples,attempts:r.attempts,builds:r.builds,fallback:r.fallback,published:r.published})),[
    {samples:31,attempts:1,builds:0,fallback:0,published:true},{samples:31,attempts:1,builds:1,fallback:1,published:true},{samples:32,attempts:0,builds:0,fallback:0,published:true},
  ]);
  assert.deepEqual(safeEvidence(report),report,'only fixed classifications, booleans and counts leave the page');
});

test('factory wrapping returns the original lazy iterator and preserves cancellation value',()=>{
  const h=fixture(),descriptor=Object.getOwnPropertyDescriptor(PeriodAccounting,'prepareRetirement')!,sentinel={cancel:true};let returned:any;
  Object.defineProperty(PeriodAccounting,'prepareRetirement',{...descriptor,value:function(...args:any[]){returned=Reflect.apply(descriptor.value,this,args);return returned;}});
  h.probe.start();
  try{
    const work=h.create();assert.strictEqual(work,returned);assert.deepEqual(h.progress,[],'observing a factory never advances it');
    assert.deepEqual((work as any).return(sentinel),{done:true,value:sentinel});assert.deepEqual(h.progress,[]);
    const report=h.probe.stop();assert.equal(report.status,'insufficient-evidence');assert.equal(report.published,false);assert.equal(report.tailIncrementalRows,null);
  }finally{h.probe.stop();Object.defineProperty(PeriodAccounting,'prepareRetirement',descriptor);}
  h.restored();
});

test('original preparation errors retain identity and cannot qualify publication',()=>{
  const h=fixture(),sentinel={original:true};h.probe.start();h.member.retiring=h.member.retirementPreparing=true;
  try{
    const work=h.create(h.after,()=>{throw sentinel;});assert.throws(()=>work.next(),error=>error===sentinel);
    h.member.retiring=h.member.retirementPreparing=false;
    const report=h.probe.stop();assert.equal(report.status,'insufficient-evidence');assert.equal(report.published,false);
  }finally{h.probe.stop();h.member.retiring=h.member.retirementPreparing=false;}
  h.restored();
});

for(const problem of ['basis','second-retirement','unsettled'])test(problem+' cannot qualify completed routing counts',()=>{
  const h=fixture();h.probe.start();
  try{
    h.run();if(problem==='basis')h.member.revision++;else if(problem==='second-retirement')h.run();else h.member.workNeeded=true;
    const report=h.probe.stop();assert.equal(report.status,'insufficient-evidence');assert.equal(report.tailFullBuilds,null);
    if(problem==='basis')assert.equal(report.basisSame,false);else if(problem==='second-retirement')assert.equal(report.retirementCalls,2);else assert.equal(report.settled,false);
  }finally{h.probe.stop();}
  h.restored();
});

test('bounded records and missing runtime remain explicit unknown outcomes',()=>{
  const h=fixture();h.probe.start();
  try{
    const large={...h.after,quota:Array.from({length:2050},()=>h.after.quota[0])},work=h.create(large);work.return(undefined as any);
    const report=h.probe.stop();assert.equal(report.omitted,2);assert.equal(report.status,'insufficient-evidence');assert.equal(report.rows.length,0);
  }finally{h.probe.stop();}
  h.restored();
  const absent=new Function('return ('+retirementRoutesScript()+')')()({members:new Set()});absent.start();assert.equal(absent.stop().status,'insufficient-evidence');
});

test('observer failures preserve the real result and restore every original factory',()=>{
  let references=0;
  class BrokenWeakRef extends WeakRef<object>{constructor(value:object){super(value);if(++references>1)throw new Error('observer unavailable');}}
  const baseline=fixture(false),expected=baseline.run(),h=fixture(true,BrokenWeakRef as any);h.probe.start();
  try{
    const actual=h.run();assert.deepEqual(h.progress,baseline.progress);assert.equal(actual.bytes,expected.bytes);
    for(const source of ['private source 0','private source 1'])assert.deepEqual(actual.quotaSummary(source,'w',{from:1001,to:32000}),expected.quotaSummary(source,'w',{from:1001,to:32000}));
    const report=h.probe.stop();assert.ok(report.invalid>0);assert.equal(report.status,'insufficient-evidence');
  }finally{h.probe.stop();}
  h.restored();
});

test('unrelated accounting factories are counted separately from the captured prior',()=>{
  const h=fixture(),foreign=structuredClone(h.before);h.probe.start();
  try{
    drain(PeriodAccounting.prepare(foreign,null));h.run();const report=h.probe.stop();
    assert.equal(report.status,'complete');assert.equal(report.unmatched,4);assert.equal(report.fallbackCalls,1);assert.equal(report.tailFullBuilds,1);
  }finally{h.probe.stop();}
  h.restored();
});

test('unchanged observations prepared for changed work are not labelled a full tail rebuild',()=>{
  const baseline=fixture(false,WeakRef,true),expected=baseline.run(),h=fixture(true,WeakRef,true);h.probe.start();
  try{
    const actual=h.run();assert.equal(actual.bytes,expected.bytes);assert.deepEqual(h.progress,baseline.progress);
    const report=h.probe.stop();assert.equal(report.status,'complete');assert.equal(report.tailFullBuilds,1);assert.equal(report.nonTailBuildCalls,1);assert.equal(report.quotaPrepareCalls,2);
    assert.equal(report.rows[2].tail,false);assert.equal(report.rows[2].builds,1);assert.equal(report.rows[2].reuses,1);
  }finally{h.probe.stop();}
  h.restored();
});

for(const mutation of ['entry','duplicate','map'])test('publication '+mutation+' mismatch cannot qualify routing',()=>{
  const h=fixture();h.probe.start();
  try{
    h.run();const entry=h.member.tapes.get('quota')!;
    if(mutation==='entry')h.member.tapes.set('quota',{...entry,tape:h.before});
    else if(mutation==='duplicate')entry.tape.quota.push(entry.tape.quota[0]);
    else (entry.accounting as any).quota.delete('private source 0\nw');
    const report=h.probe.stop();assert.equal(report.status,'insufficient-evidence');assert.equal(report.published,false);assert.equal(report.tailFullBuilds,null);
  }finally{h.probe.stop();}
  h.restored();
});

test('an absent basis cannot match itself at both capture boundaries',()=>{
  const h=fixture();delete (h.member.scopeKeys as any).quota;h.probe.start();
  try{h.run();const report=h.probe.stop();assert.equal(report.status,'insufficient-evidence');assert.ok(report.invalid>0);}
  finally{h.probe.stop();}h.restored();
});

test('actual incremental retirement can qualify with zero full-tail builds',()=>{
  const h=fixture(true,WeakRef,false,true);h.probe.start();
  try{
    h.run();const report=h.probe.stop();assert.equal(report.status,'complete');assert.equal(report.tailIncrementalRows,2);
    assert.equal(report.tailFullBuilds,0);assert.equal(report.quotaPrepareCalls,0);assert.equal(report.fallbackCalls,1);
  }finally{h.probe.stop();}h.restored();
});

test('observer collection follows the original reading once and preserves its value',async()=>{
  const value={original:true},events:string[]=[],files:unknown[]=[];
  const cdp={evaluate:async(expression:string,signal:AbortSignal)=>{events.push('collect');assert.match(expression,/PreparationProbe.*stop/);assert.equal(signal.aborted,false);return {status:'complete'};}};
  const result=await observePreparations(async()=>{events.push('read');return value;},cdp as any,{save:(_name,file)=>{events.push('save');files.push(file);}},'idle-retirement-routes');
  assert.strictEqual(result.reading,value);assert.equal(result.status,'complete');assert.deepEqual(events,['read','collect','save']);assert.deepEqual(files,[{status:'complete'}]);
});

for(const brokenWriter of [false,true])test('interrupted readings keep their original error with writer failure '+brokenWriter,async()=>{
  const original={original:true};let commands=0;
  const cdp={evaluate:async()=>{commands++;assert.fail('no observer command after interruption');}};
  const evidence={save:(_name:string,file:any)=>{assert.equal(file.status,'insufficient-evidence');if(brokenWriter)throw new Error('writer unavailable');}};
  await assert.rejects(observePreparations(async()=>{throw original;},cdp as any,evidence,'idle-retirement-routes'),error=>error===original);
  assert.equal(commands,0);
});

for(const failure of ['read','writer','cancel'])test('observer '+failure+' leaves a completed original reading intact and insufficient',async()=>{
  const value={original:true},controller=new AbortController();let commands=0;
  const cdp={evaluate:async()=>{commands++;if(failure==='read')throw new Error('observer unavailable');return {status:'complete'};}};
  const result=await observePreparations(async()=>{if(failure==='cancel')controller.abort();return value;},cdp as any,{save(){if(failure==='writer')throw new Error('writer unavailable');}},'idle-retirement-routes',controller.signal);
  assert.strictEqual(result.reading,value);assert.equal(result.status,undefined);assert.equal(commands,failure==='cancel'?0:1);
});
