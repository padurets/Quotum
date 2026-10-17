import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {Preparations,type Preparation} from '../../ui/lib/prepare.js';
import {HistoryPool} from '../../ui/lib/historyPool.js';
import {preparationOwnersScript} from '../preparationOwners.js';
import {safeEvidence} from '../evidence.js';

function fixture(observe=true) {
  const tasks:(()=>void)[]=[],pool=new HistoryPool();let now=0,gets=0,created=0,failObserverClock=false;
  let scheduler:Preparations|undefined;
  const probe=observe?runInNewContext('('+preparationOwnersScript()+')',{Map,Set,WeakMap,WeakSet,performance:{now:()=>{if(failObserverClock)throw Error('observer clock unavailable');return now;}}})(pool):null;
  const period={estimatedBytes:0,evictionCandidates:()=>[],preparationOwner:{},retiring:true,retirementPreparing:true};
  pool.register(period);
  class Reader {
    readonly estimatedBytes=0;
    readonly plotOwner={};readonly composeOwner={};
    constructor(readonly scope:'quota'|'budget'){pool.register(this);}
    evictionCandidates(){return [];}
    get preparations(){gets++;if(!scheduler){created++;scheduler=new Preparations({now:()=>++now,post:run=>tasks.push(run)});}return scheduler;}
  }
  const readers=[new Reader('quota'),new Reader('budget'),new Reader('budget')];
  const finish=()=>{for(let i=0;tasks.length;i++){assert.ok(i<10_000);tasks.shift()!();}};
  return {probe,readers,period,tasks,finish,counts:()=>({gets,created}),failClock:(value:boolean)=>{failObserverClock=value;},get scheduler(){return scheduler!;}};
}

test('owner observation leaves the reader getter lazy and returns its original scheduler',()=>{
  const h=fixture();assert.deepEqual(h.counts(),{gets:0,created:0});
  const first=h.readers[0].preparations;
  for(const reader of h.readers)assert.strictEqual(reader.preparations,first);
  assert.deepEqual(h.counts(),{gets:4,created:1});
  h.probe.start();const report=h.probe.stop();
  assert.equal(report.status,'complete');assert.equal(report.opening.schedulers,1);assert.equal(report.opening.readers,3);
  assert.equal(report.rows.length,0);assert.deepEqual(h.counts(),{gets:4,created:1},'snapshots do not read a preparation getter');
});

test('observing actual scheduler selections preserves cancellation, replacement, validity and publication',()=>{
  const run=(observe:boolean)=>{
    const h=fixture(observe),scheduler=h.readers[0].preparations,events:string[]=[];
    function* work(name:string):Preparation<string>{try{for(let i=0;i<40;i++){events.push(name);yield;}return name;}finally{events.push('release '+name);}}
    const submit=(owner:object,name:string,valid=true)=>scheduler.replace(owner,work(name),()=>{events.push('valid '+name);return valid;},value=>events.push('ready '+value));
    h.probe?.start();
    submit(h.period.preparationOwner,'old');h.tasks.shift()!();submit(h.period.preparationOwner,'new');
    submit(h.readers[0].plotOwner,'plot');submit(h.readers[1].composeOwner,'invalid',false);
    submit({},'unknown');h.finish();
    return {events,report:h.probe?.stop()};
  };
  const baseline=run(false),observed=run(true);assert.deepEqual(observed.events,baseline.events);
  const {report}=observed;assert.equal(report.status,'complete');
  assert.equal(report.opening.pending[0].jobs,0);assert.equal(report.closing.pending[0].jobs,0);
  const period=report.rows.filter((row:any)=>row.kind==='period');
  assert.ok(period.every((row:any)=>row.retiring&&row.preparing));
  assert.equal(new Set(period.map((row:any)=>row.owner)).size,1);
  assert.equal(new Set(period.map((row:any)=>row.job)).size,2,'a replacement retains its owner but receives a distinct job ID');
  assert.ok(period.some((row:any)=>row.returned&&row.sameJob&&row.requeued));
  const invalid=report.rows.find((row:any)=>row.kind==='history-compose');
  assert.equal(invalid.scope,'budget');assert.equal(invalid.sameJob,false);
  assert.equal(observed.events.includes('invalid'),false,'selecting a job does not imply advancing its generator');
  assert.ok(report.rows.some((row:any)=>row.kind==='unknown'));
  assert.equal(JSON.stringify(safeEvidence(report)),JSON.stringify(report),'only fixed classifications and numeric receipts leave the page');
});

test('an original generator exception keeps its identity and an ambiguous selected-job receipt',()=>{
  const h=fixture(),scheduler=h.readers[0].preparations,error=new Error('original generator failure');
  h.probe.start();
  scheduler.replace(h.period.preparationOwner,(function*(){throw error;})(),()=>true,()=>assert.fail('must not publish'));
  assert.throws(()=>h.tasks.shift()!(),value=>value===error);
  const report=h.probe.stop();assert.equal(report.rows.length,1);assert.equal(report.rows[0].returned,false);
  assert.equal(report.rows[0].sameJob,true);assert.equal(report.invalid,0);
});

test('the record cap preserves work and makes omitted owner selections explicit',()=>{
  const h=fixture(),scheduler=h.readers[0].preparations;let count=0,ready=false;
  h.probe.start();scheduler.replace({},(function*(){for(let i=0;i<33_000;i++){count++;yield;}return 1;})(),()=>true,()=>{ready=true;});h.finish();
  const report=h.probe.stop();assert.equal(count,33_000);assert.equal(ready,true);
  assert.equal(report.rows.length,2048);assert.ok(report.omitted>0);assert.equal(report.status,'insufficient-evidence');
  assert.equal(report.closing.pending[0].jobs,0);
});

test('late scheduler observation cannot qualify the earlier recording boundary',()=>{
  const h=fixture();h.probe.start();void h.readers[0].preparations;
  const report=h.probe.stop();assert.equal(report.opening.schedulers,0);assert.equal(report.closing.schedulers,1);
  assert.equal(report.status,'insufficient-evidence');
});

test('an opening pending job remains visible and cannot qualify an empty opening boundary',()=>{
  const h=fixture(),scheduler=h.readers[0].preparations;
  scheduler.replace({},(function*(){yield;return 42;})(),()=>true,()=>{});
  h.probe.start();h.finish();const report=h.probe.stop();
  assert.equal(report.opening.pending[0].jobs,1);assert.equal(report.closing.pending[0].jobs,0);
  assert.equal(report.rows.length,1);assert.equal(report.status,'insufficient-evidence');
});

test('observer clock failures neither advance nor suppress application work',()=>{
  const h=fixture(),scheduler=h.readers[0].preparations;let advances=0,published=0;
  h.probe.start();h.failClock(true);
  scheduler.replace(h.period.preparationOwner,(function*(){advances++;return 42;})(),()=>true,value=>{published=value;});
  h.finish();h.failClock(false);
  const report=h.probe.stop();assert.equal(advances,1);assert.equal(published,42);
  assert.equal(report.invalid,1);assert.equal(report.status,'insufficient-evidence');
});
