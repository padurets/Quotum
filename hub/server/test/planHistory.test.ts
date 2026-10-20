import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {HistoryTiles,HistoryLimit} from '../history.js';
import {readHistory} from '../historyRead.js';
import {PeriodReader} from '../periodRead.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {ResetFeed} from '../resets.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {Events,type Clock,type Frame} from '../events.js';
import {Projection} from '../projection.js';
import {expandPeriod} from '../domain/periodWire.js';
import {config} from '../config.js';
import type {Hub} from '../api.js';
import type {Chunk} from '../domain/history.js';
const M=60_000,H=60*M,D=24*H,T=Math.floor(1_800_000_000_000/H)*H,RET=config.retention.sampleDays*D;
function fixture(clock?:Clock){
  const store=new Store(':memory:',T-RET),directory=new Directory(store.db),user=directory.createUser('plan@example.test','Plan','unused',T-RET),personal=directory.boards(user.id)[0].id;
  const board=directory.createBoard('Shared',user.id,T-RET),source=store.source('codex','a'.repeat(24),T-RET);store.hold(source,user.id,T-RET);
  const hub:Hub={store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null};
  const events=new Events(hub,{...config.events,recheckMs:0},clock),tiles=new HistoryTiles(store),period=new PeriodReader(hub,tiles,events),projection=new Projection(hub);
  const record=(at:number,plan:string)=>store.record(source,{observedAt:at,plan,staleAfterMs:3*H,resets:null,windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used:25,remaining:75,resetAt:T+7*D}]});
  const query=(from:number,to:number)=>({cell:String(M),from:String(from),to:String(to)});
  const legacy=(id:string,from:number,to:number)=>JSON.parse(readHistory(hub,tiles,events,id,user.id,{...query(from,to),scope:'quota'})) as {chunks:Chunk[]};
  const composite=(id:string,from:number,to:number)=>{const reply=expandPeriod(JSON.parse(period.read(id,user.id,{version:1,selection:{mode:'range',from,to},evaluatedAt:Date.now(),quota:query(from,to)})));assert.equal(reply.quota?.state,'complete');return reply.quota?.state==='complete'?reply.quota.value.chunks:[];};
  const plans=(chunks:Chunk[])=>chunks.flatMap(c=>c.plans??[]);
  return {store,directory,user,personal,board,source,events,tiles,period,projection,record,legacy,composite,plans,close:()=>{events.close();store.close();}};
}
test('both transports expose recorded facts, authorized predecessors and historical timestamps',t=>{
  t.mock.method(Date,'now',()=>T+4*H);const h=fixture();t.after(h.close);
  h.record(T,'pro');h.record(T+M,'');h.record(T+2*M,'pro');h.record(T+H,'max');h.record(T+H+M,'pro');h.record(T+3*H,'max');
  const expected=[[T,'pro',null],[T+H,'max',{at:T,plan:'pro'}],[T+H+M,'pro',{at:T+H,plan:'max'}],[T+3*H,'max',{at:T+H+M,plan:'pro'}]];
  for(const chunks of [h.legacy(h.personal,T,T+4*H).chunks,h.composite(h.personal,T,T+4*H)])assert.deepEqual(h.plans(chunks).map(([,at,plan,previous])=>[at,plan,previous]),expected);
  assert.deepEqual(h.plans(h.legacy(h.personal,T+3*H,T+4*H).chunks)[0][3],{at:T+H+M,plan:'pro'},'context outside the requested chunk remains authorized');
  h.store.share(h.board.id,h.source,h.user.id,T+2*H);
  for(const chunks of [h.legacy(h.board.id,T,T+4*H).chunks,h.composite(h.board.id,T,T+4*H)])assert.deepEqual(h.plans(chunks).map(([,at,plan,previous])=>[at,plan,previous]),[[T+3*H,'max',null]]);
  h.directory.saveView(h.board.id,{...h.directory.view(h.board.id),hidden:['source:'+h.source]},h.user.id,T+4*H);
  assert.equal(h.plans(h.legacy(h.board.id,T,T+4*H).chunks).length,1);assert.equal(h.plans(h.composite(h.board.id,T,T+4*H)).length,1);
  h.directory.saveView(h.board.id,{...h.directory.view(h.board.id),hidden:[]},h.user.id,T+4*H);
  assert.equal(h.plans(h.legacy(h.board.id,T,T+4*H).chunks).length,1);
  h.store.unshare(h.board.id,h.source);
  assert.deepEqual(h.plans(h.legacy(h.board.id,T,T+4*H).chunks),[]);assert.deepEqual(h.plans(h.composite(h.board.id,T,T+4*H)),[]);
});
test('a watched board receives provenance expiry without a measurement or numeric forecast change',t=>{
  let now=T;const timers=new Map<object,{at:number;run:()=>void}>();t.mock.method(Date,'now',()=>now);
  const clock:Clock={now:()=>now,after:(ms,run)=>{const id={};timers.set(id,{at:now+ms,run});return ()=>{timers.delete(id);};}};
  const h=fixture(clock);t.after(h.close);h.events.attach();
  h.record(T-RET+H,'pro');h.record(T-RET+2*H,'max');h.record(T,'max');
  h.directory.createSession('plan-session',h.user.id,T,4*H);
  const frames:Frame[]=[];h.events.open({user:h.user.id,secret:'plan-session',board:h.personal,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});h.events.flush();frames.length=0;
  const before=h.projection.forecastPart(h.personal,h.source,T).value.weekly;
  assert.equal(before.planSince,T-RET+2*H);
  const end=T+2*H+1+config.events.smoothMs;
  for(let i=0;;i++){assert.ok(i<1000);const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);now=next[1].at;next[1].run();}
  now=end;
  const changes=frames.filter(frame=>frame.type==='forecast').map(frame=>JSON.parse(frame.data));
  assert.equal(changes.length,1);assert.deepEqual(changes[0].forecast.weekly,{...before,planSince:null});
});
test('hot closed tiles redact a retained predecessor at the exclusive deadline without pruning or touching',t=>{
  const at=T-RET;let now=T;t.mock.method(Date,'now',()=>now);
  for(const composite of [false,true]){
    const h=fixture();t.after(h.close);now=T;h.record(at,'private-old-plan');h.record(at+2*D,'max');
    const from=at+2*D,to=from+H,read=()=>composite?h.composite(h.personal,from,to):h.legacy(h.personal,from,to).chunks;
    assert.deepEqual(h.plans(read())[0][3],{at,plan:'private-old-plan'});
    now=T+1;const chunks=read();assert.equal(h.plans(chunks)[0][3],null);assert.ok(!JSON.stringify(chunks).includes('private-old-plan'));
    h.store.prune(T+1);assert.equal(h.store.planChanges(h.source,T)[0].at,at,'forecast baseline survives physical retention');
    assert.equal(h.plans(read())[0][3],null);
  }
});
test('plan bytes participate in bounded admission and malformed facts do not become guessed changes',t=>{
  t.mock.method(Date,'now',()=>T+3*H);const h=fixture();t.after(h.close);
  h.record(T,'pro');h.record(T+H,'max');
  const small=new HistoryTiles(h.store,300);
  assert.throws(()=>small.read(h.personal,M,T,T+2*H,T+3*H,h.store.authorizedSources(h.personal),undefined,'quota'),HistoryLimit);
  h.store.db.prepare("INSERT INTO events VALUES (?,?,?,?)").run(h.source,T+2*H,'plan','\u0000invalid');
  assert.equal(h.plans(h.legacy(h.personal,T,T+3*H).chunks).length,2);
});
test('forecast provenance uses the producer asOf and is independently redacted by board and retention',t=>{
  let now=T;t.mock.method(Date,'now',()=>now);const h=fixture();t.after(h.close);
  h.record(T-2*H,'pro');h.record(T-H,'max');h.record(T,'max');
  const global=h.projection.forecastPart(h.personal,h.source,T),forecast=global.value.weekly;
  assert.equal(forecast.planSince,T-H);assert.equal(global.changesAt,T-H+RET+1);
  h.store.share(h.board.id,h.source,h.user.id,T);
  assert.equal(h.projection.forecastPart(h.board.id,h.source,T).value.weekly.planSince,null);
  now=T-H+RET;assert.equal(h.projection.forecastPart(h.personal,h.source,now).value.weekly.planSince,T-H);
  now++;const redacted=h.projection.forecastPart(h.personal,h.source,now).value.weekly;
  assert.deepEqual(redacted,{...forecast,planSince:null});
});
