import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters} from '../../server/domain/dataFilters';
import {PageClock} from '../lib/clock';
import {setLocale} from '../i18n';
import {atOnce} from '../lib/activity';
import {num,workHours} from '../lib/format';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';
import {activityClockConsumer} from './activityClockFixture';

for(const fixed of [false,true])for(const failure of [false,true])test(`${fixed?'fixed':'live'} shared ${failure?'failure and Retry':'replacement'} commits all Activity consumers together`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed,personal:true,initialFilters:defaultFilters()});
  const credit=(project:string,from:number,to:number)=>h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:project,startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
  credit('Keep project',NOW-20*M,NOW-18*M);h.events.flush();await flush();
  const d=await drawings(h),paint=consumer({...h,...d});
  const clock=new PageClock({now:()=>NOW,visible:()=>true,setTimeout:()=>null,clearTimeout:()=>{}});
  const check=(frame:ReturnType<typeof paint.render>,agentMinutes:number,activeMinutes:number,agents:number,names:string[])=>{
    assert.deepEqual(frame.entries.map((entry:any)=>entry.name).sort(),names);
    assert.equal(frame.entries.reduce((sum:number,entry:any)=>sum+entry.group.agentMs,0),agentMinutes*M);
    for(const language of ['en','ru'] as const){
      setLocale(language);const summary=activityClockConsumer('Totals',clock,h.period,frame.totals);
      try{
        const html=summary.render(),values=[...html.matchAll(/<b[^>]*>(.*?)<\/b>/g)].map(match=>match[1]);
        assert.deepEqual(values,[workHours(agentMinutes*M),workHours(activeMinutes*M),num(agents),atOnce(agentMinutes*M,activeMinutes*M)],`${language}: all four quantities use the committed full cohort`);
        assert.ok(html.includes(`data-agent-ms="${agentMinutes*M}"`));
      }finally{summary.close();}
      for(const entry of frame.entries){
        const legend=activityClockConsumer('LegendAmount',clock,h.period,entry);
        try{assert.ok(legend.render().includes('>'+workHours(entry.group.agentMs)+'</b>'));}finally{legend.close();}
      }
    }
  };
  let held:ReturnType<typeof h.hold>|undefined;
  try{
    const a=paint.settle();check(a,3,3,2,['Keep project','Work project']);assert.ok(a.paths.length);
    held=h.hold();credit('New project',NOW-19*M,NOW-16*M);h.events.flush();await flush();
    for(let i=0;i<3;i++){const pending=paint.render();check(pending,3,3,2,['Keep project','Work project']);assert.deepEqual(pending.paths,a.paths);paint.finishParent();paint.finishChild();}
    if(failure){
      held.reject(new Error('shared work unavailable'));await flush();assert.equal(d.renderActivity().error,'history_failed');
      const reads=h.requests.length;
      for(let i=0;i<4;i++){const failed=paint.render();check(failed,3,3,2,['Keep project','Work project']);assert.deepEqual(failed.paths,a.paths);paint.finishParent();paint.finishChild();await flush();}
      assert.equal(h.requests.length,reads,'equivalent parent renders do not retry the failed shared owner');
      assert.equal(typeof paint.render().retry,'function');paint.render().retry();await flush();assert.ok(h.requests.length>reads,'the actual panel Retry reaches its shared reader');
    }else{held.release();await flush();}
    check(paint.render(),3,3,2,['Keep project','Work project']);
    paint.finishParent();check(paint.render(),3,3,2,['Keep project','Work project']);
    paint.finishChild();const b=paint.settle();check(b,6,5,3,['Keep project','New project','Work project']);assert.notDeepEqual(b.paths,a.paths);
    h.event({type:'history',data:{sources:[],since:0,workSince:0}});
    const retired=paint.render();assert.equal(retired.paths.length,0);assert.equal(retired.entries.length,0);
    const summary=activityClockConsumer('Totals',clock,h.period,retired.totals);
    try{assert.ok(!summary.render().includes('data-agent-ms='),'hard invalidation retires every numerical consumer before replacement');}finally{summary.close();}
  }finally{held?.release();await flush();paint.close();d.close();await h.close();setLocale('en');}
});
