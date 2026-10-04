import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MeterTile} from '../lib/meterTiles';
import {composeMeters, type MeterSeriesCells} from '../../server/domain/meterHistory';
import {HistoryTile} from '../lib/historyTiles';
import {drain} from '../lib/prepare';
import type {Chunk} from '../../server/domain/history';

test('staging a money update keeps the published exact tile unchanged',()=>{
  const cell=60_000,known={work:0,sources:{s:0}},tile=new HistoryTile(0,cell);
  const chunk=(value:string):Chunk=>({from:0,to:cell,series:[],activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[],meterSeries:[{source:'s',meter:'usage',kind:'counter',unit:'USD',semantics:null,cells:[[0,value,'0','0',0]]}]});
  tile.merge(chunk('9007199254740993'),known);
  tile.readTo=cell;
  const before=tile.chunk(known),staged=drain(tile.staged(chunk('9007199254740994'),known));
  assert.deepEqual(tile.chunk(known),before);
  assert.equal(staged.chunk(known).meterSeries![0].cells[0][1],'9007199254740994');
  assert.ok(staged.bytes>0);
});

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
