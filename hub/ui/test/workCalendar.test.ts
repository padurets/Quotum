import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarWindow,calendarLevel,exactAgentHours,WorkCalendar} from '../lib/workCalendar.js';
import {heatmapLayout,heatCellAt,heatCellChangesAt} from '../lib/heatmap.js';
import {calendarCells,calendarPartition,parseCalendar,type CalendarCell} from '../../server/domain/workCalendar.js';
import {drain} from '../../server/domain/prepare.js';
import type {Stretch} from '../../server/domain/work.js';
import {EMPTY_VIEW,encodeView,decodeView} from '../../server/domain/view.js';
import {AGENT_HOURS_HEATMAP,showWidgets,widgetVisible} from '../../server/domain/widgets.js';
import {fixture,flush,NOW,M} from './periodRuntimeFixture.js';
const H=3_600_000,DAY=24*H;
const row=(from:number,to:number):Stretch=>({session:1,source:null,device:'d',user:'u',origin:'terminal',project:null,folder:null,startedAt:from,from,to});
function reading(from:number,to:number,zone='UTC'){
  const window=calendarWindow(to,zone,{mode:'range',from,to}),cells=drain(calendarCells([row(from,to)],window.edges,window.edges.slice(1).map((_,i)=>i),to,from,from,90*DAY,{from,to})).map(([,c])=>c);
  return {window,value:{zone,edges:window.edges,cells,availableFrom:from,retainedFrom:from,cursor:'cursor'},basis:null,loading:false,error:null};
}
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
  assert.ok(calendarPartition({from:NOW-31*DAY,to:NOW}).length<=3073);assert.ok(parseCalendar({zone:'UTC'}));assert.equal(parseCalendar({zone:'UTC',edges:[0,1]}),null);
  assert.deepEqual([0,1,H/2,H,2*H,4*H].map(n=>calendarLevel(n,H)),[0,1,2,3,4,5]);assert.equal(calendarLevel(4*H,4*H),calendarLevel(H,H));assert.equal(exactAgentHours(1,'en'),'0.000000278');
});
test('compact calendar fits all selected dates without separate date rows',()=>{
  const r=reading(NOW-30*DAY,NOW);for(const width of [248,318,538,1138]){const l=heatmapLayout(r,width,'calendar','en');assert.ok(l.height<=204);assert.equal(l.cells.reduce((n,c)=>n+(c.cell.agentMs??0),0),30*DAY);assert.ok(l.cells.every(c=>c.x>=0&&c.x+c.width<=width));}
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
test('a selection replacement retires the old generation and hiding removes demand',()=>{
  const calendar=new WorkCalendar();calendar.configure(true,'a',NOW,false,{mode:'live',periodMs:H});const generation=calendar.generation;calendar.configure(true,'a',NOW,false,{mode:'range',from:NOW-3*H,to:NOW-2*H});assert.ok(calendar.generation>generation);assert.equal(calendar.state.value,null);assert.deepEqual(calendar.demand(),{zone:calendar.state.window.zone});calendar.configure(false,'a',NOW);assert.equal(calendar.demand(),undefined);
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
