import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,NOW,H} from './periodRuntimeFixture';
import {activityAxisFixture} from './activityAxisFixture';
import {plotGroups} from '../lib/historyPlot';
import type {ActivityGroup} from '../lib/types';

async function producer(length=72*H){
  const creditFrom=length===24*H?NOW-6*H:NOW-3*H,creditTo=length===24*H?creditFrom+10*60_000:NOW-H;
  const h=await fixture({personal:true,periodName:'3d',creditFrom,creditTo});
  if(length===24*H)h.credit(NOW-30*H,NOW-29*H);
  const range={from:NOW-length,to:NOW};h.settings.range=length===24*H?'24h':'3d';h.selectRange(range);await flush();
  const d=await drawings(h),settle=async()=>{for(let i=0;i<12;i++){await flush();d.runScheduled();}};
  d.loader.pan({token:1,length,...range,direction:1});await settle();
  const strip=d.loader.getActivityPlot();assert.ok(strip,'the real reader publishes a strip');
  const groups=plotGroups(strip,{k0:strip.from/strip.cell,k1:strip.to/strip.cell-1},'source');
  assert.equal(groups.length,1);assert.equal(strip.barMs,H);
  const reading=d.renderActivity().history;assert.ok(reading&&reading.activity.agentMs===creditTo-creditFrom);
  const mount=(periodMs:number)=>{
    const f=activityAxisFixture(false,{range,periodMs,now:NOW+1000,cells:groups[0].cells,landmarks:[NOW-2*H,NOW-H],warmup:false});
    Object.assign(f.props,{strip,groups:groups.map(group=>({group,name:group.key,color:'red'})),paint:new Map(groups.map(group=>[group.key,'red'])),activity:reading.activity,currentActivity:reading.activity,history:reading});
    f.stageModel();f.settle();return f;
  };
  return {h,d,range,settle,mount,close:async()=>{d.close();await h.close();}};
}

test('a retained real strip keeps its physical value and edge projection through another gesture',async()=>{
  const prior=Date.now;Date.now=()=>NOW;const p=await producer();
  try{
    for(const periodMs of [24*H,72*H])for(const cancel of [false,true]){
      const f=p.mount(periodMs);
      f.pointerDown();f.flush();f.pointerMove(198);f.runFrame();f.settle();
      f.props.prepared=false;f.pointerUp();f.runFrame();f.flush();f.settle();
      const before=f.snapshot('held real strip'),token=f.pointerDown();
      const check=(label:string)=>{
        const s=f.snapshot(label);
        assert.equal(s.path,before.path);assert.equal(s.ratio,1,`${label}: the displayed positive strip keeps its value domain`);
        assert.ok(s.bandBounds.visible&&s.bandBounds.to>370,'the native band cannot clip the 72-hour answer to a 24-hour prefix');
        assert.ok(s.bars.some(bar=>bar.to>Math.max(48,s.bandBounds.from,s.maskBounds!.from)&&bar.from<Math.min(388,s.bandBounds.to,s.maskBounds!.to)&&bar.y>=12&&bar.y<272),'positive work is inside both the actual band clip and value clip');
      };
      check('pointer down before React');f.flush();check('pointer down after React');
      // Stay inside the real two-hour work interval, without entering the live snap.
      f.pointerMove(210);f.runFrame();check('accepted move');f.flush();
      if(cancel)f.pan.cancel(token);else f.pointerUp(210);
      f.flush();check('stop before final RAF');f.runFrame();f.flush();f.settle();check('final presented pose');
      if(cancel)assert.deepEqual(f.snapshot('restored').landmarks,before.landmarks);
    }
  }finally{await p.close();Date.now=prior;}
});

test('a pending shorter period pans from the displayed measurement end and adopts the actual ready answer',async()=>{
  const prior=Date.now;Date.now=()=>NOW;const p=await producer();
  try{
    const f=p.mount(24*H);
    f.pointerDown();f.flush();f.pointerMove(198);f.runFrame();f.settle();
    const blocked=p.h.hold();p.h.settings.range='24h';p.h.selectRange(null);await flush();
    f.props.prepared=false;f.pointerUp();f.runFrame();f.flush();f.settle();
    const held=f.snapshot('pending live24');f.pointerDown();
    const draft=f.pan.get()!;
    assert.equal(draft.length,24*H,'the requested accounting duration stays 24 hours');
    assert.ok(Math.abs(draft.to-held.viewport.to)<1,'Activity has no future; its visible right edge is the measurement end');
    assert.equal(draft.lookAhead,0,'an older longer drawing cannot invent forecast time');
    f.flush();f.pointerMove(210);f.runFrame();f.flush();f.pointerUp(210);f.runFrame();f.flush();f.settle();
    const pending=f.snapshot('released24'),selected=pending.selected;
    assert.ok(selected);assert.equal(selected.to,Math.round(pending.viewport.to));assert.equal(selected.to-selected.from,24*H);
    blocked.release();await flush();p.d.loader.endPan(true);p.h.selectRange(selected);p.d.loader.choose('24h',selected);await p.settle();
    const ready=p.d.renderActivity();
    assert.equal(ready.loading,false);assert.equal(ready.error,undefined);assert.equal(ready.history,ready.drawing);
    const expected=Math.max(0,Math.min(NOW-H,selected.to)-Math.max(NOW-3*H,selected.from));
    assert.ok(expected>0);assert.equal(ready.history.activity.agentMs,expected,'actual producer evidence agrees with the reached interval');
    Object.assign(f.props,{strip:null,origin:ready.history.since,activity:ready.history.activity,currentActivity:ready.history.activity,history:ready.history,groups:ready.history.activity.by.source.map((group:ActivityGroup)=>({group,name:group.key,color:'red'})),prepared:true});
    f.stageModel();f.settle();
    const adopted=f.snapshot('ready shorter drawing');
    assert.ok(Math.abs(adopted.viewport.from-selected.from)<1&&Math.abs(adopted.viewport.to-selected.to)<1,'the ready 24-hour answer owns its matching duration at the reached end');
    assert.ok(adopted.bars.some(bar=>bar.x>48&&bar.x<388&&bar.y>=12&&bar.y<272));
  }finally{await p.close();Date.now=prior;}
});

test('a shorter retained strip ignores an overscan peak when the next requested period is longer',async()=>{
  const prior=Date.now;Date.now=()=>NOW;const p=await producer(24*H);
  try{
    assert.equal(p.d.loader.getActivityPlot()!.cell,5*60_000);
    const f=p.mount(72*H),initial=f.snapshot('actual24h');
    assert.ok(initial.bars.some(bar=>bar.y>=12&&bar.y<272));
    f.pointerDown();f.flush();f.pointerMove(198);f.runFrame();f.settle();
    f.props.prepared=false;f.pointerUp();f.runFrame();f.flush();f.settle();
    const before=f.snapshot('held24h'),token=f.pointerDown();
    assert.equal(f.pan.get()!.length,72*H);
    for(const s of [f.snapshot('pointer down'),(f.flush(),f.snapshot('after React'))]){
      assert.equal(s.path,before.path);assert.equal(s.ratio,before.ratio,'the one-hour peak outside the displayed24h cannot change its scale');
      assert.deepEqual(s.labels,before.labels);assert.ok(Math.abs(s.viewport.to-s.viewport.from-24*H)<1);
    }
    f.pointerMove(210);f.runFrame();assert.equal(f.snapshot('move').ratio,1);
    f.pan.cancel(token);f.runFrame();f.flush();f.settle();
    assert.equal(f.snapshot('cancel').ratio,1);assert.deepEqual(f.snapshot('cancel').landmarks,before.landmarks);
  }finally{await p.close();Date.now=prior;}
});
