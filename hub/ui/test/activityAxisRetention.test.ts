import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityAxisFixture} from './activityAxisFixture';

const M=60000,H=3600000;

for(const periodMs of [2*M,3*M,6*M])test(`Activity retains its value projection while a six-minute range returns to a pending ${periodMs/M}-minute live period`,()=>{
  const to=12*M+17017;
  const f=activityAxisFixture(false,{range:{from:to-6*M,to},periodMs,now:to+1000,cells:[[10*M,H],[11*M,H]],warmup:false});
  const before=f.snapshot('ready fixed range'),token=f.begin();
  assert.equal(before.ratio,1);
  f.flush();f.pan.move(token,2);f.runFrame();f.settle();
  const active=f.snapshot('last accepted input');
  f.props.prepared=false;
  assert.equal(f.pan.finish(token),'live');
  assert.equal(f.commits.at(-1),null,'the actual controller returns to live');
  f.flush();
  const finalFrame=f.runFrame();
  const retained=(value:ReturnType<typeof f.snapshot>)=>{
    assert.equal(value.drawReady,'false','the previous prepared model still owns the paths');
    assert.equal(value.path,active.path,'the same positive artwork is retained');
    assert.equal(value.ratio,active.ratio,'the requested period cannot rescale retained artwork');
    assert.equal(value.lowBarY,active.lowBarY,'the positive bar keeps its height');
    assert.deepEqual(value.landmarks,active.landmarks,'the final time pose and value projection stay together');
    assert.deepEqual(value.labels,active.labels,'the scale describes the retained bars');
  };
  retained(finalFrame);f.settle();retained(f.snapshot('pending after React'));
  f.parentUpdate();f.flush();retained(f.snapshot('another pending publication'));
  f.props.prepared=true;f.stageModel();f.settle();
  const replacement=f.snapshot('ready live replacement');
  assert.equal(replacement.drawReady,'true');
  assert.equal(replacement.ratio,1,'the replacement owns its numeric basis');
  assert.deepEqual(replacement.labels,before.labels);
});
