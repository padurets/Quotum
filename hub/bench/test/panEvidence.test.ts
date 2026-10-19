import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {panTransactionsScript} from '../panEvidence.js';

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
