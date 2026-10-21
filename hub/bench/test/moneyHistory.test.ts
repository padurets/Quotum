import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {Store} from '../../server/store/store';
import {composeMeters,selectionOf} from '../../server/domain/meterHistory';
import type {Meter} from '../../server/domain/meters';
import {moneyHistoryReady} from '../moneyHistory';

test('personal currency recovery accepts exact live carry cells across a minute boundary',()=>{
  const store=new Store(':memory:',1),source=store.source('openrouter','111111111111111111111111',1),observedAt=119900,now=121000,cell=60000;
  const meter=(id:string,amount:string):Meter=>({id,amount,kind:'counter',unit:'USD',at:observedAt,staleAfterMs:300000,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null});
  try{
    store.record(source,{type:'meters',observedAt,staleAfterMs:300000,meters:[meter('credits','100000000'),meter('usage','43600000')],keys:[],inventoryComplete:true,inventoryError:null});
    const cells=store.meters.cells(selectionOf([[source,'balance']],'USD'),60000,now,cell);
    const series=composeMeters([{from:60000,meterSeries:cells}],cell,60000,now)[0],point=series.points.at(-1)!;
    assert.deepEqual(series.points.map(p=>[p.at,p.value]),[[60000,'56400000'],[120000,'56400000']]);
    assert.notEqual(point.at,Math.floor(observedAt/cell)*cell,'the production ledger legitimately carries this fresh balance into the next minute');
    // The same dependency-free function is serialized into the real browser probe.
    const ready=runInNewContext('('+moneyHistoryReady.toString()+')') as typeof moneyHistoryReady;
    assert.equal(ready(`${point.at}:${point.value}`,'56400000',observedAt,cell,now),true);
    assert.equal(ready(`60000:56400000`,'56400000',observedAt,cell,119950),true);
    for(const last of [null,undefined,'','broken','NaN:56400000','0:56400000','180000:56400000','120000:56400001'])assert.equal(ready(last,'56400000',observedAt,cell,now),false,String(last));
  }finally{store.close();}
});
