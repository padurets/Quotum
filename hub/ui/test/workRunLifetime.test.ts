import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters} from '../../server/domain/dataFilters';
import {publishDataFilters} from '../lib/filterSelection';
import {Preparations} from '../lib/prepare';
import {consumer,drawings,fixture,flush,NOW,M} from './periodRuntimeFixture';

for(const fixed of [false,true])for(const filtered of [false,true])test(`${fixed?'fixed':'live'} ${filtered?'selected':'all-visible'} work retires across an actual hub restart`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const filters=defaultFilters();if(filtered)filters.projects={mode:'include',values:['Work project']};
  const h=await fixture({heatmap:true,fixed,personal:true,initialFilters:filters}),d=await drawings(h);
  let old:ReturnType<typeof h.hold>|undefined,replacement:ReturnType<typeof h.hold>|undefined;
  try{
    const mounted=consumer({...h,...d}),before=mounted.settle(),history=d.renderActivity().history;
    assert.ok(before.paths.length&&before.names.length&&history!.activity.agentMs>0);
    const native=d.loader.getFinancial(),values=h.period.getValue(h.source).value,run=h.events.epoch;
    h.event({type:'hello',data:{epoch:run}});
    assert.equal(d.renderActivity().history,history,'same-run hello retains the complete frame');
    assert.deepEqual(mounted.render().paths,before.paths);assert.deepEqual(mounted.render().names,before.names);
    old=h.hold();h.credit(NOW-2*M,NOW-M);h.events.flush();await flush();
    replacement=h.hold();const baseline=h.restart();
    assert.notEqual(h.events.epoch,run);assert.equal(h.page.get().hubEpoch,h.events.epoch);
    const revoked=()=>{
      const shown=d.renderActivity();assert.equal(shown.history,null);assert.equal(shown.drawing,null);
      assert.deepEqual(mounted.settle().paths,[]);assert.deepEqual(mounted.render().names,[]);
      assert.equal(h.period.get().value,null);assert.equal(h.period.get().rows.length,0);
      assert.equal(h.period.calendar.get().value,null);
    };
    revoked();await flush();revoked();
    assert.equal(d.loader.getFinancial().presentation,native.presentation,'work retirement preserves native authority');
    assert.equal(d.loader.getFinancial().history,native.history,'native quota evidence stays independent');
    assert.equal(h.period.getValue(h.source).value,values,'historical values stay visible');
    old.release();await flush();revoked();
    replacement.reject(new Error('replacement unavailable'));await flush();revoked();
    assert.equal(h.period.get().error,'unavailable','a local error with no run remains actionable');
    baseline();h.period.retry();d.loader.retry();await flush();
    assert.equal(h.period.get().basis.run,h.events.epoch,'recovery is proved by the new producer');
    assert.ok(d.renderActivity().history!.activity.agentMs>0);
    assert.ok(mounted.settle().paths.length);assert.ok(h.period.calendar.get().value);
    assert.equal(h.pool.activeFlights,0);
  }finally{old?.release();replacement?.release();await flush();d.close();await h.close();publishDataFilters(null,false);}
});

test('a reply from a different run cannot acknowledge replacement work or calendar evidence',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({heatmap:true,personal:true,initialFilters:defaultFilters()}),d=await drawings(h);
  const held=h.hold();
  try{
    const old=h.fresh();h.event({type:'hello',data:{epoch:'different-run'}});await flush();
    const intent=h.period.intent();await h.period.transport.receive(old,intent);
    assert.equal(h.period.get().value,null);assert.equal(d.renderActivity().history,null);
    assert.equal(h.period.calendar.get().value,null);
  }finally{held.release();await flush();d.close();await h.close();publishDataFilters(null,false);}
});

for(const fixed of [false,true])test(`${fixed?'fixed':'live'} cooperative work preparation cannot cross a hub run boundary`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({heatmap:true,fixed,personal:true,initialFilters:defaultFilters()}),d=await drawings(h);
  const tasks:(()=>void)[]=[];let clock=0;
  const scheduler=new Preparations({now:()=>clock++,post:run=>tasks.push(run)});
  const drain=async()=>{for(let i=0;tasks.length&&i<10000;i++){tasks.shift()!();await flush();}assert.equal(tasks.length,0);};
  let replacement:ReturnType<typeof h.hold>|undefined;
  try{
    const mounted=consumer({...h,...d});assert.ok(mounted.settle().paths.length);
    h.prepareWith(scheduler);h.credit(NOW-2*M,NOW-M);h.events.flush();await flush();
    assert.ok(tasks.length,'the old producer reached actual cooperative preparation');
    replacement=h.hold();h.restart();await flush();await drain();
    assert.equal(h.period.get().value,null);assert.equal(h.period.calendar.get().value,null);
    assert.equal(d.renderActivity().history,null);assert.deepEqual(mounted.settle().paths,[]);
    replacement.reject(new Error('replacement unavailable'));await flush();await drain();
    assert.equal(h.period.get().value,null);assert.deepEqual(mounted.settle().names,[]);
  }finally{replacement?.release();await flush();await drain();h.prepareWith(null);d.close();await h.close();publishDataFilters(null,false);}
});
