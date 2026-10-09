import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {buildApp,type Hub} from '../api.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';
import {newSecret} from '../domain/auth.js';
import type {PeriodReply,PeriodRequest} from '../domain/periodRead.js';
import {mergeWork,workedSessions} from '../domain/periodWork.js';
import {deepSeekMeasurement} from '../connectors/deepseek.js';
import {periodValues,nearbyPeriodValues} from '../periodValues.js';
import {periodValueAt,hasPeriodValue,withValueStates} from '../domain/periodValues.js';
import {HistoryLimit} from '../history.js';
import {sharedWork} from '../periodWork.js';

const M=60_000,H=60*M,now=1_800_000_000_000;
async function fixture() {
  const store=new Store(':memory:',now-3*H),directory=new Directory(store.db);
  const user=directory.createUser('a@example.com','A','unused',now-3*H),board=directory.boards(user.id)[0].id;
  const token=newSecret('qt_s');directory.createSession(token,user.id,now-3*H,24*H);
  const source=store.source('codex','a'.repeat(24),now-3*H);store.hold(source,user.id,now-3*H);
  const device=directory.saveDevice({userId:user.id,machine:{id:'machine-0123456789',name:'Laptop',os:'linux',arch:'x86_64'},agent:'quotum/0.6.0',tokenId:null},now-3*H).id;
  const hub:Hub={store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null};
  const app=await buildApp(hub);
  const read=(body:PeriodRequest,asBoard=board)=>app.inject({method:'POST',url:`/api/boards/${asBoard}/period`,headers:{origin:'http://localhost',cookie:`quotum_session=${token}`},payload:body});
  const credit=(from:number,to:number,id='stable')=>store.creditWork(device,from,to,[{source,origin:'terminal',startedAt:now-3*H,project:'Project',folder:'folder',identity:{kind:'stable',sessionId:id}}]);
  const details=(body:unknown)=>app.inject({method:'POST',url:`/api/boards/${board}/period/sessions`,headers:{origin:'http://localhost',cookie:`quotum_session=${token}`},payload:body as object});
  return {store,directory,hub,app,user,board,source,device,read,credit,details};
}

test('period values use the last batch strictly before the boundary and keep expired evidence',()=>{
  const store=new Store(':memory:',now-3*H);
  try {
    const directory=new Directory(store.db),user=directory.createUser('a@example.com','A','x',now).id;
    const id=store.source('codex','a'.repeat(24),now-3*H),sources=[{id,provider:'codex'}];
    const record=(at:number,used:number,extra=false)=>store.record(id,{observedAt:at,plan:'',resets:null,staleAfterMs:M,windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used,remaining:100-used,resetAt:now-M},...(extra?[{id:'session',kind:'session' as const,label:null,minutes:300,used:0,remaining:100,resetAt:now+H}]:[])]});
    record(now-3*M,90,true);record(now-2*M,30);record(now-M,5);
    const read=(to:number)=>periodValues(store,sources,user,to,()=>{})[0];
    assert.equal(read(now-4*M).windows.length,0);
    assert.deepEqual(read(now-M).windows.map(w=>[w.id,w.remaining,w.observedAt,w.stale]),[['weekly',70,now-2*M,true]]);
    assert.equal(read(now-2*M+1).windows[0].stale,false);
    assert.equal(read(now).windows[0].remaining,95);
    assert.equal(read(now).windows[0].stale,true);
    const retained=read(now-2*M+1),interval=retained.validFor!;
    assert.ok(interval.from<=now-2*M+1&&interval.to>now-2*M+1);
    for(const edge of [interval.from,interval.to-1])assert.deepEqual(read(edge).windows,retained.windows);
    assert.notDeepEqual(read(interval.to).windows,retained.windows,'a stale boundary or new observation ends reuse');
  }finally{store.close();}
});

test('nearby card states cross exclusive observations and deadlines without interpolating money',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const wallet=h.store.source('deepseek','b'.repeat(24),now-3*H);h.store.hold(wallet,h.user.id,now-3*H);
  for(const [at,used,amount] of [[now-3*M,90,'9007199254.740993'],[now-M,30,'9007199254.740991']] as const){
    h.store.record(h.source,{observedAt:at,plan:'',resets:null,staleAfterMs:M,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used,remaining:100-used,resetAt:now-M}]});
    h.store.record(wallet,deepSeekMeasurement({is_available:true,balance_infos:[{currency:'USD',total_balance:amount,granted_balance:'0',topped_up_balance:amount}]},at));
  }
  const sources=[{id:h.source,provider:'codex'},{id:wallet,provider:'deepseek'}];let held=0;
  const values=nearbyPeriodValues(h.store,sources,h.user.id,now-2*M,2*M,bytes=>{held+=bytes;},bytes=>{held-=bytes;assert.ok(held>=0);});assert.ok(held>0);
  for(const to of [now-4*M,now-3*M,now-3*M+1,now-2*M,now-2*M+1,now-M,now-M+1,now]){
    const fresh=periodValues(h.store,sources,h.user.id,to,()=>{});
    for(const [i,value] of values.entries()){
      assert.ok(hasPeriodValue(value,to),String(to));const {states:_states,...snapshot}=periodValueAt(value,to)!;assert.deepEqual(snapshot,fresh[i]);
    }
  }
});

test('sparse card states preserve optional fields and unchanged key context in either direction',()=>{
  const base={id:'s',provider:'deepseek',windows:[],meters:[],keys:[]};
  const values=Array.from({length:80},(_,i)=>({...base,validFor:{from:i*100,to:(i+1)*100},
    keys:[{id:'key',name:'A long retained key name',disabled:false,expiresAt:null,includeByok:false,at:i,staleAfterMs:100,presence:'observed' as const,missCount:0,periods:{day:null,week:null,month:null},byokUsage:{total:null,day:null,week:null,month:null}}],
    ...(i%3?{currencyUnavailable:true}:{}),
  }));
  const packed=withValueStates(values[40],values,()=>{});
  assert.ok(JSON.stringify(packed).length<JSON.stringify(values).length/2);
  const roundtrip=JSON.parse(JSON.stringify(packed));
  for(const to of [7999,0,4199,100,7899,1,4099]){
    const {states:_states,...value}=periodValueAt(roundtrip,to)!;
    assert.deepEqual(value,values[Math.floor(to/100)]);
  }
  assert.equal(periodValueAt(roundtrip,8000),undefined);
  assert.equal(periodValueAt(roundtrip,-1),undefined);
  assert.deepEqual(roundtrip,packed,'replay never mutates the shared sequence');
});

test('a cached cell range reads exact totals and boundaries without rebuilding cells',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  h.store.record(h.source,{observedAt:now-M,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:now+H}]});
  let work=0;const original=h.store.agentWork.bind(h.store);t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{work++;return original(...args);});
  const response=await h.read({version:1,selection:{mode:'range',from:now-H,to:now-1},evaluatedAt:now,quota:{cell:String(M),from:String(now-H),to:String(now),cells:'skip'}});
  assert.equal(response.statusCode,200,response.body);const part=response.json<PeriodReply>().quota!;if(part.state!=='complete')throw new Error('quota');
  assert.deepEqual(part.value.chunks,[]);assert.deepEqual(part.value.tape!.quota,[]);assert.equal(part.value.tape!.fixed!.quota[0].remainingAtEnd,83);assert.equal(work,1);
});

test('an oversized section does not discard siblings or retain its failed reservation',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const limited=t.mock.method(h.store,'agentWork',()=>{throw new HistoryLimit();});
  const request:PeriodRequest={version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,quota:{cell:String(M),from:String(now-H),to:String(now)},sessions:{},values:[h.source]};
  const reply=(await h.read(request)).json<PeriodReply>();
  assert.equal(reply.quota?.state,'error');assert.equal(reply.sessions?.state,'error');assert.equal(reply.values?.state,'complete');
  limited.mock.restore();const next=(await h.read(request)).json<PeriodReply>();
  assert.equal(next.quota?.state,'complete');assert.equal(next.sessions?.state,'complete');assert.equal(next.values?.state,'complete');
});

test('a chart-only past tile reads only its work, and extraction replacement releases its reservation',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  h.credit(now-2*H,now-H);h.credit(now-30*M,now-M,'later');
  const original=h.store.agentWork.bind(h.store),ranges:number[][]=[];
  t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{ranges.push(args.slice(0,2) as number[]);return original(...args);});
  const response=await h.read({version:1,selection:{mode:'range',from:now-2*H,to:now-M},evaluatedAt:now,quota:{cell:String(M),from:String(now-2*H),to:String(now-H),evidence:'skip'}});
  assert.equal(response.json<PeriodReply>().quota?.state,'complete');assert.deepEqual(ranges,[[now-2*H,now-H]]);
  let used=0,peak=0;
  const read=sharedWork(h.hub,h.store.shown(h.board,[]),null,bytes=>{used+=bytes;peak=Math.max(peak,used);},bytes=>{used-=bytes;assert.ok(used>=0);});
  const first=read(now-2*H,now-H),before=used;
  assert.equal(first.length,1);assert.ok(before>0);
  const second=read(now-2*H,now);
  assert.equal(second.length,2);assert.equal(peak,used,'replacement does not retain the former extraction');
  read(now-90*M,now-M);assert.equal(peak,used,'contained reads reuse the extraction');
  const final=used;t.mock.method(h.store,'agentWork',(_from:number,_to:number,_sources?:string[],reserve?:(bytes:number)=>void)=>{reserve?.(64);throw new HistoryLimit();});
  assert.throws(()=>read(now-3*H,now),HistoryLimit);assert.equal(used,0);assert.equal(peak,final);
});

test('money retains exact amounts, compressed anchors and accepted interruption',()=>{
  const store=new Store(':memory:',now-3*H);
  try {
    const directory=new Directory(store.db),user=directory.createUser('a@example.com','A','x',now).id;
    const id=store.source('deepseek','b'.repeat(24),now-3*H),sources=[{id,provider:'deepseek'}];
    const answer={is_available:true,balance_infos:[{currency:'USD',total_balance:'9007199254.740993',granted_balance:'0',topped_up_balance:'9007199254.740993'}]};
    store.record(id,deepSeekMeasurement(answer,now-3*M));store.record(id,deepSeekMeasurement(answer,now-M));
    const read=(to:number)=>periodValues(store,sources,user,to,()=>{})[0].meters.find(m=>m.id==='balance:USD')!;
    assert.equal(read(now-2*M).at,now-3*M,'no invented heartbeat inside a compressed span');
    assert.equal(read(now).amount,'9007199254740993');assert.equal(read(now).at,now-M);
    store.record(id,deepSeekMeasurement({is_available:true,balance_infos:[]},now));
    assert.equal(read(now).stale,true,'exclusive interruption ends availability without erasing the number');
    assert.equal(read(now).amount,'9007199254740993');
  }finally{store.close();}
});

test('ended sessions are clipped, composite reads share extraction, and deltas replace their tail',async t=>{
  t.mock.method(Date,'now',()=>now);
  const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  h.credit(now-2*H,now-H);
  const from=now-90*M,to=now-60*M;
  let reads=0;const original=h.store.agentWork.bind(h.store);t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{reads++;return original(...args);});
  const response=await h.read({version:1,selection:{mode:'range',from,to},evaluatedAt:now,quota:{cell:String(M),from:String(from),to:String(to)},sessions:{}});
  assert.equal(response.statusCode,200,response.body);const reply=response.json<PeriodReply>();
  assert.equal(reply.quota?.state,'complete');assert.equal(reply.sessions?.state,'complete');assert.equal(reads,1);
  if(reply.sessions?.state!=='complete')throw new Error('sessions');
  const trace=reply.sessions.value,rows=workedSessions(trace,{from,to},now);
  assert.equal(rows.length,1);assert.equal(rows[0].workedMs,30*M);assert.equal(rows[0].currentPresence,undefined);
  assert.equal(response.body.includes('producer_id'),false);assert.equal(response.body.includes(h.user.id),false);assert.equal(response.body.includes('"stable"'),false);
  const live={mode:'live' as const,periodMs:H};
  const baseline=(await h.read({version:1,selection:live,evaluatedAt:now,sessions:{}})).json<PeriodReply>();
  if(baseline.sessions?.state!=='complete')throw new Error('baseline');
  h.credit(now-5*M,now-M);
  const next=(await h.read({version:1,selection:live,evaluatedAt:now,sessions:{cursor:baseline.sessions.value.cursor}})).json<PeriodReply>();
  if(next.sessions?.state!=='delta')throw new Error('delta');
  const once=mergeWork(baseline.sessions.value,next.sessions.value),twice=mergeWork(once,next.sessions.value);
  assert.deepEqual(once,twice);assert.equal(workedSessions(once,{from:now-H,to:now},now)[0].workedMs,4*M);
  assert.equal(workedSessions(once,{from:now-3*M,to:now},now)[0].workedMs,2*M);
  assert.equal(workedSessions(once,{from:now,to:now+H},now).length,0);
});

test('period access is rechecked, malformed sections fail, and the legacy route keeps its contract',async t=>{
  t.mock.method(Date,'now',()=>now);
  const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const request:PeriodRequest={version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,values:[h.source]};
  assert.equal((await h.read(request,'missing')).statusCode,404);
  assert.equal((await h.read({...request,values:['private']})).statusCode,404);
  assert.equal((await h.read({...request,quota:{scope:'quota'}})).statusCode,400);
  assert.equal((await h.read(request)).statusCode,200);
  h.store.db.prepare('DELETE FROM holders WHERE source_id=?').run(h.source);
  assert.equal((await h.read(request)).statusCode,404);
});


test('a fixed range summarizes its own work without rewriting the retained live index',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  h.credit(now-2*H,now-30*M);
  const request:PeriodRequest={version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,sessions:{}};
  const initial=(await h.read(request)).json<PeriodReply>().sessions!;if(initial.state!=='complete')throw new Error('baseline');
  const original=h.store.agentWork.bind(h.store),ranges:number[][]=[];
  t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{ranges.push(args.slice(0,2) as number[]);return original(...args);});
  const past={mode:'range' as const,from:now-2*H,to:now-H};
  const extended=(await h.read({...request,selection:past,sessions:{cursor:initial.value.cursor}})).json<PeriodReply>().sessions!;
  if(extended.state!=='complete')throw new Error('fixed range');
  assert.deepEqual(ranges,[[now-2*H-M,now-H+M]]);
  const value=extended.value;
  assert.equal(value.anchor,now-2*H-M);assert.equal(value.cut,now-H+M);assert.deepEqual(value.fixed?.range,{from:past.from,to:past.to});assert.deepEqual(value.spans,[]);
  assert.equal(workedSessions(value,past,now)[0].workedMs,H);
  assert.equal(workedSessions(initial.value,{from:now-H,to:now},now)[0].workedMs,30*M);
  const detailRequest={version:1,selection:past,evaluatedAt:now,cursor:extended.value.cursor,refs:[value.refs[0].ref]};
  const detail=await h.details(detailRequest);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().sessions.value[0].workedMs,H);
  assert.equal((await h.details({...detailRequest,refs:Array(101).fill(value.refs[0].ref)})).statusCode,400);
  h.credit(now-10*M,now-5*M,'another');
  assert.equal((await h.details(detailRequest)).statusCode,400,'a stale detail cursor cannot name current evidence');
});


test('quota unavailability ends both historical values and exact tape coverage at its exclusive boundary',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const at=now-2*M,boundary=now-M;
  h.store.record(h.source,{observedAt:at,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:now+H}]});
  h.store.db.prepare("INSERT INTO events(source_id,at,kind,detail) VALUES (?,?,'quota_unavailable','')").run(h.source,boundary);
  const request:PeriodRequest={version:1,selection:{mode:'range',from:now-H,to:boundary},evaluatedAt:now,values:[h.source],quota:{cell:String(M),from:String(now-H),to:String(now)}};
  const response=await h.read(request);assert.equal(response.statusCode,200,response.body);
  const reply=response.json<PeriodReply>();if(reply.values?.state!=='complete'||reply.quota?.state!=='complete')throw new Error('period');
  const value=reply.values.value[0].windows[0];assert.equal(value.remaining,83);assert.equal(value.validUntil,boundary);assert.equal(value.stale,true);
  const summary=reply.quota.value.tape!.fixed!.quota[0];assert.equal(summary.remainingAtEnd,null);assert.equal(summary.points.at(-1)![3],boundary);
  const before=periodValues(h.store,h.store.sources(h.board),h.user.id,boundary-1,()=>{})[0];
  assert.equal(before.windows[0].stale,false);assert.equal(before.validFor!.to,boundary);
});
