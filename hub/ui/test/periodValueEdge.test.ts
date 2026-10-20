import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {t as translate} from '../i18n';
import {num,stamp} from '../lib/format';
import {level} from '../lib/quota';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {buildApp} from '../../server/api.js';
import {Ingest} from '../../server/ingest.js';
import {Duty} from '../../server/duty.js';
import {Cadence} from '../../server/cadence.js';
import {Pairing} from '../../server/pairing.js';
import {Setup} from '../../server/setup.js';
import {ResetFeed} from '../../server/resets.js';
import {newSecret} from '../../server/domain/auth.js';
import {expandPeriod,type PeriodWireReply} from '../../server/domain/periodWire.js';
import {periodValueAt} from '../../server/domain/periodValues.js';
import {shifted} from '../../server/domain/periodShift.js';
import type {Meter} from '../../server/domain/meters.js';

const M=60_000,H=60*M,now=1_800_000_025_000;
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

/** Render the actual value and status markup; unrelated plan and reset controls stay closed. */
const reactRequire=createRequire(import.meta.url),React=reactRequire('react'),{renderToStaticMarkup}=reactRequire('react-dom/server');
const meterCode=readFileSync(new URL('../components/Meter.tsx',import.meta.url),'utf8').replace(/^import .*;$/mg,'');
const sourceCode=readFileSync(new URL('../components/SourceCard.tsx',import.meta.url),'utf8');
const start=sourceCode.indexOf('function Limit({');
const limitCode=sourceCode.slice(start,sourceCode.indexOf('\n}',start)+2);
const consumerContext={exports:{} as any,require:reactRequire,t:translate,num,stamp,level,windowName:()=> 'Weekly',ResetLine:()=>null,PlanNote:()=>null,PlanMark:()=>null};
runInNewContext(ts.transpileModule(meterCode+limitCode+'\nexports.Limit=Limit;',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,consumerContext);
const cardHTML=(w:any)=>renderToStaticMarkup(React.createElement(consumerContext.exports.Limit,{w,measuredAt:w.observedAt,weekly:null}));

for(const limit of ['reset','ttl'] as const)test(`rounded native values evaluate ${limit} at the selected edge and render their warning`,async t=>{
  const h=await fixture(t),id=h.source('codex'),at=now-M,deadline=now+10_000;
  h.store.record(id,{observedAt:at,plan:'',resets:null,staleAfterMs:limit==='ttl'?deadline-at-1:H,windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:limit==='reset'?deadline:now+H}]});
  // A stored future reply must not enter a range merely because rounding puts its edge later.
  h.store.record(id,{observedAt:now+5_000,plan:'',resets:null,staleAfterMs:H,windows:[{id:'future',kind:'session',label:null,minutes:300,used:99,remaining:1,resetAt:now+H}]});
  for(const to of [deadline,deadline-1,deadline+1,now+35_000]){
    const base=(await h.values([id],to))[0];assert.equal(base.windows[0].stale,false,'a future selected edge evaluates at the current clock');
    const value=periodValueAt(base,to)!;assert.ok(value);const window=value.windows[0];
    assert.equal(window.id,'weekly');assert.equal(window.observedAt,at);assert.equal(window.remaining,83);
    const html=cardHTML(window);
    assert.equal(html.includes('Measurements stale'),to>=deadline,'the rendered value explains expired evidence');
    assert.equal(html.includes('aria-hidden="false"'),to>=deadline,'the rendered status dot matches the selected edge');
    assert.equal(window.validUntil,deadline);assert.equal(window.stale,to>=deadline);
    assert.ok(value.validFor!.from<=to&&to<value.validFor!.to,'base value proves its own requested edge');
  }
});

test('rounded wallet, cap and subscription funds keep exact amounts, admission and currency provenance at expiry',async t=>{
  const h=await fixture(t),wallet=h.source(),cap=h.source('zai'),funds=h.source('codex'),at=now-M,ttl=70_000,deadline=at+ttl+1,to=now+35_000;
  const target=h.store.currencies.create(h.user.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',now-2*H);h.store.currencies.select(h.user.id,target.id);
  h.record(wallet,at,'7',ttl,'9007199254741000');
  h.store.record(cap,{type:'meters',observedAt:at,staleAfterMs:H,meters:[{...meter('quota:credit:5h','40',at,H),kind:'cap',unit:'credits:zai',limit:'100',minutes:300,resetAt:deadline}],keys:[],inventoryComplete:true,inventoryError:null});
  h.store.record(funds,{observedAt:at,plan:'',resets:null,staleAfterMs:ttl,windows:[],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'1234567890.123456789',hasCredits:true}]});
  h.record(wallet,now+5_000,'10',H,'10');
  h.store.record(cap,{type:'meters',observedAt:now+5_000,staleAfterMs:H,meters:[{...meter('quota:credit:5h','0',now+5_000,H),kind:'cap',unit:'credits:zai',limit:'1000',minutes:300}],keys:[],inventoryComplete:true,inventoryError:null});
  h.store.record(funds,{observedAt:now+5_000,plan:'',resets:null,staleAfterMs:H,windows:[],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'0',hasCredits:true}]});
  for(const edge of [deadline-1,deadline,to]){
    const values=(await h.values([wallet,cap,funds],edge)).map(value=>periodValueAt(value,edge)!),walletValue=values.find(v=>v.id===wallet)!,capValue=values.find(v=>v.id===cap)!,fundsValue=values.find(v=>v.id===funds)!;
    const balance=walletValue.meters.find(m=>m.id==='balance')!,converted=walletValue.meters.find(m=>m.conversion?.original.meterId==='balance')!;
    assert.equal(balance.amount,'9007199254740993');assert.equal(balance.at,at);assert.equal(balance.stale,edge>=deadline);
    assert.equal(converted.amount,'18014398509481986');assert.equal(converted.conversion!.original.amount,balance.amount);assert.equal(converted.conversion!.original.at,at);assert.equal(converted.stale,edge>=deadline);
    assert.equal(capValue.meters[0].amount,'40');assert.equal(capValue.meters[0].limit,'100');assert.equal(capValue.meters[0].stale,edge>=deadline);
    const credits=fundsValue.meters.find(m=>m.id==='balance:credits')!;
    assert.equal(credits.amount,'1234567890123456789');assert.equal(credits.scale,9);assert.equal(credits.at,at);assert.equal(credits.stale,edge>=deadline);assert.equal(fundsValue.creditBalance!.at,at);assert.equal(fundsValue.creditBalance!.validUntil,deadline);
    for(const value of values)assert.ok(value.validFor!.from<=edge&&edge<value.validFor!.to);
  }
});

test('nearby cached values cross future deadlines without admitting future observations or changing fixed coverage',async t=>{
  const h=await fixture(t),id=h.source(),at=now-M,deadline=now+10_001,from=now-H,to=now+35_000;
  h.record(id,at,'0',70_000);
  const result=await h.read(id,from,to),value=result.value;
  assert.equal(result.summary.end,'100000000','the incomplete interval uses the elapsed state point');assert.deepEqual(result.fixed.range,{from,to});
  for(const edge of [now-5_000,deadline-1,deadline,deadline+1,to,to+1]){
    const cached=periodValueAt(value,edge);assert.ok(cached,`cached edge ${edge}`);
    const fresh=periodValueAt((await h.values([id],edge))[0],edge)!;
    assert.deepEqual(cached.meters,fresh.meters);assert.deepEqual(cached.windows,fresh.windows);assert.deepEqual(cached.keys,fresh.keys);
    assert.equal(cached.meters.find(m=>m.id==='balance')!.amount,'100000000');
    assert.equal(cached.meters.find(m=>m.id==='balance')!.stale,edge>=deadline);
    const restored=periodValueAt(cached,to);assert.ok(restored,'return to the original edge retains a proof');assert.equal(restored.meters.find(m=>m.id==='balance')!.stale,true);
  }
  const moved=shifted(result.fixed,{from:from-40_000,to:to-40_000});assert.ok(moved);assert.deepEqual(moved.range,{from:from-40_000,to:to-40_000});
});

test('future context endpoints cannot certify key or unlimited-credit freshness, including cached shifts',async t=>{
  const h=await fixture(t),wallet=h.source(),funds=h.source('codex'),at=now-M,to=now+35_000;
  for(const time of [at,now+5_000]){
    h.store.record(wallet,{type:'meters',observedAt:time,staleAfterMs:H,meters:[meter('credits','100000000',time,H)],keys:[{id:'a'.repeat(12),name:'Known key',disabled:false,expiresAt:null,includeByok:false,at:time,staleAfterMs:H,presence:'observed',missCount:0,periods:{day:null,week:null,month:null}}],inventoryComplete:true,inventoryError:null});
    h.store.record(funds,{observedAt:time,plan:'',resets:null,staleAfterMs:H,windows:[],balances:[{id:'balance:credits',unit:'credits:codex',status:'unlimited',hasCredits:true}]});
  }
  const baseline=await h.values([wallet,funds],to);
  for(const edge of [now-1,now,now+1,to]){
    const fresh=await h.values([wallet,funds],edge);
    for(const value of baseline){
      const cached=periodValueAt(value,edge);assert.ok(cached);
      const expected=fresh.find(v=>v.id===value.id)!;
      assert.deepEqual(cached.keys,expected.keys);assert.deepEqual(cached.creditBalance,expected.creditBalance);
      assert.ok(cached.validFor!.from<=edge&&edge<cached.validFor!.to);
    }
    assert.equal(fresh.find(v=>v.id===wallet)!.keys[0].at,at);
    assert.equal(fresh.find(v=>v.id===wallet)!.keys[0].presence,'missing');
    assert.equal(fresh.find(v=>v.id===funds)!.creditBalance!.at,at);
    assert.equal(fresh.find(v=>v.id===funds)!.creditBalance!.validUntil,at+1);
  }
});

test('future-only measurements and future interruptions are not admitted by rounded card values',async t=>{
  const h=await fixture(t),native=h.source('codex'),wallet=h.source(),empty=h.source('codex'),at=now-M,to=now+35_000;
  const record=(id:string,time:number)=>h.store.record(id,{observedAt:time,plan:'',resets:null,staleAfterMs:H,windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used:0,remaining:100,resetAt:now+H}]});
  record(native,at);record(empty,now+5_000);h.record(wallet,at,'100000000',H);
  h.store.db.prepare("INSERT INTO events(source_id,at,kind,detail) VALUES (?,?,'quota_unavailable','')").run(native,now+5_000);
  h.store.db.prepare('UPDATE meter_spans SET interrupted_at=? WHERE source_id=?').run(now+5_000,wallet);
  const values=await h.values([native,wallet,empty],to);
  assert.equal(values.find(v=>v.id===native)!.windows[0].stale,false);
  assert.equal(values.find(v=>v.id===wallet)!.meters.find(m=>m.id==='balance')!.stale,false);
  assert.equal(values.find(v=>v.id===wallet)!.meters.find(m=>m.id==='balance')!.amount,'0');
  assert.deepEqual(values.find(v=>v.id===empty)!.windows,[]);
});
