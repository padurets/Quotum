import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {PeriodPreparation} from '../periodPrepare.js';
import {PeriodReader} from '../periodRead.js';
import {ReadError} from '../historyRead.js';
import {HistoryTiles} from '../history.js';
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
import {PeriodAccounting} from '../domain/periodAccounting.js';
import {defaultFilters,workFilter} from '../domain/dataFilters.js';
import type {PeriodReply} from '../domain/periodRead.js';

const M=60_000,H=60*M,NOW=1_800_000_000_000;

test('queued detail input charges the original duplicate-rich body and releases it on cancellation',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=fixture();t.after(h.close);
  const filter=workFilter(defaultFilters());filter.projects={mode:'include',values:['A']};
  const initial=JSON.parse(h.reader.read(h.board,h.user.id,{...h.request,sessions:{},workFilter:filter})) as PeriodReply;
  if(initial.sessions?.state!=='complete')throw new Error('sessions');
  const queue=(h.reader as unknown as {preparation:PeriodPreparation}).preparation,block=new AbortController();
  const busy=queue.run(function*(){for(;;)yield;},block.signal),busyRejected=assert.rejects(busy);
  const charges:number[]=[];const original=h.reader.detailsAsync.bind(h.reader);
  // Observe the actual shared reservation, rather than estimating the JSON alone.
  const history=(h.reader as unknown as {history:HistoryTiles}).history;
  for(const count of [1,16000]){
    const abort=new AbortController();
    const details=original(h.board,h.user.id,{version:1,selection:h.request.selection,evaluatedAt:NOW,cursor:initial.sessions.value.cursor,refs:[],workFilter:{...filter,projects:{mode:'include',values:Array(count).fill('A')}}},abort.signal);
    const rejected=assert.rejects(details);charges.push((history as unknown as {reserved:number}).reserved);
    abort.abort();await rejected;assert.equal((history as unknown as {reserved:number}).reserved,0);
  }
  block.abort();await busyRejected;h.released();
  assert.ok(charges[1]>charges[0]+500000,JSON.stringify(charges));
  assert.equal((JSON.parse(await h.read()) as PeriodReply).quota?.state,'complete');h.released();
});

test('waiting period bodies share the finite preparation budget and return capacity after cancellation',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=fixture();t.after(h.close);
  const queue=(h.reader as unknown as {preparation:PeriodPreparation}).preparation,history=(h.reader as unknown as {history:HistoryTiles}).history,block=new AbortController();
  const busy=queue.run(function*(){for(;;)yield;},block.signal),busyRejected=assert.rejects(busy);
  const filters=workFilter(defaultFilters());filters.projects={mode:'include',values:Array.from({length:876},(_,i)=>`${i}`.padStart(83,'p'))};
  const held:{abort:AbortController;done:Promise<void>}[]=[];
  const add=()=>{const abort=new AbortController(),read=h.reader.readAsync(h.board,h.user.id,{...h.request,sessions:{},workFilter:structuredClone(filters)},abort.signal);held.push({abort,done:assert.rejects(read)});};
  add();const size=(history as unknown as {reserved:number}).reserved,capacity=Math.floor(32*1024*1024/size);assert.ok(capacity>1&&capacity<100);
  for(let i=1;i<capacity;i++)add();assert.equal((history as unknown as {reserved:number}).reserved,capacity*size);
  await assert.rejects(h.reader.readAsync(h.board,h.user.id,{...h.request,sessions:{},workFilter:filters}),error=>error instanceof ReadError&&error.statusCode===413);
  held[0].abort.abort();await held[0].done;add();assert.equal((history as unknown as {reserved:number}).reserved,capacity*size);
  for(const item of held)item.abort.abort();await Promise.all(held.map(item=>item.done));assert.equal((history as unknown as {reserved:number}).reserved,0);
  block.abort();await busyRejected;assert.equal((JSON.parse(await h.read()) as PeriodReply).quota?.state,'complete');h.released();
});

function fixture(){
  const store=new Store(':memory:',NOW-3*H),directory=new Directory(store.db);
  const user=directory.createUser('prepare@example.test','Prepare','unused',NOW-3*H),board=directory.boards(user.id)[0].id;
  const source=store.source('codex','a'.repeat(24),NOW-3*H);store.hold(source,user.id,NOW-3*H);
  const hub:Hub={store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null};
  const events=new Events(hub,undefined,{now:()=>NOW,after:()=>()=>{}},null),history=new HistoryTiles(store),reader=new PeriodReader(hub,history,events);
  const record=(used:number,at=NOW-90*M+(used===10?0:1),sourceId=source)=>store.record(sourceId,{observedAt:at,staleAfterMs:H,plan:'',resets:null,windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used,remaining:100-used,resetAt:NOW+H}]});
  record(10);
  const request={version:1,selection:{mode:'range',from:NOW-2*H,to:NOW-H},evaluatedAt:NOW,quota:{cell:String(M),from:String(NOW-2*H),to:String(NOW-H),cells:'skip'}};
  const read=(signal?:AbortSignal)=>reader.readAsync(board,user.id,request,signal);
  const released=()=>{const reservation=history.reservation();reservation.add(32*1024*1024);reservation.close();};
  return {store,directory,hub,user,board,source,request,reader,read,record,released,close:()=>{events.close();store.close();}};
}

test('active and queued cancellation close preparation and remove listeners without overtaking',async()=>{
  const queue=new PeriodPreparation(),active=new AbortController(),queued=new AbortController();
  let started!:()=>void,closed=0,queuedStarted=false;
  const began=new Promise<void>(resolve=>{started=resolve;});
  const first=queue.run(function*(){try{started();for(;;)yield;}finally{closed++;}},active.signal);
  const firstRejected=assert.rejects(first);
  await began;
  const second=queue.run(function*(){queuedStarted=true;return 2;},queued.signal),secondRejected=assert.rejects(second);
  queued.abort();await secondRejected;
  assert.equal(queuedStarted,false);assert.equal(getEventListeners(queued.signal,'abort').length,0);
  let thirdStarted=false;
  const third=queue.run(function*(){thirdStarted=true;return 3;});
  await nextTurn();assert.equal(thirdStarted,false);
  active.abort();await firstRejected;
  assert.equal(await third,3);assert.equal(closed,1);assert.equal(getEventListeners(active.signal,'abort').length,0);
});

test('a presence snapshot that exceeds capacity releases its partial reservation and preserves value siblings',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=fixture();t.after(h.close);
  const snapshot=t.mock.method(h.hub.ingest.live,'presenceSnapshot',(reserve:(bytes:number)=>void)=>{reserve(1024);reserve(32*1024*1024);throw new Error('unreachable');});
  const reply=JSON.parse(await h.reader.readAsync(h.board,h.user.id,{...h.request,sessions:{},values:[h.source]})) as PeriodReply;
  assert.deepEqual(reply.quota,{state:'error',error:'history_limit'});
  assert.deepEqual(reply.sessions,{state:'error',error:'history_limit'});
  assert.equal(reply.values?.state,'complete');h.released();
  snapshot.mock.restore();assert.equal((JSON.parse(await h.read()) as PeriodReply).quota?.state,'complete');h.released();
});

test('presence snapshots keep their captured operational state across reports',t=>{
  const h=fixture();t.after(h.close);
  const device=h.directory.saveDevice({userId:h.user.id,machine:{id:'snapshot-device-0123456789',name:'Laptop',os:'linux',arch:'x86_64'},agent:'quotum/0.7.0',tokenId:null},NOW).id;
  const session={clientId:'codex',source:h.source,sessionId:'stable',device:{id:device,name:'Laptop'},origin:'terminal' as const,project:'Project',folder:null,startedAt:NOW-H,sentStartedAt:NOW-H,lastWorkedAt:NOW,working:true};
  h.hub.ingest.live.report(device,h.user.id,[session],NOW);
  let held=0;const snapshot=h.hub.ingest.live.presenceSnapshot(bytes=>{held+=bytes;},(_device,owner)=>owner===h.user.id);
  h.hub.ingest.live.report(device,h.user.id,[{...session,working:false}],NOW+1);
  assert.ok(held>0);
  const args=[device,'codex',h.source,'stable','terminal','Project',null,NOW] as const;
  assert.equal(snapshot(...args)?.working,true);
  assert.equal(h.hub.ingest.live.presence(...args)?.working,false);
});

test('details keep their work cursor through unrelated resource updates while queued',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=fixture();t.after(h.close);
  const initial=JSON.parse(h.reader.read(h.board,h.user.id,{...h.request,sessions:{}})) as PeriodReply;
  if(initial.sessions?.state!=='complete')throw new Error('sessions');
  let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
  const original=PeriodAccounting.prepare;
  t.mock.method(PeriodAccounting,'prepare',function*(...args:Parameters<typeof original>){
    started();const until=performance.now()+12;do{yield;}while(performance.now()<until);return yield*original(...args);
  });
  const active=h.read();await began;
  const details=h.reader.detailsAsync(h.board,h.user.id,{version:1,selection:h.request.selection,evaluatedAt:NOW,cursor:initial.sessions.value.cursor,refs:[]});
  h.reader.touch('unrelated-source',NOW,['quota']);
  await active;const response=JSON.parse(await details);assert.equal(response.sessions.state,'complete');h.released();
});

test('a financial grant revoked between sections discards the captured preparation',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=fixture();t.after(h.close);
  const board=h.directory.createBoard('Shared',h.user.id,NOW-3*H).id;
  h.store.share(board,h.source,h.user.id,NOW-3*H);
  const revision=h.store.sources(board)[0].budget!.revision;
  const grant=h.store.setBudget(board,h.source,h.user.id,true,revision,NOW-3*H);
  const original=PeriodAccounting.prepare;let attempts=0;
  t.mock.method(PeriodAccounting,'prepare',function*(...args:Parameters<typeof original>){
    if(++attempts===1)setImmediate(()=>h.store.setBudget(board,h.source,h.user.id,false,grant.revision,NOW));
    const until=performance.now()+12;do{yield;}while(performance.now()<until);return yield*original(...args);
  });
  const read=h.reader.readAsync(board,h.user.id,{...h.request,funds:{...h.request.quota,unit:'credits:codex',meters:JSON.stringify([[h.source,'balance:credits']])}});
  await assert.rejects(read,error=>error instanceof ReadError&&error.statusCode===404);
  assert.equal(attempts,2);h.released();
});

for(const change of ['relevant','unrelated','after-cut','other-scope','currency','layout','churn','floor','cancel'] as const)test(`cooperative period preparation handles ${change} between slices`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=fixture();t.after(h.close);
  let attempts=0;const abort=new AbortController(),original=PeriodAccounting.prepare;
  t.mock.method(PeriodAccounting,'prepare',function*(...args:Parameters<typeof original>){
    attempts++;
    if(attempts===1||change==='churn')setImmediate(()=>{
      if(change==='relevant'){h.record(40);h.reader.touch(h.source,NOW-90*M,['quota']);}
      if(change==='unrelated'){const other=h.store.source('codex','b'.repeat(24),NOW-3*H);h.record(40,NOW-90*M,other);h.reader.touch(other,NOW-90*M,['quota']);}
      if(change==='after-cut'){h.record(40,NOW-M);h.reader.touch(h.source,NOW-M,['quota']);}
      if(change==='other-scope')h.reader.touch(h.source,NOW-90*M,['budget']);
      if(change==='currency')h.store.currencies.select(h.user.id,'EUR');
      if(change==='layout'){const view=h.directory.view(h.board);h.directory.saveView(h.board,{...view,hidden:['source:'+h.source]},h.user.id,NOW);}
      if(change==='churn')h.reader.touch(h.source,NOW-90*M,['quota']);
      if(change==='floor')for(let i=0;i<2049;i++)h.reader.touch('other-source',0,['quota']);
      if(change==='cancel')abort.abort();
    });
    // Hold one production slice open; the mutation runs only after it yields.
    const until=performance.now()+12;do{yield;}while(performance.now()<until);
    return yield*original(...args);
  });
  if(change==='cancel')await assert.rejects(h.read(abort.signal));
  else if(change==='churn')await assert.rejects(h.read(),error=>error instanceof ReadError&&error.statusCode===503&&error.code==='unavailable');
  else{
    const reply=JSON.parse(await h.read()) as PeriodReply,part=reply.quota;
    assert.equal(part?.state,'complete');if(part?.state!=='complete')throw new Error('quota');
    assert.equal(part.value.tape!.fixed!.quota[0].remainingAtEnd,change==='relevant'?60:90);
    assert.equal(reply.basis.revision,change==='relevant'?'1':change==='floor'?'2049':'0','a snapshot never acknowledges later irrelevant facts');
  }
  assert.equal(attempts,['relevant','currency','churn','floor'].includes(change)?2:1);
  h.released();
  if(change==='cancel')assert.equal(getEventListeners(abort.signal,'abort').length,0);
});
