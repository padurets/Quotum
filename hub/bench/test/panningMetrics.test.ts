import {test} from 'node:test';
import assert from 'node:assert/strict';
import {panCost} from '../panningMetrics.js';

test('diagnostic cost rejects reload-reset and missing counters instead of accepting negative overhead', () => {
  const before={Timestamp:100,ScriptDuration:20,TaskDuration:30};
  assert.equal(panCost(before,{Timestamp:240,ScriptDuration:19,TaskDuration:29}).valid,false);
  assert.equal(panCost(before,{Timestamp:240}).valid,false);
  assert.deepEqual(panCost(before,{Timestamp:120,ScriptDuration:22,TaskDuration:33}),{valid:true,scriptMs:2000,taskMs:3000,seconds:20});
});
