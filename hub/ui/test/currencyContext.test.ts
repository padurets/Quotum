import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {Projection} from '../../server/projection.js';
import {Ingest} from '../../server/ingest.js';
import {Duty} from '../../server/duty.js';
import {Cadence} from '../../server/cadence.js';
import {ResetFeed} from '../../server/resets.js';
import {Pairing} from '../../server/pairing.js';
import {Setup} from '../../server/setup.js';
import {buildApp} from '../../server/api.js';
import {newSecret} from '../../server/domain/auth.js';
import {deepSeekMeasurement} from '../../server/connectors/deepseek.js';
import {moneySelection,readMoney} from '../lib/moneySelection';
import {budgetView,capLeft,capPercent,money} from '../lib/money';
import {displayMeter} from '../../server/domain/currencyPresentation.js';
import {ratePath,convertBy,exchangeRatesOf} from '../../server/domain/currency.js';
import {composeMeters} from '../../server/domain/meterHistory.js';
import {displayHistory} from '../../server/currencies/history.js';
import type {Meter} from '../../server/domain/meters.js';
import {config} from '../../server/config.js';

const date=Date.UTC(2026,9,6),at=date+12*3_600_000;
const meter=(id='balance',amount='37000000',unit='USD'):Meter=>({id,unit,amount,kind:'balance',at,staleAfterMs:3_600_000,stale:false,limit:null,resetAt:null,minutes:null,scope:'account',label:null});
function fixture(file=':memory:') {
  const store=new Store(file,at),directory=new Directory(store.db),alice=directory.createUser('a@example.com','A','fixture',at),bob=directory.createUser('b@example.com','B','fixture',at);
  const board=directory.createBoard('Shared',alice.id,at);directory.addMember(board.id,bob.id,at);
  const source=store.source('openrouter','1'.repeat(24),at);store.hold(source,alice.id,at);store.share(board.id,source,alice.id,at);
  const caps={...meter('key:aaaaaaaaaaaa:cap','3000000'),kind:'cap' as const,limit:'10000000'};
  store.record(source,{type:'meters',observedAt:at,staleAfterMs:3_600_000,meters:[{...meter('credits','50000000'),kind:'counter'},{...meter('usage','13000000'),kind:'counter'},caps],keys:[{id:'aaaaaaaaaaaa',name:'K',at,staleAfterMs:3_600_000,presence:'observed',missCount:0,disabled:false,expiresAt:null,includeByok:false,periods:{day:null,week:null,month:null}}],inventoryComplete:true,inventoryError:null});
  const ingest=new Ingest(store,directory,new Duty(),new Cadence()),resets=new ResetFeed(undefined,()=>{}),hub={store,directory,ingest,resets,pairing:new Pairing(directory),setup:new Setup(false,null),local:null};
  return {store,directory,alice,bob,board,source,hub,projection:new Projection(hub)};
}
const personal=(h:ReturnType<typeof fixture>,owner:string,symbol:string,rate='2000000')=>h.store.currencies.create(owner,{name:'Personal',symbol,fractionDigits:2},'USD',rate,at);

test('standard currency definitions preserve minor-unit precision in the common formatter',()=>{
  const h=fixture();try {
    for(const [id,digits,formatted] of [['KWD',3,'3.125 KWD'],['BHD',3,'3.125 BHD'],['TND',3,'3.125 TND'],['ISK',0,'3 ISK'],['UGX',0,'3 UGX']] as const) {
      h.store.currencies.select(h.alice.id,id);const context=h.store.currencies.context(h.alice.id);
      assert.equal(context.target.fractionDigits,digits);assert.equal(money('3125000',id,false,context),formatted);
    }
  }finally{h.store.close();}
});

test('a shared board keeps native facts common while funds, caps and formatting use each reader currency',()=>{
  const h=fixture();try {
    const a=personal(h,h.alice.id,'AP'),b=personal(h,h.bob.id,'BP','5000000');assert.notEqual(a.id,b.id);
    h.store.currencies.select(h.alice.id,a.id);h.store.currencies.select(h.bob.id,b.id);
    const first=h.projection.snapshot(h.alice.id,h.board.id,at)!,second=h.projection.snapshot(h.bob.id,h.board.id,at)!;
    assert.deepEqual(first.sources,second.sources);
    const av=budgetView(first.sources[0],first.sources[0].keys,first.sources[0].meters,first.currencies),bv=budgetView(second.sources[0],second.sources[0].keys,second.sources[0].meters,second.currencies);
    assert.equal(av.remaining.values[0].total.amount,'74000000');assert.equal(bv.remaining.values[0].total.amount,'185000000');
    assert.equal(capLeft(av.limits[0].meter),'14000000');assert.equal(capLeft(bv.limits[0].meter),'35000000');assert.equal(capPercent(av.limits[0].native),30);assert.equal(capPercent(bv.limits[0].native),30);
    assert.equal(money(av.remaining.values[0].total.amount,a.id,false,first.currencies),'74.00 AP');
    assert.ok(!JSON.stringify(second.currencies).includes(a.id));assert.throws(()=>h.store.currencies.definition(h.bob.id,a.id));assert.throws(()=>h.store.currencies.select(h.bob.id,a.id));
    const privateQuote=h.store.db.prepare('SELECT id FROM exchange_rates WHERE owner_id=?').get(h.alice.id)!.id as string;assert.equal(h.store.currencies.get(privateQuote),null);assert.equal(h.store.currencies.get(privateQuote,h.bob.id),null);
  }finally{h.store.close();}
});

test('a private currency absent a public feed composes exact paths and keeps original CNY precision',()=>{
  const h=fixture();try {
    const c=personal(h,h.alice.id,'AP');h.store.currencies.select(h.alice.id,c.id);
    const source=h.store.source('deepseek','2'.repeat(24),at);h.store.hold(source,h.alice.id,at);h.store.share(h.board.id,source,h.alice.id,at);
    const measured=deepSeekMeasurement({is_available:true,balance_infos:[{currency:'CNY',total_balance:'110',granted_balance:'10',topped_up_balance:'100'}]},at);h.store.record(source,measured);
    const quote=h.store.currencies.save({source:'another_bank',base:'EUR',date,fetchedAt:at,rates:{EUR:'1000000',USD:'1000000',CNY:'7000000'}});for(const m of measured.meters)h.store.currencies.record(source,m,'USD',quote);
    const snapshot=h.projection.snapshot(h.alice.id,h.board.id,at)!,card=snapshot.sources.find(s=>s.id===source)!,view=budgetView(card,[],card.meters,snapshot.currencies);
    assert.equal(view.remaining.values[0].total.amount,'31428571');assert.equal(view.remaining.values[0].total.conversion?.original.amount,'110000000');assert.equal(view.remaining.values[0].total.conversion?.steps?.length,2);
    const path=ratePath(c.id,'EUR',[...h.store.db.prepare('SELECT id FROM exchange_rates').all()].flatMap(r=>h.store.currencies.get(String(r.id),h.alice.id)??[]),at);assert.ok(path);assert.equal(convertBy('7000000',path),'3500000');
    assert.equal(exchangeRatesOf({...quote,source:'a_different_source'}).source,'a_different_source');
  }finally{h.store.close();}
});

test('missing quotes and overflowing results keep native limits and distinct unknown versus zero',()=>{
  const h=fixture();try {
    h.store.currencies.select(h.alice.id,'EUR');const snap=h.projection.snapshot(h.alice.id,h.board.id,at)!,card=snap.sources[0],view=budgetView(card,card.keys,card.meters,snap.currencies);
    assert.equal(view.remaining.values.length,0);assert.equal(view.limits.length,1);assert.equal(view.limits[0].unavailable,true);assert.equal(capPercent(view.limits[0].native),30);
    const c=personal(h,h.alice.id,'BIG','9223372036854775807');h.store.currencies.select(h.alice.id,c.id);const context=h.projection.snapshot(h.alice.id,h.board.id,at)!.currencies;
    assert.equal(displayMeter(meter(),h.source,context),null);const zero=displayMeter(meter('balance','0'),h.source,context);assert.equal(zero?.amount,'0');
  }finally{h.store.close();}
});

test('reader preferences and sparse pinned paths survive restart and later quote versions',()=>{
  const root=mkdtempSync(join(tmpdir(),'quotum-currency-context-')),file=join(root,'hub.sqlite');const h=fixture(file);let store=h.store;
  try {
    const c=personal(h,h.alice.id,'AP');store.currencies.select(h.alice.id,c.id);
    const initial=store.currencies.binding(h.alice.id,'USD',c.id,at)!;
    store.currencies.binding(h.alice.id,'USD',c.id,at+1000);assert.equal(store.db.prepare('SELECT count(*) n FROM currency_bindings').get()?.n,1);
    store.currencies.setRate(h.alice.id,c.id,'USD','3000000',at+2000,at+2000);
    assert.deepEqual(store.currencies.binding(h.alice.id,'USD',c.id,at),initial);assert.equal(convertBy('1000000',store.currencies.binding(h.alice.id,'USD',c.id,at+3000)!), '3000000');
    store.close();store=new Store(file,at+4000);assert.equal(store.currencies.preference(h.alice.id).id,c.id);assert.deepEqual(store.currencies.binding(h.alice.id,'USD',c.id,at),initial);
    store.currencies.prune(at+4000);assert.ok(store.currencies.get(initial[0].id,h.alice.id));
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('retention preserves the pinned rate of a native predecessor serving a retained partial cell',async t=>{
  const h=fixture(),target=personal(h,h.alice.id,'AP'),source=h.store.source('deepseek','3'.repeat(24),1);h.store.hold(source,h.alice.id,1);h.store.currencies.select(h.alice.id,target.id);
  const observe=(time:number,total:string)=>{h.store.record(source,deepSeekMeasurement({is_available:true,balance_infos:[{currency:'USD',total_balance:total,granted_balance:'0',topped_up_balance:total}]},time));h.store.currencies.context(h.alice.id,{[source]:h.store.state(source).meters!.map(m=>({unit:m.unit,at:m.at}))});};
  observe(1,'10');observe(30000,'11');h.store.currencies.setRate(h.alice.id,target.id,'USD','3000000',100000,100000);observe(120000,'12');observe(180000,'12');
  h.store.currencies.setRate(h.alice.id,target.id,'USD','5000000',10000,190000);
  const now=90000+config.retention.sampleDays*86400000;t.mock.method(Date,'now',()=>now);
  const app=await buildApp(h.hub);t.after(async()=>{await app.close();h.store.close();});
  const token=newSecret('qt_s');h.directory.createSession(token,h.alice.id,now,60000);const board=h.directory.boards(h.alice.id).find(b=>b.personal)!.id;
  const read=async()=>{const r=await app.inject({method:'GET',url:'/api/history?board='+board+'&cell=60000&from=60000&to=120000&unit=USD&meters='+encodeURIComponent(JSON.stringify([[source,'balance:USD']]))+'&currency='+encodeURIComponent(target.id),headers:{cookie:'quotum_session='+token}});assert.equal(r.statusCode,200);return composeMeters(r.json().chunks,60000,60000,120000)[0];};
  const before=await read();assert.equal(before.end,'22000000');h.store.prune(now);const after=await read();assert.equal(after.end,before.end);assert.equal(after.points[0].semantics?.conversion?.rate.id,before.points[0].semantics?.conversion?.rate.id);
});

test('foreign display transforms native accounting instead of inferring expenses from rate movement',()=>{
  const h=fixture();try {
    const c=personal(h,h.alice.id,'AP');h.store.currencies.select(h.alice.id,c.id);
    const chunks=[{from:at,to:at+60_000,series:[],resets:[],grants:[],activity:{devices:{},sources:{},projects:{},sessions:[],cells:[]},meterSeries:h.store.meters.cells({unit:'USD',ids:[[h.source,'balance']]},at,at+60_000,60_000)}];
    const displayed=displayHistory(chunks,h.store.currencies,h.alice.id,c.id,60_000),series=composeMeters(displayed,60_000,at,at+60_000)[0];assert.equal(series.end,'74000000');assert.equal(series.spent,'0');assert.equal(series.topup,'0');
    assert.equal(h.store.state(h.source).meters?.find(m=>m.id==='usage')?.amount,'13000000');
  }finally{h.store.close();}
});

test('the owner API changes one shared currency context and refuses another reader personal definition',async t=>{
  t.mock.method(Date,'now',()=>at);const h=fixture(),app=await buildApp(h.hub);t.after(async()=>{await app.close();h.store.close();});
  const cookies=new Map<string,string>();for(const user of [h.alice,h.bob]){const token=newSecret('qt_s');h.directory.createSession(token,user.id,at,60_000);cookies.set(user.id,'quotum_session='+token);}
  const call=(owner:string,method:'GET'|'POST',url:string,payload?:object)=>app.inject({method,url,payload,headers:{cookie:cookies.get(owner),origin:'http://localhost'}});
  const created=await call(h.alice.id,'POST','/api/currencies',{name:'Points',symbol:'AP',fractionDigits:2,base:'USD',rate:'2000000'});assert.equal(created.statusCode,201);const id=created.json().id as string;
  assert.equal((await call(h.alice.id,'POST','/api/currencies/display',{currency:id})).statusCode,200);assert.equal((await call(h.bob.id,'POST','/api/currencies/display',{currency:id})).statusCode,400);
  const a=await call(h.alice.id,'GET','/api/overview?board='+h.board.id),b=await call(h.bob.id,'GET','/api/overview?board='+h.board.id);assert.equal(a.json().currencies.target.id,id);assert.equal(b.json().currencies.target.id,'USD');assert.ok(!b.body.includes(id));
  const detail=await call(h.alice.id,'GET','/api/currencies/'+encodeURIComponent(id));assert.equal(detail.statusCode,200);assert.equal(detail.json().rates[0].rates[id],'2000000');assert.equal((await call(h.bob.id,'GET','/api/currencies/'+encodeURIComponent(id))).statusCode,404);
  const url='/api/history?board='+h.board.id+'&cell=60000&from='+at+'&to='+(at+60_000)+'&unit=USD&meters='+encodeURIComponent(JSON.stringify([[h.source,'balance']]))+'&currency='+encodeURIComponent(id);
  const history=await call(h.alice.id,'GET',url);assert.equal(history.statusCode,200);assert.equal(composeMeters(history.json().chunks,60_000,at,at+60_000)[0].end,'74000000');assert.equal((await call(h.bob.id,'GET',url)).statusCode,404);
});

test('a full reader history loads bindings by series and keeps repeated conversion semantics sparse',async t=>{
  t.mock.method(Date,'now',()=>at);const h=fixture(),target=personal(h,h.alice.id,'PT');h.store.currencies.select(h.alice.id,target.id);
  const from=at-480*60000,ids:[string,string][]=[];
  for(let index=0;index<32;index++) {
    const source=h.store.source('deepseek',(index+100).toString(16).padStart(24,'0'),from);h.store.hold(source,h.alice.id,from);ids.push([source,'balance:USD']);
    for(let time=from+1;time<at;time+=300000)h.store.record(source,deepSeekMeasurement({is_available:true,balance_infos:[{currency:'USD',total_balance:'100',granted_balance:'10',topped_up_balance:'90'}]},time));
    h.store.record(source,deepSeekMeasurement({is_available:true,balance_infos:[{currency:'USD',total_balance:'100',granted_balance:'10',topped_up_balance:'90'}]},at-1));
  }
  const app=await buildApp(h.hub);t.after(async()=>{await app.close();h.store.close();});
  const token=newSecret('qt_s');h.directory.createSession(token,h.alice.id,at,60000);const board=h.directory.boards(h.alice.id).find(b=>b.personal)!.id;
  const url='/api/history?board='+board+'&cell=60000&from='+from+'&to='+at+'&unit=USD&meters='+encodeURIComponent(JSON.stringify(ids))+'&currency='+encodeURIComponent(target.id);
  const prepare=h.store.db.prepare.bind(h.store.db);let reads=0;
  t.mock.method(h.store.db,'prepare',(...args:Parameters<typeof prepare>)=>{reads++;return prepare(...args);});
  for(let repeat=0;repeat<2;repeat++) {
    reads=0;const response=await app.inject({method:'GET',url,headers:{cookie:'quotum_session='+token}});assert.equal(response.statusCode,200);assert.ok(reads<300,`${reads} SQL preparations`);
    const chunks=response.json().chunks,series=chunks.flatMap((chunk:{meterSeries?:{cells:unknown[][]}[]})=>chunk.meterSeries??[]);
    assert.ok(series.reduce((count:number,s:{cells:unknown[][]})=>count+s.cells.length,0)>10000);
    const metadata=series.reduce((count:number,s:{cells:unknown[][]})=>count+s.cells.filter(row=>(row[5] as {semantics?:unknown})?.semantics).length,0);
    assert.ok(metadata<series.reduce((count:number,s:{cells:unknown[][]})=>count+s.cells.length,0)/2,`${metadata} repeated metadata records`);
    for(const result of composeMeters(chunks,60000,from,at))assert.equal(result.end,'200000000');
  }
});

test('a new price revision refreshes missing foreign history without changing default reference requests',()=>{
  const h=fixture();try {
    h.store.currencies.select(h.alice.id,'EUR');const first=h.store.currencies.context(h.alice.id);
    h.store.currencies.save({source:'ecb',base:'EUR',date,fetchedAt:at,rates:{EUR:'1000000',USD:'2000000'}});const second=h.store.currencies.context(h.alice.id);
    assert.notEqual(first.revision,second.revision);const prefs=readMoney({unit:'USD'}),card=h.projection.snapshot(h.alice.id,h.board.id,at)!.sources[0];assert.notDeepEqual(moneySelection([card],[],prefs,first).selection,moneySelection([card],[],prefs,second).selection);assert.equal(h.store.currencies.context(h.bob.id).revision,undefined);
    const quote=h.store.currencies.latest(at)!;assert.throws(()=>{quote.rates.USD='9000000';});
    assert.equal(h.store.currencies.latest(at)?.rates.USD,'2000000');
  }finally{h.store.close();}
});
