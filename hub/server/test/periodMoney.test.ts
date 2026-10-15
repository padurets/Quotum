import {test,type TestContext} from 'node:test';
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
import {expandPeriod,type PeriodWireReply} from '../domain/periodWire.js';
import {periodValueAt} from '../domain/periodValues.js';
import {shifted} from '../domain/periodShift.js';
import type {Meter} from '../domain/meters.js';
import {deepSeekMeasurement} from '../connectors/deepseek.js';
import {periodTape} from '../periodTape.js';
import {PeriodAccounting} from '../domain/periodAccounting.js';
import {drain} from '../domain/prepare.js';

const M=60_000,H=60*M,now=1_800_000_000_000;
async function fixture(t:TestContext) {
  t.mock.method(Date,'now',()=>now);
  const store=new Store(':memory:',now-3*H),directory=new Directory(store.db);
  const user=directory.createUser('reader@example.test','Reader','unused',now-3*H),board=directory.boards(user.id)[0].id;
  const token=newSecret('qt_s');directory.createSession(token,user.id,now-3*H,24*H);
  const app=await buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null});
  t.after(async()=>{await app.close();store.close();});
  let next=0;
  const source=(provider:Parameters<Store['source']>[0]='openrouter')=>{const id=store.source(provider,(++next).toString().padStart(24,'a'),now-3*H);store.hold(id,user.id,now-3*H);return id;};
  const record=(id:string,at:number,usage='0',ttl=H,credits='100000000')=>store.record(id,{type:'meters',observedAt:at,staleAfterMs:ttl,meters:[meter('credits',credits,at,ttl),meter('usage',usage,at,ttl)],keys:[],inventoryComplete:true,inventoryError:null});
  const values=async(ids:string[],to:number)=>{
    const response=await app.inject({method:'POST',url:`/api/boards/${board}/period`,headers:{origin:'http://localhost',cookie:`quotum_session=${token}`},payload:{version:1,selection:{mode:'range',from:now-H,to},evaluatedAt:now,values:ids}});
    assert.equal(response.statusCode,200,response.body);const reply=expandPeriod(response.json<PeriodWireReply>());
    assert.equal(reply.values?.state,'complete');if(reply.values?.state!=='complete')throw new Error('values');return reply.values.value;
  };
  const read=async(id:string,from:number,to:number,unit='USD',currency?:string,meterId='balance')=>{
    const response=await app.inject({method:'POST',url:`/api/boards/${board}/period`,headers:{origin:'http://localhost',cookie:`quotum_session=${token}`},payload:{version:1,selection:{mode:'range',from,to},evaluatedAt:now,values:[id],budget:{cell:String(M),from:String(Math.floor(from/M)*M),to:String(Math.ceil(to/M)*M),meters:JSON.stringify([[id,meterId]]),unit,...(currency?{currency}:{})}}});
    assert.equal(response.statusCode,200,response.body);const reply=expandPeriod(response.json<PeriodWireReply>());
    if(reply.values?.state!=='complete'||reply.budget?.state!=='complete'||!reply.budget.value.tape?.fixed)throw new Error('money');
    return {value:reply.values.value[0],fixed:reply.budget.value.tape.fixed,summary:reply.budget.value.tape.fixed.money[0]};
  };
  return {store,directory,user,board,source,record,read,values};
}
const meter=(id:string,amount:string,at:number,staleAfterMs:number):Meter=>({id,kind:'counter',unit:'USD',amount,limit:null,at,staleAfterMs,resetAt:null,minutes:null,scope:null,label:null,stale:false});

test('historical caps and finite or unlimited credits retain compressed availability independently of their sample time',async t=>{
  const h=await fixture(t),cap=h.source('zai'),finite=h.source('codex'),unlimited=h.source('codex'),start=now-8*M,last=now-2*M;
  for(let at=start;at<=last;at+=M){
    h.store.record(cap,{type:'meters',observedAt:at,staleAfterMs:M,meters:[{...meter('quota:credit:5h','40',at,M),kind:'cap',unit:'credits:zai',limit:'100',minutes:300}],keys:[],inventoryComplete:true,inventoryError:null});
    for(const [id,status] of [[finite,'finite'],[unlimited,'unlimited']] as const)h.store.record(id,{observedAt:at,staleAfterMs:M,plan:'pro',resets:null,windows:[],resourceStatus:{windows:'missing',resets:'missing'},balances:[{id:'balance:credits',unit:'credits:codex',status,...(status==='finite'?{amount:'0'}:{}),hasCredits:true}]});
  }
  const edge=now-4*M,deadline=last+M+1,values=await h.values([cap,finite,unlimited],edge);
  for(const value of values){
    const observation=value.provider==='zai'?value.meters[0]:value.creditBalance!;
    assert.equal(observation.at,start,'interior heartbeats are not invented');assert.equal(observation.staleAfterMs,M);assert.equal(observation.validUntil,deadline);
    assert.ok(value.validFor!.from<=edge&&value.validFor!.to>edge);
    for(const boundary of [value.validFor!.from,value.validFor!.to-1]){
      const fresh=(await h.values([value.id],boundary))[0];assert.deepEqual(fresh.meters,value.meters);assert.deepEqual(fresh.creditBalance,value.creditBalance);
    }
  }
  assert.equal(values.find(v=>v.id===cap)!.meters[0].stale,false);assert.equal(values.find(v=>v.id===finite)!.meters[0].amount,'0');
  const before=await h.values([cap,finite],deadline-1),after=await h.values([cap,finite],deadline);
  assert.equal(before.find(v=>v.id===cap)!.meters[0].stale,false);assert.equal(after.find(v=>v.id===cap)!.meters[0].stale,true);assert.equal(after.find(v=>v.id===finite)!.creditBalance!.validUntil,deadline);
  for(const value of before){const cached=periodValueAt(value,deadline);assert.ok(cached);assert.deepEqual(cached.meters,after.find(v=>v.id===value.id)!.meters);}
});

test('a composed balance expires at its first unavailable component without changing its original TTL',async t=>{
  const h=await fixture(t),id=h.source(),first=now-10*M,missing=now-3*M;
  h.record(id,first,'0',2*M);
  h.store.record(id,{type:'meters',observedAt:missing,staleAfterMs:H,meters:[meter('credits','100000000',missing,H)],keys:[],inventoryComplete:true,inventoryError:null});
  const value=(await h.values([id],missing+1))[0],credits=value.meters.find(m=>m.id==='credits')!,usage=value.meters.find(m=>m.id==='usage')!,balance=value.meters.find(m=>m.id==='balance')!;
  assert.equal(credits.stale,false);assert.equal(usage.stale,true);assert.equal(balance.stale,true);
  assert.equal(balance.validUntil,first+2*M+1);assert.equal(balance.validUntil,Math.min(credits.validUntil!,usage.validUntil!));assert.equal(balance.amount,'100000000');assert.equal(balance.staleAfterMs,2*M);
});

test('a recovery at the exclusive endpoint cannot revive an expired native or converted balance',async t=>{
  const h=await fixture(t),id=h.source(),a=now-30*M,b=now-10*M;
  const target=h.store.currencies.create(h.user.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',now-2*H);h.store.currencies.select(h.user.id,target.id);
  h.record(id,a,'0',M);h.record(id,b,'100000000',M);
  for(const currency of [undefined,target.id]){
    const before=await h.read(id,now-40*M,b,'USD',currency),after=await h.read(id,now-40*M,b+1,'USD',currency);
    assert.equal(before.summary.end,null);assert.equal(before.value.meters.find(m=>m.id==='balance')!.stale,true);
    assert.equal(after.summary.end,'0');assert.equal(after.summary.points.at(-1)!.value,'0');assert.equal(after.summary.points.at(-1)!.knownFrom,b);
    assert.equal(before.summary.coveredMs,0);assert.equal(before.summary.spent,null);assert.equal(after.summary.unlocated.length,1);
    assert.ok(before.summary.points.every(p=>p.knownFrom!<b));
  }
});

test('accounting coverage ends at the last confirmed observation, including unchanged heartbeats',async t=>{
  const h=await fixture(t),id=h.source(),a=now-40*M,b=now-20*M;
  h.record(id,a);
  const unknown=await h.read(id,now-30*M,now-15*M);
  assert.equal(unknown.summary.end,'100000000');assert.equal(unknown.summary.coveredMs,0);assert.equal(unknown.summary.spent,null);
  h.record(id,b);
  const confirmed=await h.read(id,a,b),tail=await h.read(id,a,now-15*M);
  assert.equal(confirmed.summary.coveredMs,b-a);assert.equal(confirmed.summary.spent,'0');assert.equal(tail.summary.coveredMs,b-a);assert.equal(tail.summary.spent,'0');
  h.record(id,now-10*M,'15000000');
  const spent=await h.read(id,a,now-10*M+1);assert.equal(spent.summary.spent,'15000000');assert.equal(spent.summary.coveredMs,30*M);
});

test('paired currency heartbeats agree across card, endpoint, boundary points and cached replay without becoming spending',async t=>{
  const h=await fixture(t),id=h.source(),a=now-5*M,b=now-3*M,c=now-M;
  const target=h.store.currencies.create(h.user.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',now-2*H);h.store.currencies.select(h.user.id,target.id);
  const amount='9007199254741001';h.record(id,a,'0',H,amount);await h.read(id,a-20*M,a+1,'USD',target.id);
  h.store.currencies.setRate(h.user.id,target.id,'USD','3000000',b-M/2,b-M/2);
  h.record(id,b,'0',H,amount);await h.read(id,b-20*M,b+1,'USD',target.id);h.record(id,c,'0',H,amount);
  assert.deepEqual(h.store.meters.readings(id,'usage',0,now).map(r=>r.at),[a]);
  const base=await h.read(id,b+30_000-20*M,b+30_000,'USD',target.id);
  for(const to of [b-1,b,b+1,b+29_999,b+45_000]){
    const from=to-20*M,fresh=await h.read(id,from,to,'USD',target.id),expected=(BigInt(amount)*(to<=b?2n:3n)).toString();
    const card=fresh.value.meters.find(m=>m.kind==='balance'&&m.unit===target.id)!;
    assert.equal(card.amount,expected);assert.equal(fresh.summary.end,expected);assert.equal(fresh.summary.semantics!.conversion!.original.amount,amount);
    assert.equal(fresh.summary.semantics!.conversion!.original.at,card.conversion!.original.at);assert.deepEqual(fresh.summary.semantics!.conversion!.rate,card.conversion!.rate);
    const point=fresh.summary.points.filter(p=>p.knownFrom!<to&&p.validUntil!>=to).at(-1)!;
    assert.equal(point.value,expected);assert.equal(point.semantics!.conversion!.original.amount,amount);assert.equal(fresh.summary.spent,'0');assert.equal(fresh.summary.topup,'0');
    const cached=shifted(base.fixed,{from,to});assert.ok(cached);assert.deepEqual(cached.money,fresh.fixed.money);
    const retained=periodValueAt(base.value,to);assert.ok(retained);assert.deepEqual(retained.meters,fresh.value.meters);
  }
  const native=await h.read(id,b+30_000-20*M,b+30_000);assert.equal(native.summary.end,amount);assert.equal(native.summary.spent,'0');
  h.record(id,c+10_000,'17',H,amount);
  const changed=await h.read(id,c-20*M,c+20_000,'USD',target.id),expected=(BigInt(amount)-17n).toString();
  assert.equal(changed.summary.semantics!.conversion!.original.amount,expected);assert.equal(changed.summary.end,(BigInt(expected)*3n).toString());assert.equal(changed.summary.spent,'51');
});

test('balance-only currency heartbeats preserve native facts and the same exclusive boundary valuation',async t=>{
  const h=await fixture(t),id=h.source('deepseek'),a=now-5*M,b=now-3*M;
  const target=h.store.currencies.create(h.user.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',now-2*H);h.store.currencies.select(h.user.id,target.id);
  const answer={is_available:true,balance_infos:[{currency:'USD',total_balance:'100',granted_balance:'0',topped_up_balance:'100'}]};
  h.store.record(id,deepSeekMeasurement(answer,a));
  h.store.currencies.setRate(h.user.id,target.id,'USD','3000000',b-M/2,b-M/2);
  h.store.record(id,deepSeekMeasurement(answer,b));
  for(const currency of [undefined,target.id])for(const to of [b,b+1]){
    const value=await h.read(id,to-20*M,to,'USD',currency,'balance:USD'),expected=currency?(to===b?'200000000':'300000000'):'100000000';
    assert.equal(value.summary.end,expected);assert.equal(value.summary.spent,null);assert.equal(value.summary.topup,null);
    const point=value.summary.points.filter(p=>p.knownFrom!<to&&p.validUntil!>=to).at(-1)!;assert.equal(point.value,expected);
    if(currency){const card=value.value.meters.find(m=>m.conversion?.original.meterId==='balance:USD')!;
      assert.equal(card.amount,expected);assert.equal(value.summary.semantics!.conversion!.original.at,card.conversion!.original.at);
      assert.equal(point.semantics!.conversion!.original.amount,'100000000');
    }
  }
  assert.deepEqual(h.store.meters.readings(id,'balance:USD',0,now).map(r=>[r.at,r.amount]),[[a,'100000000']]);
});

test('money indexes reserve their own memory before preparation and reuse the same ownership',async t=>{
  const h=await fixture(t),id=h.source();h.record(id,now-5*M);h.record(id,now-M);
  const query={unit:'USD',currency:'USD',meters:JSON.stringify([[id,'balance']])};
  const tape=periodTape(h.store,h.board,h.store.shown(h.board,[]),h.user.id,'budget',query,{from:now-H,to:now},'test',now-H,()=>{});
  let admitted=0;const index=drain(PeriodAccounting.prepare(tape,null,undefined,undefined,undefined,bytes=>{admitted=bytes;}));
  assert.ok(admitted>0);assert.equal(index.bytes,admitted);assert.equal(index.quotaBytes,0);
  const expected=index.moneySummary(id,'balance','USD',{from:now-H,to:now});
  const reused=drain(PeriodAccounting.prepare(tape,null,undefined,index,undefined,()=>assert.fail('unchanged money must not be charged twice')));
  assert.equal(reused.bytes,index.bytes);assert.deepEqual(reused.moneySummary(id,'balance','USD',{from:now-H,to:now}),expected);
  assert.throws(()=>drain(PeriodAccounting.prepare(tape,null,undefined,undefined,undefined,()=>{throw new Error('budget');})),/budget/);
});
