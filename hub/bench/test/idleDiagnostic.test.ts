import {test} from 'node:test';
import assert from 'node:assert/strict';
import {idleSensitivity} from '../idleDiagnostic.js';

test('measured idle growth can remain below the unchanged absolute budget',()=>{
  const baseline=0.1076399471873742,copies=[0.1407154799641784,0.1331075868202594];
  const result=idleSensitivity(baseline,copies,true);
  assert.equal(result.valid,true);assert.equal(result.growthDetected,true);
  assert.equal(result.overBudget,false);assert.equal(result.threshold,0.3);
  assert.equal(result.scriptMsPerSecond,copies[0]+copies[1]);
  assert.equal(result.increaseMsPerSecond,result.scriptMsPerSecond-baseline);
  assert.equal(result.ratio,result.scriptMsPerSecond/baseline);
  assert.equal(idleSensitivity(.2,[.19,.18],true).overBudget,true);
});

test('a doubled idle fixture without measured growth fails sensitivity',()=>{
  for(const copies of [[.1,.1],[.08,.09]]) {
    const result=idleSensitivity(.2,copies,true);
    assert.equal(result.valid,true);assert.equal(result.growthDetected,false);
  }
});

test('invalid phases, counters or a missing copy cannot demonstrate sensitivity',()=>{
  for(const [baseline,copies,phaseValid] of [
    [.1,[.1,.1],false],[.1,[.2],true],[.1,[.2,.2,.2],true],
    [0,[.1,.1],true],[NaN,[.1,.1],true],[.1,[Infinity,.1],true],[.1,[-.1,.3],true],
  ] as const) {
    const result=idleSensitivity(baseline,copies,phaseValid);
    assert.equal(result.valid,false);assert.equal(result.growthDetected,false);
    assert.equal(result.ratio,null);assert.equal(result.increaseMsPerSecond,null);
  }
});
