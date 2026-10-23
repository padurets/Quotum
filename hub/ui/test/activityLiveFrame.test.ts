import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';
import {activityClockConsumer as clockConsumer} from './activityClockFixture';
import {PageClock} from '../lib/clock';
import {defaultFilters} from '../../server/domain/dataFilters';

for(const replace of [false,true])test(`all-visible ${replace?'retained replacement':'idle'} frame expires its accepted live work without polling`,async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({personal:true,initialFilters:defaultFilters(),creditFrom:NOW-H-M/2,creditTo:NOW-H+1000}),d=await drawings(h),paint=consumer({...h,...d});
 let now=NOW,panning:number|null=null,gestureAt=NOW,displayedProps:any;const timers=new Map<object,{at:number;run:()=>void}>();
 const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:(run,ms)=>{const id={};timers.set(id,{at:now+ms,run});return id;},clearTimeout:id=>{timers.delete(id as object);}});
 let numerical:any,legend:any;
 try{
  const a=paint.settle();displayedProps=a.totals;numerical=clockConsumer('Totals',clock,h.period,displayedProps,()=>panning,()=>gestureAt);assert.ok(numerical.render().includes('data-agent-ms="1000"'));legend=clockConsumer('LegendItem',clock,h.period,a.entries[0],()=>panning,()=>gestureAt);legend.render();
  if(replace){
   h.store.creditWork(h.device,NOW-17*M,NOW-14*M,[{source:h.source,client:'codex',origin:'terminal',project:'New project',folder:'New project',startedAt:NOW-H,identity:{kind:'stable',sessionId:'New project'}}]);h.events.flush();await flush();
   const held=paint.render();assert.deepEqual(held.paths,a.paths);assert.equal(held.totals.retained,true);displayedProps=held.totals;numerical.update(displayedProps);
  }
  const expectedEnd=NOW+2000;
  for(let count=0;;count++){assert.ok(count<10000);const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>expectedEnd)break;now=next[1].at;h.advance(now);timers.delete(next[0]);next[1].run();numerical.render();legend.render();}
  now=expectedEnd;h.advance(now);
  const html=numerical.render();
  assert.ok(html.includes('data-agent-ms="0"'),'accepted A has expired; an unfinished B cannot freeze old live totals');
  panning=1;gestureAt=now;legend.update(a.entries[0]);assert.ok(numerical.update(displayedProps).includes('data-agent-ms="0"'),'starting a gesture must not revive already expired work');
  now+=2*M;h.advance(now);assert.ok(numerical.update(displayedProps).includes('data-agent-ms="0"'));assert.equal(timers.size,0,'a gesture adds no numerical deadline');
  h.event({type:'history',data:{sources:[],since:0,workSince:0}});assert.ok(legend.update(a.entries[0]).includes('data-time="activity-work">—</b>'),'retired evidence cannot use the old group as a scalar fallback');assert.ok(!numerical.update(displayedProps).includes('data-agent-ms='),'a hard cutoff retires the captured live projector during the gesture');
  const recaptured={...displayedProps,history:{...displayedProps.history,projection:h.period.captureActivity(displayedProps.history)}};
  assert.ok(!numerical.update(recaptured).includes('data-agent-ms='),'recapturing old evidence preserves its retirement instead of reviving scalar amounts');
 }finally{numerical?.close();legend?.close();paint.close();d.close();await h.close();}
});

test('an accepted live frame wakes when its knowledge ends and never revives after a range round trip',async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,creditFrom:NOW-H-M/2,creditTo:NOW-H+1000}),d=await drawings(h),paint=consumer({...h,...d});
  let now=NOW;const timers=new Map<object,{at:number;run:()=>void}>();
  const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:(run,ms)=>{const token={};timers.set(token,{at:now+ms,run});return token;},clearTimeout:token=>{timers.delete(token as object);}});
  let view:any;
  try{
    const props=paint.settle().totals,projection=props.history.projection;assert.ok(projection);
    view=clockConsumer('Totals',clock,h.period,props);assert.ok(view.render().includes('data-agent-ms="1000"'));
    const reads=h.requests.length;
    for(let count=0;;count++){
      assert.ok(count<10000);const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>NOW+H+2000)break;
      now=next[1].at;h.advance(now);timers.delete(next[0]);next[1].run();view.render();
    }
    assert.ok(!view.render().includes('data-agent-ms='),'expired evidence becomes unknown rather than a confirmed zero');
    assert.equal(h.requests.length,reads,'clock expiry never polls');
    h.selectRange({from:NOW-H,to:NOW});assert.equal(h.period.activityValid(projection),false);
    h.selectRange(null);assert.equal(h.period.activityValid(projection),false,'returning to the same range cannot restore the old lifetime');
    assert.ok(!view.update(props).includes('data-agent-ms='));
  }finally{view?.close();paint.close();d.close();await h.close();}
});
