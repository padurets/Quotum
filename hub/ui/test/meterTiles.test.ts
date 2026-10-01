import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MeterTile} from '../lib/meterTiles';
import {composeMeters, type MeterSeriesCells} from '../../server/domain/meterHistory';

test('money tile packing preserves bigint values, original intervals, partial headers and replacement semantics',()=>{
  const before={limit:'10000000',resetAt:1_000_000,minutes:1440,scope:'monthly',label:'old'};
  const after={...before,limit:'20000000',label:'new'};
  const raw:MeterSeriesCells={source:'s',meter:'cap',kind:'cap',unit:'USD',semantics:before,cells:[[0,'9007199254740993','0','0',0,{segment:1}],[1,'17000000','0','1',60_000,{segment:1,semantics:after,steps:[{from:-10,to:60_001,amount:'1',evidence:'gap'}]}]]};
  const tile=new MeterTile(0,60_000);
  tile.merge(0,120_000,[raw]);tile.merge(0,120_000,[raw]);
  const packed=tile.chunk(0,120_000);
  assert.deepEqual(composeMeters([{from:0,meterSeries:packed}],60_000,0,120_000),composeMeters([{from:0,meterSeries:[raw]}],60_000,0,120_000));
  assert.deepEqual(tile.chunk(60_000,120_000)[0].semantics,before);
  assert.ok(tile.bytes>0);
  tile.merge(60_000,120_000,[{...raw,semantics:before,cells:[[0,'13000000','0','0',0,{segment:1}]]}]);
  assert.equal(tile.chunk(60_000,120_000)[0].cells[0][1],'13000000');
  assert.deepEqual(tile.chunk(60_000,120_000)[0].cells[0][5]?.steps,undefined);
});
