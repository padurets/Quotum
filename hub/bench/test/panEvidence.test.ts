import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {panEvidenceScript, panTransactionsScript} from '../panEvidence.js';

test('numeric pan evidence preserves many inputs credited by one original frame and marks overflow', () => {
  let now = 0;
  const context = {performance:{now:()=>++now}};
  const recorder=vm.runInNewContext(panEvidenceScript(true, 5),context);
  recorder.add('input',{inputId:1});recorder.add('input',{inputId:2});
  recorder.add('frame',{frameId:17,pose:[[1,3],[1,3],[1,3],[1,3]]});
  recorder.add('credit',{inputId:1,frameId:17});recorder.add('credit',{inputId:2,frameId:17});
  const data=JSON.parse(JSON.stringify(recorder.read()));
  assert.equal(data.status,'complete');
  assert.deepEqual(data.entries.map((entry:{id:number;at:number})=>[entry.id,entry.at]),[[1,1],[2,2],[3,3],[4,4],[5,5]]);
  assert.equal(data.entries[3].frameId,data.entries[4].frameId);
  recorder.add('frame',{frameId:18});
  const overflow=JSON.parse(JSON.stringify(recorder.read()));
  assert.equal(overflow.status,'insufficient-evidence');assert.equal(overflow.omitted,1);
  assert.deepEqual(overflow.entries.map((entry:{id:number})=>entry.id),[2,3,4,5,6]);
  assert.equal(vm.runInNewContext(panEvidenceScript(false),context),null);
});

test('opt-in RAF handles preserve native cancellation, callback arguments and exception boundaries',()=>{
  const window={},callbacks=new Map<number,(stamp:number)=>unknown>();let next=100;
  function original(this:unknown,callback:(stamp:number)=>unknown){assert.equal(this,window);callbacks.set(++next,callback);return next;}
  const recorder=vm.runInNewContext(panEvidenceScript(true,20,true),{window,performance:{now:()=>1}}),schedule=recorder.wrap(original);
  const fire=(id:number,stamp:number)=>{const callback=callbacks.get(id);callbacks.delete(id);return callback?.(stamp);};
  const canceled=schedule(()=>assert.fail('canceled callback ran'));callbacks.delete(canceled);fire(canceled,5);
  const first=schedule(function(this:unknown,stamp:number){assert.equal(this,window);assert.equal(stamp,10);recorder.add('frame',{from:0});return 7;});
  assert.equal(first,102);assert.equal(fire(first,10),7);
  recorder.add('input',{});
  const failure=new Error('same failure');
  const second=schedule(()=>{recorder.add('frame',{from:1});throw failure;});
  assert.throws(()=>fire(second,20),value=>value===failure);
  recorder.add('frame',{from:2});
  const reset=schedule(()=>recorder.add('frame',{from:0}));fire(reset,30);
  const rows=JSON.parse(JSON.stringify(recorder.read())).entries;
  assert.deepEqual(rows.map((row:{rafFrom?:number|null;rafTo?:number|null})=>[row.rafFrom,row.rafTo]),[[null,first],[undefined,undefined],[first,second],[second,null],[null,reset]]);
  const ordinary=vm.runInNewContext(panEvidenceScript(true),{performance:{now:()=>1}});
  assert.equal(ordinary.wrap,undefined);ordinary.add('frame',{from:1});
  assert.deepEqual(Object.keys(ordinary.read().entries[0]),['id','at','kind','from']);
});

test('wheel receipts distinguish generation gaps, delayed delivery and separate feeding segments', () => {
  let now=410;
  const recorder=vm.runInNewContext(panTransactionsScript(),{performance:{now:()=>now}});
  recorder.input(10,100,'wheel');recorder.input(26,400,'wheel');recorder.push('wheel',7);
  let data=JSON.parse(JSON.stringify(recorder.read()));
  assert.equal(data.maxStampGap,16);assert.equal(data.maxDeliveryGap,300);
  assert.equal(data.writes[0].stampGap,16);assert.equal(data.writes[0].idleMs,10);
  recorder.input(20,430,'wheel');now=431;recorder.push('wheel',7);
  data=JSON.parse(JSON.stringify(recorder.read()));
  assert.equal(data.stampRegressions,1);assert.equal(data.writes[1].stampGap,-6,'original clock order is retained');
  recorder.input(2000,2010,'return');now=2011;recorder.push('return',8);
  data=JSON.parse(JSON.stringify(recorder.read()));
  assert.equal(data.maxStampGap,16,'a deliberate pause between segments is excluded');
  assert.equal(data.writes[2].stampGap,null);assert.equal(data.status,'complete');
});

test('missing input clocks and bounded write receipts stay explicitly unavailable', () => {
  const recorder=vm.runInNewContext(panTransactionsScript(2),{performance:{now:()=>100}});
  recorder.push('wheel',NaN);recorder.input(1,2,'wheel');recorder.input(NaN,3,'wheel');
  recorder.push('wheel',4);recorder.push('wheel',5);
  const data=JSON.parse(JSON.stringify(recorder.read()));
  assert.equal(data.status,'insufficient-evidence');assert.equal(data.invalidClocks,1);
  assert.equal(data.pushesDuring,3);assert.equal(data.omitted,1);assert.equal(data.writes.length,2);
  assert.equal(data.writes[0].token,null);assert.equal(data.writes[0].stamp,null);
  assert.equal(data.writes[1].stampGap,null);assert.equal(data.writes[1].idleMs,null);
});
