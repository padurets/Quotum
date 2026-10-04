import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {composeMeters, meterCells, selectionOf, type MeterSeriesCells} from '../domain/meterHistory.js';
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
  const series=store.meters.cells(selectionOf([[source,'key:111111111111:cap']],'USD'),0,180_000,60_000);
  const result=composeMeters([{from:0,meterSeries:series}],60_000,0,180_000)[0];
  assert.deepEqual(result.points.map(p=>[p.value,p.semantics?.limit]),[['8000000','10000000'],['17000000','20000000']]);
  assert.equal(result.points.some(p=>p.at===60_000),false,'a coalesced cell across different allowances is unknown');
  assert.equal(result.spent,'0');
  store.close();
});

test('a cap changing usage within one period keeps the last value only inside its own interval',()=>{
  const readings=[meter('quota:credit:5h',0,'800000000',{kind:'cap',unit:'credits:zai',limit:'2000000000',resetAt:null,minutes:300,scope:'five_hour'}),meter('quota:credit:5h',30000,'900000000',{kind:'cap',unit:'credits:zai',limit:'2000000000',resetAt:null,minutes:300,scope:'five_hour'})].map(r=>({...r,previousAt:null}));
  const cells=meterCells({source:'zai:fixture',meter:'quota:credit:5h',readings,spans:[{from:0,to:30000,staleAfterMs:204000}]},'credits:zai',0,60000,60000)[0].cells;
  assert.equal(cells.length,1);assert.equal(cells[0][1],'1100000000');
  assert.equal(cells[0][5]!.knownFrom,30000);assert.equal(cells[0][5]!.knownUntil,60000);
});

test('a cap cannot borrow the freshness of a preceding different meter identity',()=>{
  const readings=[meter('changing',0,'1000000'),meter('changing',30000,'1000000',{kind:'cap',unit:'credits:zai',limit:'2000000',minutes:300,scope:'five_hour'})].map(r=>({...r,previousAt:null}));
  const spans=[{from:0,to:0,staleAfterMs:300000},{from:30000,to:30000,staleAfterMs:60000}];
  assert.deepEqual(meterCells({source:'fixture',meter:'changing',readings,spans},'credits:zai',120000,180000,60000),[]);
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
