import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {buildApp} from '../api.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';
import {newSecret} from '../domain/auth.js';
import {HistoryLimit} from '../history.js';
import {packWork,packWorkPrepared,workedSessions,type WorkTrace} from '../domain/periodWork.js';
import {expandPeriod,type PeriodWireReply} from '../domain/periodWire.js';
import {prepareFixedTape,prepareFixedWork} from '../periodFixed.js';

const H=3_600_000,NOW=1_800_000_000_000,MONTH=30*24*H;
const trace=(count:number):WorkTrace=>({anchor:NOW-MONTH,cut:NOW,knownFrom:NOW-MONTH,
  refs:Array.from({length:count},(_,id)=>({ref:String(id),source:'codex:source',clientId:'codex',device:{id:'device',name:'Laptop'},origin:'terminal',project:'Project',folder:null,startedAt:NOW-MONTH})),
  spans:Array.from({length:count},(_,id)=>[id,0,MONTH]),
});

test('hour expansion is admitted before its first yield and cancellation releases the entire preparation',()=>{
  let held=0;const limit=32*1024*1024;
  const reserve=(bytes:number)=>{if(held+bytes>limit)throw new HistoryLimit();held+=bytes;};
  const release=(bytes:number)=>{assert.ok(bytes>=0&&bytes<=held);held-=bytes;};
  const oversized=packWorkPrepared(trace(2000),reserve,release);
  assert.throws(()=>oversized.next(),HistoryLimit,'a rejected month cannot allocate even its first expanded hour');
  assert.equal(held,0);
  const input=trace(2),cancelled=packWorkPrepared(input,reserve,release);
  assert.equal(cancelled.next().done,false);assert.ok(held>MONTH/H*2*3*8);
  cancelled.return(input);assert.equal(held,0,'cancellation releases packing buffers and dictionary scratch');
  const accepted=packWorkPrepared(input,reserve,release);let result=accepted.next();
  const peak=held;
  while(!result.done)result=accepted.next();
  assert.ok(held>0&&held<peak,'completed packing retains only the output, not its dictionary and growth scratch');
  assert.deepEqual(workedSessions(result.value,{from:NOW-H,to:NOW},NOW).map(row=>row.workedMs),[H,H]);
  release(held);assert.equal(held,0);
});

test('preallocated work blocks preserve same-hour gaps, overlaps, boundaries and reference transitions',()=>{
  const input={...trace(3),anchor:NOW-4*H,spans:[
    [0,0,10],[0,20,30],[0,25,40],[0,H-5,H+5],[0,H+10,H+20],[0,2*H,2*H+5],
    [1,0,H],[1,H,2*H],[2,0,0],[2,H-1,H+1],[0,3*H,3*H+5],
  ] as WorkTrace['spans']};
  const packed=packWork(input),blocks=packed.packed!.blocks;
  assert.equal(blocks.length,24);assert.ok(blocks.every(Number.isFinite));
  assert.deepEqual(Array.from({length:8},(_,i)=>[blocks[i*3],blocks[i*3+1]-input.anchor/H]),[[0,0],[0,1],[0,2],[1,0],[1,1],[2,0],[2,1],[0,3]]);
  assert.deepEqual(workedSessions(packed,{from:input.anchor,to:NOW},NOW).map(row=>row.workedMs),[60,2*H,2]);
});

test('repeated fragmented hours retain one pattern instead of reserving one dictionary entry per raw span',()=>{
  const input=trace(1),hours=200,perHour=100;input.spans=[];
  for(let hour=0;hour<hours;hour++)for(let part=0;part<perHour;part++){const at=hour*H+part*30_000;input.spans.push([0,at,at+1000]);}
  let held=0,peak=0;const limit=256*1024;
  const packed=packWork(input,bytes=>{if(held+bytes>limit)throw new HistoryLimit();held+=bytes;peak=Math.max(peak,held);},bytes=>{assert.ok(bytes>=0&&bytes<=held);held-=bytes;});
  assert.equal(packed.packed!.blocks.length,hours*3);assert.equal(packed.packed!.patterns.length,1);
  assert.equal(workedSessions(packed,{from:input.anchor,to:input.anchor+hours*H},NOW)[0].workedMs,hours*perHour*1000);
  assert.ok(held>0&&held<peak&&peak<=limit,'scratch is bounded and released between repeated patterns');
});

test('fixed quota and work preparations include long raw spans in the remaining shared capacity',()=>{
  const input=trace(100),range={from:NOW-MONTH,to:NOW},occupied=31*1024*1024,limit=32*1024*1024;
  let held=occupied;
  const reserve=(bytes:number)=>{if(held+bytes>limit)throw new HistoryLimit();held+=bytes;};
  const release=(bytes:number)=>{held-=bytes;};
  const work=prepareFixedWork(input,range,H,NOW,reserve,release);
  assert.throws(()=>work.next(),HistoryLimit,'fewer than 128 raw spans still expand into a month of hours');
  assert.equal(held,occupied);
  const tape=prepareFixedTape({from:range.from,cut:range.to,cursor:'',replaceFrom:range.from,quota:[],money:[]},input,range,H,reserve,release);
  assert.throws(()=>tape.next(),HistoryLimit,'quota accounting shares the same work expansion ceiling');
  assert.equal(held,occupied);
});

test('oversized retained producer work fails within the shared budget and smaller live and fixed reads still complete',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const from=NOW-MONTH,store=new Store(':memory:',from-H),directory=new Directory(store.db);
  const user=directory.createUser('budget@example.test','Budget','unused',from-H),board=directory.boards(user.id)[0].id;
  const cookie=newSecret('qt_s');directory.createSession(cookie,user.id,from-H,32*24*H);
  const secret=newSecret('qt_m');directory.createToken(secret,'token',user.id,'budget',from-H);
  const source=store.source('codex','a'.repeat(24),from-H);store.hold(source,user.id,from-H);
  const ingest=new Ingest(store,directory,new Duty(),new Cadence()),credential=ingest.authenticate(`Bearer ${secret}`);
  assert.ok(credential&&credential!=='revoked');
  const app=await buildApp({store,directory,ingest,resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null});
  t.after(async()=>{await app.close();store.close();});
  const sessions=Array.from({length:200},(_,id)=>({provider:'codex',account:'a'.repeat(24),sessionId:id.toString(16).padStart(32,'0'),origin:'terminal' as const,startedAt:new Date(from).toISOString(),working:true,project:'Project'}));
  const machine=(id:number)=>({id:`machine-budget-${String(id).padStart(12,'0')}`,name:`Laptop ${id}`,os:'linux',arch:'x86_64'});
  for(const at of [from,from+120_000,from+240_000])for(let id=0;id<10;id++){
    assert.equal(ingest.sessions(credential,{version:1,agent:'quotum/0.7.0',machine:machine(id),sentAt:new Date(at).toISOString(),sessions},at).accepted,200);
  }
  const rows=store.agentWork(from,NOW);assert.equal(rows.length,2000);assert.ok(rows.every(row=>row.from===from&&row.to===from+240_000));
  // Repeated adjacent reports extend these same rows; scale the retained duration
  // through that ledger operation without replaying a month of 2000 producers.
  const keys=sessions.map(session=>({source,client:'codex',origin:session.origin,startedAt:from,project:'Project',folder:'',identity:{kind:'stable' as const,sessionId:session.sessionId}}));
  for(let id=0;id<10;id++)store.creditWork(directory.deviceByMachine(user.id,machine(id).id)!.id,from+240_000,NOW,keys);
  for(const periodMs of [MONTH,H])for(const mode of ['live','range'] as const){
    const response=await app.inject({method:'POST',url:`/api/boards/${board}/period`,headers:{origin:'http://localhost',cookie:`quotum_session=${cookie}`},payload:{version:1,selection:mode==='live'?{mode,periodMs}:{mode,from:NOW-periodMs,to:NOW},evaluatedAt:NOW,values:[source],sessions:{}}});
    assert.equal(response.statusCode,200,response.body);const reply=expandPeriod(response.json<PeriodWireReply>());
    assert.equal(reply.values?.state,'complete','work capacity cannot discard sibling card values');
    if(periodMs===MONTH){assert.deepEqual(reply.sessions,{state:'error',error:'history_limit'});continue;}
    assert.equal(reply.sessions?.state,'complete');if(reply.sessions?.state!=='complete')throw new Error('incomplete smaller read');
    const retained=workedSessions(reply.sessions.value,reply.basis.range,NOW);
    assert.equal(retained.length,2000);assert.ok(retained.every(row=>row.workedMs===H));
  }
});
