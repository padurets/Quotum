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
import {PeriodAccounting} from '../domain/periodAccounting.js';
import {periodValueAt} from '../domain/periodValues.js';
import {shifted} from '../domain/periodShift.js';
import {admitSpan} from '../domain/periodAdmission.js';
import {decodeSamples} from '../domain/periodTape.js';
import type {Meter,Reading} from '../domain/meters.js';
import type {PeriodScope} from '../domain/periodRead.js';
const {moneyPointAt}=await import(new URL('../../ui/lib/moneyView.ts',import.meta.url).href);

const M=60_000,H=60*M,now=1_800_000_025_000,to=Math.ceil(now/M)*M;
const meter=(id:string,amount:string,at:number,staleAfterMs:number):Meter=>({id,kind:'counter',unit:'USD',amount,limit:null,at,staleAfterMs,resetAt:null,minutes:null,scope:null,label:null,stale:false});
async function fixture(t:TestContext) {
  let clock=now;t.mock.method(Date,'now',()=>clock);
  const store=new Store(':memory:',now-3*H),directory=new Directory(store.db);
  const user=directory.createUser('reader@example.test','Reader','unused',now-3*H),board=directory.boards(user.id)[0].id;
  const session=newSecret('qt_s');directory.createSession(session,user.id,now-3*H,24*H);
  const secret=newSecret('qt_m');directory.createToken(secret,'token',user.id,'test',now-3*H);
  const app=await buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null});
  t.after(async()=>{await app.close();store.close();});
  let next=0;
  const source=(provider:Parameters<Store['source']>[0]='openrouter')=>{const id=store.source(provider,(++next).toString().padStart(24,'a'),now-3*H);store.hold(id,user.id,now-3*H);return id;};
  const record=(id:string,at:number,usage='7',ttl=70_000,credits='9007199254741000')=>store.record(id,{type:'meters',observedAt:at,staleAfterMs:ttl,meters:[meter('credits',credits,at,ttl),meter('usage',usage,at,ttl)],keys:[],inventoryComplete:true,inventoryError:null});
  const ingest=async(at:number,ttl=70_000)=>{
    const response=await app.inject({method:'POST',url:'/v1/ingest',headers:{authorization:'Bearer '+secret},payload:{version:1,agent:'quotum/0.7.0',machine:{id:'machine-test-0123456789',name:'Laptop',os:'linux',arch:'x86_64'},sentAt:new Date(at).toISOString(),snapshots:[{provider:'codex',account:'f'.repeat(24),plan:'pro',observedAt:new Date(at).toISOString(),via:'codex/app-server',client:'0.154.0',staleAfterMs:ttl,windows:[{id:'weekly',kind:'weekly',minutes:10080,usedPercent:17,resetsAt:new Date(now+H).toISOString()}],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'2500',hasCredits:true}]}],failures:[]}});
    assert.equal(response.statusCode,200,response.body);assert.equal(response.json().accepted,1,response.body);
  };
  const read=async(id:string,meterId='balance',scope:PeriodScope='budget',options:{to?:number;live?:boolean;unit?:string;currency?:string}={})=>{
    const edge=options.live?clock:options.to??to,from=edge-H;
    const response=await app.inject({method:'POST',url:`/api/boards/${board}/period`,headers:{origin:'http://localhost',cookie:'quotum_session='+session},payload:{version:1,selection:options.live?{mode:'live',periodMs:H}:{mode:'range',from,to:edge},evaluatedAt:clock,values:[id],[scope]:{cell:String(M),from:String(Math.floor(from/M)*M),to:String(Math.ceil(edge/M)*M),...(meterId?{meters:JSON.stringify([[id,meterId]]),unit:options.unit??'USD',...(options.currency?{currency:options.currency}:{})}:{})}}});
    assert.equal(response.statusCode,200,response.body);const reply=expandPeriod(response.json<PeriodWireReply>()),section=reply[scope];
    assert.equal(reply.values?.state,'complete');assert.equal(section?.state,'complete');
    if(reply.values?.state!=='complete'||section?.state!=='complete'||!section.value.tape)throw new Error('period');
    const tape=section.value.tape;
    for(const series of tape.quota)if(series.samplesEncoding==='delta'){series.samples=decodeSamples(series.samples);delete series.samplesEncoding;}
    const fixed=tape.fixed??new PeriodAccounting(tape,null).fixed(reply.basis.range,M);
    return {reply,value:reply.values.value[0],tape,fixed,summary:fixed.money[0]};
  };
  return {store,user,board,source,record,ingest,read,clock:(at:number)=>{clock=at;}};
}

test('a future credit heartbeat preserves the admitted anchor and elapsed-day TTL',async t=>{
  const h=await fixture(t),at=now-M,future=now+5_000;
  h.clock(at);await h.ingest(at);h.clock(now);
  const id=h.store.sources(h.board)[0].id;
  assert.equal((await h.read(id,'balance:credits','funds',{currency:'USD'})).summary.end,'100000000','the incomplete period evaluates at the elapsed clock');
  await h.ingest(future,H);
  for(const live of [false,true]){
    const result=await h.read(id,'balance:credits','funds',{currency:'USD',live}),native=result.value.meters.find(m=>m.id==='balance:credits')!;
    assert.equal(native.at,at);assert.equal(native.validUntil,at+70_000+1);assert.equal(native.stale,false);
    assert.equal(result.summary.end,'100000000');assert.equal(result.summary.coveredMs,0);
    assert.equal(result.summary.semantics!.conversion!.original.at,at);
    if(live)assert.deepEqual(result.tape.money[0].spans.map(s=>[s.to,s.staleAfterMs]),[[at,70_000]]);
    else assert.equal(moneyPointAt(result.summary,to-1),undefined);
    const quota=await h.read(id,'','quota',{live});
    assert.equal(quota.value.windows[0].observedAt,at);assert.equal(quota.fixed.quota[0].remainingAtEnd,83);
  }
  assert.equal(h.store.meters.spans(id,'balance:credits',0,now)[0].to,future,'admission does not rewrite the producer ledger');
  h.clock(future);assert.equal((await h.read(id,'balance:credits','funds',{currency:'USD'})).value.meters.find(m=>m.id==='balance:credits')!.at,at,'the cut remains exclusive');
  h.clock(future+1);
  const admitted=await h.read(id,'balance:credits','funds',{currency:'USD'});
  assert.equal(admitted.summary.end,'100000000');assert.equal(admitted.summary.coveredMs,future-at);
  assert.equal(admitted.summary.semantics!.conversion!.original.at,future);
});

test('paired native and converted money share admitted TTL, exact amounts and neighboring replay',async t=>{
  const h=await fixture(t),id=h.source(),at=now-M,deadline=at+70_000+1;
  const target=h.store.currencies.create(h.user.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',now-2*H);h.store.currencies.select(h.user.id,target.id);
  h.record(id,at);h.record(id,now+5_000,'100',H,'100');
  for(const currency of [undefined,target.id]){
    const base=await h.read(id,'balance','budget',{currency});
    for(const edge of [now-1,now,deadline-1,deadline,to-1,to]){
      const result=await h.read(id,'balance','budget',{currency,to:edge}),native=result.value.meters.find(m=>m.id==='balance')!,expected=currency?'18014398509481986':'9007199254740993';
      assert.equal(native.amount,'9007199254740993');assert.equal(native.at,at);assert.equal(native.stale,Math.min(edge,now)>=deadline);
      assert.equal(result.summary.end,Math.min(edge,now)>=deadline?null:expected);assert.equal(result.summary.coveredMs,0);assert.equal(result.summary.spent,null);assert.equal(result.summary.topup,null);
      const replay=shifted(base.fixed,{from:edge-H,to:edge});
      if(edge<=now||edge===to)assert.deepEqual(replay?.money,result.fixed.money);else assert.equal(replay,null,'future neighboring geometry has no reuse proof');
      assert.deepEqual(periodValueAt(base.value,Math.min(edge,now))?.meters,result.value.meters);
      if(currency)assert.equal(result.summary.semantics!.conversion!.original.at,at);
    }
    const live=await h.read(id,'balance','budget',{currency,live:true});
    assert.equal(live.summary.end,currency?'18014398509481986':'9007199254740993');
    assert.equal(live.tape.money[0].readings.length,1);assert.equal(live.tape.money[0].paired!.readings.length,1);
    assert.equal(live.tape.money[0].paired!.spans[0].to,at);
  }
});

test('admitted changed readings keep their own TTL and accounting before a future tail',async t=>{
  const h=await fixture(t),id=h.source(),a=now-M,b=now-10_000;
  h.record(id,a);h.record(id,b,'24',20_000);h.record(id,now+5_000,'24',H);
  for(const live of [false,true]){
    const result=await h.read(id,'balance','budget',{live});
    assert.equal(result.value.meters.find(m=>m.id==='usage')!.validUntil,b+20_000+1);
    assert.equal(result.summary.coveredMs,b-a);assert.equal(result.summary.spent,'17');assert.equal(result.summary.topup,'0');
    assert.equal(result.summary.end,'9007199254740976');
  }
});

test('unchanged recovery heads never borrow a future TTL',async t=>{
  const h=await fixture(t),id=h.source(),a=now-M,b=now-10_000;
  h.record(id,a,'7',1000);h.record(id,b,'7',H);h.record(id,now+5_000,'7',H);
  for(const edge of [b,b+1,now,to]){
    const result=await h.read(id,'balance','budget',{to:edge});
    assert.equal(result.summary.end,null);assert.equal(result.summary.coveredMs,0);
    if(edge>b){assert.equal(result.value.meters.find(m=>m.id==='usage')!.at,b);assert.equal(result.value.meters.find(m=>m.id==='usage')!.validUntil,b+1);}
  }
  h.clock(now+5_001);assert.equal((await h.read(id)).summary.end,'9007199254740993');
});

test('admitted FX heartbeat provenance survives a later compressed future endpoint',async t=>{
  const h=await fixture(t),id=h.source(),a=now-M,b=now-10_000;
  const target=h.store.currencies.create(h.user.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',now-2*H);h.store.currencies.select(h.user.id,target.id);
  h.record(id,a);await h.read(id,'balance','budget',{currency:target.id,to:a+1});
  h.store.currencies.setRate(h.user.id,target.id,'USD','3000000',b-1000,b-1000);h.record(id,b);
  await h.read(id,'balance','budget',{currency:target.id,to:b+1});h.record(id,now+5_000,'7',H);
  const result=await h.read(id,'balance','budget',{currency:target.id});
  assert.equal(result.summary.end,null);assert.equal(result.summary.coveredMs,b-a);
  assert.equal(result.summary.semantics!.conversion!.original.at,b);
  assert.equal(result.value.meters.find(m=>m.conversion?.original.meterId==='balance')!.amount,'27021597764222979');
  assert.equal(result.value.meters.find(m=>m.id==='balance')!.validUntil,b+1);
  assert.equal(result.summary.spent,'0');assert.equal(result.summary.topup,'0');
});

test('native interruptions and monetary holds become effective only after the evidence cut admits them',async t=>{
  const h=await fixture(t),native=h.source('codex'),cap=h.source('zai'),at=now-M,future=now+5_000;
  h.store.record(native,{observedAt:at,plan:'',resets:null,staleAfterMs:H,windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:now+H}]});
  h.store.record(cap,{type:'meters',observedAt:at,staleAfterMs:H,meters:[{...meter('quota:credit:5h','40',at,H),kind:'cap',unit:'credits:zai',limit:'100',minutes:300}],keys:[],inventoryComplete:true,inventoryError:null});
  h.store.db.prepare("INSERT INTO events(source_id,at,kind,detail) VALUES (?,?,'quota_unavailable','')").run(native,future);
  h.store.db.prepare('UPDATE meter_spans SET hold_until=?,interrupted_at=? WHERE source_id=?').run(future,future,cap);
  for(const clock of [now,future,future+1]){
    h.clock(clock);
    for(const live of [false,true]){
      const quota=await h.read(native,'','quota',{live}),money=await h.read(cap,'quota:credit:5h','quota',{unit:'credits:zai',live});
      assert.equal(quota.value.windows[0].stale,clock>future);assert.equal(quota.fixed.quota[0].remainingAtEnd,clock>future?null:83);
      assert.equal(money.value.meters[0].stale,clock>future);assert.equal(money.summary.end,clock>future?null:'60');
    }
  }
});

test('retained and legacy span heads cannot become invented admitted observations',()=>{
  const reading:Reading={...meter('usage','9007199254740993',100,200),previousAt:null};
  assert.equal(admitSpan({from:150,to:400,staleAfterMs:100,observedFrom:100},300,reading),undefined);
  assert.equal(admitSpan({from:150,to:400,staleAfterMs:100},300,reading,150),undefined,'a legacy clipped head is not an FX witness');
  assert.deepEqual(admitSpan({from:150,to:400,staleAfterMs:100},300,reading,200),{from:150,to:200,staleAfterMs:0});
  assert.deepEqual(admitSpan({from:50,to:400,staleAfterMs:100},300,reading),{from:50,to:100,staleAfterMs:200});
  assert.equal(admitSpan({from:300,to:400,staleAfterMs:100,observedFrom:300},300,reading),undefined);
  assert.deepEqual(admitSpan({from:100,to:250,staleAfterMs:100,observedFrom:100,holdUntil:300,interruptedAt:301},300,reading),{from:100,to:250,staleAfterMs:100,observedFrom:100});
});
