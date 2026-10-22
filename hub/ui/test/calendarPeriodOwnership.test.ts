import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import type {PeriodReply,PeriodRequest} from '../../server/domain/periodRead';
import {PeriodTransport,fetchPeriod,type PeriodIntent,type PeriodReservation} from '../lib/periodTransport';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';

const until=async(check:()=>unknown)=>{for(let i=0;i<300;i++){await new Promise<void>(setImmediate);if(check())return;}assert.fail('period transport did not settle');};
const jsonBytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));

async function prepared(t:TestContext){
  t.mock.method(Date,'now',()=>NOW);
  const resolved=Intl.DateTimeFormat.prototype.resolvedOptions;
  t.mock.method(Intl.DateTimeFormat.prototype,'resolvedOptions',function(this:Intl.DateTimeFormat){return {...resolved.call(this),timeZone:'UTC'};});
  const h=await fixture({personal:true,heatmap:true});
  // Keep the fixture's initial complete view, then exercise a separate actual
  // transport so a reentrant edit cannot quietly start an unrelated second read.
  h.period.transport.reset();t.mock.method(h.period.transport,'change',()=>{});
  for(let i=0;i<12;i++)h.store.creditWork(h.device,NOW-(50-i)*M,NOW-(49-i)*M,[{
    source:h.source,client:'codex',origin:'terminal',startedAt:NOW-H,
    project:`Project ${i} with a complete historical name`,folder:`Folder ${i}`,
    identity:{kind:'stable',sessionId:(i+1).toString(16).padStart(32,'0')},
  }]);
  h.events.history(h.source,NOW-H,undefined,true);
  // Deliver setup work before capturing the independently current wire intent.
  h.events.flush();await flush();
  const quota=h.initialRequests.find(request=>request.quota)!.quota;
  const request:PeriodRequest=JSON.parse(JSON.stringify({version:1,selection:h.period.selection,evaluatedAt:NOW,
    quota:{...quota,meta:''},sessions:{},values:[h.source],facets:true,sourceWork:{},calendar:{zone:'UTC'}}));
  return {h,request};
}

function reading(h:Awaited<ReturnType<typeof fixture>>){
  return {work:h.period.get().value,quota:h.period.tapes.get('quota'),value:h.period.getValue(h.source),
    facets:h.period.getFacets(),sourceWork:h.period.sourceTape};
}
function unchanged(h:Awaited<ReturnType<typeof fixture>>,before:ReturnType<typeof reading>){
  for(const [key,value] of Object.entries(reading(h)))assert.equal(value,before[key as keyof typeof before],`${key} still belongs to the previous complete view`);
}
function siblingBytes(reply:PeriodReply){
  const parts=[reply.quota,reply.sessions,reply.values,reply.facets,reply.sourceWork];
  assert.ok(parts.every(part=>part?.state==='complete'),'the real producer must supply all five decoded siblings');
  // A deliberately modest independent floor, rather than the production heap
  // estimator: every still-unadopted semantic payload must remain represented.
  return parts.reduce((bytes,part)=>bytes+jsonBytes(part!.state==='complete'?part!.value:null),0);
}

function transport(t:TestContext,h:Awaited<ReturnType<typeof fixture>>,request:PeriodRequest,options:{
  before?:(reply:PeriodReply,intent:PeriodIntent)=>void;
  queued?:(reply:PeriodReply,intent:PeriodIntent)=>void;
  after?:(reply:PeriodReply)=>void;
}={}){
  const captured:PeriodIntent={...h.period.intent(),request};
  let requests=0,received=0,reply:PeriodReply|undefined,stopped=false;
  const errors:unknown[]=[];
  const current=()=>!stopped&&h.period.generation===captured.generation&&h.period.revision===captured.revision?captured:null;
  t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{
    requests++;
    assert.equal(init?.method,'POST');
    const body=JSON.parse(String(init.body));
    return new Response(h.reader.read(h.board,h.alice.id,body),{headers:{'content-type':'application/json'}});
  });
  const owner=new PeriodTransport(h.pool,current,async(part,intent,reserve?:PeriodReservation)=>{
    reply=part;
    try{
      options.before?.(part,intent);
      const adopted=h.period.receive(part,intent,reserve);
      options.queued?.(part,intent);
      await adopted;options.after?.(part);
    }catch(error){errors.push(error);}
    finally{received++;}
  },fetchPeriod);
  return {owner,start:()=>owner.change(),stop:()=>{stopped=true;owner.reset();},reply:()=>reply!,requests:()=>requests,
    settled:async()=>{await until(()=>received>0&&h.pool.activeFlights===0);assert.equal(errors.length,0,errors.map(String).join('\n'));assert.equal(requests,1);assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes,'the completed transport releases every shared reservation');}};
}

test('actual mixed calendar publication keeps every unadopted sibling charged under shared pool pressure',async t=>{
  const {h,request}=await prepared(t),before=reading(h);
  let input:PeriodReply|undefined,published=0;
  const wire=transport(t,h,request,{before:reply=>{input=reply;}});
  const stop=h.period.calendar.subscribe(()=>{
    if(!input||h.period.calendar.get().error)return;
    published++;unchanged(h,before);
    const floor=siblingBytes(input),reserved=h.pool.estimatedBytes-h.period.estimatedBytes;
    assert.equal(h.period.calendar.get().value!.cells,input.calendar!.state==='complete'?input.calendar!.value.cells:null);
    // Remove evictable caches first: this competition is between live owners,
    // rather than depending on how much reusable history happens to be cached.
    for(const candidate of h.period.evictionCandidates())candidate.drop();
    const padding=h.pool.budget-h.period.estimatedBytes-floor;
    assert.ok(padding>0);
    const pressure={estimatedBytes:padding,evictionCandidates:()=>[]},probe={role:'visible' as const};
    h.pool.register(pressure);
    try{assert.equal(h.pool.reserve(probe,Math.max(1,Math.floor(floor/4))),false,`a second reader cannot spend the decoded siblings' reservation (${reserved} charged, ${floor} semantic payload bytes)`);}
    finally{h.pool.release(probe);h.pool.unregister(pressure);}
    assert.ok(reserved>=floor,`only ${reserved} bytes remain charged for ${floor} bytes of unadopted siblings`);
  });
  try{
    wire.start();await wire.settled();assert.equal(published,1);
    assert.equal(h.period.get().rows.length,13);assert.equal(h.period.get().rows.reduce((sum:number,row:any)=>sum+row.workedMs,0),13*M);
    assert.equal(h.period.getFacets().value.projects.length,13);
    assert.equal(h.period.getValue(h.source).value.windows[0].remaining,83);
    assert.ok(h.period.tapes.get('quota').tape.quota.length>0);
    assert.ok(h.period.sourceTape.sources.length>0);
    assert.ok(wire.owner.evidence().size>0,'the actual successful transport retains adopted evidence cursors');
  }finally{stop();wire.stop();await h.close();}
});

test('a calendar-only actual wire response is adopted and releases its entire flight',async t=>{
  const {h,request:mixed}=await prepared(t),before=reading(h);
  const request:PeriodRequest={version:1,selection:mixed.selection,evaluatedAt:NOW,calendar:{zone:'UTC'}};
  const old=h.period.calendar.get().value;
  const wire=transport(t,h,request);
  try{
    wire.start();await wire.settled();unchanged(h,before);
    const current=h.period.calendar.get();assert.equal(current.error,null);assert.equal(h.period.calendar.needed,false);
    assert.notEqual(current.value,old);
    assert.equal(current.value!.cells.reduce((sum:number,cell:any)=>sum+(cell.agentMs??0),0),13*M);
    assert.equal(wire.owner.evidence().size,0,'a calendar-only reply invents no resource cursor');
  }finally{wire.stop();await h.close();}
});

test('a resource-only edit admits the independently current calendar without reviving old global siblings',async t=>{
  const {h,request}=await prepared(t);
  let before:ReturnType<typeof reading>,input:PeriodReply|undefined,published=0;
  const generation=h.period.calendar.generation;
  const wire=transport(t,h,request,{before:reply=>{
    input=reply;
    const view=h.directory.view(h.board);
    h.directory.saveView(h.board,{...view,shown:[...view.shown,'budget-history']},h.alice.id,NOW+1);
    h.events.flush();before=reading(h);
    assert.equal(h.period.calendar.generation,generation,'the actual layout edit preserves calendar authority');
  }});
  const stop=h.period.calendar.subscribe(()=>{
    if(!input||h.period.calendar.get().error)return;
    published++;unchanged(h,before);
    assert.ok(h.pool.estimatedBytes-h.period.estimatedBytes>=siblingBytes(input),'the rejected global siblings remain owned until their flight finishes');
  });
  try{
    wire.start();await wire.settled();assert.equal(published,1);unchanged(h,before!);
    assert.equal(h.period.calendar.get().value!.cells.reduce((sum:number,cell:any)=>sum+(cell.agentMs??0),0),13*M);
    assert.equal(wire.owner.evidence().size,0,'a stale global reply cannot reinstate resource cursors');
  }finally{stop();wire.stop();await h.close();}
});

test('an authority change while actual adoption is queued rejects stale calendar and resource payloads',async t=>{
  const {h,request}=await prepared(t);
  let after:ReturnType<typeof reading>,calendar:unknown;
  const wire=transport(t,h,request,{queued:()=>{
    h.selectRange({from:NOW-2*H,to:NOW-H});after=reading(h);calendar=h.period.calendar.get();
  }});
  try{
    wire.start();await wire.settled();unchanged(h,after!);
    assert.equal(h.period.calendar.get(),calendar);
    assert.equal(h.period.calendar.get().value,null,'the old calendar cannot repopulate the new analytical interval');
    assert.equal(h.period.selection.from,NOW-2*H);assert.equal(wire.owner.evidence().size,0);
  }finally{wire.stop();await h.close();}
});

for(const cancel of [false,true])test(`a reentrant calendar subscriber ${cancel?'cancels':'retires'} the old response without freeing or restoring it before transport completion`,async t=>{
  const {h,request}=await prepared(t);
  let input:PeriodReply|undefined,after:ReturnType<typeof reading>,retired:unknown,published=0;
  const wire=transport(t,h,request,{before:reply=>{input=reply;},after:()=>{
    unchanged(h,after!);assert.equal(h.period.calendar.get().value,null);
    assert.equal(h.pool.activeFlights,1,'the preparing flight keeps its actual slot until adoption returns');
    assert.ok(h.pool.estimatedBytes-h.period.estimatedBytes>=siblingBytes(input!),'the obsolete or cancelled response still owns its decoded siblings');
    assert.ok(h.period.calendar.bytes>=jsonBytes(retired),'the transport still pins the retired calendar it has handed off');
  }});
  const stop=h.period.calendar.subscribe(()=>{
    if(!input||published||h.period.calendar.get().error)return;
    published++;retired=h.period.calendar.get().value;
    h.selectRange({from:NOW-2*H,to:NOW-H});after=reading(h);
    if(cancel)wire.stop();
    assert.equal(h.pool.activeFlights,1,'aborting a preparing transport cannot release its slot early');
    assert.ok(h.pool.estimatedBytes-h.period.estimatedBytes>=siblingBytes(input));
    assert.ok(h.period.calendar.bytes>=jsonBytes(retired),'a nested authority change cannot free the outer publisher\'s cells');
  });
  try{
    wire.start();await wire.settled();assert.equal(published,1);unchanged(h,after!);
    assert.equal(h.period.calendar.get().value,null);assert.equal(wire.owner.evidence().size,0);
    assert.ok(h.period.calendar.bytes<jsonBytes(retired),'the final flight release drops its last retired numerical owner');
  }finally{stop();wire.stop();await h.close();}
});

test('a refused calendar handoff retains the actual unadopted payload conservatively until flight release',async t=>{
  const {h,request}=await prepared(t),old=h.period.calendar.get().value;
  let inside=0,lastAccepted=0,refused=0,checked=false;
  const reserve=h.pool.reserve,receive=h.period.calendar.receive;
  t.mock.method(h.pool,'reserve',function(this:typeof h.pool,flight:Parameters<typeof reserve>[0],bytes:number){
    if(inside&&bytes<lastAccepted){refused++;return false;}
    const accepted=reserve.call(this,flight,bytes);if(accepted)lastAccepted=bytes;return accepted;
  });
  t.mock.method(h.period.calendar,'receive',function(this:typeof h.period.calendar,...args:Parameters<typeof receive>){inside++;try{return receive.apply(this,args);}finally{inside--;}});
  const wire=transport(t,h,request,{after:reply=>{
    checked=true;assert.ok(refused>0,'the actual calendar must attempt a reservation handoff');
    assert.equal(h.period.calendar.get().value,old);assert.equal(h.period.calendar.get().error,'history_limit');
    assert.ok(h.pool.estimatedBytes-h.period.estimatedBytes>=jsonBytes(reply.calendar),'the still-unadopted decoded calendar remains charged after its siblings commit');
  }});
  try{
    wire.start();await wire.settled();assert.ok(checked);assert.equal(h.period.get().rows.length,13);
    assert.equal(h.period.getFacets().value.projects.length,13);assert.equal(h.period.getValue(h.source).value.windows[0].remaining,83);
  }finally{wire.stop();await h.close();}
});
