import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {composeMeters, selectionOf, type MeterSeriesCells} from '../domain/meterHistory.js';
import type {Meter} from '../domain/meters.js';

const meter=(id:string,at:number,amount:string,extra:Partial<Meter>={}):Meter=>({id,kind:'counter',unit:'USD',amount,at,staleAfterMs:300_000,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null,...extra});
const record=(store:Store,source:string,at:number,meters:Meter[])=>store.record(source,{type:'meters',observedAt:at,staleAfterMs:300_000,meters,keys:[],inventoryComplete:true,inventoryError:null});

test('virtual balance uses usage spending and credits top-ups even when only credits changed',()=>{
  const store=new Store(':memory:',1),source=store.source('openrouter','111111111111111111111111',1);
  for(const [at,credits,usage] of [[1,'50000000','30000000'],[60_001,'70000000','33000000'],[120_001,'80000000','33000000']] as const)record(store,source,at,[meter('credits',at,credits),meter('usage',at,usage)]);
  const selection=selectionOf([[source,'balance']],'USD');
  const series=store.meters.cells(selection,0,180_000,60_000);
  const result=composeMeters([{from:0,meterSeries:series}],60_000,0,180_000)[0];
  assert.deepEqual(result.points.map(p=>p.value),['20000000','37000000','47000000']);
  assert.equal(result.spent,'3000000');assert.equal(result.topup,'30000000');
  assert.equal(series.length,1,'paired dependencies are one logical series');
  store.close();
});

test('cap history carries its actual historical remaining and limit after the current cap disappears',()=>{
  const store=new Store(':memory:',1),source=store.source('openrouter','111111111111111111111111',1);
  const cap=(at:number,value:string,limit:string)=>meter('key:111111111111:cap',at,value,{kind:'cap',limit,resetAt:1_000_000,minutes:1440,scope:'monthly',label:'laptop'});
  record(store,source,1,[cap(1,'2000000','10000000')]);
  record(store,source,60_001,[cap(60_001,'3000000','20000000')]);
  record(store,source,120_001,[]);
  const series=store.meters.cells(selectionOf([[source,'key:111111111111:cap']],'USD'),0,120_000,60_000);
  const result=composeMeters([{from:0,meterSeries:series}],60_000,0,120_000)[0];
  assert.deepEqual(result.points.map(p=>[p.value,p.semantics?.limit]),[['8000000','10000000'],['17000000','20000000']]);
  assert.equal(result.spent,'0');
  store.close();
});

test('exceptional intervals survive cell and chunk partition and re-reading without double counting',()=>{
  const semantics={limit:null,resetAt:null,minutes:null,scope:null,label:null};
  const series:MeterSeriesCells={source:'s',meter:'usage',kind:'counter',unit:'USD',semantics,cells:[[1,'5','0','5',60_000,{segment:1,steps:[{from:1,to:60_001,amount:'3',evidence:'continuous'},{from:-100_000,to:60_002,amount:'2',evidence:'gap'}]}]]};
  const expected=composeMeters([{from:0,meterSeries:[series]}],60_000,0,120_000)[0];
  const split={...series,cells:series.cells.map(row=>[0,...row.slice(1)] as typeof row)};
  const repeated=composeMeters([{from:60_000,meterSeries:[split]},{from:60_000,meterSeries:[split]}],60_000,0,120_000)[0];
  assert.deepEqual(repeated,expected);
  assert.equal(expected.spent,'3');assert.deepEqual(expected.unlocated,[{from:-100_000,to:60_002,amount:'2',evidence:'gap'}]);
  const short=composeMeters([{from:0,meterSeries:[series]}],60_000,60_000,120_000)[0];
  assert.equal(short.spent,'0');assert.equal(short.unlocated.length,2);
});

test('meter selection normalizes duplicates, stays bounded and rejects raw hashes and invalid units',()=>{
  assert.deepEqual(selectionOf([['s','balance'],['s','balance']],'USD'),{unit:'USD',ids:[['s','balance']]});
  assert.throws(()=>selectionOf(Array.from({length:33},(_,i)=>['s','m'+i]),'USD'));
  assert.throws(()=>selectionOf([['s','https://secret.invalid']],'USD'));
  assert.throws(()=>selectionOf([['s','balance']],'usd'));
});

test('unavailable accounting never consumes numerical or exceptional spending slots',()=>{
  const series:MeterSeriesCells={source:'s',meter:'balance:CNY',kind:'balance',unit:'CNY',semantics:null,accounting:{spending:'unavailable',topups:'unavailable'},cells:[[0,'2000000',null,null,1000,{steps:[{from:0,to:1,amount:'1000000',evidence:'estimate'}],topupInternal:'2000000',topupSteps:[{from:0,to:1,amount:'2000000',evidence:'estimate'}]}]]};
  const result=composeMeters([{from:0,meterSeries:[series]}],60000,0,60000)[0];
  assert.equal(result.spent,null);assert.equal(result.topup,null);assert.equal(result.points[0].spent,null);assert.deepEqual(result.unlocated,[]);assert.deepEqual(result.topupUnlocated,[]);assert.deepEqual(result.points[0].steps,[]);
});

test('a kind or unit transition within one cell retains both identities and the confirmed delta',()=>{
  for(const change of [{kind:'balance' as const},{unit:'requests' as const}]) {
    const store=new Store(':memory:',1),source=store.source('openrouter','111111111111111111111111',1);
    try {
      record(store,source,1,[meter('m',1,'10000000')]);
      record(store,source,10001,[meter('m',10001,'15000000')]);
      record(store,source,20001,[meter('m',20001,'20000000',change)]);
      const packed=store.meters.cells(selectionOf([[source,'m']],'USD'),0,60000,60000);
      const counter=composeMeters([{from:0,meterSeries:packed}],60000,0,60000).find(s=>s.kind==='counter');
      assert.equal(counter?.end,'15000000');assert.equal(counter.spent,'5000000');
      assert.equal(counter.coveredMs,10000);
      if('kind' in change)assert.deepEqual(packed.map(s=>s.kind),['counter','balance']);
    }finally{store.close();}
  }
});
