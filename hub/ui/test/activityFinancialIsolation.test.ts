import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import type {History} from '../lib/types';
import {defaultFilters} from '../../server/domain/dataFilters';
import {planEventsAt,planEventsDeadline} from '../../server/domain/history';
import {frameChangesAt} from '../lib/periods';
import {shallowEqual} from '../lib/store';
import {timeRangeKey} from '../lib/timeRange';
import {fixture,drawings,flush,NOW,H,M} from './periodRuntimeFixture';

function financialPointRead():never {
  const error=new Error('Activity inspected native financial data');
  error.name='FinancialPointRead';
  throw error;
}
const isFinancialPointRead=(error:unknown)=>error instanceof Error&&error.name==='FinancialPointRead';

/** Observe the loaded producer evidence without replacing its quota values. */
function forbidQuotaPoints(history:History) {
  const restores=history.series.map(series=>{
    const descriptor=Object.getOwnPropertyDescriptor(series,'points');
    assert.ok(descriptor);
    Object.defineProperty(series,'points',{configurable:true,enumerable:true,get:financialPointRead});
    return ()=>Object.defineProperty(series,'points',descriptor);
  });
  return ()=>{for(const restore of restores.reverse())restore();};
}

/** Copying the envelope is harmless; walking its financial facts is not needed. */
function forbidPlanInspection(history:History) {
  const descriptor=Object.getOwnPropertyDescriptor(history,'events');
  assert.ok(descriptor);
  const events=new Proxy(history.events,{get(target,key,receiver){
    if(key===Symbol.iterator||typeof key==='string'&&(
      /^\d+$/.test(key)||['flatMap','map','filter','some','every','reduce','find'].includes(key)
    ))financialPointRead();
    return Reflect.get(target,key,receiver);
  }});
  Object.defineProperty(history,'events',{configurable:true,enumerable:true,get:()=>events});
  return ()=>Object.defineProperty(history,'events',descriptor);
}

for(const fixed of [false,true])test(`${fixed?'fixed Activity alone':'live Activity with a quota widget'} reads work without native quota points`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed,activityOnly:fixed}),d=await drawings(h);
  let restore=()=>{};
  try{
    const raw=d.loader.get().history;
    assert.ok(raw&&raw.series.some(series=>series.points.length));
    assert.equal(h.period.activityProjectionState(raw).ready,true);
    restore=forbidQuotaPoints(raw);
    let shown:ReturnType<typeof d.renderActivity>|undefined;
    assert.doesNotThrow(()=>{shown=d.renderActivity();},'Activity must not require quota point contents');
    assert.ok(shown?.history);
    assert.equal(shown.loading,false);
    assert.equal(shown.error,undefined);
    assert.equal(shown.history.range,raw.range);
    assert.equal(shown.history.activity.agentMs,M);
    assert.equal(shown.history.activity.agents,1);
    assert.deepEqual(shown.history.activity.by.project.map((group:{name:string|null})=>group.name),['Work project']);
    for(let i=0;i<3;i++)assert.equal(d.renderActivity().history,shown.history,'unchanged snapshots retain their identity');
    assert.throws(()=>d.render(),isFinancialPointRead,'quota readers still require their native points');
    restore();restore=()=>{};
    // Real financial news replaces the native input after the first snapshot.
    // Activity must still have no reason to inspect that input's plan facts.
    h.store.record(h.source,{observedAt:NOW-M,plan:'Changed plan',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:19,remaining:81,resetAt:NOW+H}]});
    h.events.flush();await flush();
    const updated=d.loader.get().history;
    assert.ok(updated);
    restore=forbidPlanInspection(updated);
    let next:ReturnType<typeof d.renderActivity>|undefined;
    assert.doesNotThrow(()=>{next=d.renderActivity();},'Activity has no financial plan expiry clock');
    assert.ok(next?.history);
    assert.equal(next.history.activity.agentMs,M);
    assert.equal(next.history.activity.agents,1);
    assert.throws(()=>d.render(),isFinancialPointRead,'quota readers retain their plan event deadline');
  }finally{restore();d.close();await h.close();}
});

test('co-visible fixed Activity prepares one shared native frame and both consumers reuse it',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed:true}),d=await drawings(h);
  let restore=()=>{};
  try{
    const raw=d.loader.get().history;assert.ok(raw&&raw.series.some(series=>series.points.length));
    const accounting=h.period.tapes.get('quota').accounting,project=accounting.project.bind(accounting);
    let calls=0;
    t.mock.method(accounting,'project',(...args:Parameters<typeof project>)=>{calls++;return project(...args);});
    const reads=h.requests.length,activity=d.renderActivity();
    assert.ok(activity.history);assert.equal(activity.loading,false);assert.equal(activity.error,undefined);
    assert.equal(calls,1,'the first consumer builds the native frame demanded by the visible quota widget');
    assert.equal(activity.history.activity.agentMs,M);assert.equal(activity.history.activity.agents,1);
    assert.deepEqual(activity.history.activity.by.project.map((group:{name:string|null})=>group.name),['Work project']);
    assert.ok(activity.history.series.some((series:{remainingAtEnd:number|null})=>series.remainingAtEnd===83),'the shared frame also contains the actual native quota endpoint');
    restore=forbidQuotaPoints(raw);
    for(let i=0;i<3;i++){
      assert.equal(d.renderActivity().history,activity.history,'Activity reuses the complete shared projection');
      assert.equal(d.render().history,activity.history,'the quota consumer reuses the same projection without rereading native points');
    }
    assert.equal(calls,1);assert.equal(h.requests.length,reads,'sharing a fixed frame adds no request');
  }finally{restore();d.close();await h.close();}
});

test('Activity retains selected work through pending and failure, recovers, then retires revoked authority',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({initialFilters:defaultFilters()}),d=await drawings(h);
  let restore=()=>{},release=()=>{};
  const held=h.hold();
  try{
    const initial=d.renderActivity();
    assert.ok(initial.history);
    assert.equal(initial.history.activity.agentMs,M);
    const captured=h.period.captureActivity(initial.history);
    assert.ok(captured?.projector,'live Activity keeps its numerical projection lifetime');
    assert.equal(h.period.activityValid(captured),true);
    release=h.period.retainActivity(captured);
    h.credit(NOW-M,NOW);h.events.flush();await flush();
    assert.ok(h.requests.some(request=>request.sessions));
    const pending=d.renderActivity();
    assert.equal(pending.history,initial.history,'pending selected work keeps the completed frame');
    assert.equal(h.period.get().loading,false,'a soft refresh retains completed work evidence');
    assert.equal(h.period.get().error,null);
    held.reject(new Error('held work delivery failed'));await flush();
    const failed=d.renderActivity();
    assert.equal(failed.error,'history_failed');
    assert.equal(failed.history,initial.history,'a work error retains compatible completed evidence');
    assert.ok(h.period.get().error,'failed selected work activates the incomplete-cohort guard');
    assert.equal(h.period.activityValid(captured),true);
    const raw=d.loader.get().history;
    assert.ok(raw);
    restore=forbidQuotaPoints(raw);
    let hidden:History|undefined;
    // The fourth argument selects Activity in the existing projection owner.
    // Older implementations accept it but still read quota points above.
    assert.doesNotThrow(()=>{hidden=h.period.project(raw,'quota',NOW,true);});
    assert.ok(hidden);
    assert.equal(hidden.activity.known,null,'failed selected work cannot invent an empty completed cohort');
    assert.equal(hidden.activity.agentMs,0);
    restore();restore=()=>{};
    h.period.retry();d.loader.retry();await flush();
    const recovered=d.renderActivity();
    assert.equal(recovered.error,undefined);
    assert.equal(recovered.loading,false);
    assert.ok(recovered.history);
    assert.notEqual(recovered.history,initial.history);
    assert.equal(recovered.history.activity.agentMs,2*M,'retry delivers both actual credited intervals');
    const renewed=h.period.captureActivity(recovered.history);
    assert.ok(renewed?.projector);
    assert.equal(h.period.activityValid(renewed),true);
    release();release=h.period.retainActivity(renewed);
    h.remove();await flush();
    assert.equal(h.period.activityValid(captured),false,'revoked authority retires the captured lifetime');
    assert.equal(h.period.activityValid(renewed),false,'recovered work has the same authority boundary');
    const retired=d.renderActivity();
    assert.ok(!retired.history||retired.history.activity.known===null);
    assert.equal(retired.history?.activity.agentMs??0,0,'revoked work cannot return through the retained frame');
  }finally{restore();held.release();release();d.close();await h.close();}
});

test('Activity executes only its rolling frame clock while quota retains its financial clock',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture(),d=await drawings(h);
  let financialCalls=0,frameCalls=0,nextWake:number|null=null;
  const projectionChangesAt=h.period.projectionChangesAt;
  t.mock.method(h.period,'projectionChangesAt',(...args:unknown[])=>{
    financialCalls++;return projectionChangesAt(...args);
  });
  try{
    const slots:{current:unknown}[]=[];
    let cursor=0;
    const context={
      useRef:(current:unknown)=>slots[cursor++]??(slots[cursor-1]={current}),
      useMemo:(read:()=>unknown)=>read(),useSyncExternalStore:(_subscribe:unknown,read:()=>unknown)=>read(),
      pan:h.pan,hubNow:()=>NOW,planEventsAt,planEventsDeadline,shallowEqual,
      useClock:(changes:(at:number)=>number|null)=>{nextWake=changes(NOW);return NOW;},
      frameChangesAt:(...args:Parameters<typeof frameChangesAt>)=>{frameCalls++;return frameChangesAt(...args);},
      fundsHistory:{},page:h.page,timeRange:h.selectedRange,timeRangeKey,prefs:()=>h.settings,boardPeriod:h.period,
      read:null as unknown as (loader:unknown,rolling:boolean,financial:boolean,activity:boolean)=>{history:History|null},
    };
    const source=readFileSync(new URL('../lib/history.ts',import.meta.url),'utf8');
    const body=source.slice(source.indexOf('function usePeriodHistory('),source.indexOf('export function useHistory('));
    runInNewContext(ts.transpileModule(body+'\nglobalThis.read=usePeriodHistory;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
    const activity=context.read(d.loader,true,false,true);
    assert.equal(activity.history?.activity.agentMs,M);
    assert.equal(financialCalls,0,'executing the Activity clock must not inspect native accounting deadlines');
    assert.ok(frameCalls>0,'the rolling frame still owns its wake');
    assert.equal(nextWake,frameChangesAt(null,d.loader.get().history!.cellMs,NOW));
    assert.ok(nextWake!==null&&nextWake>NOW);
    cursor=0;slots.length=0;
    const quota=context.read(d.loader,false,false,false);
    assert.ok(quota.history);
    assert.ok(financialCalls>0,'quota keeps the actual financial deadline owner');
  }finally{d.close();await h.close();}
});
