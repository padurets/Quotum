import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters} from '../../server/domain/dataFilters';
import {expandPeriod} from '../../server/domain/periodWire';
import {Preparations} from '../lib/prepare';
import {setLocale, t} from '../i18n';
import {workHours} from '../lib/format';
import {fixture, drawings, consumer, flush, NOW, H, M} from './periodRuntimeFixture';
import {mounted} from './activitySubsetFixture';

for(const order of ['shared-first','local-first','local-failure','live-preparation','http-ahead','native-only'] as const)test(`${order}: Activity replaces its summary, legend and stacks together`,async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const fixed=order!=='live-preparation',h=await fixture({fixed,personal:true,initialFilters:defaultFilters()});
  const credit=(project:string,from:number,to:number)=>h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:project,startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
  credit('Keep project',NOW-20*M,NOW-18*M);h.events.flush();await flush();
  const d=await drawings(h),tasks:(()=>void)[]=[];
  let clock=0,reads=0,revision='',fail=false,wait:Promise<void>|null=null,release=()=>{};
  const scheduler=new Preparations({now:()=>clock++,post:task=>tasks.push(task)});
  const local=mounted(h,d.renderActivity(),async(_board,request)=>{
    reads++;const reply=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,request)));revision=reply.basis.revision;
    await wait;if(fail){fail=false;throw Error('subset unavailable');}return reply;
  },fixed?undefined:scheduler);
  const paint=consumer({...h,...d},{muted:{'activity:project:"Work project"':true},subset:local.reader});
  const finishLocal=async()=>{for(let i=0;i<10000;i++){await flush();if(!tasks.length&&!scheduler.size)return;tasks.shift()?.();}throw Error('local preparation did not settle');};
  const check=(frame:ReturnType<typeof paint.render>,minutes:number,names:string[])=>{
    assert.deepEqual(frame.entries.filter((entry:any)=>!entry.muted).map((entry:any)=>entry.name).sort(),names);
    assert.equal(frame.entries.filter((entry:any)=>!entry.muted).reduce((sum:number,entry:any)=>sum+(entry.group?.agentMs??0),0),minutes*M);
    for(const language of ['en','ru'] as const){
      setLocale(language);const html=local.renderProps(frame.totals);
      assert.ok(html.includes(`data-agent-ms="${minutes*M}"`),`${language}: complete selected totals stay with their drawing`);
      assert.ok(html.includes(t('activity.agents')+`</span><b>${minutes===2?1:2}</b>`));
      for(const entry of frame.entries.filter((entry:any)=>!entry.muted))assert.ok(local.legend(entry).includes(workHours(entry.group.agentMs)));
    }
  };
  let upstream:ReturnType<typeof h.hold>|undefined;
  const dispatch=h.page.dispatch,queued:Parameters<typeof dispatch>[0][]=[];
  const deliver=()=>{h.page.dispatch=dispatch;queued.splice(0).forEach(dispatch);};
  try{
    await finishLocal();const initial=paint.settle();check(initial,2,['Keep project']);assert.ok(initial.paths.length);
    if(order==='http-ahead')h.page.dispatch=event=>{if(event.type==='hub')queued.push(event);else dispatch(event);};
    else if(order==='local-first')upstream=h.hold();
    else if(fixed&&order!=='native-only')wait=new Promise<void>(yes=>{release=yes;});
    if(order==='native-only')h.store.record(h.source,{observedAt:NOW-M,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:18,remaining:82,resetAt:NOW+H}]});
    else credit('New project',NOW-17*M,NOW-14*M);
    h.events.flush();await flush();
    if(order==='native-only'){local.reader.retry();await flush();assert.notEqual(revision,h.period.get().basis.revision);assert.equal(local.reader.compatible(),true,'unrelated quota revisions cannot strand a complete work frame');}
    if(order==='http-ahead'){local.reader.retry();await flush();assert.equal(local.reader.numbers(NOW)?.agentMs,5*M);assert.equal(local.reader.compatible(),false);const count=reads;await flush();assert.equal(reads,count,'waiting for the real stream does not poll');}
    if(order==='local-first'||order==='http-ahead'){assert.equal(local.reader.get().loading,false);assert.equal(local.reader.numbers(NOW)?.agentMs,5*M);}
    else if(order!=='native-only')assert.equal(local.reader.get().loading,true);
    // Both preparation phases remain independently controllable. A current hub
    // answer or a completed local answer alone cannot publish half of the frame.
    for(let i=0;i<4;i++){
      const retained=paint.render();check(retained,2,['Keep project']);assert.deepEqual(retained.paths,initial.paths);
      paint.finishParent();paint.finishChild();
    }
    if(order==='local-failure')fail=true;
    release();wait=null;upstream?.release();deliver();await flush();
    if(order==='local-failure'){
      assert.equal(local.reader.get().error,'history_failed');check(paint.settle(),2,['Keep project']);
      local.reader.retry();await flush();
    }
    await finishLocal();
    check(paint.render(),2,['Keep project']);
    paint.finishParent();check(paint.render(),2,['Keep project']);
    paint.finishChild();const replacement=paint.settle();check(replacement,order==='native-only'?2:5,order==='native-only'?['Keep project']:['Keep project','New project']);
    if(order==='native-only')assert.deepEqual(replacement.paths,initial.paths);else assert.notDeepEqual(replacement.paths,initial.paths);
    assert.equal(reads,fixed?(['local-failure','http-ahead'].includes(order)?3:2):0,'presentation adds no transport');
    assert.equal(local.pool.activeFlights,0);assert.ok(local.pool.estimatedBytes<=local.pool.budget);
    h.event({type:'history',data:{sources:[],since:0,workSince:0}});
    const retired=paint.render();assert.equal(retired.paths.length,0);assert.equal(retired.entries.length,0);
    assert.ok(!local.renderProps(retired.totals).includes('data-agent-ms='),'a hard work cutoff retires every numerical consumer before replacement');
  }finally{
    release();upstream?.release();deliver();await flush();paint.close();await local.close();scheduler.dispose();d.close();await h.close();setLocale('en');
  }
});
