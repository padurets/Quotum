import {test} from 'node:test';
import assert from 'node:assert/strict';
import {processIdentity} from '../browserProcess.js';

test('ownership counters preserve proc units without exporting a process name or malformed counters',()=>{
  const fields=Array.from({length:50},(_,i)=>String(i));fields[0]='D';
  const stat=()=>`99 (private path ) secret-canary) ${fields.join(' ')}`;
  assert.deepEqual(processIdentity(99,stat()),{pid:99,state:'D',parent:1,group:2,session:3,birth:'19',
    minorFaults:7,majorFaults:9,userTicks:11,systemTicks:12,blockIoTicks:39});
  fields[9]='secret-canary';fields[39]='9007199254740992';
  const identity=processIdentity(99,stat());
  assert.equal(identity?.majorFaults,null);assert.equal(identity?.blockIoTicks,null);
  assert.doesNotMatch(JSON.stringify(identity),/private|secret-canary|path/);
  fields[19]='invalid';
  assert.equal(processIdentity(99,stat()),null,'malformed birth grants no process identity');
  assert.equal(processIdentity(99,''),null);
});
