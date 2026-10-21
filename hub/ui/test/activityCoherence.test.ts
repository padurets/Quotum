import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters} from '../../server/domain/dataFilters';
import type {PeriodReply} from '../../server/domain/periodRead';
import type {HubEvent} from '../lib/board';
import {drawings,fixture,flush,NOW,H,M} from './periodRuntimeFixture';

test('native quota can complete before selected work without publishing an empty Activity replacement',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({periodName:'3d',initialFilters:defaultFilters()}),d=await drawings(h);
  let release=()=>{};
  try{
    const first=d.renderActivity();assert.ok(first.history!.activity.agentMs>0);
    const transport=h.period.transport,receive=transport.receive;
    let blocked=false;
    const gate=new Promise<void>(yes=>{release=yes;});
    // Independent native and work replies can complete in either order. Hold
    // work adoption while the real coordinator accepts the native section.
    transport.receive=async(reply:PeriodReply,...args:unknown[])=>{
      if(!reply.sessions)return receive.call(transport,reply,...args);
      await receive.call(transport,{...reply,sessions:undefined},...args);
      blocked=true;await gate;
      return receive.call(transport,{...reply,quota:undefined,budget:undefined,funds:undefined,values:undefined},...args);
    };
    const range={from:NOW-3*24*H-12_345,to:NOW-12_345};
    // This fixture keeps navigation timers dormant; advance its reader clock
    // beyond the previous selection's settle window instead of sleeping.
    (d.loader as any).env.now=()=>NOW+1000;
    h.selectRange(range);d.loader.choose('3d',range);await flush();
    assert.ok(blocked,'the actual selected-work transport is held independently');
    const native=d.render();assert.equal(native.loading,false);
    assert.equal(h.period.projectionState(native.history,'quota').ready,true);
    assert.equal(native.history.activity.known,null,'native accounting explicitly marks selected work pending');
    const before=h.requests.length;
    for(let i=0;i<20;i++){
      const pending=d.renderActivity();
      assert.equal(pending.history,first.history,'retain the complete work frame rather than the native placeholder');
      assert.equal(pending.drawing,first.drawing);
    }
    assert.equal(h.requests.length,before,'presentation adds no read');
    release();await flush();
    const ready=d.renderActivity();
    assert.equal(ready.history.range,`${range.from}-${range.to}`);
    assert.equal(ready.history.activity.agentMs,M);
    assert.ok(ready.history.activity.by.project.length);
    assert.equal(h.period.activityProjectionState(ready.history).ready,true);
  }finally{release();d.close();await h.close();}
});

for(const fixed of [false,true])for(const kind of ['global','scoped-work','scoped-quota','budget','unrelated'] as const)test(`${fixed?'fixed':'live'} Activity ${kind} work retirement is synchronous before a native rerender`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed,initialFilters:defaultFilters()}),d=await drawings(h);
  try{
    const first=d.renderActivity();assert.ok(first.history!.activity.agentMs>0);
    const data:Extract<HubEvent,{type:'history'}>['data']={since:NOW-M,sources:[h.source]};
    if(kind==='global')data.workSince=0;
    else data.changes=[{source:kind==='unrelated'?'outside-board':h.source,scope:kind==='budget'?'budget':'quota',since:kind==='scoped-quota'?0:NOW-M,workSince:0}];
    h.event({type:'history',data});
    const pending=d.renderActivity(),hard=!['budget','unrelated'].includes(kind);
    if(hard){
      assert.equal(pending.history,null,'the coordinator retirement clears retained work immediately');
      assert.equal(pending.drawing,null);
    }else{
      assert.ok(pending.history!.activity.agentMs>0);
      assert.deepEqual(pending.history!.activity,first.history!.activity);
    }
  }finally{d.close();await h.close();}
});

test('a work-only error wakes Activity and preserves independent native accounting',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({initialFilters:defaultFilters()}),d=await drawings(h);
  try{
    const first=d.renderActivity(),native=d.loader.get(),revision=h.period.getProjectionRevision('quota');
    const intent=h.period.intent();intent.request.sessions={};
    await h.period.transport.receive({version:1,basis:h.period.get().basis,sessions:{state:'error',error:'history_failed'}},intent);
    assert.ok(h.period.getProjectionRevision('quota')>revision,'selected-work errors notify the Activity projection');
    assert.equal(d.loader.get(),native,'native cells need no replacement');
    assert.equal(h.period.projectionState(native.history,'quota').ready,true);
    assert.equal(h.period.projectionState(native.history,'quota').error,undefined);
    const failed=d.renderActivity();assert.equal(failed.error,'history_failed');assert.equal(failed.history,first.history);
  }finally{d.close();await h.close();}
});
