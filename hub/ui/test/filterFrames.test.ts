import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sseParser} from '../lib/live';

test('configuration has a UTF-8 frame bound while released large browser bootstraps remain readable',()=>{
  const frames:string[]=[],push=sseParser(type=>frames.push(type));
  push('event: snapshot\ndata: '+JSON.stringify({payload:'x'.repeat(800*1024)})+'\n\n');
  push('event: filters\ndata: '+JSON.stringify({payload:'я'.repeat(130*1024)})+'\n\n');
  assert.deepEqual(frames,['snapshot','filters']);
  assert.throws(()=>push('event: filters\ndata: '+JSON.stringify({payload:'я'.repeat(140*1024)})+'\n\n'),/filters_frame_limit/);
  const reordered=sseParser(()=>{throw new Error('must not publish');});
  assert.throws(()=>reordered('data: '+JSON.stringify({payload:'я'.repeat(140*1024)})+'\nevent: filters\n\n'),/filters_frame_limit/);
});
