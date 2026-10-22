import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters,executableWorkFilters,parseWorkFilter,workFilter} from '../../server/domain/dataFilters';
import {expandPeriod} from '../../server/domain/periodWire';
import {activityFeedback} from './activityFeedbackFixture';
import {fixture,drawings,flush,NOW,H,M} from './periodRuntimeFixture';

for(const retained of [false,true])test(`fixed Activity ${retained?'retained':'initial'} failure waits for Retry through real subscriber renders`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed:true,personal:true,initialFilters:defaultFilters()});
  h.store.creditWork(h.device,NOW-20*M,NOW-18*M,[{source:h.source,client:'codex',origin:'terminal',project:'Keep project',folder:'',startedAt:NOW-H,identity:{kind:'stable',sessionId:'keep'}}]);h.events.flush();await flush();
  const d=await drawings(h);let fail=!retained;
  const local=activityFeedback(h,d,{send:async(board,request)=>{if(fail)throw Error('network unavailable');return expandPeriod(JSON.parse(h.reader.read(board,h.alice.id,request)));}});
  try{
    local.click('"Work project"');await local.settle();
    const old=local.reader.get().model;
    if(retained){assert.equal(local.reader.numbers(NOW)?.agentMs,2*M);fail=true;h.credit(NOW-M,NOW);h.events.flush();await local.settle();}
    t.diagnostic(JSON.stringify({retained,reads:local.reads,renders:local.renders,error:local.reader.get().error}));
    assert.equal(local.reads,retained?2:1,'one failed semantic need makes one bounded request');
    assert.equal(local.reader.get().errorOwner,'subset-read');assert.equal(local.reader.get().model,old);
    for(let i=0;i<5;i++){local.update();await local.settle();}
    assert.equal(local.reads,retained?2:1,'rendering the error cannot authorize another request');
    fail=false;local.reader.retry();await local.settle();
    assert.equal(local.reads,retained?3:2);assert.equal(local.reader.get().error,null);assert.equal(local.reader.numbers(NOW)?.agentMs,2*M);
    assert.equal(local.pool.activeFlights,0);
  }finally{await local.close();d.close();await h.close();}
});

test('unchanged live upstream pending and error settle, and Retry reaches the real work reader',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({personal:true,initialFilters:defaultFilters()}),d=await drawings(h);
  const local=activityFeedback(h,d,{muted:{'activity:project:"Other project"':true}});let gate:ReturnType<typeof h.hold>|undefined;
  try{
    await local.settle();const old=local.reader.get().model;assert.ok(old);
    gate=h.hold();h.credit(NOW-M,NOW);h.events.flush();await local.settle();
    assert.equal(local.reader.get().loading,true);assert.equal(local.reader.get().model,old);
    for(let i=0;i<4;i++){local.update();await local.settle();}
    gate.reject(Error('upstream unavailable'));await local.settle();assert.equal(local.reader.get().errorOwner,'upstream-work');
    for(let i=0;i<4;i++){local.update();await local.settle();}
    const reads=h.requests.length;local.reader.retry();await local.settle();
    assert.equal(h.requests.length,reads+1);assert.equal(local.reads,0);assert.equal(local.reader.get().error,null);assert.equal(local.reader.numbers(NOW)?.agentMs,2*M);
  }finally{gate?.release();await local.close();d.close();await h.close();}
});

for(const fixed of [false,true])test(`${fixed?'fixed':'live'} admitted oversized predicate has one stable local error until narrowed`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({fixed,personal:true,initialFilters:defaultFilters()}),d=await drawings(h);
  const local=activityFeedback(h,d,{muted:{'activity:project:"Other project"':true}});
  try{
    await local.settle();const filters=defaultFilters();filters.projects.values=Array.from({length:700},(_,i)=>String(i).padStart(4,'0')+'x'.repeat(110));
    assert.ok(parseWorkFilter(workFilter(filters)));assert.equal(executableWorkFilters(workFilter(filters)),false);
    const reads=local.reads;local.filters(filters);await local.settle();assert.equal(local.reader.get().error,'history_limit');assert.equal(local.reads,reads);
    for(let i=0;i<4;i++){local.update();await local.settle();}
    assert.equal(local.reads,reads);local.filters(defaultFilters());await local.settle();
    assert.equal(local.reader.get().error,null);assert.equal(local.reader.numbers(NOW)?.agentMs,M);assert.equal(local.reads,reads+Number(fixed));
  }finally{await local.close();d.close();await h.close();}
});

test('pausing a failed subset does not retry it, but relevant work while paused gets one resumed attempt',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({fixed:true,personal:true,initialFilters:defaultFilters()}),d=await drawings(h);let fail=true;
  const local=activityFeedback(h,d,{muted:{'activity:project:"Other project"':true},send:async(board,request)=>{if(fail)throw Error('network unavailable');return expandPeriod(JSON.parse(h.reader.read(board,h.alice.id,request)));}});
  try{
    await local.settle();assert.equal(local.reads,1);local.pause(true);await local.settle();local.pause(false);await local.settle();assert.equal(local.reads,1);
    h.event({type:'history',data:{sources:[h.source],since:0,workAuthority:h.page.get().board!.workAuthority,changes:[{source:h.source,scope:'budget',since:0}]}});await local.settle();assert.equal(local.reads,1,'independent financial news does not reopen work');
    local.pause(true);await local.settle();h.credit(NOW-M,NOW);h.events.flush();await local.settle();assert.equal(local.reads,1);
    fail=false;local.pause(false);await local.settle();assert.equal(local.reads,2);assert.equal(local.reader.numbers(NOW)?.agentMs,2*M);
  }finally{await local.close();d.close();await h.close();}
});

test('news during a failed flight authorizes one current attempt without publishing the old error',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({fixed:true,personal:true,initialFilters:defaultFilters()}),d=await drawings(h);
  let reject!:(error:Error)=>void;
  const first=new Promise<never>((_resolve,no)=>{reject=no;});let calls=0;
  const local=activityFeedback(h,d,{muted:{'activity:project:"Other project"':true},send:async(board,request)=>{if(++calls===1)return first;return expandPeriod(JSON.parse(h.reader.read(board,h.alice.id,request)));}});
  try{
    await local.settle();assert.equal(local.reads,1);const errors:string[]=[],stop=local.reader.subscribe(()=>{const error=local.reader.get().error;if(error)errors.push(error);});
    h.credit(NOW-M,NOW);h.events.flush();await local.settle();reject(Error('older read failed'));await local.settle();stop();
    assert.equal(local.reads,2);assert.deepEqual(errors,[]);assert.equal(local.reader.get().error,null);assert.equal(local.reader.numbers(NOW)?.agentMs,2*M);
    for(let i=0;i<4;i++){local.update();await local.settle();}assert.equal(local.reads,2);
  }finally{reject(Error('fixture stopped'));await local.close();d.close();await h.close();}
});

test('a live preparation refusal is stable under subscriber renders and retries locally once',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({personal:true,initialFilters:defaultFilters()}),d=await drawings(h);
  const local=activityFeedback(h,d,{muted:{'activity:project:"Other project"':true}}),reserve=local.pool.reserve.bind(local.pool);let attempts=0;
  local.pool.reserve=()=>{attempts++;return false;};
  try{
    await local.settle();assert.equal(local.reader.get().errorOwner,'local-preparation');assert.equal(attempts,1);assert.equal(local.reads,0);
    for(let i=0;i<5;i++){local.update();await local.settle();}
    assert.equal(attempts,1,'failed preparation is not a new demand on every render');
    local.pool.reserve=reserve;local.reader.retry();await local.settle();assert.equal(local.reader.get().error,null);assert.equal(local.reader.numbers(NOW)?.agentMs,M);assert.equal(local.reads,0);
  }finally{local.pool.reserve=reserve;await local.close();d.close();await h.close();}
});
