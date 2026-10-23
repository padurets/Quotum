import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters} from '../../server/domain/dataFilters';
import {PageClock} from '../lib/clock';
import {num,workHours} from '../lib/format';
import {atOnce} from '../lib/activity';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';
import {activityClockConsumer} from './activityClockFixture';

for(const fixed of [false,true])for(const cold of [false,true])test(`${fixed?'fixed':'live'} ${cold?'cold HTTP':'first mounted'} shared failure stays idle until the panel Retry produces a complete frame`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed,personal:true,initialFilters:defaultFilters(),initialFailure:cold}),d=await drawings(h),held=cold?undefined:h.hold();
  let paint:ReturnType<typeof consumer>|undefined;
  const clock=new PageClock({now:()=>NOW,visible:()=>true,setTimeout:()=>null,clearTimeout:()=>{}});
  const text=(frame:ReturnType<NonNullable<typeof paint>['render']>)=>{
    const view=activityClockConsumer('Totals',clock,h.period,frame.totals);
    try{return view.render();}finally{view.close();}
  };
  try{
    h.store.creditWork(h.device,NOW-19*M,NOW-16*M,[{source:h.source,client:'codex',origin:'terminal',project:'New project',folder:'New project',startedAt:NOW-H,identity:{kind:'stable',sessionId:'New project'}}]);
    if(held){h.events.flush();await flush();held.reject(new Error('initial work unavailable'));await flush();}
    paint=consumer({...h,...d});assert.equal(d.renderActivity().error,'history_failed');
    const reads=h.requests.length;
    for(let i=0;i<5;i++){
      const failed=paint.render(),html=text(failed);
      assert.equal(failed.paths.length,0);assert.equal(failed.entries.length,0);
      assert.equal((html.match(/<b>—<\/b>/g)??[]).length,4,'unavailable evidence does not invent zero or another cohort');
      assert.ok(!html.includes('data-agent-ms='));paint.finishParent();paint.finishChild();await flush();
    }
    assert.equal(h.requests.length,reads,'repeated parent/child renders do not retry an initial error');
    paint.render().retry();await flush();assert.ok(h.requests.length>reads);
    const ready=paint.settle(),html=text(ready),values=[...html.matchAll(/<b[^>]*>(.*?)<\/b>/g)].map(match=>match[1]);
    assert.deepEqual(values,[workHours(4*M),workHours(4*M),num(2),atOnce(4*M,4*M)]);
    assert.ok(ready.paths.length);assert.equal(ready.entries.length,2);assert.equal(d.renderActivity().error,undefined);
  }finally{held?.release();await flush();paint?.close();d.close();await h.close();}
});
