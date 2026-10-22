import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters} from '../../server/domain/dataFilters';
import {Preparations} from '../lib/prepare';
import {workHours} from '../lib/format';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';
import {mounted} from './activitySubsetFixture';

test('a retained live frame expires its enabled legend and summary from the same admitted work',async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,initialFilters:defaultFilters()});
  const credit=(project:string,from:number,to:number)=>h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:project,startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
  credit('Keep project',NOW-H+M/2,NOW-H+1.5*M);h.events.flush();await flush();
  const d=await drawings(h),tasks:(()=>void)[]=[];
  let clock=0;const scheduler=new Preparations({now:()=>clock++,post:task=>tasks.push(task)});
  const local=mounted(h,d.renderActivity(),async()=>{throw Error('live work adds no transport');},scheduler);
  const paint=consumer({...h,...d},{muted:{'activity:project:"Work project"':true},subset:local.reader,now:h.clock.hubNow});
  try{
    await flush();while(tasks.length){tasks.shift()!();await flush();}
    const initial=paint.settle(),model=initial.totals.model;assert.ok(local.renderProps(initial.totals).includes(`data-agent-ms="${M}"`));
    credit('New project',NOW-17*M,NOW-14*M);h.events.flush();await flush();
    assert.equal(local.reader.get().loading,true);assert.ok(tasks.length);
    h.advance(NOW+2*M);const retained=paint.settle();assert.equal(retained.totals.model,model);
    assert.ok(local.renderProps(retained.totals).includes('data-agent-ms="0"'));
    const entry=retained.entries.find((entry:any)=>entry.name==='Keep project');assert.ok(entry);
    assert.ok(local.legend(entry).includes(workHours(0)),'enabled legend values use the retained interval index rather than frozen scalar props');
  }finally{paint.close();scheduler.dispose();await flush();await local.close();d.close();await h.close();}
});
