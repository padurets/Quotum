import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,NOW,H,M} from './periodRuntimeFixture';
import {expandPeriod} from '../../server/domain/periodWire';
import {workedSessions} from '../../server/domain/periodWork';
import {PeriodAccounting} from '../../server/domain/periodAccounting';
import {PeriodIndex} from '../../server/domain/periodIndex';
import {decodeSamples,sampleCount,mergeTape,bindRate,rateAt,type PeriodTape,type MoneyTape} from '../../server/domain/periodTape';
import {retainTape} from '../../server/domain/periodRetention';
import {drain,Preparations} from '../lib/prepare';
import {PERIOD_SCOPES} from '../../server/domain/periodRead';
import type {Meter} from '../../server/domain/meters';

test('a superseded money span tail is retired while complete rate transitions remain observable',()=>{
  const path=[{id:'first-proof',source:'manual',base:'USD',date:0,fetchedAt:0,from:'1000000',to:'2000000'}];
  const group=(to:number):MoneyTape=>({source:'wallet',meter:'balance',displayUnit:'EUR',readings:[{id:'balance',at:0,previousAt:null,kind:'balance',unit:'USD',amount:'9007199254741000',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:1000}],spans:[{from:0,to,observedFrom:0,staleAfterMs:1000}]});
  const tape=(money:MoneyTape,cut:number,replaceFrom=0):PeriodTape=>({from:0,cut,replaceFrom,cursor:'cursor',quota:[],money:[money]});
  const first=group(100);for(const at of [0,100])bindRate(first,'USD\n'+at,path);
  const latest=group(200);for(const at of [0,200])bindRate(latest,'USD\n'+at,path);
  const before=tape(first,101),next=tape(latest,201,101),merged=mergeTape(before,next);
  const project=(value:PeriodTape)=>new PeriodAccounting(value,null).fixed({from:150,to:151},1);
  const untrimmed=structuredClone(next);bindRate(untrimmed.money[0],'USD\n100',path);
  assert.notDeepEqual(project(untrimmed),project(next),'the old union retains a superseded heartbeat date');
  const retained=drain(retainTape(merged,50));assert.deepEqual(project(retained),project(next));
  assert.equal(rateAt(retained.money[0],'USD\n100'),undefined);
  for(const transition of [path,[{...path[0],id:'new-proof',date:100}],null]){
    const changed=group(200);bindRate(changed,'USD\n0',path);bindRate(changed,'USD\n100',transition);bindRate(changed,'USD\n200',path);
    const baseline=tape(changed,201,101),result=drain(retainTape(mergeTape(before,baseline),50));
    assert.deepEqual(project(result),project(baseline));
    assert.deepEqual(rateAt(result.money[0],'USD\n100'),transition,'equal numeric rates with new provenance and unavailable paths survive');
    assert.deepEqual(rateAt(result.money[0],'USD\n200'),path,'recovery keeps the original observation anchor');
  }
});

for(const replacement of ['authority','response'])test(`clock retirement releases staged work when ${replacement} changes during preparation`,async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({clocked:true});
  const report=async(batch:number,working:boolean)=>{
    const sessions=Array.from({length:100},(_,i)=>({provider:'codex',account:'a'.repeat(24),sessionId:(batch*100+i+1).toString(16).padStart(32,'0'),origin:'terminal',project:'Project',folder:'Folder',startedAt:new Date(NOW+batch*10*M).toISOString(),lastWorkedAt:new Date(now).toISOString(),working}));
    h.hub.ingest.sessions({kind:'device',device:h.directory.deviceById(h.device)!},{version:1,agent:'quotum/0.7.0',machine:{id:'machine-0123456789',name:'Work laptop',os:'linux',arch:'x86_64'},sentAt:new Date(now).toISOString(),sessions},now);h.events.flush();await flush();
  };
  const queue:(()=>void)[]=[];let time=0;
  const preparer=new Preparations({now:()=>++time,post:run=>queue.push(run)});
  try{
    for(let batch=0;batch<2;batch++){
      now=NOW+batch*10*M;h.jump(now);await flush();await report(batch,true);
      now+=2*M;h.jump(now);await flush();await report(batch,false);
    }
    assert.equal(h.period.get().rows.length,201);
    h.prepareWith(preparer);const bytes=h.pool.estimatedBytes,requests=h.requests.length;
    now=NOW+H+2*M;h.jump(now);await flush();
    for(let i=0;h.pool.estimatedBytes===bytes&&queue.length;i++){assert.ok(i<1000);queue.shift()!();await flush();}
    assert.ok(h.pool.estimatedBytes>bytes,'retirement has admitted real staging before cancellation');
    assert.equal(h.requests.length,requests,'the clock-only job made no HTTP request');
    if(replacement==='authority')h.remove();
    else{h.report(true,now);now+=M;h.jump(now);h.report(false,now);}
    await flush();
    for(let i=0;queue.length||h.pool.activeFlights;i++){assert.ok(i<10000);queue.shift()?.();await flush();}
    assert.equal(preparer.size,0);assert.equal(h.period.get().error,null);
    assert.equal(h.period.get().rows.length,replacement==='authority'?0:101,'the replacement cannot publish retired contexts');
    assert.equal(h.period.get().value.refs.length,replacement==='authority'?0:101);
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes,'cancelled staging is released');
  }finally{await h.close();preparer.dispose();}
});

test('a clock retirement capacity refusal consumes the expired deadline without HTTP or a timer loop',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({clocked:true});
  const reserve=h.pool.reserve.bind(h.pool);let refused=0;
  try{
    h.pool.reserve=(_owner,bytes)=>{if(bytes){refused++;return false;}return true;};
    now+=H;h.jump(now);await flush();
    assert.equal(refused,1);assert.equal(h.period.retirementAt,Infinity);assert.equal(h.period.get().error,null);
    now+=H;h.jump(now);await flush();
    assert.equal(refused,1,'the same expired edge is not retried');assert.equal(h.requests.length,0);
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes);
  }finally{h.pool.reserve=reserve;await h.close();}
});

test('a delayed real work sweep corrects the retained left edge without restoring its expired prefix',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({clocked:true});
  try{
    h.report(true,now);await flush();
    const pending=h.hold();now+=H+M;h.jump(now);await flush();
    assert.equal(h.period.get().rows.length,0,'the old credited interval has left the selected hour');
    h.report(false,now);await flush();
    assert.ok(h.requests.some(request=>request.sessions?.cursor),'late producer evidence uses its existing cursor');
    pending.release();await flush();
    const fresh=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,sessions:{}})));
    assert.ok(fresh.sessions&&fresh.sessions.state!=='error');
    const expected=workedSessions(fresh.sessions.value,fresh.basis.range,now);
    assert.equal(h.period.get().error,null);assert.equal(h.period.get().rows.length,1);
    assert.equal(h.period.get().rows[0].workedMs,140_000,'only the overlap of the bounded real credit remains');
    assert.equal(h.period.get().rows[0].workedMs,expected[0].workedMs);
    assert.ok(h.period.get().value.anchor>=NOW+M);
    const requests=h.requests.length;now+=M;h.jump(now);await flush();
    assert.equal(h.period.workedAt([h.period.get().rows[0].ref],null,now),80_000);assert.equal(h.requests.length,requests);
  }finally{await h.close();}
});

test('returning to a cached live period retires evidence that expired while it was hidden',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({clocked:true});
  try{
    h.settings.range='24h';h.period.changed();await flush();
    assert.ok(h.period.retained.size>0);
    now+=2*H;h.jump(now);await flush();const requests=h.requests.length;
    h.settings.range='1h';h.period.changed();await flush();
    assert.equal(h.requests.length,requests,'the cached return does not need HTTP');
    assert.equal(h.period.get().error,null);assert.equal(h.period.get().rows.length,0);
    assert.equal(h.period.get().value.refs.length,0,'a cached expired context is not retained indefinitely');
  }finally{await h.close();}
});

test('canceling a pan resumes expired evidence retirement without HTTP or geometry invalidation',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({clocked:true});
  try{
    const value=h.period.get().value,revision=h.period.getProjectionRevision('quota');
    h.pan.begin({source:Symbol(),input:'pointer',selected:null,length:H,now,historyStart:NOW-4*H,span:H,width:400});
    now+=H;h.jump(now);await flush();
    assert.equal(h.period.get().value,value,'a gesture retains its existing evidence');
    h.pan.cancel();await flush();
    assert.equal(h.period.get().rows.length,0);assert.equal(h.period.get().value.refs.length,0);
    assert.equal(h.period.getProjectionRevision('quota'),revision,'storage retirement keeps the prepared geometry revision');
    assert.equal(h.requests.length,0);
  }finally{await h.close();}
});

test('a backward hub clock correction reloads a discarded prefix and preserves the previous basis while waiting',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({clocked:true});
  try{
    now+=H;h.jump(now);await flush();assert.equal(h.period.get().value.refs.length,0);
    const basis=h.period.get().basis,pending=h.hold();h.clock.heard(now-4*M);await flush();
    assert.equal(h.period.get().loading,true);assert.equal(h.period.get().error,null);
    assert.deepEqual(h.period.get().basis,basis,'the old presentation keeps its actual selected bounds');
    assert.equal(h.requests.length,1);assert.ok(h.requests[0].sessions);
    assert.equal(h.requests[0].sessions!.cursor,undefined,'discarded work cannot reuse its old cursor');
    assert.equal(h.requests[0].quota?.evidence,undefined,'discarded quota reads a complete baseline too');
    pending.release();await flush();
    assert.equal(h.period.get().error,null);assert.equal(h.period.get().loading,false);
    assert.equal(h.period.get().rows.length,1);assert.equal(h.period.get().rows[0].workedMs,M);
    assert.equal(h.period.get().basis.range.to,now-4*M);
    const requests=h.requests.length;h.clock.heard(now);await flush();
    assert.equal(h.period.get().rows.length,0);assert.equal(h.requests.length,requests,'ordinary forward time still needs no read');
  }finally{await h.close();}
});

for(const periodName of ['1h','30d'])test(`${periodName}: a prolonged actual session stream stays complete in the default live memory budget`,async t=>{
  const periodMs=periodName==='1h'?H:30*24*H,interval=periodName==='1h'?10*M:24*H;
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({periodName,clocked:true,sessionMs:100*24*H});
  let peak=0;const reserve=h.pool.reserve.bind(h.pool);
  h.pool.reserve=(owner,bytes)=>{const admitted=reserve(owner,bytes);if(admitted)peak=Math.max(peak,h.pool.estimatedBytes);return admitted;};
  const move=async(value:number)=>{now=value;h.jump(now);await flush();};
  const report=async(batch:number,working:boolean)=>{
    const sessions=Array.from({length:100},(_,j)=>({provider:'codex',account:'a'.repeat(24),sessionId:(batch*100+j+1).toString(16).padStart(32,'0'),origin:'terminal',project:`Project ${batch}-${j}`,folder:`Folder ${batch}-${j}`,startedAt:new Date(NOW+batch*interval).toISOString(),lastWorkedAt:new Date(now).toISOString(),working}));
    const accepted=h.hub.ingest.sessions({kind:'device',device:h.directory.deviceById(h.device)!},{version:1,agent:'quotum/0.6.0',machine:{id:'machine-0123456789',name:'Work laptop',os:'linux',arch:'x86_64'},sentAt:new Date(now).toISOString(),sessions},now);
    assert.equal(accepted.accepted,100);h.events.flush();await flush();
  };
  const oracle=()=>{
    const reply=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs},evaluatedAt:now,sessions:{}})));
    assert.ok(reply.sessions&&reply.sessions.state!=='error');
    const rows=workedSessions(reply.sessions.value,reply.basis.range,now);
    const fields=(rows:typeof h.period.workRows)=>rows.map(({ref,workedMs,lastWorkedAt}:any)=>({ref,workedMs,lastWorkedAt})).sort((a:any,b:any)=>a.ref.localeCompare(b.ref));
    assert.equal(h.period.get().error,null);assert.deepEqual(fields(h.period.get().rows),fields(rows));
  };
  try{
    h.directory.saveView(h.board,{...h.directory.view(h.board),shown:['agents'],hidden:['activity','quota-history']},h.alice.id,now);h.events.touchBoards([h.board]);h.events.flush();await flush();
    for(let batch=0;batch<60;batch++){
      await move(NOW+batch*interval);await report(batch,true);
      await move(NOW+batch*interval+2*M);await report(batch,false);
      assert.equal(h.period.get().error,null,`batch ${batch} remains complete`);
      if(batch%10===0||batch===59)oracle();
    }
    const count=periodMs/interval*100;
    assert.equal(h.period.get().rows.length,count);assert.ok(h.period.get().value.refs.length<=count+100);
    assert.ok(h.pool.estimatedBytes<6*1024*1024);assert.ok(peak<=15*1024*1024);
    t.diagnostic(`${count} current contexts; retained ${h.pool.estimatedBytes} bytes; admitted peak ${peak} bytes; ${h.requests.length} requests for 120 accepted reports`);
    const requests=h.requests.length;
    await move(now+periodMs+H);oracle();
    assert.equal(h.requests.length,requests,'clock expiry never reads history');
    assert.equal(h.period.get().rows.length,0);assert.equal(h.period.get().value.refs.length,0);
    assert.ok(h.pool.estimatedBytes<10_000,'expired contexts and their derived indexes are released');
  }finally{await h.close();}
});

for(const periodName of ['1h','30d'])test(`${periodName}: rolling quota, paired money and subscription funds retain only exact boundary evidence`,async t=>{
  const periodMs=periodName==='1h'?H:30*24*H,step=periodMs/60,start=NOW-periodMs;
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({personal:true,periodName,clocked:true,sessionMs:120*24*H});
  const wallet=h.store.source('openrouter','e'.repeat(24),start-H),funds=h.store.source('codex','d'.repeat(24),start-H);
  h.store.hold(wallet,h.alice.id,start-H);h.store.hold(funds,h.alice.id,start-H);
  const currency=h.store.currencies.create(h.alice.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',start-H);h.store.currencies.select(h.alice.id,currency.id);
  h.settings.money={...h.settings.money,selected:{USD:[[wallet,'balance']]}};
  h.settings.funds={...h.settings.funds,selected:{USD:[[funds,'balance:credits']]}};
  const meter=(id:string,amount:string,at:number):Meter=>({id,kind:'counter',unit:'USD',amount,at,staleAfterMs:2*step,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null});
  const record=(at:number,n:number)=>{
    const result=h.hub.ingest.accept({kind:'device',device:h.directory.deviceById(h.device)!},{version:1,agent:'quotum/0.7.0',machine:{id:'machine-0123456789',name:'Work laptop',os:'linux',arch:'x86_64'},sentAt:new Date(at).toISOString(),snapshots:[{provider:'codex',account:'d'.repeat(24),plan:'pro',observedAt:new Date(at).toISOString(),via:'codex/app-server',client:'0.154.0',staleAfterMs:2*step,windows:[{id:'weekly',kind:'weekly',minutes:10080,usedPercent:n%90,resetsAt:new Date(at+7*24*H).toISOString()}],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:String(2500-n),hasCredits:true}]}],failures:[]},at);
    assert.equal(result.accepted,1);
    // Accepted missing observations and unchanged recoveries create real gaps and
    // compressed heads in the same producer store used by connector deliveries.
    const readings=n%11===0?[meter('credits','9007199254741000',at)]:[meter('credits',String(9007199254741000n+BigInt(Math.floor(n/7))*1000000n),at),meter('usage',String(Math.floor(n/3)*1000),at)];
    h.store.record(wallet,{type:'meters',observedAt:at,staleAfterMs:2*step,meters:readings,keys:[],inventoryComplete:true,inventoryError:null});
  };
  const oracle=()=>{
    const selection={mode:'live' as const,periodMs},range={from:now-periodMs,to:now},queries=h.period.queries(h.page.get().board,range);
    const reply=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection,evaluatedAt:now,...queries,sessions:{}})));
    assert.ok(reply.sessions&&reply.sessions.state!=='error');const index=new PeriodIndex(reply.sessions.value);
    for(const scope of PERIOD_SCOPES){
      const part=reply[scope];assert.equal(part?.state,'complete');if(part?.state!=='complete'||!part.value.tape)throw Error('missing evidence');
      const tape=part.value.tape;for(const series of tape.quota)if(series.samplesEncoding==='delta'){series.samples=decodeSamples(series.samples);delete series.samplesEncoding;}
      const expected=new PeriodAccounting(tape,reply.sessions.value,index.curves).fixed(range,step),retained=h.period.tapes.get(scope);
      assert.ok(retained);assert.equal(h.period.projectionErrors[scope],undefined);
      const actual=retained.accounting.fixed(range,step);
      assert.deepEqual(actual,expected,`${scope}: retained accounting, geometry and provenance match a fresh authorized baseline`);
    }
  };
  try{
    for(let i=0;i<60;i++)record(start+i*step,i);
    h.directory.saveView(h.board,{...h.directory.view(h.board),shown:['agents','quota-history','budget-history','subscription-funds'],hidden:['activity']},h.alice.id,now);h.events.touchBoards([h.board]);h.events.flush();await flush();
    for(let i=60;i<180;i++){
      now=start+i*step;h.jump(now);await flush();record(now,i);now++;h.jump(now);h.events.flush();await flush();
      if(i%30===0||i===179)oracle();
      assert.equal(h.period.get().error,null);assert.ok(h.pool.estimatedBytes<=h.pool.budget);
    }
    for(const entry of h.period.tapes.values()){
      for(const series of entry.tape.quota)assert.ok(sampleCount(series.samples)<=62);
      for(const group of entry.tape.money){assert.ok(group.readings.length<=62);assert.ok((group.paired?.readings.length??0)<=62);assert.ok(Object.keys(group.rateBindings?.entries??{}).length<=140);}
    }
    const requests=h.requests.length;now+=periodMs+step;h.jump(now);await flush();oracle();
    assert.equal(h.requests.length,requests,'expiry compacts all families without HTTP');
    for(const entry of h.period.tapes.values()){
      for(const series of entry.tape.quota)assert.equal(sampleCount(series.samples),1,'only the actual predecessor remains');
      for(const group of entry.tape.money){assert.equal(group.readings.length,1);assert.ok((group.paired?.readings.length??0)<=1);assert.ok(group.spans.length<=1);assert.ok(Object.keys(group.rateBindings?.entries??{}).length<=8);}
    }
    if(periodName==='1h'){
      h.settings.range='24h';h.period.changed();await flush();
      assert.ok(h.requests.length>requests,'widening a discarded prefix reads a complete baseline');
      assert.equal(h.requests.find((request,index)=>index>=requests&&request.sessions)?.sessions?.cursor,undefined);
    }
  }finally{await h.close();}
});


test('positive thirty-day work retains one complete analytical basis through a discarded-prefix wait, error and retry',async t=>{
 const periodMs=30*24*H;let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({periodName:'30d',clocked:true,creditFrom:NOW-periodMs,creditTo:NOW,sessionMs:60*24*H}),d=await drawings(h);
 const history=d.render().history;assert.ok(history);const refs=h.period.get().rows.map((r:any)=>r.ref);
 const facts=()=>{const at=h.clock.hubNow(),project=h.period.project(history,'quota',at);return JSON.parse(JSON.stringify({basis:h.period.get().basis.range,rows:h.period.get().rows.map((r:any)=>[r.ref,r.workedMs]),worked:h.period.workedAt(refs,null,at),range:h.period.activityRangeAt(at),quotaRange:h.period.rangeAt('quota',at),summary:h.period.activitySummaryAt('project',at),activity:h.period.activityAt(history,'project',at),geometry:{since:project.since,to:project.to,activity:project.activity}}));};
 try{
  now+=H;h.jump(now);await flush();assert.ok(h.period.get().value.anchor>=NOW-periodMs+H);const retained=facts();assert.ok(retained.worked>0);assert.equal(retained.worked,periodMs-H);
  const waiting=h.hold();h.clock.heard(now-2*H);await flush();assert.equal(h.period.get().loading,true);assert.deepEqual(facts(),retained,'all positive scalars, coverage, ranges and geometry keep the same complete basis');
  waiting.reject(new Error('baseline unavailable'));await flush();assert.ok(h.period.get().error);assert.deepEqual(facts(),retained,'an error keeps the complete basis until retry succeeds');
  const retry=h.hold();h.period.retry();await flush();assert.equal(h.period.get().loading,true);assert.deepEqual(facts(),retained);retry.release();await flush();
  assert.equal(h.period.get().error,null);assert.equal(h.period.get().loading,false);const at=h.clock.hubNow(),reply=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs},evaluatedAt:at,sessions:{}})));
  assert.ok(reply.sessions&&reply.sessions.state!=='error');const expected=workedSessions(reply.sessions.value,reply.basis.range,at);assert.equal(h.period.get().rows[0].workedMs,expected[0].workedMs);assert.equal(h.period.workedAt(refs,null,at),expected[0].workedMs);assert.deepEqual(h.period.activityRangeAt(at),reply.basis.range);assert.equal(h.period.activitySummaryAt('project',at).agentMs,expected[0].workedMs);
 }finally{d.close();await h.close();}
});
