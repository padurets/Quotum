import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarWindow,calendarLevel,exactAgentHours,WorkCalendar,CALENDAR_RETENTION} from '../lib/workCalendar.js';
import {calendarCells,normalizeRanges,parseCalendar,type CalendarBasis,type CalendarCell} from '../../server/domain/workCalendar.js';
import {drain} from '../../server/domain/prepare.js';
import type {Stretch} from '../../server/domain/work.js';
import {EMPTY_VIEW,encodeView,decodeView} from '../../server/domain/view.js';
import {AGENT_HOURS_HEATMAP,showWidgets,widgetVisible} from '../../server/domain/widgets.js';
import {fixture,flush,NOW,M} from './periodRuntimeFixture.js';

const H=3_600_000,DAY=24*H;
const row=(from:number,to:number):Stretch=>({session:1,source:null,device:'d',user:'u',origin:'terminal',project:null,folder:null,startedAt:from,from,to});

test('calendar partitions real local dates across DST, quarter-hour offsets and skipped dates',()=>{
  for(const [at,zone,key,hours] of [
    ['2026-03-08T17:00Z','America/New_York','2026-03-08',23],
    ['2026-11-01T17:00Z','America/New_York','2026-11-01',25],
    ['2026-10-20T17:00Z','Asia/Kathmandu','2026-10-20',24],
    ['2011-12-31T12:00Z','Pacific/Apia','2011-12-30',0],
  ] as const){
    const window=calendarWindow(Date.parse(at),zone),i=window.dates.indexOf(key);assert.ok(i>=0);
    assert.equal(window.edges[i+1]-window.edges[i],hours*H);assert.ok(parseCalendar({zone:window.zone,edges:window.edges}));
    if(zone==='Asia/Kathmandu')assert.equal(new Date(window.edges[i]).toISOString(),'2026-10-19T18:15:00.000Z');
    const cells=drain(calendarCells([row(window.edges[i],window.edges[i+1])],window.edges,[i],window.edges[90],window.edges[0],window.edges[0],90*DAY));
    assert.equal(cells[0][1].agentMs,hours===0?null:hours*H);
  }
});

test('midnight work splits without unioning concurrent agents, and partial retention expires exactly',()=>{
  const window=calendarWindow(Date.UTC(2026,9,20,12),'UTC'),midnight=window.edges[89];
  const cells=drain(calendarCells([row(midnight-H/2,midnight+H/2),row(midnight-H/4,midnight+H/4)],window.edges,[88,89],midnight+H,window.edges[0],window.edges[0],90*DAY));
  assert.deepEqual(cells.map(([,c])=>c.agentMs),[.75*H,.75*H]);
  const partial=drain(calendarCells([row(midnight,midnight+H)],window.edges,[89],midnight+H,window.edges[0],midnight+10*60_000,90*DAY))[0][1];
  assert.equal(partial.agentMs,50*60_000);assert.equal(partial.validUntil,midnight+10*60_000+90*DAY+1);
  assert.deepEqual(normalizeRanges([{from:0,to:2},{from:1,to:3},{from:10,to:12}]),[{from:0,to:3},{from:10,to:12}]);
});

test('intensity uses stable hour thresholds and tiny positive details remain nonzero',()=>{
  assert.deepEqual([0,1,H-1,H,4*H,16*H,64*H,150*H].map(calendarLevel),[0,1,1,2,3,4,5,5]);
  assert.equal(exactAgentHours(1,'en'),'0.000000278');assert.equal(exactAgentHours(150*H,'en'),'150');
});

test('clock expiry and midnight retire values without a request and stale generations cannot restore them',()=>{
  const at=Date.now(),calendar=new WorkCalendar();calendar.configure(true,'board/authority/filter',at);
  const window=calendar.state.window,basis:CalendarBasis={run:'run',revision:'1',evaluatedAt:at,evidenceCut:at,range:{from:window.edges[0],to:window.edges[90]},calendarKey:'key',workAuthority:'a',filterKey:'f'};
  const cells=window.dates.map((_,i)=>({agentMs:i===89?H:0,from:window.edges[i],to:Math.min(at,window.edges[i+1]),validUntil:i===89?at+1000:null}));
  const part={state:'complete' as const,basis,value:{zone:window.zone,edges:window.edges,cells,availableFrom:window.edges[0],retainedFrom:window.edges[0],cursor:'cursor'}};
  calendar.receive(part,calendar.generation,()=>true);assert.equal(calendar.needed,false);
  calendar.tick(at+1000);assert.equal(calendar.state.value?.cells[89].agentMs,null);assert.equal(calendar.needed,false,'expiry alone does not demand another HTTP read');calendar.dirty();assert.equal(calendar.needed,true);
  const generation=calendar.generation;calendar.configure(true,'new filter',at+1000);calendar.receive(part,generation,()=>true);assert.equal(calendar.state.value,null);
  calendar.tick(window.edges[90]);assert.notDeepEqual(calendar.state.window.edges,window.edges);assert.equal(calendar.state.value,null);
  calendar.configure(false,'new filter',at);assert.equal(calendar.bytes,0);assert.equal(calendar.demand(),undefined);
});

test('the optional calendar uses the string codec tail and stays available on source-free boards',()=>{
  assert.equal(widgetVisible(EMPTY_VIEW,AGENT_HOURS_HEATMAP,0),false);
  const view=showWidgets({...EMPTY_VIEW,layout:{columns:6,places:{[AGENT_HOURS_HEATMAP]:{x:0,y:0,w:6,h:9}}}},[AGENT_HOURS_HEATMAP]);
  assert.equal(widgetVisible(view,AGENT_HOURS_HEATMAP,0),true);
  const encoded=encodeView(view);assert.ok(JSON.stringify(encoded).includes(AGENT_HOURS_HEATMAP));
  assert.deepEqual(decodeView(encoded),view);
});

test('the real coordinator coalesces calendar work and retains its frontier across analytical navigation',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true});t.after(()=>h.close());
  assert.ok(h.period.calendar.state.value);assert.equal(h.initialRequests.filter(r=>r.calendar).length,1);
  const value=h.period.calendar.state.value,cursor=value.cursor;
  h.selectRange({from:NOW-2*H,to:NOW-H});await flush();
  assert.equal(h.requests.filter(r=>r.calendar).length,0,'common range navigation does not reread the calendar');
  assert.equal(h.period.calendar.state.value,value);
  h.requests.length=0;h.credit(NOW-M,NOW);h.events.flush();await flush();
  assert.equal(h.requests.filter(r=>r.calendar).length,1,JSON.stringify({frames:h.frames,requests:h.requests,needed:h.period.calendar.needed}));
  assert.equal(h.requests.find(r=>r.calendar)!.calendar!.cursor,cursor);
  assert.ok(h.period.calendar.state.value.cells[89].agentMs>=2*M);
});

test('work authority clears the calendar before a delayed replacement and cannot be restored by its old flight',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true});t.after(()=>h.close());
  assert.ok(h.period.calendar.state.value.cells[89].agentMs>0);
  const held=h.hold();h.credit(NOW-M,NOW);h.events.flush();await flush();h.remove();
  assert.equal(h.period.calendar.state.value,null);
  held.release();await flush();
  assert.ok(!h.period.calendar.state.value||h.period.calendar.state.value.cells.every((c:CalendarCell)=>c.agentMs===null||c.agentMs===0));
});

test('financial news and a local midnight do not poll calendar history',async t=>{
  let at=NOW;t.mock.method(Date,'now',()=>at);const h=await fixture({heatmap:true,clocked:true});t.after(()=>h.close());
  const before=h.period.calendar.state.value;
  h.event({type:'history',data:{sources:[h.source],since:NOW-M,changes:[{source:h.source,scope:'budget',since:NOW-M}]}});await flush();
  assert.equal(h.requests.filter(r=>r.calendar).length,0);assert.equal(h.period.calendar.state.value,before);
  h.requests.length=0;at=h.period.calendar.state.window.edges[90];h.jump(at);await flush();
  assert.equal(h.period.calendar.state.window.edges[89],at);assert.equal(h.period.calendar.state.value.cells[89].agentMs,null);
  assert.equal(h.requests.filter(r=>r.calendar).length,0,'civil midnight changes presentation without polling');
});

test('zero-history boundaries advance once without a clock loop, and a clock correction clears future evidence',t=>{
  const prior=process.env.TZ;process.env.TZ='America/New_York';t.after(()=>{if(prior===undefined)delete process.env.TZ;else process.env.TZ=prior;});
  const at=Date.parse('2026-11-02T03:50:00Z'),calendar=new WorkCalendar();calendar.configure(true,'calendar',at);
  const window=calendar.state.window,basis:CalendarBasis={run:'run',revision:'1',evaluatedAt:at,evidenceCut:at,range:{from:window.edges[0],to:window.edges[90]},calendarKey:'key',workAuthority:'a',filterKey:'f'};
  const cells=window.dates.map((_,i)=>({agentMs:0,from:window.edges[i],to:Math.min(at,window.edges[i+1]),validUntil:null}));
  calendar.receive({state:'complete',basis,value:{zone:window.zone,edges:window.edges,cells,availableFrom:window.edges[0],retainedFrom:at-CALENDAR_RETENTION,cursor:'cursor'}},calendar.generation,()=>true);
  const entry=window.edges[0]+CALENDAR_RETENTION+1;assert.equal(calendar.nextAt(at),entry);
  calendar.tick(entry+10*M);assert.equal(calendar.state.value!.cells[0].from,window.edges[0]+10*M+1);
  assert.equal(calendar.state.value!.cells[0].agentMs,0);assert.equal(calendar.nextAt(entry+10*M),window.edges[90]);assert.equal(calendar.needed,false);
  calendar.tick(at-1000);assert.equal(calendar.state.value,null);assert.equal(calendar.demand(),undefined);
});
