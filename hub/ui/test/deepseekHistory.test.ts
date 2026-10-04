import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Store} from '../../server/store/store';
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
    const moneyContext={original,history:{meterSeries:original},strip:null,unit:'CNY',prefs:{money:{view:'balance'},muted:{}},sources:[{id,title:'Fixture',provider:'deepseek'}],arrange:{view:{}},locale:'en',board:'b',moneyIdentity,composeMetersPrepared,colorOf:()=> '#fff',nameOf:()=> 'Fixture',usePrepared:(work:()=>Generator<void,unknown,void>)=>({value:drain(work()),ready:true}),model:null as unknown as {entries:typeof original;lines:Line[]}};
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
    assert.equal(moneySelection([card],[],readMoney({unit:null})).selection,undefined);
    assert.deepEqual(moneySelection([card],[],readMoney({unit:'CNY'})).selection?.ids,[[id,'balance:CNY']]);
    assert.equal(balanceGroups(card)[0].total.amount,'110000000');assert.equal(balanceGroups(card)[0].components.length,2);
    assert.equal(readMoney({unit:'USD'}).unit,'USD');assert.equal(moneySelection([card],[],readMoney({unit:'USD'})).selection?.ids.length,0);
  }finally{store.close();}
});
