import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deepSeek,deepSeekMeasurement} from '../connectors/deepseek.js';
import {ConnectorTransport} from '../connectors/transport.js';
import {convertMoney,conversionId,ratePath,type RateSnapshot,type ExchangeRates} from '../domain/currency.js';
import {parseEcb,ecbReader} from '../currencies/ecb.js';
import {Currencies} from '../currencies/service.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Credentials} from '../secrets/credentials.js';
import {SecretKey} from '../secrets/crypto.js';
import {startSecrets} from '../secrets/start.js';
import {composeMeters} from '../domain/meterHistory.js';
import type {Meter} from '../domain/meters.js';
import {CurrencyBindings,type BindingRange} from '../store/currencyBindings.js';

const DAY=86_400_000,date=Date.UTC(2026,9,5),at=date+12*3_600_000;
const xml=(day='2026-10-05',usd='1',cny='7')=>`<Cube><Cube time='${day}'><Cube currency='USD' rate='${usd}'/><Cube currency='CNY' rate='${cny}'/><Cube currency='GBP' rate='0.8'/></Cube></Cube>`;
const rates=()=>parseEcb(xml(),at);
const row=(currency='CNY',total='110')=>({currency,total_balance:total,granted_balance:'10',topped_up_balance:'100'});
const measurement=(time=at,rows=[row()])=>deepSeekMeasurement({is_available:true,balance_infos:rows},time);
const native=(unit:string,amount='110000000'):Meter=>({id:'wallet',unit,amount,kind:'balance',at,staleAfterMs:60_000,stale:false,limit:null,resetAt:null,minutes:null,scope:'wallet-scope',label:'Wallet'});

test('missing paths scan rate legs linearly rather than every pair of quote versions',()=>{
  const target='personal:'+'1'.repeat(24),quotes:RateSnapshot[]=[];let reads=0;
  for(let index=0;index<500;index++) {
    const rates={USD:'1000000',[target]:String(2000000+index)};
    quotes.push({id:String(index),source:'manual',base:'USD',date:0,fetchedAt:index,validUntil:null,get rates(){reads++;return rates;}});
  }
  assert.equal(ratePath('CNY',target,quotes,at),null);assert.ok(reads<quotes.length*10,`${reads} rate reads`);
});

test('retention removes unused private revisions while retaining nominal and pinned quotes',()=>{
  const store=new Store(':memory:',at),directory=new Directory(store.db),owner=directory.createUser('rates@example.com','Owner','fixture',at);
  try {
    const target=store.currencies.create(owner.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',at);
    const initial=store.currencies.binding(owner.id,'USD',target.id,1)!;
    for(let index=1;index<=1000;index++)store.currencies.setRate(owner.id,target.id,'USD',String(2000000+index),index,at);
    const pinned=store.currencies.binding(owner.id,'USD',target.id,500)!;
    store.currencies.prune(2000);
    assert.equal(store.db.prepare('SELECT count(*) n FROM exchange_rates WHERE owner_id=?').get(owner.id)?.n,3);
    assert.ok(store.currencies.get(initial[0].id,owner.id));assert.ok(store.currencies.get(pinned[0].id,owner.id));
    assert.deepEqual(store.currencies.binding(owner.id,'USD',target.id,500),pinned);
  }finally{store.close();}
});

test('zero-date updates cannot bypass retention or replace the initial nominal reference',()=>{
  const store=new Store(':memory:',at),directory=new Directory(store.db),owner=directory.createUser('nominal@example.com','Owner','fixture',at);
  try {
    const target=store.currencies.create(owner.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',1);
    const initial=store.db.prepare('SELECT initial_quote_id id FROM currency_definitions WHERE id=?').get(target.id)!.id as string;
    for(let version=1;version<=1000;version++)store.currencies.setRate(owner.id,target.id,'USD',String(2000000+version),0,version+1);
    store.currencies.prune(at);
    assert.equal(store.db.prepare('SELECT count(*) n FROM exchange_rates WHERE owner_id=?').get(owner.id)?.n,2);
    assert.equal(store.currencies.get(initial,owner.id)?.rates[target.id],'2000000');
  }finally{store.close();}
});

test('a warmed binding index does not reread its archive for each history cell',()=>{
  let reads=0;
  const rows:BindingRange[]=Array.from({length:1000},(_,index)=>({get observation_at(){reads++;return index*60000;},through_at:index*60000+50000,anchor:'',steps:'[]'}));
  const binder=new CurrencyBindings('EUR',()=>rows,()=>null,()=>{throw new Error('read-only range');});
  binder.observationAt('source','USD',60000);reads=0;
  for(let index=0;index<480;index++)assert.notEqual(binder.observationAt('source','USD',(index+1)*60000),null);
  assert.ok(reads<10000,`${reads} archive reads`);
});

test('currency arithmetic handles arbitrary pairs, exact signs, zero and values above Number precision',()=>{
  const quote=rates();
  assert.equal(convertMoney(native('CNY'),'USD',quote)?.amount,'15714286');
  assert.equal(convertMoney(native('CNY','-110000000'),'USD',quote)?.amount,'-15714286');
  assert.equal(convertMoney(native('CNY','0'),'USD',quote)?.amount,'0');
  assert.equal(convertMoney(native('EUR'),'USD',quote)?.amount,'110000000');
  assert.equal(convertMoney(native('GBP'),'USD',quote)?.amount,'137500000');
  assert.equal(convertMoney(native('USD'),'GBP',quote)?.amount,'88000000');
  assert.equal(convertMoney(native('EUR','9007199254740993'),'USD',{...quote,rates:{...quote.rates,USD:'500000'}})?.amount,'4503599627370497');
  assert.equal(convertMoney(native('JPY'),'USD',quote),null);assert.equal(convertMoney(native('tokens'),'USD',quote),null);
  assert.deepEqual(convertMoney(native('USD'),'USD',{...quote,rates:{}}),{amount:'110000000',unit:'USD'});
});

test('the public source validates dated quotes and bounds its fixed credential-free transport',async()=>{
  for(const invalid of [xml('2026-10-06'),xml('2026-09-20'),xml('2026-02-30'),xml('2026-10-05','0'),xml().replace('</Cube>',"<Cube currency='USD' rate='2'/></Cube>"),'x'.repeat(65_537)])assert.throws(()=>parseEcb(invalid,at));
  const read=ecbReader(async(input,options)=>{
    assert.equal(input,'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');assert.equal(options?.redirect,'error');assert.ok(options?.signal);
    assert.deepEqual(options?.headers,{Accept:'application/xml'});return new Response(xml(),{headers:{'Content-Type':'application/xml'}});
  },()=>at);
  assert.deepEqual(await read(new AbortController().signal),rates());
  await assert.rejects(ecbReader(async()=>new Response('bad',{status:503}),()=>at)(new AbortController().signal));
  await assert.rejects(ecbReader(async()=>new Response('x'.repeat(65_537),{headers:{'Content-Type':'application/xml'}}),()=>at)(new AbortController().signal));
});

test('DeepSeek captures native observations without a currency service or any derived fields',async()=>{
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}}),secret=Buffer.from('sk-'+'a'.repeat(32));
  transport.send=async(operation,token)=>{assert.equal(operation,'balance');assert.equal(token,secret);return {is_available:true,balance_infos:[row()]};};
  try {const adapter=deepSeek(transport,()=>at),reply=await adapter.identify(secret);assert.equal(reply.measurement?.meters.length,3);assert.ok(reply.measurement?.meters.every(m=>m.unit==='CNY'&&!m.conversion));assert.ok(!JSON.stringify(reply).includes('usdRate'));}finally{transport.close();}
});

test('provider capture commits before a blocked currency read; accounts share one persisted quote and survive offline restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'quotum-currencies-')),file=join(dir,'hub.sqlite');let store=new Store(file,at),calls=0;
  let release!:(value:ExchangeRates)=>void;const pending=new Promise<ExchangeRates>(resolve=>{release=resolve;});
  let service=new Currencies(store,async()=>{calls++;return pending;},()=>at);service.start();
  try {
    const a=store.source('deepseek','1'.repeat(24),at),b=store.source('deepseek','2'.repeat(24),at);
    store.record(a,measurement());store.record(b,measurement());
    const first=service.update(a),second=service.update(b);
    assert.equal(store.state(a).meters?.length,3);assert.equal(store.meters.readings(a,'balance:CNY',0,at+1)[0].amount,'110000000');assert.equal(calls,1);
    release(rates());await Promise.all([first,second]);
    assert.equal(store.db.prepare('SELECT count(*) n FROM exchange_rates').get()?.n,1);
    assert.equal(store.currencies.project(a,store.state(a).meters![0],'USD',at)?.conversion?.rate.id,store.currencies.project(b,store.state(b).meters![0],'USD',at)?.conversion?.rate.id);
    await service.stop();store.close();store=new Store(file,at+1000);
    service=new Currencies(store,async()=>{throw new Error('must use persisted cache');},()=>at+1000);service.start();
    store.record(a,measurement(at+1000));await service.update(a);
    assert.equal(store.currencies.project(a,store.state(a).meters![0],'USD',at+1000)?.amount,'15714286');
  }finally{await service.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('native USD is independent of reference availability; rate failures leave provider facts and key health unchanged',async()=>{
  const store=new Store(':memory:',at);let calls=0;const service=new Currencies(store,async()=>{calls++;throw new Error('SECRET_CANARY');},()=>at);service.start();
  try {
    const usd=store.source('deepseek','1'.repeat(24),at),cny=store.source('deepseek','2'.repeat(24),at);
    store.record(usd,measurement(at,[row(),row('USD','37')]));await service.update(usd);assert.equal(calls,0);
    store.record(cny,measurement());const original=store.state(cny);await service.update(cny);
    assert.deepEqual(store.state(cny),original);assert.equal(store.state(cny).error,null);assert.equal(store.state(cny).balanceStatus?.partial,false);assert.equal(calls,1);
    await service.update(cny);assert.equal(calls,1);assert.equal(store.db.prepare('SELECT count(*) n FROM money_valuations').get()?.n,0);
    assert.ok(!JSON.stringify(store.state(cny)).includes('SECRET_CANARY'));
  }finally{await service.stop();store.close();}
});

test('a late rate reply cannot restore missing provider balances or recreate a removed source',async()=>{
  const store=new Store(':memory:',at);let release!:(value:ExchangeRates)=>void;const service=new Currencies(store,()=>new Promise(resolve=>{release=resolve;}),()=>at);service.start();
  try {
    const id=store.source('deepseek','1'.repeat(24),at);store.record(id,measurement());const update=service.update(id);
    store.record(id,measurement(at+1,[]));release(rates());await update;
    assert.equal(store.db.prepare('SELECT count(*) n FROM money_valuations').get()?.n,0);assert.ok(store.state(id).meters?.every(m=>m.stale));
    store.db.prepare('DELETE FROM sources WHERE id=?').run(id);await service.update(id);assert.equal(store.db.prepare('SELECT 1 FROM sources WHERE id=?').get(id),undefined);
  }finally{await service.stop();store.close();}
});

test('shared valuations preserve original scope and immutable historical provenance without turning exchange movements into spending',()=>{
  const store=new Store(':memory:',at);try {
    const id=store.source('deepseek','1'.repeat(24),at),first=measurement();store.record(id,first);
    const q1=store.currencies.save(rates());for(const m of first.meters)store.currencies.record(id,m,'USD',q1);
    const nextAt=at+DAY,next=measurement(nextAt),q2=store.currencies.save(parseEcb(xml('2026-10-06','2','7'),nextAt));store.record(id,next);for(const m of next.meters)store.currencies.record(id,m,'USD',q2);
    const rows=store.currencies.readings(id,conversionId('balance:CNY','USD'),0,nextAt+1);assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.conversion?.rate.id),[q1.id,q2.id]);assert.equal(rows[0].scope,first.meters[0].scope);assert.equal(rows[0].label,first.meters[0].label);
    const history=composeMeters([{from:at,meterSeries:store.meters.cells({unit:'USD',ids:[[id,conversionId('balance:CNY','USD')]]},at,nextAt+60_000,60_000)}],60_000,at,nextAt+60_000)[0];
    assert.equal(history.spent,null);assert.equal(history.topup,null);assert.equal(history.semantics?.conversion?.rate.id,q2.id);assert.ok(history.points.some(p=>p.semantics?.conversion?.rate.id===q1.id));
    store.currencies.save({...rates(),fetchedAt:nextAt});assert.equal(store.currencies.get(q1.id)?.fetchedAt,at);
    store.record(id,measurement(nextAt+120_000,[]));store.currencies.interrupt(id,'balance:CNY','USD',nextAt+120_000);
    assert.equal(store.currencies.project(id,store.state(id).meters![0],'USD',nextAt+120_000)?.stale,true);
  }finally{store.close();}
});

test('the valuation store reuses the same quote across providers and currencies without provider-specific fields',()=>{
  const store=new Store(':memory:',at);try {
    const a=store.source('deepseek','1'.repeat(24),at),b=store.source('openrouter','2'.repeat(24),at),quote=store.currencies.save(rates());
    const cny=native('CNY'),gbp=native('GBP');store.currencies.record(a,cny,'USD',quote);store.currencies.record(b,gbp,'USD',quote);
    const first=store.currencies.project(a,cny,'USD',at)!,second=store.currencies.project(b,gbp,'USD',at)!;
    assert.equal(first.conversion?.rate.id,second.conversion?.rate.id);assert.equal(second.amount,'137500000');assert.equal(second.scope,'wallet-scope');assert.equal(second.label,'Wallet');
    assert.equal(second.conversion?.original.unit,'GBP');assert.ok(!JSON.stringify(second).includes('cnyPerEur'));
    assert.equal(store.db.prepare('SELECT count(*) n FROM exchange_rates').get()?.n,1);
  }finally{store.close();}
});

test('a native USD arrival ends derived availability without another rate request',async()=>{
  const store=new Store(':memory:',at);let calls=0;const service=new Currencies(store,async()=>{calls++;return rates();},()=>at);service.start();
  try {
    const id=store.source('deepseek','1'.repeat(24),at);store.record(id,measurement());await service.update(id);
    store.record(id,measurement(at+1000,[row(),row('USD','37')]));await service.update(id);
    assert.equal(calls,1);assert.equal(store.currencies.spans(id,conversionId('balance:CNY','USD'),at+1001)[0].interruptedAt,at+1000);
    assert.equal(store.currencies.project(id,store.state(id).meters![0],'USD',at+1000)?.stale,true);
  }finally{await service.stop();store.close();}
});

test('retention keeps the last valuation predecessor and every quote referenced by retained history',()=>{
  const store=new Store(':memory:',at);try {
    const id=store.source('deepseek','1'.repeat(24),at),quote=store.currencies.save(rates());
    for(const [offset,value] of [[0,'1000000'],[1000,'2000000'],[2000,'3000000']] as const)store.currencies.record(id,{...native('CNY',value),at:at+offset},'USD',quote);
    assert.equal(store.currencies.prune(at+500),false);
    assert.equal(store.currencies.prune(at+2500),true);
    const values=store.currencies.readings(id,conversionId('wallet','USD'),0,at+3000);assert.equal(values.length,1);assert.equal(values[0].conversion?.rate.id,quote.id);assert.ok(store.currencies.get(quote.id));
  }finally{store.close();}
});

test('the ordinary credential path commits native capture and clears provider buffers before its scheduled reference read',async()=>{
  const store=new Store(':memory:',at),directory=new Directory(store.db),owner=directory.createUser('fx@example.com','Owner','fixture-password',at);
  const key=SecretKey.parse(Buffer.from(Buffer.alloc(32,7).toString('base64url'))),report=startSecrets(store.db,{current:key,previous:null,reset:null,storageAtStart:null,wasFileAtStart:false});
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});let captured:Buffer|undefined,reads=0;
  transport.send=async(_operation,bytes)=>{captured=bytes;return {is_available:true,balance_infos:[row()]};};
  const credentials=new Credentials(store,key,report,new Map([['deepseek',deepSeek(transport,()=>at)]]));
  const service=new Currencies(store,async signal=>{
    reads++;assert.ok(signal instanceof AbortSignal);assert.ok(captured?.every(byte=>byte===0));
    assert.equal(store.db.prepare("SELECT count(*) n FROM readings WHERE meter_id='balance:CNY'").get()?.n,1);
    return rates();
  },()=>at);service.start();
  try {
    const created=await credentials.create(owner.id,'deepseek','sk-'+'a'.repeat(32),{account:{kind:'new',name:'Personal'},allowUnknownExpiry:true});
    assert.equal(reads,0);await new Promise<void>(resolve=>setImmediate(resolve));await service.update(created.sourceId!);
    assert.equal(reads,1);assert.equal(store.currencies.project(created.sourceId!,store.state(created.sourceId!).meters![0],'USD',at)?.amount,'15714286');
  }finally{await service.stop();transport.close();store.close();}
});
