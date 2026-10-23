import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityAxisFixture} from './activityAxisFixture';

for(const live of [false,true])for(const mode of ['painted','painted-pending','unpainted','preparation-pending','upstream-pending'] as const)test(`${live?'live':'historical'} Activity cancel restores both axes in its final native frame (${mode})`,()=>{
  const f=activityAxisFixture(live),before=f.snapshot('before'),commits=f.commits.length,token=f.begin();
  f.flush();f.pan.move(token,live?-170:170);
  if(mode!=='unpainted'){f.runFrame();f.settle();}
  if(mode==='painted-pending')f.pan.move(token,live?-85:85);
  if(mode==='preparation-pending'){f.stageModel();f.flush();assert.ok(f.snapshot('staging').preparing>0);}
  if(mode==='upstream-pending'){f.props.prepared=false;f.parentUpdate();f.flush();}
  f.pan.cancel(token);f.flush();
  const native=f.runFrame();
  const same=(value:ReturnType<typeof f.snapshot>)=>{
    for(let i=0;i<2;i++)assert.ok(Math.abs(value.landmarks[i]-before.landmarks[i])<1e-9,'both original temporal landmarks restore together');
    assert.ok(Math.abs(value.lowBarY-before.lowBarY)<1e-9,'bar height restores before React or preparation can flush');
    assert.deepEqual(value.labels,before.labels,'the value labels match the restored bar');
  };
  same(native);f.settle();same(f.snapshot('settled'));assert.equal(f.commits.length,commits,'cancel never changes the URL');
});

test('an old cancelled final frame cannot repaint the next Activity gesture',()=>{
  const f=activityAxisFixture(false),old=f.begin();f.flush();f.pan.move(old,170);f.runFrame();f.settle();
  f.pan.cancel(old);const late=f.pendingFrames();assert.ok(late.length);
  const latest=f.begin();f.flush();f.pan.move(latest,-85);f.runFrame();
  const before=f.snapshot('newest');late.forEach(run=>run());const after=f.snapshot('late-old');
  assert.deepEqual(after.landmarks,before.landmarks);assert.equal(after.lowBarY,before.lowBarY);assert.deepEqual(after.labels,before.labels);
  f.pan.cancel(latest);f.flush();f.runFrame();f.settle();
});
