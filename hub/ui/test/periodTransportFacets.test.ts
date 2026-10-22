import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,abortable,NOW,H,M} from './periodRuntimeFixture';
import {defaultFilters,workFilter} from '../../server/domain/dataFilters';
import {publishDataFilters} from '../lib/filterSelection';
import {subscriptionSelection} from '../lib/subscription';
import {PeriodTransport,type PeriodIntent,type HistoryReadOwner} from '../lib/periodTransport';
import {HistoryPool} from '../lib/historyPool';
import {PERIOD_SCOPES,type PeriodRequest,type PeriodReply} from '../../server/domain/periodRead';
import {assertActivityCancellation} from '../../bench/fixedActivity';

test('fresh interactive facets answer while an older same-cohort work response is held',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const filters=defaultFilters();filters.projects={mode:'exclude',values:['Other project']};
  const h=await fixture({personal:true,fixed:true,heatmap:true,periodName:'1d',initialFilters:filters});
  h.selectRange({from:NOW-24*H,to:NOW});await flush();
  const view=h.directory.view(h.board);
  h.directory.saveView(h.board,{...view,shown:['agents','activity','quota-history','budget-history','subscription-funds','agent-hours-heatmap'],hidden:[]},h.alice.id,NOW+1);
  h.events.flush();await flush();
  const drawing=await drawings(h),held=h.hold();let releaseFacets=()=>{};
  const choose=(next:typeof filters)=>{
    publishDataFilters(next);h.period.changed();
    drawing.loader.setWorkFilter(JSON.stringify([h.page.get().hubEpoch,workFilter(next)]),workFilter(next));
    const board=h.page.get().board;assert.ok(board);
    drawing.loader.setMeters(subscriptionSelection(Object.values(board.cards),board.view));
  };
  try{
    h.requests.length=0;assert.equal(h.period.getFacets().value,null);
    h.credit(NOW-2*M+700,NOW-M+700);h.events.flush();drawing.runScheduled();await flush();
    assert.ok(held.reply);assert.equal(h.requests.length,1);assert.ok(!h.requests[0].facets);
    const old=h.period.intent();releaseFacets=h.period.demandFacets();await flush();
    assert.equal(h.period.intent().generation,old.generation);
    assert.equal(h.period.intent().resourceGeneration,old.resourceGeneration);
    assert.ok(h.period.getFacets().value?.clients.includes('codex'),'opening Clients must not wait for the held response or its HTTP timeout');
    assert.equal(held.signal?.aborted,false,'the original native evidence retains its actual lifetime');
    assert.equal(h.requests.filter(body=>body.facets).length,1);
    assert.equal(h.requests.filter(body=>body.sessions).length,2);
    assert.equal(h.pool.activeFlights,1,'the interactive response has settled beside the still-held original');
    const b=structuredClone(filters);b.clients={mode:'exclude',values:['codex']};choose(b);await flush();
    choose(structuredClone(filters));await flush();releaseFacets();releaseFacets=()=>{};
    assert.equal(h.requests.filter(body=>body.sessions).length,2,'B and final A cannot bypass useful older native work');
    held.release();await flush();drawing.runScheduled();await flush();
    assertActivityCancellation(h.requests,h.period.intent().request.selection);
    assert.equal(h.requests.filter(body=>body.sessions).length,3);
    const work=h.requests.filter(body=>body.sessions);assert.deepEqual(work.at(-1)?.workFilter,workFilter(filters));
    const activity=drawing.renderActivity();assert.ok(activity.history);assert.equal(activity.loading,false);
    assert.equal(activity.history.since,NOW-24*H);assert.equal(activity.history.to,NOW);
    assert.deepEqual([activity.history.activity.agentMs,activity.history.activity.activeMs,activity.history.activity.agents],[2*M,2*M,1],'the actual Activity consumer restores A rather than B\'s excluded zero');
    assert.ok(h.period.activityProjectionState(drawing.loader.get().history).ready);
    assert.equal(h.pool.activeFlights,0);assert.ok(h.pool.estimatedBytes<=h.pool.budget);
  }finally{held.release();releaseFacets();drawing.close();h.page.dispatch({type:'board-close'});await h.close();publishDataFilters(null,false);}
});

test('two open controls and a later invalidation do not duplicate a covering same-cohort facet response',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true,current:true}),old=h.hold();let releaseFirst=()=>{},releaseSecond=()=>{},facets:ReturnType<typeof h.hold>|undefined;
  try{
    h.requests.length=0;h.credit(NOW-2*M+10,NOW-M+10);h.events.flush();await flush();assert.ok(old.reply);
    facets=h.hold();releaseFirst=h.period.demandFacets();await flush();
    assert.ok(facets.reply,'the actual facet HTTP must start before the older response is released');
    assert.equal(h.requests.length,2);assert.equal(h.pool.activeFlights,2);
    releaseSecond=h.period.demandFacets();await flush();assert.equal(h.requests.length,2);
    const generation=h.period.intent().generation,facetGeneration=h.period.intent().facetGeneration,resource=h.period.intent().resourceGeneration;
    h.endIdle();await flush();
    assert.equal(h.period.intent().generation,generation);assert.ok(h.period.intent().facetGeneration>facetGeneration);
    assert.equal(h.period.intent().resourceGeneration,resource,'a real presence-only stream update keeps the native resource authority');
    assert.equal(h.requests.length,2,'an in-flight facet body continues to own the replacement lane');
    facets.release();await flush();
    assert.ok(h.requests.length>=3,'invalidated facet evidence is refreshed after its covering response settles');
    assert.ok(h.period.getFacets().value?.clients.includes('codex'));
    assert.equal(old.signal?.aborted,false);assert.ok(h.pool.activeFlights<=2);
    releaseFirst();releaseFirst=()=>{};releaseSecond();releaseSecond=()=>{};
    const reads=h.requests.length;releaseFirst=h.period.demandFacets();await flush();
    assert.equal(h.requests.length,reads,'reopening complete fixed-range choices reads their current cache');
  }finally{old.release();facets?.release();releaseFirst();releaseSecond();h.page.dispatch({type:'board-close'});await h.close();}
});

const range={from:NOW-H,to:NOW};
const query={cell:String(M),from:String(range.from),to:String(range.to),cells:'skip'};
type Attempt={body:PeriodRequest;signal:AbortSignal;bytes:number;answer():Promise<void>};
function transportFixture(request:Partial<PeriodRequest>={sessions:{}}){
  const pool=new HistoryPool(),attempts:Attempt[]=[],received:{reply:PeriodReply;intent:PeriodIntent}[]=[];
  let intent:PeriodIntent|null={board:'board',generation:1,revision:1,resourceGeneration:1,facetGeneration:1,request:{version:1,selection:{mode:'range',...range},evaluatedAt:NOW,...request}};
  const transport=new PeriodTransport(pool,()=>intent,(reply,captured)=>{received.push({reply,intent:captured});},async(_board,body,signal,reserve)=>{
    const ordinal=attempts.length+1,bytes=ordinal*1024,basis={run:'run',revision:String(ordinal),evaluatedAt:NOW,evidenceCut:NOW,range};
    let answer!:()=>void;const pending=new Promise<void>(resolve=>{answer=resolve;});
    assert.ok(reserve(bytes));
    attempts.push({body,signal,bytes,answer:async()=>{answer();await flush();}});
    await abortable(pending,signal);
    const reply:PeriodReply={basis};
    for(const scope of PERIOD_SCOPES)if(body[scope])reply[scope]={state:'complete',basis,value:{run:'run',now:NOW,historyStart:0,known:{work:0,sources:{}},chunks:[],meta:'m',tape:{cursor:`${scope}-${ordinal}`,from:range.from,cut:range.to,replaceFrom:range.from,quota:[],money:[]}}};
    if(body.facets)reply.facets={state:'complete',basis,value:{projects:[],devices:[],clients:['codex'],funding:[]}};
    return reply;
  });
  const change=(patch:Partial<PeriodIntent>={},parts:Partial<PeriodRequest>={})=>{assert.ok(intent);intent={...intent,...patch,revision:intent.revision+1,request:{...intent.request,...parts}};transport.change();};
  return {pool,transport,attempts,received,intent:()=>intent,change,close:async()=>{intent=null;transport.reset();await flush();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);}};
}

for(const control of ['no facets','already requested facets','new cohort','new cohort with facets'] as const)
test(`interactive admission preserves the existing barrier for ${control}`,async()=>{
  const h=transportFixture({sessions:{},...(control.includes('with facets')||control==='already requested facets'?{facets:true as const}:{})});
  try{
    h.transport.change();await flush();assert.equal(h.attempts.length,1);
    const newCohort=control.startsWith('new cohort');
    h.change(newCohort?{generation:2}:{},control==='no facets'?{calendar:{zone:'UTC',relative:true}}:{facets:true});await flush();
    assert.equal(h.attempts.length,1);assert.equal(h.attempts[0].signal.aborted,false);
    assert.equal(h.pool.activeFlights,1);assert.equal(h.pool.estimatedBytes,1024);
  }finally{await h.close();}
});

test('a queued interactive body covers repeated demand while the same shared two slots remain occupied',async()=>{
  const h=transportFixture(),blocker={role:'visible' as const},owner={estimatedBytes:0,evictionCandidates:()=>[]};
  try{
    h.transport.change();await flush();h.pool.request(owner,blocker,()=>{},()=>{});await flush();
    h.change({}, {facets:true});await flush();assert.equal(h.pool.activeFlights,2);assert.equal(h.attempts.length,1);
    h.change({}, {facets:true});await flush();assert.equal(h.attempts.length,1);
    h.pool.release(blocker);await flush();assert.equal(h.attempts.length,2,'exactly one queued interactive body starts in the newly free slot');
    assert.ok(h.attempts[1].body.facets);assert.equal(h.pool.activeFlights,2);assert.equal(h.pool.estimatedBytes,3072);
    h.change({}, {facets:true});await flush();assert.equal(h.attempts.length,2);
  }finally{h.pool.release(blocker);await h.close();}
});

test('interactive admission retains decoded input and the original reader slot until its actual finished promise settles',async()=>{
  const h=transportFixture();let finish!:()=>void,role:'visible'|null='visible';
  const owner:HistoryReadOwner={finished:new Promise<void>(resolve=>{finish=resolve;}),role:()=>role,cancel:()=>{role=null;}};
  const read=h.transport.read('quota',query,undefined,owner).catch(error=>error);
  try{
    h.transport.change();await flush();h.change({}, {facets:true});await flush();assert.equal(h.attempts.length,2);
    await h.attempts[0].answer();await read;
    assert.equal(h.pool.activeFlights,2,'a decoded old answer still belongs to its preparing recipient');
    assert.equal(h.pool.estimatedBytes,4096,'both decoded inputs and the late native metadata view remain charged');
    h.transport.reset();await flush();assert.equal(h.pool.activeFlights,1);assert.equal(h.pool.estimatedBytes,2048);
    finish();await flush();assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,0);
  }finally{finish();await h.close();}
});

test('live baseline pruning remains serialized when the captured intent promises facets but its actual body omits them',async()=>{
  const h=transportFixture({selection:{mode:'live',periodMs:H},sessions:{},facets:true,quota:query,budget:query});
  try{
    h.transport.change();await flush();assert.ok(h.attempts[0].body.facets);assert.ok(h.attempts[0].body.quota);assert.ok(!h.attempts[0].body.budget);
    await h.attempts[0].answer();assert.equal(h.attempts.length,2);
    assert.ok(h.intent()?.request.facets);assert.ok(!h.attempts[1].body.facets);assert.ok(h.attempts[1].body.budget);
    h.change({}, {facets:true});await flush();assert.equal(h.attempts.length,2,'a pending native baseline keeps its original admission barrier');
    await h.attempts[1].answer();await flush();assert.equal(h.attempts.length,3);
    assert.ok(h.attempts[2].body.facets,'the later current request still reaches fresh facets after baseline adoption');
  }finally{await h.close();}
});

test('a separate admission admits interactive work without changing its real pool owner or admitting a third flight',async()=>{
  const pool=new HistoryPool(),owner={estimatedBytes:0,evictionCandidates:()=>[]},admission={};
  const original={role:'visible' as const},ordinary={role:'visible' as const},interactive={role:'visible' as const,admission},duplicate={role:'visible' as const,admission};
  const started:object[]=[];
  try{
    for(const flight of [original,ordinary])pool.request(owner,flight,()=>{started.push(flight);},()=>{});
    await flush();assert.deepEqual(started,[original],'ordinary work retains one visible admission per owner');
    for(const flight of [interactive,duplicate])pool.request(owner,flight,()=>{started.push(flight);},()=>{});
    await flush();assert.deepEqual(started,[original,interactive]);assert.equal(pool.activeFlights,2);
    const active=(pool as unknown as {active:Map<object,{owner:object}>}).active;
    assert.ok([...active.values()].every(value=>value.owner===owner),'diagnostics and demand bindings still identify the original storage owner');
    pool.release(original);await flush();assert.deepEqual(started,[original,interactive,ordinary]);assert.equal(pool.activeFlights,2);
    pool.release(interactive);await flush();assert.deepEqual(started,[original,interactive,ordinary,duplicate]);assert.equal(pool.activeFlights,2);
  }finally{for(const flight of [original,ordinary,interactive,duplicate])pool.release(flight);await flush();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);}
});

test('interactive admission preempts speculation but waits for its finished lifetime before using the shared second slot',async()=>{
  const pool=new HistoryPool(),owner={estimatedBytes:0,evictionCandidates:()=>[]},speculativeOwner={estimatedBytes:0,evictionCandidates:()=>[]};
  const original={role:'visible' as const},speculative={role:'ahead' as const},interactive={role:'visible' as const,admission:{}};
  let finish!:()=>void,cancelled=0,started=false;
  const finished=new Promise<void>(resolve=>{finish=resolve;});
  try{
    pool.request(owner,original,()=>{assert.ok(pool.reserve(original,1024));},()=>{});
    pool.request(speculativeOwner,speculative,()=>{assert.ok(pool.reserve(speculative,2048));},()=>{cancelled++;void finished.then(()=>pool.release(speculative));});
    await flush();assert.equal(pool.activeFlights,2);assert.equal(pool.estimatedBytes,3072);
    pool.request(owner,interactive,()=>{started=true;assert.ok(pool.reserve(interactive,4096));},()=>{});
    await flush();assert.equal(cancelled,1);assert.equal(started,false);assert.equal(pool.activeFlights,2);assert.equal(pool.estimatedBytes,3072);
    finish();await flush();assert.equal(started,true);assert.equal(pool.activeFlights,2);assert.equal(pool.estimatedBytes,5120);
  }finally{finish();for(const flight of [original,speculative,interactive])pool.release(flight);await flush();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);}
});
