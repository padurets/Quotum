import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MeterTile} from '../lib/meterTiles';
import {composeMeters, type MeterSeriesCells} from '../../server/domain/meterHistory';
import {HistoryTile} from '../lib/historyTiles';
import {drain,Preparations} from '../lib/prepare';
import type {Chunk} from '../../server/domain/history';
import type {MeterSemantics} from '../../server/domain/meters';

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

const cell = 60_000;
const rate = {id:'default',source:'codex-default',base:'credits:codex',date:0,fetchedAt:100,from:'1000000',to:'40000'};
const semantics = (at:number,amount:string,steps=false):MeterSemantics => ({limit:null,resetAt:null,minutes:null,scope:null,label:null,scale:6,
  conversion:{original:{meterId:'balance:credits',unit:'credits:codex',amount,scale:10,at},rate,...(steps?{steps:[rate,{...rate,id:'manual',source:'manual',base:'USD',to:'2000000'}]}:{})}});
const series = (cells:MeterSeriesCells['cells']):MeterSeriesCells => ({source:'s',meter:'balance:credits',kind:'balance',unit:'USD',role:'total',accounting:{spending:'unavailable',topups:'unavailable'},pointMode:'observation',semantics:semantics(0,'12345678912345'),cells});
const compose = (values:MeterSeriesCells[]) => composeMeters([{from:0,meterSeries:values}],cell,0,3*cell);

test('interned cell metadata preserves openings, observations, exact provenance and exceptional intervals across copy-on-write replacement',()=>{
  const a=semantics(0,'12345678912345'),b=semantics(70000,'12345678912346',true),c=semantics(100000,'-0000012345');
  const input=series([[0,'49382716',null,null,cell,{pointOffsetMs:1,validUntil:cell,semantics:a}],
    [1,'98765432',null,null,cell,{pointOffsetMs:40000,validUntil:2*cell,open:'49382716',openSemantics:a,semantics:b,
      observations:[{at:60000,value:'49382716',validUntil:70000,semantics:a},{at:70000,value:'98765432',validUntil:80000,semantics:b},{at:100000,value:'-5',validUntil:120000,semantics:c}],
      steps:[{from:100,to:90000,amount:'1234567890123456789',evidence:'gap'}],topupSteps:[{from:90000,to:100000,amount:'1',evidence:'continuous'}]}],
    [2,'98765432',null,null,cell,{pointOffsetMs:0,validUntil:3*cell}]]);
  const tile=new MeterTile(0,cell);tile.merge(0,3*cell,[input]);
  const original=tile.chunk(0,3*cell),bytes=tile.bytes;
  assert.deepEqual(compose(original),compose([input]));
  const copy=drain(tile.clonePrepared());
  copy.merge(cell,2*cell,[]);
  assert.deepEqual(tile.chunk(0,3*cell),original);assert.equal(tile.bytes,bytes);
  assert.equal(copy.chunk(cell,2*cell).length,0);
  assert.deepEqual(copy.chunk(2*cell,3*cell)[0].cells[0][5]?.semantics,b,'the successor retains the removed predecessor semantics');
  for(let i=0;i<100;i++)copy.merge(cell,2*cell,[series([[0,String(i),null,null,cell,{semantics:semantics(cell+i,String(i),true)}]])]);
  const fresh=new MeterTile(0,cell);fresh.merge(0,3*cell,copy.chunk(0,3*cell));
  assert.ok(copy.bytes<fresh.bytes+512,'replaced metadata and nested rate references are released');
  copy.merge(0,3*cell,[]);assert.equal(copy.bytes,0,'an empty replacement releases the whole dictionary');
  assert.deepEqual(tile.chunk(0,3*cell),original,'discarding a staged version never releases the published dictionary');
});

test('many converted observations share rate provenance while preserving every original anchor',()=>{
  const input=series(Array.from({length:60},(_,i)=>[i,String(100000000-i),null,null,cell,{semantics:semantics(i*cell,String(25000000000000-i)),pointOffsetMs:0,validUntil:(i+1)*cell}]));
  const tile=new MeterTile(0,cell);tile.merge(0,60*cell,[input]);
  assert.deepEqual(composeMeters([{from:0,meterSeries:tile.chunk(0,60*cell)}],cell,0,60*cell),composeMeters([{from:0,meterSeries:[input]}],cell,0,60*cell));
  assert.ok(tile.bytes<80_000,'one tile retains shared metadata instead of several full copies per cell');
});

test('compact cell headers retain nulls, zero offsets, exclusive bounds and unfamiliar field names',()=>{
  const extra={open:null,first:'900719925474099312345',segment:0,pointOffsetMs:0,openOffsetMs:0,validUntil:cell,knownFrom:0,knownUntil:cell,topupInternal:'0',
    observations:[{at:0,value:'900719925474099312345',validUntil:cell,semantics:null}],
    ...{'0':'numeric key','x:open':'prefixed key','futureField':'future value'}};
  const input=series([[0,'900719925474099312345',null,'0',cell,extra]]),tile=new MeterTile(0,cell);
  tile.merge(0,cell,[input]);
  assert.deepEqual(tile.chunk(0,cell)[0].cells[0][5],extra);
});
