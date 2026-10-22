import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';
import {defaultFilters} from '../../server/domain/dataFilters';

for(const fixed of [false,true])for(const preparing of [false,true])test(`${fixed?'fixed':'live'} shared A/B/C retains the ${preparing?'queued B':'painted A'} frame until its consumer releases it`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed,personal:true,initialFilters:defaultFilters()});
  const credit=(project:string,from:number,to:number)=>h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:project,startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
  credit('Keep project',NOW-20*M,NOW-18*M);h.events.flush();await flush();
  const d=await drawings(h),paint=consumer({...h,...d});
  try{
    const initial=paint.settle(),a=initial.totals.history;
    assert.ok(a);assert.equal(a.activity.agentMs,3*M);
    credit('B project',NOW-19*M,NOW-16*M);h.events.flush();await flush();
    const b=d.renderActivity().drawing!;assert.equal(b.activity.agentMs,6*M);
    const bProjection=h.period.captureActivity(b);
    if(preparing){const pending=paint.render();assert.deepEqual(pending.paths,initial.paths);assert.equal(pending.totals.history,a);}
    assert.equal(paint.queuedParent(),preparing?1:0,'only an actual render can capture B for preparation');
    credit('C project',NOW-18*M,NOW-14*M);h.events.flush();await flush();
    const c=d.renderActivity().drawing!;assert.equal(c.activity.agentMs,10*M);
    const cProjection=h.period.captureActivity(c);
    assert.equal(paint.queuedParent(),preparing?1:0,'C has arrived without a React render replacing the B job');
    if(fixed){
      assert.equal(a.projection,null);assert.equal(bProjection,null);assert.equal(cProjection,null,'fixed frames keep scalar evidence rather than a rolling projector');
      assert.equal(h.period.activityLeases.size,0,'a removed subset must not recreate a fixed raw-work lease');
    }else{
      assert.ok(a.projection?.projector);assert.ok(bProjection?.projector);assert.ok(cProjection?.projector);
      assert.equal(h.period.activityLeases.has(a.projection.projector),true,'painted A is still owned');
      assert.equal(h.period.activityLeases.has(bProjection.projector),preparing,'an unseen B has no UI lease; a queued B does');
      assert.equal(h.period.activity,cProjection.projector,'C is the independent current shared reader');
      const held=a.projection.bytes+(preparing?bProjection.bytes:0)+cProjection.bytes;
      assert.ok(h.period.estimatedBytes>=held,'all independently held projectors remain charged');
    }
    if(preparing){
      paint.finishParent();const publishedB=paint.render();
      assert.equal(publishedB.incomingFrame.history.activity,b.activity,'the completed real B generator does not pretend to be C');
      assert.equal(publishedB.totals.history,a,'child preparation still paints the complete A frame');
      if(!fixed){const before=h.period.estimatedBytes,release=h.period.retainActivity(bProjection);assert.equal(h.period.estimatedBytes,before,'a second owner of B does not duplicate its charge');release();}
    }
    const latest=paint.settle();assert.equal(latest.totals.history.activity,c.activity);assert.equal(latest.totals.history.activity.agentMs,10*M);
    assert.ok(h.pool.estimatedBytes<=h.pool.budget);assert.equal(h.pool.activeFlights,0);
    paint.close();assert.equal(h.period.activityLeases.size,0,'disposing both preparation owners releases their captured projectors');
  }finally{paint.close();d.close();await h.close();}
});
