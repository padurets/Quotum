import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {panEvidenceScript} from '../panEvidence.js';

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
