import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bounded} from '../reversalDiagnostic.js';

test('diagnostic waiting is bounded independently of a silent page response',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const failed=assert.rejects(bounded('page pause',new Promise(()=>{})),/page pause: diagnostic deadline/);
  t.mock.timers.tick(5000);await failed;
});

test('a responsive diagnostic preserves its result or error and releases its deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  assert.deepEqual(await bounded('browser',Promise.resolve({responded:true})),{responded:true});
  const error=new Error('original failure');await assert.rejects(bounded('browser',Promise.reject(error)),candidate=>candidate===error);
  t.mock.timers.tick(5000);
});
