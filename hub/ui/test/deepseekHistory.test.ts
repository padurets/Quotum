import {defaultCurrencyContext} from '../../server/domain/currency';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {config} from '../../server/config';
import {buildApp} from '../../server/api';
import {Ingest} from '../../server/ingest';
import {Duty} from '../../server/duty';
import {Cadence} from '../../server/cadence';
import {Pairing} from '../../server/pairing';
import {ResetFeed} from '../../server/resets';
import {Setup} from '../../server/setup';
import {newSecret} from '../../server/domain/auth';
import {deepSeekMeasurement} from '../../server/connectors/deepseek';
import {composeMeters,composeMetersPrepared} from '../../server/domain/meterHistory';
import {MeterTile} from '../lib/meterTiles';
import {moneyPointAt,moneyIdentity} from '../lib/moneyView';
import {moneySelection,readMoney} from '../lib/moneySelection';
import {balanceGroups} from '../lib/money';
import {plotPathPrepared,observationRunsPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {readout} from '../lib/readout';
import {drain} from '../lib/prepare';
import {preparationFixture} from './preparationFixture';
import type {Card} from '../lib/types';
import type {Line} from '../lib/lines';

const answer=(amount='110')=>({is_available:true,balance_infos:[{currency:'CNY',total_balance:amount,granted_balance:'10',topped_up_balance:'100'}]});

test('reader valuations keep unchanged native amounts on their assigned timelines through retention and packing',async t=>{
  const store=new Store(':memory:',1),directory=new Directory(store.db),owner=directory.createUser('timeline@fixture.example','Fixture','unused',1),board=directory.boards(owner.id)[0].id;
  const source=store.source('deepseek','4'.repeat(24),1);store.hold(source,owner.id,1);
  const target=store.currencies.create(owner.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',1);store.currencies.select(owner.id,target.id);
  const observe=(at:number)=>{store.record(source,deepSeekMeasurement({is_available:true,balance_infos:[{currency:'USD',total_balance:'100',granted_balance:'0',topped_up_balance:'100'}]},at));store.currencies.context(owner.id,{[source]:store.state(source).meters!.map(m=>({unit:m.unit,at:m.at}))});};
  observe(50000);store.currencies.setRate(owner.id,target.id,'USD','3000000',70000,70000);observe(80000);store.currencies.setRate(owner.id,target.id,'USD','4000000',90000,90000);observe(100000);
  let now=120000;t.mock.method(Date,'now',()=>now);
  const app=await buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),pairing:new Pairing(directory),resets:new ResetFeed(undefined,()=>{}),setup:new Setup(false,null),local:null});
  t.after(async()=>{await app.close();store.close();});
  for(const retained of [false,true]) {
    if(retained){now=60010+config.retention.sampleDays*86400000;store.prune(now);}
    const token=newSecret('qt_s');directory.createSession(token,owner.id,now,60000);
    for(const from of retained?[60000]:[0,60000]) {
      const response=await app.inject({method:'GET',url:'/api/history?board='+board+'&cell=60000&from='+from+'&to=120000&unit=USD&meters='+encodeURIComponent(JSON.stringify([[source,'balance:USD']]))+'&currency='+encodeURIComponent(target.id),headers:{cookie:'quotum_session='+token}});assert.equal(response.statusCode,200);
      const tile=new MeterTile(0,60000);for(const chunk of response.json().chunks)tile.merge(chunk.from,chunk.to,chunk.meterSeries);
      const series=composeMeters([{from:60000,meterSeries:tile.chunk(60000,120000)}],60000,60000,120000)[0];
      assert.equal(moneyPointAt(series,75000)?.value,'200000000');assert.equal(moneyPointAt(series,85000)?.value,'300000000');assert.equal(moneyPointAt(series,105000)?.value,'400000000');
      assert.equal(moneyPointAt(series,85000)?.semantics?.conversion?.original.at,80000);
      if(retained)assert.equal(moneyPointAt(series,60009),undefined);
      assert.equal(series.spent,null);assert.equal(series.topup,null);
    }
  }
});

test('FX openings preserve their own quote through HTTP, reader conversion and packed chunk boundaries',async t=>{
  const store=new Store(':memory:',1),directory=new Directory(store.db),owner=directory.createUser('opening@fixture.example','Fixture','unused',1),board=directory.boards(owner.id)[0].id;
  const source=store.source('deepseek','2'.repeat(24),1);store.hold(source,owner.id,1);store.currencies.select(owner.id,'CNY');
  for(const [at,usd] of [[50000,'1000000'],[90000,'2000000']] as const) {
    const measured=deepSeekMeasurement(answer(),at);store.record(source,measured);
    const quote=store.currencies.save({source:'fixture',base:'EUR',date:0,fetchedAt:at,rates:{EUR:'1000000',USD:usd,CNY:'7000000'}});
    for(const meter of measured.meters)store.currencies.record(source,meter,'USD',quote);
  }
  t.mock.method(Date,'now',()=>120000);
  const app=await buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),pairing:new Pairing(directory),resets:new ResetFeed(undefined,()=>{}),setup:new Setup(false,null),local:null});
  t.after(async()=>{await app.close();store.close();});
  const token=newSecret('qt_s');directory.createSession(token,owner.id,120000,60000);
  for(const from of [0,60000]) {
    const response=await app.inject({method:'GET',url:'/api/history?board='+board+'&cell=60000&from='+from+'&to=120000&unit=USD&meters='+encodeURIComponent(JSON.stringify([[source,'fx:USD:balance:CNY']]))+'&currency=CNY',headers:{cookie:'quotum_session='+token}});
    assert.equal(response.statusCode,200);
    const tile=new MeterTile(0,60000);for(const chunk of response.json().chunks)tile.merge(chunk.from,chunk.to,chunk.meterSeries);
    const series=composeMeters([{from:60000,meterSeries:tile.chunk(60000,120000)}],60000,60000,120000)[0];
    assert.equal(moneyPointAt(series,75000)?.value,'110000000');assert.equal(moneyPointAt(series,95000)?.value,'110000000');
    assert.equal(moneyPointAt(series,75000)?.semantics?.conversion,undefined);assert.equal(moneyPointAt(series,95000)?.semantics?.conversion,undefined);
    assert.equal(series.spent,null);assert.equal(series.topup,null);
  }
});

test('a continuous opening value survives a partial retention cell through HTTP and packing',async t=>{
  const store=new Store(':memory:',1),directory=new Directory(store.db),M=60_000,cutoff=60_010;
  const now=cutoff+config.retention.sampleDays*86_400_000;t.mock.method(Date,'now',()=>now);
  const owner=directory.createUser('prefix@fixture.example','Fixture','unused',1),board=directory.boards(owner.id)[0].id;
  const source=store.source('deepseek','1'.repeat(24),1);store.hold(source,owner.id,1);
  for(const [at,total] of [[1,'110'],[60_001,'110'],[65_000,'110'],[90_000,'100'],[110_000,'100']] as const)store.record(source,deepSeekMeasurement(answer(total),at));
  store.prune(now);
  const app=await buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),pairing:new Pairing(directory),resets:new ResetFeed(undefined,()=>{}),setup:new Setup(false,null),local:null});
  t.after(async()=>{await app.close();store.close();});
  const token=newSecret('qt_s');directory.createSession(token,owner.id,now,60_000);
  const response=await app.inject({method:'GET',url:'/api/history?board='+board+'&cell='+M+'&from=60000&to=120000&unit=CNY&meters='+encodeURIComponent(JSON.stringify([[source,'balance:CNY']])),headers:{cookie:'quotum_session='+token}});
  assert.equal(response.statusCode,200);
  const chunks=response.json().chunks,tile=new MeterTile(60_000,M);
  for(const chunk of chunks)tile.merge(chunk.from,chunk.to,chunk.meterSeries);
  const history=composeMeters([{from:60_000,meterSeries:tile.chunk(60_000,120_000)}],M,60_000,120_000)[0];
  assert.equal(moneyPointAt(history,cutoff-1),undefined);assert.equal(moneyPointAt(history,75_000)?.value,'110000000');
  assert.equal(moneyPointAt(history,90_000)?.value,'100000000');assert.equal(moneyPointAt(history,120_000),undefined);
  assert.equal(history.coveredMs,49_990);assert.equal(history.start,null);
});

test('actual ledger, packed cells, money preparation, chart geometry and raw readout retain holes and recovery anchors',()=>{
  const store=new Store(':memory:',1);try {
    const id=store.source('deepseek','1'.repeat(24),1),M=60_000;
    store.record(id,deepSeekMeasurement(answer(),1));
    store.record(id,deepSeekMeasurement({is_available:true,balance_infos:[]},60_001));
    store.record(id,deepSeekMeasurement(answer(),120_001));
    store.record(id,deepSeekMeasurement(answer('105'),180_001));
    const selected={unit:'CNY',ids:[[id,'balance:CNY']] as [string,string][]};
    const raw=store.meters.cells(selected,0,240_000,M),tile=new MeterTile(0,M);tile.merge(0,240_000,raw);
    const chunks=[{from:0,meterSeries:tile.chunk(0,240_000)}],original=composeMeters(chunks,M,0,240_000);
    assert.deepEqual(original,composeMeters([{from:0,meterSeries:raw}],M,0,240_000));
    const saved=original[0];
    assert.equal(moneyPointAt(saved,120_000),undefined);assert.equal(moneyPointAt(saved,120_010)?.value,'110000000');
    assert.equal(moneyPointAt(saved,65_000),undefined);assert.equal(moneyPointAt(saved,180_000)?.value,'110000000');assert.equal(moneyPointAt(saved,180_001)?.value,'105000000');
    const moneySource=readFileSync(new URL('../components/MoneyAnalytics.tsx',import.meta.url),'utf8'),start=moneySource.indexOf('  const prepared=usePrepared(');
    const region=moneySource.slice(start,moneySource.indexOf('  const model=prepared.value',start));
    const moneyContext={context:defaultCurrencyContext,original,history:{meterSeries:original},strip:null,unit:'CNY',prefs:{money:{view:'balance'},muted:{}},sources:[{id,title:'Fixture',provider:'deepseek'}],arrange:{view:{}},locale:'en',board:'b',selection:{ids:[['s','balance']]},moneyIdentity,composeMetersPrepared,colorOf:()=> '#fff',nameOf:()=> 'Fixture',usePrepared:(work:()=>Generator<void,unknown,void>)=>({value:drain(work()),ready:true}),model:null as unknown as {entries:typeof original;lines:Line[]}};
    runInNewContext(ts.transpileModule(region+'\nglobalThis.model=prepared.value;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,moneyContext);
    const line=moneyContext.model.lines[0];assert.equal(line.pointMode,'observation');assert.ok(line.points.some(p=>p[0]===120_001&&p[3]===180_000));
    assert.equal(readout([line],[],120_000,M,210_000,240_000,[],undefined,120_000).rows[0].value,null);
    assert.notEqual(readout([line],[],120_000,M,210_000,240_000,[],undefined,120_010).rows[0].value,null);
    assert.equal(readout([line],[],60_000,M,210_000,240_000,[],undefined,65_000).rows[0].value,null);
    const hook=preparationFixture(),context={...hook,axis:{active:false,basis:{from:0,to:240_000,end:210_000}},incomingLines:moneyContext.model.lines,incomingPlans:[],incomingForecasts:[],incomingMarkers:[],incomingStrip:null,desiredFrom:0,desiredTo:240_000,desiredNow:210_000,desiredLive:true,incomingReady:true,modelContext:'money',navigation:undefined,valueAxis:{min:0,max:20},stepped:true,cellMs:M,width:900,height:220,left:40,right:12,top:12,bottom:28,clipPrepared,plotPathPrepared,observationRunsPrepared,draw:null as unknown as ()=>{value:{paths:{line:string;last:[number,number]}[]}}};
    const chartSource=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8'),chartStart=chartSource.indexOf('  const inputs = '),chartRegion=chartSource.slice(chartStart,chartSource.indexOf('  const model = ',chartStart));
    runInNewContext(ts.transpileModule(`function draw(){${chartRegion}\nreturn prepared;}\nglobalThis.draw=draw;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
    hook.begin();context.draw();hook.commit();hook.finish();hook.begin();const path=context.draw().value.paths[0];
    assert.equal((path.line.match(/M/g)??[]).length,2);assert.ok(path.line.includes('M464.0,'),'recovery draws at its actual anchor, not the cell midpoint');
    assert.equal(path.last[0],40+180_001/240_000*848,'last marker is the real primary observation, not a deadline endpoint');
    tile.merge(120_000,240_000,[]);const removed=composeMeters([{from:0,meterSeries:tile.chunk(0,240_000)}],M,0,240_000)[0];assert.equal(moneyPointAt(removed,120_010),undefined);
  }finally{store.close();}
});

test('subscription preferences survive new currencies, and money defaults choose totals without double counting components',()=>{
  const store=new Store(':memory:',1);try {
    const id=store.source('deepseek','1'.repeat(24),1);store.record(id,deepSeekMeasurement(answer(),1));
    const card:Card={...store.state(id),stale:false,owners:[],measureIntervalMs:null};
    assert.deepEqual(moneySelection([card],[],readMoney({unit:null})).selection,{unit:'USD',ids:[]});
    assert.equal(readMoney({unit:'CNY'}).unit,'USD');assert.deepEqual(moneySelection([card],[],readMoney({unit:'CNY'})).selection?.ids,[]);
    assert.equal(balanceGroups(card)[0].total.amount,'110000000');assert.equal(balanceGroups(card)[0].components.length,2);
    assert.equal(readMoney({unit:'USD'}).unit,'USD');assert.equal(moneySelection([card],[],readMoney({unit:'USD'})).selection?.ids.length,0);
  }finally{store.close();}
});
