import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MeterTile} from '../lib/meterTiles';
import {composeMeters, type MeterSeriesCells} from '../../server/domain/meterHistory';
import {HistoryTile} from '../lib/historyTiles';
import {drain,Preparations} from '../lib/prepare';
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

test('a packed monetary cell enters the estimate before preparation reads the next cell',()=>{
  const tile=new MeterTile(0,60_000);
  let nextRead=false;
  const cells:MeterSeriesCells['cells']=[[0,'10000000','0','0',60_000],[1,'9000000','0','0',60_000]];
  Object.defineProperty(cells,1,{get(){nextRead=true;assert.ok(tile.bytes>256,'new packed bytes cannot wait for the whole series');return [1,'9000000','0','0',60_000];}});
  tile.merge(0,120_000,[{source:'s',meter:'balance',kind:'balance',unit:'USD',semantics:null,cells}]);
  assert.ok(nextRead);assert.equal(tile.chunk(0,120_000)[0].cells.length,2);
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

test('a dense monetary cell yields before reading all intervals and cancellation preserves the published tile',()=>{
  let visits=0,time=0,ready=false,small=false;const tasks:(()=>void)[]=[];
  const scheduler=new Preparations({now:()=>time++,post:run=>tasks.push(run)}),owner={};
  const known={work:0,sources:{s:0}},tile=new HistoryTile(0,60000);
  const base:Chunk={from:0,to:60000,series:[],activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[],meterSeries:[{source:'s',meter:'m',kind:'counter',unit:'USD',semantics:null,cells:[[0,'1','0','0',0]]}]};
  tile.merge(base,known);tile.readTo=60000;const before=tile.chunk(known);
  const steps=Array.from({length:6000},(_,i)=>({from:-i-1,to:1,evidence:'gap' as const,get amount(){visits++;return '1';}}));
  const update:Chunk={...base,meterSeries:[{...base.meterSeries![0],cells:[[0,'2','0','6000',0,{steps}]]}]};
  scheduler.replace(owner,tile.staged(update,known),()=>true,()=>{ready=true;});
  scheduler.replace({},(function*(){small=true;return;})(),()=>true,()=>{});
  tasks.shift()!();
  assert.ok(visits>0&&visits<40,`one scheduler slice read ${visits} intervals`);
  tasks.shift()!();assert.equal(small,true);assert.equal(ready,false);
  scheduler.cancel(owner);while(tasks.length)tasks.shift()!();
  assert.equal(ready,false);assert.deepEqual(tile.chunk(known),before);
});
