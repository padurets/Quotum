import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarWindow,calendarLevel,exactAgentHours,WorkCalendar} from '../lib/workCalendar.js';
import {heatmapLayout,heatCellAt,heatCellChangesAt} from '../lib/heatmap.js';
import {calendarCells,calendarPartition,parseCalendar,type CalendarCell} from '../../server/domain/workCalendar.js';
import {drain} from '../../server/domain/prepare.js';
import type {Stretch} from '../../server/domain/work.js';
import {EMPTY_VIEW,encodeView,decodeView} from '../../server/domain/view.js';
import {AGENT_HOURS_HEATMAP,showWidgets,widgetVisible} from '../../server/domain/widgets.js';
import {expandPeriod} from '../../server/domain/periodWire.js';
import {fixture,flush,NOW,M} from './periodRuntimeFixture.js';
const H=3_600_000,DAY=24*H;
const row=(from:number,to:number):Stretch=>({session:1,source:null,device:'d',user:'u',origin:'terminal',project:null,folder:null,startedAt:from,from,to});
test('calendar presentation identity separates live periods without changing on ordinary clock movement',()=>{
  const calendar=new WorkCalendar(),now=Date.UTC(2035,1,10,12);
  calendar.configure(true,'authority',now,false,{mode:'live',periodMs:DAY});const day=calendar.presentationKey();
  calendar.tick(now+60_000);assert.equal(calendar.presentationKey(),day);
  calendar.configure(true,'authority',now,false,{mode:'live',periodMs:30*DAY});const month=calendar.presentationKey();
  assert.notEqual(month,day,'cached evidence for another live duration cannot retain the previous grid');
  calendar.configure(true,'authority',now,false,{mode:'range',from:now-DAY,to:now});const fixed=calendar.presentationKey();
  assert.notEqual(fixed,day);assert.notEqual(fixed,month);
  calendar.configure(true,'replacement',now,false,{mode:'range',from:now-DAY,to:now});assert.notEqual(calendar.presentationKey(),fixed);
});
function reading(from:number,to:number,zone='UTC'){
  const window=calendarWindow(to,zone,{mode:'range',from,to}),cells=drain(calendarCells([row(from,to)],window.edges,window.edges.slice(1).map((_,i)=>i),to,from,from,90*DAY,{from,to})).map(([,c])=>c);
  return {window,value:{zone,edges:window.edges,cells,availableFrom:from,retainedFrom:from,cursor:'cursor'},basis:null,loading:false,error:null};
}
test('replacement calendar arrays reuse civil instants without caching work or mixing time zones',t=>{
  const from=Date.UTC(2032,8,20,5),r=reading(from,from+DAY),other=reading(from,from+DAY,'Pacific/Honolulu'),distant=reading(from+3*DAY,from+4*DAY);
  let calls=0;const original=Intl.DateTimeFormat.prototype.formatToParts;
  t.mock.method(Intl.DateTimeFormat.prototype,'formatToParts',function(this:Intl.DateTimeFormat,...args:Parameters<typeof original>){calls++;return original.apply(this,args);});
  const draw=(value:typeof r)=>heatmapLayout(value,1138,'matrix','en');
  const clone=(value:typeof r)=>({...value,window:{...value.window,edges:[...value.window.edges]}});
  const first=draw(r);assert.ok(calls>1000);calls=0;
  const index=r.value.cells.findIndex(cell=>cell.agentMs!==null),updated={...clone(r),value:{...r.value,cells:r.value.cells.map((cell,i)=>i===index?{...cell,agentMs:cell.agentMs!+M}:cell)}};
  const next=draw(updated);
  assert.equal(calls,0,'a replacement with the same partition formats no old instant again');
  assert.equal(next.cells.reduce((sum,c)=>sum+(c.cell.agentMs??0),0),DAY+M,'only civil coordinates are cached; new work remains exact');
  const geometry=(layout:ReturnType<typeof draw>)=>layout.cells.map(({key,from,to,x,y,width,height})=>({key,from,to,x,y,width,height}));
  assert.deepEqual(geometry(next),geometry(first));
  const local=draw(other);assert.ok(calls>1000,'a different zone has its own civil coordinates');
  assert.notEqual(local.cells[0].date,first.cells[0].date);calls=0;draw(clone(r));assert.equal(calls,0);
  draw(distant);calls=0;draw(clone(r));assert.ok(calls>0,'navigation cannot retain an unbounded set of formatted instants');
});
test('civil dates and registered sums survive 23/25-hour and half-hour DST days',()=>{
  for(const [from,to,zone,hours] of [
    ['2026-03-08T05:00Z','2026-03-09T04:00Z','America/New_York',23],
    ['2026-11-01T04:00Z','2026-11-02T05:00Z','America/New_York',25],
    ['2026-10-19T18:15Z','2026-10-20T18:15Z','Asia/Kathmandu',24],
    ['2026-10-03T13:30Z','2026-10-04T13:00Z','Australia/Lord_Howe',23.5],
  ] as const){const r=reading(Date.parse(from),Date.parse(to),zone);assert.equal(r.window.dates.length,1);assert.equal(r.window.dayEdges[1]-r.window.dayEdges[0],hours*H);assert.equal(r.value.cells.reduce((n,c)=>n+(c.agentMs??0),0),hours*H);}
});
test('hourly matrix retains repeated hours and omits nonexistent hours',()=>{
  for(const [from,to,day,count] of [['2026-10-25T04:00Z','2026-11-08T05:00Z','2026-11-01',25],['2026-03-01T05:00Z','2026-03-15T04:00Z','2026-03-08',23]] as const){
    const r=reading(Date.parse(from),Date.parse(to),'America/New_York'),layout=heatmapLayout(r,1138,'matrix','en'),cells=layout.cells.filter(c=>c.date===day);
    assert.equal(cells.length,count);assert.equal(cells.reduce((n,c)=>n+c.cell.agentMs!,0),count*H);assert.equal(cells.filter(c=>c.repeated).length,count===25?2:0);
    assert.equal(layout.cells.reduce((n,c)=>n+(c.cell.agentMs??0),0),r.window.range.to-r.window.range.from);
  }
});
test('partial-minute selection and concurrent work precede responsive grouping',()=>{
  const from=Date.UTC(2026,9,20,12)+123,to=from+61*M+456,edges=calendarPartition({from,to}),window=calendarWindow(to,'Asia/Kathmandu',{mode:'range',from,to});
  const cells=drain(calendarCells([row(from,to),row(from+M,to-M)],edges,edges.slice(1).map((_,i)=>i),to,from,from,90*DAY,{from,to})).map(([,c])=>c);
  const r={window,value:{zone:window.zone,edges,cells,availableFrom:from,retainedFrom:from,cursor:''},basis:null,loading:false,error:null};
  for(const width of [248,538,1138])for(const view of ['matrix','calendar'] as const){const layout=heatmapLayout(r,width,view,'en');assert.equal(layout.cells.reduce((n,c)=>n+(c.cell.agentMs??0),0),2*(to-from)-2*M);assert.ok(layout.cells.every(c=>c.from>=from&&c.to<=to));assert.ok(layout.cells.every(c=>!c.repeated));}
});
test('server-derived partition is bounded and colour thresholds name their resolution',()=>{
  assert.ok(calendarPartition({from:NOW-31*DAY,to:NOW}).length<=3073);assert.deepEqual(parseCalendar({zone:'UTC'}),{zone:'UTC'});assert.deepEqual(parseCalendar({zone:'UTC',relative:true}),{zone:'UTC',relative:true});assert.equal(parseCalendar({zone:'UTC',edges:[0,1]}),null);
  for(const relative of [false,0,1,'true',null])assert.equal(parseCalendar({zone:'UTC',relative}),null);
  assert.deepEqual([0,1,H/2,H,2*H,4*H].map(n=>calendarLevel(n,H)),[0,1,2,3,4,5]);assert.equal(calendarLevel(4*H,4*H),calendarLevel(H,H));assert.equal(exactAgentHours(1,'en'),'0.000000278');
});
test('exact hours reuse their locale formatter across values and locale changes',t=>{
  const created=new Map<string,number>();
  t.mock.method(Intl,'NumberFormat',new Proxy(Intl.NumberFormat,{construct(target,args){
    const locale=String(args[0]);created.set(locale,(created.get(locale)??0)+1);
    return Reflect.construct(target,args);
  }}));
  const values=[0,1,H,H+1,12_345*H+H/2];
  for(const locale of ['en-GB','ru-RU','en-GB','ru-RU']){
    const separator=locale==='ru-RU'?',':'.';
    assert.deepEqual(values.map(ms=>exactAgentHours(ms,locale)),
      ['0','0'+separator+'000000278','1','1'+separator+'000000278','12345'+separator+'5']);
  }
  for(const count of created.values())assert.ok(count<=1,'the same locale needs only one formatter');
});
test('compact calendar fits all selected dates without separate date rows',()=>{
  const r=reading(NOW-30*DAY,NOW);for(const width of [248,318,538,1138]){const l=heatmapLayout(r,width,'calendar','en');assert.equal(l.height,300);assert.equal(l.cells.reduce((n,c)=>n+(c.cell.agentMs??0),0),30*DAY);assert.ok(l.cells.every(c=>c.x>=0&&c.x+c.width<=width));}
});
test('optional heatmap keeps its string codec identity on source-free boards',()=>{
  assert.equal(widgetVisible(EMPTY_VIEW,AGENT_HOURS_HEATMAP,0),false);const v=showWidgets(EMPTY_VIEW,[AGENT_HOURS_HEATMAP]);assert.deepEqual(decodeView(encodeView(v)),v);
});
test('coordinator follows common-range navigation and shares credited-work requests',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true});t.after(()=>h.close());assert.ok(h.period.calendar.state.value);
  h.selectRange({from:NOW-2*H,to:NOW-H});await flush();assert.equal(h.requests.filter(r=>r.calendar).length,1);assert.deepEqual(h.period.calendar.state.basis?.range,{from:NOW-2*H,to:NOW-H});
  assert.equal(h.period.calendar.state.value.cells.reduce((n:number,c:CalendarCell)=>n+(c.agentMs??0),0),0);
  h.selectRange(null);await flush();h.requests.length=0;h.credit(NOW-M,NOW);h.events.flush();await flush();assert.equal(h.requests.filter(r=>r.calendar).length,1);assert.ok(h.period.calendar.state.value.cells.some((c:CalendarCell)=>(c.agentMs??0)>0));
});
test('authority clearing rejects an older in-flight heatmap',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true});t.after(()=>h.close());const held=h.hold();h.credit(NOW-M,NOW);h.events.flush();await flush();h.remove();assert.equal(h.period.calendar.state.value,null);held.release();await flush();assert.ok(!h.period.calendar.state.value||h.period.calendar.state.value.cells.every((c:CalendarCell)=>!c.agentMs));
});
test('financial news and shared-clock advancement never poll heatmap history',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true,clocked:true});t.after(()=>h.close());h.event({type:'history',data:{sources:[h.source],since:NOW-M,changes:[{source:h.source,scope:'budget',since:NOW-M}]}});await flush();assert.equal(h.requests.filter(r=>r.calendar).length,0);h.jump(NOW+2*M);await flush();assert.equal(h.requests.filter(r=>r.calendar).length,0);
});

test('a backwards hub clock replaces invalid calendar evidence once without polling',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true,clocked:true});t.after(()=>h.close());
  assert.ok(h.period.calendar.state.value);
  h.clock.heard(NOW-M,NOW);await flush();
  assert.ok(h.period.calendar.state.value);assert.equal(h.period.calendar.state.error,null);assert.equal(h.period.calendar.needed,false);
  assert.equal(h.period.calendar.state.basis.evaluatedAt,NOW-M);
  assert.equal(h.requests.filter(r=>r.calendar).length,1);
  h.period.wakeCalendar();await flush();assert.equal(h.requests.filter(r=>r.calendar).length,1);
});

test('a delayed calendar reply crossing midnight cannot complete the replacement generation',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({heatmap:true,clocked:true});t.after(()=>h.close());
  const midnight=h.period.calendar.nextAt(now);now=midnight-1000;h.jump(now);await flush();h.requests.length=0;
  const held=h.hold();h.credit(now-M,now);h.events.flush();await flush();assert.equal(h.requests.filter(r=>r.calendar).length,1);
  now=midnight+1000;h.jump(now);await flush();held.release();await flush();
  assert.ok(h.period.calendar.state.basis,'the retired flight must not strand the pending replacement');
  assert.equal(h.period.calendar.state.basis.evaluatedAt,now);assert.equal(h.period.calendar.needed,false);assert.equal(h.period.calendar.state.error,null);
  assert.equal(h.requests.filter(r=>r.calendar).length,2);
  h.period.wakeCalendar();await flush();assert.equal(h.requests.filter(r=>r.calendar).length,2);
});
test('a selection replacement retires the old generation and hiding removes demand',()=>{
  const calendar=new WorkCalendar();calendar.configure(true,'a',NOW,false,{mode:'live',periodMs:H});const generation=calendar.generation;calendar.configure(true,'a',NOW,false,{mode:'range',from:NOW-3*H,to:NOW-2*H});assert.ok(calendar.generation>generation);assert.equal(calendar.state.value,null);assert.deepEqual(calendar.demand(),{zone:calendar.state.window.zone,relative:true});calendar.configure(false,'a',NOW);assert.equal(calendar.demand(),undefined);
});


test('heatmap clock expiry does not reset already opened common filter choices',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true,clocked:true});t.after(()=>h.close());const stop=h.period.demandFacets();t.after(stop);await flush();const before=h.period.getFacets();assert.ok(before.value);assert.equal(h.requests.filter(r=>r.calendar).length,0,'opening common choices is not another heatmap demand');h.requests.length=0;h.jump(NOW+2*M);await flush();assert.equal(h.period.getFacets().value,before.value);assert.equal(h.period.getFacets().loading,false);assert.equal(h.requests.length,0);
});

test('moving live boundaries expire only the affected bucket without rebuilding the evidence frame',()=>{
  const c=new WorkCalendar();c.configure(true,'a',NOW,false,{mode:'live',periodMs:H});const window=c.state.window,range=window.range;
  const cells=drain(calendarCells([row(range.from,range.to)],window.edges,window.edges.slice(1).map((_,i)=>i),NOW,range.from,range.from,90*DAY,range,H)).map(([,cell])=>cell);
  c.receive({state:'complete',basis:{run:'r',revision:'1',evaluatedAt:NOW,evidenceCut:NOW,range,calendarKey:'k',filterKey:'f',workAuthority:'a'},value:{zone:window.zone,edges:window.edges,cells,availableFrom:range.from,retainedFrom:range.from,cursor:'c'}},c.generation,()=>true);
  const before=c.get(),layout=heatmapLayout(before,1138,'matrix','en'),first=layout.cells[0],next=layout.cells[1];let notifications=0;const stop=c.subscribe(()=>notifications++);
  assert.equal(heatCellChangesAt(first,NOW),NOW+1);assert.equal(heatCellAt(first,NOW).cell.agentMs,first.cell.agentMs);
  assert.equal(c.tick(NOW+1),false);assert.equal(c.get(),before);assert.equal(notifications,0);stop();
  const after=heatCellAt(first,NOW+1);assert.equal(after.cell.agentMs,first.cell.agentMs!-first.parts[0].agentMs!);assert.equal(after.partial,true);assert.deepEqual(heatCellAt(next,NOW+1).cell,next.cell);
  const last=first.parts.at(-1)!.validUntil!;assert.equal(heatCellAt(first,last).cell.agentMs,null);assert.equal(heatCellChangesAt(first,last),null);assert.equal(c.demand(),undefined);assert.ok(c.nextAt(NOW)>NOW+2*M);
});

test('coarse buckets retire exact fine contributions independently, preserving zero and partial bounds',()=>{
  const r=reading(NOW-H,NOW),layout=heatmapLayout(r,248,'matrix','en'),item=layout.cells.find(c=>c.parts.length>1)!;
  item.parts=item.parts.map((c,i)=>({...c,agentMs:i===0?2*(c.to-c.from):0,validUntil:i===0?NOW+1:null}));
  const before=heatCellAt(item,NOW),after=heatCellAt(item,NOW+1);
  assert.equal(before.cell.agentMs,2*(item.parts[0].to-item.parts[0].from));assert.equal(after.cell.agentMs,0);assert.equal(after.partial,true);assert.equal(after.cell.from,item.parts[1].from);assert.equal(heatCellChangesAt(item,NOW+1),null);
  assert.equal(after.x,item.x);assert.equal(after.width,item.width);assert.equal(after.from,item.from);assert.equal(after.to,item.to);
});


test('a repeated half-hour keeps its own hourly lane and actual clock label',()=>{
  const r=reading(Date.parse('2026-03-29T13:00Z'),Date.parse('2026-04-12T13:30Z'),'Australia/Lord_Howe'),l=heatmapLayout(r,1138,'matrix','en'),day=l.cells.filter(c=>c.date==='2026-04-05');assert.equal(day.reduce((n,c)=>n+c.cell.agentMs!,0),24.5*H);assert.equal(day.filter(c=>c.repeated).length,2);assert.ok(l.labels.some(label=>label.text==='01:30'));
});

test('an idle heatmap does not rebuild its evidence frame at every minute',()=>{
  const at=Date.UTC(2026,9,20,12,10),c=new WorkCalendar();c.configure(true,'a',at,false,{mode:'live',periodMs:H});const window=c.state.window,range=window.range;
  const cells=drain(calendarCells([],window.edges,window.edges.slice(1).map((_,i)=>i),at,range.from,range.from,90*DAY,range,H)).map(([,cell])=>cell);
  c.receive({state:'complete',basis:{run:'r',revision:'1',evaluatedAt:at,evidenceCut:at,range,calendarKey:'k',filterKey:'f',workAuthority:'a'},value:{zone:window.zone,edges:window.edges,cells,availableFrom:range.from,retainedFrom:range.from,cursor:'c'}},c.generation,()=>true);
  const before=c.get();assert.equal(c.tick(at+2*M),false);assert.equal(c.get(),before);assert.ok(c.nextAt(at)>at+2*M);assert.equal(c.demand(),undefined);
});

test('cached return and sub-minute repeat reuse anonymous integrals with exact common-range cells',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({heatmap:true,creditFrom:NOW-2*H+1234,creditTo:NOW-17*M+5678});t.after(()=>h.close());
  const cold={from:NOW-2*H,to:NOW-H};h.selectRange(cold);await flush();assert.equal(h.requests.filter(r=>r.calendar).length,1);
  now+=2517;h.jump(now);h.requests.length=0;h.selectRange(null);await flush();assert.equal(h.requests.filter(r=>r.calendar).length,0,'return to the cached live range needs no HTTP');
  const repeat={from:cold.from+2517,to:cold.to+2517};h.selectRange(repeat);await flush();assert.equal(h.requests.filter(r=>r.calendar).length,0,'new endpoints use exact integrals, not rounded bins');
  const fresh=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'range',...repeat},evaluatedAt:now,calendar:{zone:h.period.calendar.state.window.zone}})));
  if(fresh.calendar?.state!=='complete')throw new Error('oracle');assert.deepEqual(h.period.calendar.state.value.cells,fresh.calendar.value.cells);
  assert.deepEqual(h.period.calendar.state.basis.range,repeat);assert.equal(h.period.calendar.state.value.cursor,'');
  const candidates=h.period.calendar.evictionCandidates();assert.ok(candidates.length>=2);for(const entry of candidates)entry.drop();
  h.selectRange(cold);await flush();assert.equal(h.requests.filter(r=>r.calendar).length,1,'eviction falls back to the bounded shared read');
  h.credit(NOW-17*M,NOW);h.events.flush();await flush();h.requests.length=0;h.selectRange(null);await flush();
  assert.equal(h.requests.filter(r=>r.calendar).length,1,'work news invalidates the cached integral before returning to live');
});

test('a monthly heatmap replacement preserves other loaded history inside the shared budget',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true,periodName:'30d'});
  const nativeBytes=h.pool.estimatedBytes-h.period.calendar.bytes;
  let retained=h.pool.budget-nativeBytes-1600*1024,dropped=0;
  h.pool.register({get estimatedBytes(){return retained;},evictionCandidates:()=>retained?[{bytes:retained,shownAt:0,drop(){retained=0;dropped++;}}]:[]});
  try{
    assert.ok(retained>0);h.selectRange({from:NOW-60*DAY,to:NOW-30*DAY});await flush();
    assert.ok(h.period.calendar.state.value);assert.equal(h.period.calendar.state.error,null);h.selectRange(null);await flush();
    assert.equal(dropped,0,'replacing and restoring the month preserves another family’s loaded history');
    assert.ok(h.pool.estimatedBytes<=h.pool.budget);
  }finally{retained=0;await h.close();}
});

test('a fresh live calendar revision preserves an unaffected historical prefix for the shifted repeat',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({heatmap:true,periodName:'30d',creditFrom:NOW-25*DAY+1234,creditTo:NOW-24*DAY+5678});t.after(()=>h.close());
  const cold={from:NOW-45*DAY,to:NOW-15*DAY};h.selectRange(cold);await flush();
  assert.equal(h.requests.filter(r=>r.calendar).length,1);h.requests.length=0;
  h.credit(NOW-M,NOW);h.events.flush();await flush();
  assert.equal(h.requests.filter(r=>r.calendar).length,0,'recent work cannot invalidate a selected month ending fifteen days ago');
  now+=2517;h.jump(now);h.selectRange(null);await flush();
  assert.equal(h.requests.filter(r=>r.calendar).length,1,'the affected live tail requires fresh evidence');h.requests.length=0;
  const repeat={from:cold.from+2517,to:cold.to+2517};h.selectRange(repeat);await flush();
  assert.equal(h.requests.filter(r=>r.calendar).length,0,'a newer live revision must not erase reusable historical integrals');
  const fresh=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'range',...repeat},evaluatedAt:now,calendar:{zone:h.period.calendar.state.window.zone}})));
  if(fresh.calendar?.state!=='complete')throw new Error('oracle');assert.deepEqual(h.period.calendar.state.value.cells,fresh.calendar.value.cells);
  const before=h.period.calendar.state.value.cells.reduce((sum:number,c:CalendarCell)=>sum+(c.agentMs??0),0);h.requests.length=0;
  h.store.creditWork(h.device,NOW-20*DAY,NOW-20*DAY+H,[{source:h.source,accountBy:'login',client:'codex',origin:'terminal',startedAt:NOW-21*DAY,project:'Late project',folder:'Late folder',identity:{kind:'stable',sessionId:'d'.repeat(32)}}]);h.events.flush();await flush();
  assert.equal(h.requests.filter(r=>r.calendar).length,1,'a genuinely relevant historical credit still refreshes the selected calendar');
  assert.equal(h.period.calendar.state.value.cells.reduce((sum:number,c:CalendarCell)=>sum+(c.agentMs??0),0),before+H);
});

test('historical calendar evidence cannot impersonate a live tail after the live proof is evicted',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true,periodName:'30d'});t.after(()=>h.close());
  const live=h.period.calendar.state.value.cells;assert.ok(live.some((c:CalendarCell)=>(c.agentMs??0)>0));
  h.selectRange({from:NOW-45*DAY,to:NOW-15*DAY});await flush();h.requests.length=0;
  const entries=h.period.calendar.evictionCandidates();assert.equal(entries.length,2);entries[0].drop();
  h.selectRange(null);await flush();
  assert.equal(h.requests.filter(r=>r.calendar).length,1,'the unobserved fifteen-day tail requires actual evidence');
  assert.deepEqual(h.period.calendar.state.value.cells,live,'the ready live calendar retains recent credited work');
});

test('overlapping calendar prefixes cover a range even when the newest original proof has a dirty tail',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true,periodName:'30d'});t.after(()=>h.close());
  h.selectRange({from:NOW-45*DAY,to:NOW-15*DAY});await flush();
  h.store.creditWork(h.device,NOW-20*DAY,NOW-20*DAY+H,[{source:h.source,accountBy:'login',client:'codex',origin:'terminal',startedAt:NOW-21*DAY,project:'Late project',folder:'Late folder',identity:{kind:'stable',sessionId:'d'.repeat(32)}}]);h.events.flush();await flush();
  h.selectRange({from:NOW-35*DAY,to:NOW-5*DAY});await flush();h.requests.length=0;
  const target={from:NOW-40*DAY,to:NOW-10*DAY};h.selectRange(target);await flush();
  assert.equal(h.requests.filter(r=>r.calendar).length,0,'the actual union covers the target without any single enclosing proof');
  const fresh=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'range',...target},evaluatedAt:NOW,calendar:{zone:h.period.calendar.state.window.zone}})));
  if(fresh.calendar?.state!=='complete')throw new Error('oracle');assert.deepEqual(h.period.calendar.state.value.cells,fresh.calendar.value.cells);
});

test('a fresh baseline adopts UTC or local date rollover before the civil clock wakes',t=>{
  let zone='UTC';const resolved=Intl.DateTimeFormat.prototype.resolvedOptions;
  t.mock.method(Intl.DateTimeFormat.prototype,'resolvedOptions',function(this:Intl.DateTimeFormat){return {...resolved.call(this),timeZone:zone};});
  for(const [nextZone,before] of [['UTC',Date.UTC(2026,9,20,23,59,59)],['America/New_York',Date.UTC(2026,9,20,3,59,59)]] as const){
    zone=nextZone;const after=before+2000,c=new WorkCalendar(),selection={mode:'live' as const,periodMs:DAY};c.configure(true,'a',before,false,selection);
    const part=(at:number,revision:string)=>{const window=calendarWindow(at,zone,selection),range=window.range;return {state:'complete' as const,basis:{run:'r',revision,evaluatedAt:at,evidenceCut:at,range,calendarKey:revision,workAuthority:'a',filterKey:'f'},value:{zone:window.zone,edges:window.edges,availableFrom:before-2*DAY,retainedFrom:0,cursor:revision,cells:drain(calendarCells([],window.edges,window.edges.slice(1).map((_,i)=>i),at,before-2*DAY,0,90*DAY,range,DAY)).map(([,cell])=>cell)}};};
    const initial=part(before,'1');c.receive(initial,c.generation,()=>true);c.dirty();const fresh=part(after,'2');c.receive(fresh,c.generation,()=>true);
    if(zone!=='UTC')assert.deepEqual(initial.value.edges,fresh.value.edges,'local midnight does not require a UTC partition change');
    assert.equal(c.needed,false);assert.deepEqual(c.state.window.edges,fresh.value.edges);assert.deepEqual(c.state.window.range,fresh.basis.range);assert.deepEqual(c.state.window.dates,calendarWindow(after,zone,selection).dates);assert.equal(c.state.value!.cursor,'2');
  }
});

test('a baseline with the same partition cannot replace the selected period with another range',()=>{
  const c=new WorkCalendar();c.configure(true,'a',NOW,false,{mode:'range',from:NOW-H,to:NOW});const window=c.state.window,range=window.range;
  const part={state:'complete' as const,basis:{run:'r',revision:'1',evaluatedAt:NOW,evidenceCut:NOW,range,calendarKey:'k',workAuthority:'a',filterKey:'f'},value:{zone:window.zone,edges:window.edges,availableFrom:range.from,retainedFrom:0,cursor:'c',cells:drain(calendarCells([],window.edges,window.edges.slice(1).map((_,i)=>i),NOW,range.from,0,90*DAY,range)).map(([,cell])=>cell)}};
  c.receive(part,c.generation,()=>true);const accepted=c.get();
  c.receive({...part,basis:{...part.basis,revision:'2',range:{from:range.from+M,to:range.to}}},c.generation,()=>true);assert.equal(c.get(),accepted);
});

test('31 exact days spanning 32 civil dates fit a stable height at every density without dropping evidence',()=>{
  for(const zone of ['UTC','Europe/Moscow','America/New_York','Australia/Lord_Howe']){
    const to=Date.parse('2026-11-08T17:50:06.430Z'),r=reading(to-31*DAY,to,zone);
    assert.equal(r.window.dates.length,32);
    for(const locale of ['en','ru'])for(const width of [248,318,538,1138])for(const height of [160,300,520])for(const view of ['matrix','calendar'] as const){
      const l=heatmapLayout(r,width,view,locale,height);
      assert.equal(l.height,height);assert.equal(l.naturalHeight,300);
      assert.deepEqual([...new Set(l.cells.map(c=>c.date))],r.window.dates,'both partial boundary dates survive responsive thinning');
      assert.equal(l.cells.reduce((n,c)=>n+(c.cell.agentMs??0),0),31*DAY);
      assert.ok(l.cells.every(c=>c.width>0&&c.height>0&&c.x>=0&&c.x+c.width<=width+.01&&c.y>=0&&c.y+c.height<=height));
      assert.ok(l.labels.every(label=>label.x>=0&&label.x<=width&&label.y>=0&&label.y<=height),'all label anchors stay in the assigned plot');
      assert.equal(l.cells.reduce((n,c)=>n+c.parts.reduce((sum,part)=>sum+(part.agentMs??0),0),0),31*DAY,'coarser geometry retains exact fine contributions');
    }
  }
});
