import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import type {Hub} from '../api.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';
import {Events} from '../events.js';
import {HistoryTiles} from '../history.js';
import {PeriodReader} from '../periodRead.js';
import {expandPeriod,type PeriodWireReply} from '../domain/periodWire.js';
import {decodeSamples,mergeTape,type PeriodTape} from '../domain/periodTape.js';
import {mergeWork,workedSessions,type WorkTrace} from '../domain/periodWork.js';
import {PeriodAccounting} from '../domain/periodAccounting.js';

const M=60_000,H=60*M,NOW=1_800_000_000_000,range={from:NOW-H,to:NOW};
type Producer='measurement'|'work'|'private';
type Snapshot={tape:PeriodTape;work:WorkTrace};

function fixture(privateWork=false){
  const store=new Store(':memory:',NOW-3*H),directory=new Directory(store.db);
  const user=directory.createUser('fixture@example.com','Fixture','unused',NOW-3*H),board=directory.boards(user.id)[0].id;
  const source=store.source('codex','a'.repeat(24),NOW-3*H);store.hold(source,user.id,NOW-3*H);
  const device=directory.saveDevice({userId:user.id,machine:{id:'machine-0123456789',name:'Laptop',os:'linux',arch:'x86_64'},agent:'quotum/0.6.0',tokenId:null},NOW-3*H).id;
  const hub:Hub={store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null};
  const events=new Events(hub,undefined,{now:()=>NOW,after:()=>()=>{}},null),reader=new PeriodReader(hub,new HistoryTiles(store),events);
  const record=(at:number,used:number)=>store.record(source,{observedAt:at,staleAfterMs:H,plan:'',resets:null,windows:[{id:'session',kind:'session',label:null,minutes:300,used,remaining:100-used,resetAt:NOW+H}]});
  const credit=(at:number)=>store.creditWork(device,at,at+M,[{client:privateWork?'opencode':'codex',source:privateWork?null:source,origin:'terminal',startedAt:NOW-3*H,project:'Project',folder:'folder',identity:{kind:'stable',sessionId:'session'}}]);
  const touch=(producer:Producer,at=NOW-H,relevant=false)=>{
    if(producer==='private')reader.touchClient(relevant?user.id:'another-owner',at);
    else reader.touch(relevant?source:'unshown-source',at,['quota'],producer==='work');
  };
  const change=(producer:Producer,at:number,used:number)=>{if(producer==='measurement')record(at,used);else credit(at);touch(producer,at,true);};
  const read=(before?:Snapshot&{work:WorkTrace&{cursor:string}})=>{
    const reply=expandPeriod(JSON.parse(reader.read(board,user.id,{version:1,selection:{mode:'live',periodMs:H},evaluatedAt:NOW,
      quota:{cell:String(M),from:String(range.from),to:String(range.to),cells:'skip',...(before?{evidence:before.tape.cursor}:{})},sessions:before?{cursor:before.work.cursor}:{}})) as PeriodWireReply);
    assert.equal(reply.quota?.state,'complete');
    if(reply.quota?.state!=='complete'||!reply.quota.value.tape||!reply.sessions||reply.sessions.state==='error')throw new Error('incomplete period');
    const tape=reply.quota.value.tape;
    tape.quota=tape.quota.map(row=>({...row,samples:row.samplesEncoding==='delta'?decodeSamples(row.samples):row.samples,samplesEncoding:undefined}));
    return {tape,work:reply.sessions.value,sessions:reply.sessions};
  };
  const merge=(before:Snapshot,answer:ReturnType<typeof read>)=>({tape:mergeTape(before.tape,answer.tape),work:answer.sessions.state==='delta'?mergeWork(before.work,answer.sessions.value):answer.work});
  const summary=(value:Snapshot)=>({quota:new PeriodAccounting(value.tape,value.work).quotaSummary(source,'session',range),work:workedSessions(value.work,range,NOW).map(row=>({source:row.source,client:row.clientId,ms:row.workedMs}))});
  record(NOW-30*M,10);credit(NOW-30*M);
  return {reader,touch,change,read,merge,summary,close:()=>{events.close();store.close();}};
}

const orders:[Producer,Producer][]=[['work','measurement'],['private','measurement'],['measurement','work'],['measurement','private']];
for(const [older,newer] of orders)test(`overflow in ${older} cannot restore a cursor after ${newer} discarded its proof`,t=>{
  t.mock.method(Date,'now',()=>NOW);const h=fixture(older==='private'||newer==='private');t.after(h.close);
  for(let i=0;i<2048;i++)h.touch(older);
  const before=h.read();
  h.change(newer,NOW-20*M,90);
  for(let i=0;i<2048;i++)h.touch(newer);
  h.touch(older);
  const answer=h.read(before),fresh=h.read(),merged=h.merge(before,answer);
  assert.deepEqual(h.summary(merged),h.summary(fresh),'a lost journal entry must not disappear from exact accounting');
  assert.equal(answer.tape.replaceTo,undefined,'an expired tape cursor requires a complete bounded baseline');
  assert.equal(answer.sessions.state,'complete','the same admission frontier protects the work cursor');
  if(newer==='measurement'){assert.equal(h.summary(merged).quota?.remainingAtEnd,10);assert.equal(h.summary(merged).quota?.consumed,80);}
  else assert.equal(h.summary(merged).work[0].ms,2*M);

  h.change(newer,NOW-10*M,95);
  const delta=h.read(answer),complete=h.read();assert.equal(delta.sessions.state,'delta');assert.notEqual(delta.tape.replaceTo,undefined,'a newly issued cursor remains usable');
  assert.deepEqual(h.summary(h.merge(answer,delta)),h.summary(complete));
});

for(const producer of ['measurement','work','private'] as const)test(`a ${producer} cursor at the retained frontier still admits all later changes`,t=>{
  t.mock.method(Date,'now',()=>NOW);const h=fixture(producer==='private');t.after(h.close);
  h.touch(producer);const before=h.read();
  for(let i=0;i<2047;i++)h.touch(producer);
  h.change(producer,NOW-20*M,90);
  const delta=h.read(before);assert.equal(delta.sessions.state,'delta');assert.notEqual(delta.tape.replaceTo,undefined);
  assert.deepEqual(h.summary(h.merge(before,delta)),h.summary(h.read()));
});
