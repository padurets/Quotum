import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters} from '../../server/domain/dataFilters';
import {expandPeriod} from '../../server/domain/periodWire';
import {setLocale} from '../i18n';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';
import {mounted} from './activitySubsetFixture';

for(const mode of ['same-run','restart-before-first','restart-before-replacement'] as const)test(`a fixed subset ${mode} admits only the observed producer before stream delivery`,async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed:true,personal:true,initialFilters:defaultFilters()});
  const credit=(project:string,from:number,to:number)=>h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:`${project} full folder`,startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
  credit('Keep project',NOW-20*M,NOW-18*M);h.events.flush();await flush();
  const d=await drawings(h),frameA=d.renderActivity(),runA=h.events.epoch;
  const queued:Parameters<typeof h.page.dispatch>[0][]=[],dispatch=h.page.dispatch,receipts:{run:string;observed:string|undefined}[]=[];
  let holdStream=false,fail=false;
  h.page.dispatch=event=>{if(holdStream&&event.type==='hub')queued.push(event);else dispatch(event);};
  const restart=()=>{holdStream=true;const baseline=h.restart();baseline();assert.notEqual(h.events.epoch,runA);assert.equal(h.page.get().hubEpoch,runA);};
  if(mode==='restart-before-first'){restart();credit('New run project',NOW-17*M,NOW-14*M);h.events.flush();await flush();}
  const local=mounted(h,frameA,async(_board,request)=>{
    if(fail){fail=false;throw Error('subset unavailable');}
    // HTTP always uses the current reader; only the real stream frames wait.
    const reply=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,request)));
    receipts.push({run:reply.basis.run,observed:h.page.get().hubEpoch});return reply;
  });
  const shared=consumer({...h,...d},{muted:{'activity:project:"Work project"':true},subset:local.reader});
  try{
    await flush();
    const paintA=shared.settle();
    const first=local.reader.get().model;
    if(mode!=='restart-before-first'){
      assert.equal(local.reader.numbers(NOW)?.agentMs,2*M);
      fail=true;local.reader.retry();await flush();
      assert.equal(local.reader.get().error,'history_failed');assert.equal(local.reader.get().model,first);
      if(mode==='restart-before-replacement')restart();
      credit('New run project',NOW-17*M,NOW-14*M);h.events.flush();await flush();
      local.reader.retry();await flush();
    }
    const beforeHello=d.renderActivity(),paint=shared.settle();
    assert.equal(local.pool.activeFlights,0,'a rejected producer releases its flight');
    const reads=receipts.length;await flush();assert.equal(receipts.length,reads,'waiting for stream authority does not poll');
    if(mode==='same-run'){
      assert.equal(receipts.at(-1)!.run,h.page.get().hubEpoch);
      assert.equal(local.reader.numbers(NOW)?.agentMs,5*M);
      assert.ok(paint.names.includes('New run project'));
    }else{
      assert.equal(h.page.get().hubEpoch,runA);assert.notEqual(receipts.at(-1)!.run,runA);
      assert.equal(beforeHello.history,frameA.history);assert.deepEqual(paint.paths,paintA.paths);assert.deepEqual(paint.names,paintA.names);
      assert.equal(local.reader.get().model,first,'a different producer cannot replace the complete local basis');
      assert.equal(local.reader.numbers(NOW)?.agentMs??null,mode==='restart-before-first'?null:2*M);
    }
    for(const language of ['en','ru'] as const){
      setLocale(language);const html=local.render(beforeHello);
      if(mode==='restart-before-first'){assert.equal((html.match(/<b>—<\/b>/g)??[]).length,4);assert.ok(!html.includes('data-agent-ms="300000"'));}
      else assert.ok(html.includes(`data-agent-ms="${mode==='same-run'?5*M:2*M}"`),'the actual summary uses the same admitted cohort as its drawing');
    }
    if(mode!=='same-run'){
      holdStream=false;queued.splice(0).forEach(dispatch);
      assert.equal(h.page.get().hubEpoch,h.events.epoch);assert.equal(local.reader.get().model,null,'the real new-run hello retires the old subset');
      await flush();const fresh=d.renderActivity();local.rerender(fresh);await flush();
      assert.equal(local.reader.numbers(NOW)?.agentMs,5*M);assert.equal(receipts.at(-1)!.run,h.events.epoch);
      assert.ok(shared.settle().names.includes('New run project'));
      for(const language of ['en','ru'] as const){setLocale(language);assert.ok(local.render(fresh).includes('data-agent-ms="300000"'));}
    }
  }finally{
    holdStream=false;h.page.dispatch=dispatch;queued.splice(0).forEach(dispatch);
    shared.close();await local.close();d.close();await h.close();setLocale('en');
  }
});
