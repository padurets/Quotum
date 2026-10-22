import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';

for(const evict of [false,true])test(`a displayed live projector ${evict?'pays for storage after cache eviction':'shares storage with its cached owner'}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true}),d=await drawings(h);
  let release=()=>{};
  try{
    const frame=h.period.captureActivity(d.renderActivity().history),projector=frame.projector;
    assert.ok(projector);release=h.period.retainActivity(frame);
    h.selectRange({from:NOW-H-M,to:NOW-M});await flush();
    assert.notEqual(h.period.activity,projector);
    const [key,cached]=[...h.period.retained.entries()].find(([key]:[string,unknown])=>key.includes('live'))!;
    assert.ok(cached);
    if(evict){h.period.evictionCandidates().find((entry:any)=>entry.bytes===cached.bytes)!.drop();assert.equal(h.period.retained.has(key),false);}
    const charged=h.period.estimatedBytes;release();
    assert.equal(charged-h.period.estimatedBytes,evict?frame.bytes:0,'a lease only adds storage absent from the other owners');
    if(!evict){h.selectRange(null);await flush();assert.equal(h.period.activity,projector,'the cached closure restores the exact shared projector');}
  }finally{release();d.close();await h.close();}
});

test('saved resource choices share one current projector across multiple cached and drawing owners',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true}),d=await drawings(h),paint=consumer({...h,...d});
  try{
    const frame=paint.settle().totals.history.projection,projector=frame.projector;
    assert.ok(projector);
    for(const [i,shown] of [[],['budget-history'],['budget-history','subscription-funds']].entries()){
      h.directory.saveView(h.board,{...h.directory.view(h.board),shown:['agents',...shown],hidden:['activity','quota-history','quota-session-history','quota-table','quota-session-table']},h.alice.id,NOW+i+1);
      h.events.flush();await flush();assert.equal(h.period.activity,projector);
    }
    const entries=[...h.period.retained.values()];
    assert.ok(entries.length>=2);assert.ok(h.period.activityLeases.get(projector).count>=2);
    for(const entry of entries){
      entry.restore(h.period.selection);assert.equal(h.period.activity,projector);
      const before=h.period.estimatedBytes;
      h.period.evictionCandidates().find((candidate:any)=>candidate.bytes===entry.bytes)!.drop();
      const released=before-h.period.estimatedBytes;
      // Current and cached views can share tapes and accounting as well as work.
      assert.ok(released>=0&&released<=entry.bytes-frame.bytes,'dropping a cached owner cannot release storage still owned by current and drawing frames');
    }
    assert.equal(h.requests.filter(request=>request.sessions).length,0,'resource choices do not reload unchanged work');
  }finally{paint.close();d.close();await h.close();}
});

for(const survivor of ['lease','current','none'] as const)test(`shared pool admits actual marginal cache release with ${survivor} surviving owner`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true}),d=await drawings(h);
  let release=()=>{};
  try{
    const frame=h.period.captureActivity(d.renderActivity().history),projector=frame.projector;assert.ok(projector);
    if(survivor==='lease')release=h.period.retainActivity(frame);
    if(survivor==='current'){
      h.directory.saveView(h.board,{...h.directory.view(h.board),shown:['agents'],hidden:['activity','quota-history','quota-session-history','quota-table','quota-session-table']},h.alice.id,NOW+1);
      h.events.flush();await flush();assert.equal(h.period.activity,projector);
    }else{h.selectRange({from:NOW-H-M,to:NOW-M});await flush();assert.notEqual(h.period.activity,projector);}
    const entries=[...h.period.retained.entries()];assert.equal(entries.length,1);
    const [key,cached]=entries[0];
    const before=h.pool.estimatedBytes,need=cached.bytes-(survivor==='none'?0:Math.floor(frame.bytes/2));
    Object.defineProperty(h.pool,'budget',{value:before-need});
    assert.equal(h.period.evictionCandidates().length,1);
    const admitted=h.pool.trim(),after=h.pool.estimatedBytes;
    assert.equal(h.period.retained.has(key),false);
    const released=before-after;
    if(survivor==='none')assert.equal(released,cached.bytes);
    else assert.ok(released>=0&&released<=cached.bytes-frame.bytes,'other shared numerical roots may also survive the cached owner');
    assert.equal(admitted,survivor==='none','a held projector cannot be spent as if its cache eviction freed it');
    assert.equal(admitted,after<=h.pool.budget);
  }finally{release();d.close();await h.close();}
});
