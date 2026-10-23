import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,NOW,H,M} from './periodRuntimeFixture';
import {Preparations} from '../lib/prepare';
import {defaultFilters} from '../../server/domain/dataFilters';
import {publishDataFilters} from '../lib/filterSelection';

const coherent=(history:any,required=false)=>{
 if(required)assert.ok(history,'compatible completed Activity stays visible during preparation');
 if(!history)return;
 const drawn=history.activity.by.project.reduce((n:number,g:any)=>n+g.cells.reduce((sum:number,c:number[])=>sum+c[1],0),0);
 assert.equal(drawn,history.activity.agentMs,'every accepted summary and its interior cells share one work revision');
};

for(const fixed of [false,true])for(const sameKeys of [false,true])test(`${fixed?'fixed':'live'} Activity waits for its actual composed cohort: ${sameKeys?'unchanged group identities':'returning group'}`,async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const all=defaultFilters(),h=await fixture({fixed,personal:true,initialFilters:all,periodName:'24h'});
 let d:any;const tasks:(()=>void)[]=[];let clock=0,steps=0;
 const preparer=new Preparations({now:()=>clock++,post:run=>tasks.push(run)});
 const finish=async()=>{for(let i=0;i<10000;i++){while(tasks.length){assert.ok(++steps<30000,'bounded actual HistoryStore preparation');tasks.shift()!();coherent(d.renderActivity().history);}await flush();coherent(d.renderActivity().history);if(!tasks.length)return;}assert.fail('drawing preparation did not settle');};
 try{
  h.store.creditWork(h.device,NOW-11*M,NOW-7*M,[{source:h.source,client:'claude',origin:'terminal',project:sameKeys?'Work project':'Returning project',folder:'Returning folder',startedAt:NOW-H,identity:{kind:'stable',sessionId:'d'.repeat(32)}}]);h.events.flush();await flush();
  d=await drawings(h);const initial=d.renderActivity().history;
  assert.ok(initial&&initial.activity.agentMs===5*M,'positive real producer/wire/coordinator/drawing baseline');
  d.prepareWith(preparer);
  const filtered=defaultFilters();if(sameKeys)filtered.clients={mode:'exclude',values:['claude']};else filtered.projects={mode:'exclude',values:['Returning project']};
  publishDataFilters(filtered);d.syncFilters();h.period.changed();await flush();
  assert.equal(h.period.get().rows.length,1,'the actual coordinator adopted the smaller cohort independently');
  assert.ok(tasks.length>0,'HistoryStore drawing preparation is controlled separately');
  await finish();const small=d.renderActivity().history;
  assert.ok(small);assert.equal(small.activity.agentMs,M);
  const keys=small.activity.by.project.map((g:any)=>g.key);
  if(sameKeys)assert.deepEqual(keys,initial.activity.by.project.map((g:any)=>g.key),'both different cohorts really have identical group keys');
  publishDataFilters(all);d.syncFilters();h.period.changed();await flush();
  assert.equal(h.period.get().rows.length,2,'the authoritative replacement work has both exact real sessions');
  assert.equal(h.period.get().loading,false,'coordinator preparation already completed');
  assert.ok(tasks.length>0,'the independent drawing composition has not completed');
  const pending=d.renderActivity();
  assert.equal(pending.history===null,true,'a fresh current summary must not borrow the previous cohort drawing, even with identical group identities');
  assert.equal(pending.loading,true);
  await finish();const restored=d.renderActivity().history;
  assert.ok(restored);assert.equal(restored.activity.agentMs,5*M);
  assert.equal(restored.activity.by.project.reduce((sum:number,g:any)=>sum+g.cells.reduce((n:number,c:number[])=>n+c[1],0),0),5*M,'the accepted drawing groups add up to the same current full-cohort summary');
  if(!sameKeys)assert.ok(restored.activity.by.project.find((g:any)=>g.key==='"Returning project"')?.cells.length,'a returned positive group has actual cells');
 }finally{d?.close();preparer.dispose();publishDataFilters(null,false);await h.close();}
});

for(const fixed of [false,true])test(`${fixed?'fixed':'live'} same-cohort refresh keeps summary and cells on one revision while drawing preparation waits`,async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({fixed,personal:true,initialFilters:defaultFilters(),periodName:'24h'});let d:any;const tasks:(()=>void)[]=[];let clock=0,steps=0;
 const preparer=new Preparations({now:()=>clock++,post:run=>tasks.push(run)});
 const finish=async()=>{for(let i=0;i<10000;i++){while(tasks.length){assert.ok(++steps<30000);tasks.shift()!();coherent(d.renderActivity().history,true);}await flush();coherent(d.renderActivity().history,true);if(!tasks.length)return;}assert.fail('drawing preparation did not settle');};
 try{
  d=await drawings(h);const initial=d.renderActivity().history;assert.ok(initial);assert.equal(initial.activity.agentMs,M);
  const presentation=d.loader.getActivityPresentation(),keys=initial.activity.by.project.map((g:any)=>g.key);
  d.prepareWith(preparer);
  h.store.creditWork(h.device,NOW-30*M,NOW-26*M,[{source:h.source,client:'codex',origin:'terminal',project:'Work project',folder:'Private folder',startedAt:NOW-H,identity:{kind:'stable',sessionId:'e'.repeat(32)}}]);h.events.flush();await flush();
  assert.equal(h.period.get().rows.length,2,'actual coordinator already adopted the new same-cohort session');assert.equal(h.period.get().loading,false);
  assert.equal(d.loader.getActivityPresentation(),presentation,'this is a changed-evidence case without a semantic presentation/filter change');assert.ok(tasks.length>0);
  const pending=d.renderActivity().history;assert.ok(pending,'same-context accepted data remains useful during refresh');
  assert.deepEqual(pending.activity.by.project.map((g:any)=>g.key),keys);
  const drawn=pending.activity.by.project.reduce((n:number,g:any)=>n+g.cells.reduce((sum:number,c:number[])=>sum+c[1],0),0);
  assert.equal(drawn,pending.activity.agentMs,'a held same-cohort frame may be old or new, but current totals cannot borrow old interior cells');
  await finish();const settled=d.renderActivity().history;assert.ok(settled);assert.equal(settled.activity.agentMs,5*M);assert.equal(settled.activity.by.project.reduce((n:number,g:any)=>n+g.cells.reduce((sum:number,c:number[])=>sum+c[1],0),0),5*M);
 }finally{d?.close();preparer.dispose();publishDataFilters(null,false);await h.close();}
});

test('Activity reveal retains its complete frame while a native-only drawing is replaced',async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({personal:true,periodName:'24h'});let d:any;const tasks:(()=>void)[]=[];let clock=0,steps=0;
 const preparer=new Preparations({now:()=>clock++,post:run=>tasks.push(run)});
 const finish=async()=>{for(let i=0;i<10000;i++){while(tasks.length){assert.ok(++steps<30000);tasks.shift()!();coherent(d.renderActivity().history,true);}await flush();coherent(d.renderActivity().history,true);if(!tasks.length)return;}assert.fail('drawing preparation did not settle');};
 try{
  d=await drawings(h);const initial=d.renderActivity().history;assert.ok(initial);assert.equal(initial.activity.agentMs,M);coherent(initial);
  // The active reader makes this transition when Activity is hidden.
  d.loader.setActivityActive(false);await flush();
  h.store.record(h.source,{observedAt:NOW-M,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:18,remaining:82,resetAt:NOW+H}]});h.events.flush();await flush();d.runScheduled();await flush();
  const native=d.loader.get().history;assert.ok(native);assert.notEqual(native,initial);assert.equal(native.activity.cells.length,0,'a native-only composition contains no Activity cells');
  d.prepareWith(preparer);d.loader.setActivityActive(true);await flush();
  assert.ok(tasks.length>0,'revealing Activity queued its own drawing preparation');
  const pending=d.renderActivity();assert.ok(pending.history);assert.equal(pending.history.activity.agentMs,M);coherent(pending.history);
  assert.equal(pending.history,initial,'the complete Activity frame remains visible until its replacement is ready');
  await finish();const ready=d.renderActivity().history;assert.ok(ready);assert.equal(ready.activity.agentMs,M);coherent(ready);
 }finally{d?.close();preparer.dispose();await h.close();}
});
