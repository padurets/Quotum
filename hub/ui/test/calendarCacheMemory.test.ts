import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {calendarProof} from '../../server/domain/calendarWork';
import {calendarCells,type CalendarSection} from '../../server/domain/workCalendar';
import {packCalendar,expandCalendar} from '../../server/domain/workCalendarWire';
import {drain} from '../../server/domain/prepare';
import type {PeriodSelection} from '../../server/domain/period';
import {CalendarCache} from '../lib/calendarCache';
import {WorkCalendar,calendarWindow} from '../lib/workCalendar';
import {HistoryPool} from '../lib/historyPool';

const H=3_600_000,DAY=24*H,now=Date.UTC(2026,9,22,12)+4321,periodMs=30*DAY,retentionMs=90*DAY;
const live:PeriodSelection={mode:'live',periodMs},cold:PeriodSelection={mode:'range',from:now-45*DAY,to:now-15*DAY};
const known=now-75*DAY,rows=Array.from({length:75*24},(_,i)=>{
  const from=known+i*H+1234,to=from+5*60_000+567;
  return {session:i,source:null,device:'synthetic-device',user:'synthetic-user',origin:'terminal' as const,project:null,folder:null,startedAt:from,from,to};
});
function section(selection:PeriodSelection,at=now):Extract<CalendarSection,{state:'complete'}>{
  const window=calendarWindow(at,'UTC',selection),range=window.range,cut=Math.min(at,range.to),retained=at-retentionMs;
  const proof={...drain(calendarProof(rows,range,cut,known,retained,()=>{})),retentionMs,...(selection.mode==='live'?{periodMs:selection.periodMs}:{})};
  const cells=drain(calendarCells(rows,window.edges,window.edges.slice(1).map((_,i)=>i),cut,known,retained,retentionMs,range,selection.mode==='live'?selection.periodMs:undefined)).map(([,cell])=>cell);
  const part:Extract<CalendarSection,{state:'complete'}>={state:'complete',basis:{run:'synthetic-run',revision:'1',evaluatedAt:at,evidenceCut:cut,range,calendarKey:selection.mode==='live'?'live':'fixed',filterKey:'same-filter',workAuthority:'same-authority'},value:{zone:'UTC',edges:window.edges,cells,availableFrom:known,retainedFrom:retained,cursor:'cursor',proof}};
  const decoded=expandCalendar(packCalendar(part,part.basis,()=>{}),part.basis,()=>{});
  assert.ok(decoded?.state==='complete');assert.deepEqual(decoded.value.cells,cells,'the real proof codec preserves the independent row oracle');return decoded;
}
function fixture(t:TestContext){
  const resolved=Intl.DateTimeFormat.prototype.resolvedOptions;
  t.mock.method(Intl.DateTimeFormat.prototype,'resolvedOptions',function(this:Intl.DateTimeFormat){return {...resolved.call(this),timeZone:'UTC'};});
  const calendar=new WorkCalendar(),cache=(calendar as unknown as {cache:CalendarCache}).cache,pool=new HistoryPool(),flight={role:'visible' as const};
  const evictions:number[]=[];
  pool.register({get estimatedBytes(){return calendar.bytes;},evictionCandidates:()=>calendar.evictionCandidates().map(e=>({...e,drop(){evictions.push(e.bytes);e.drop();}}))});
  const reserve=(bytes:number)=>pool.reserve(flight,bytes);
  function configure(selection:PeriodSelection,at=now){try{calendar.configure(true,'same-context',at,false,selection,reserve);}finally{pool.release(flight);}}
  function receive(selection:PeriodSelection,at=now){try{calendar.receive(section(selection,at),calendar.generation,reserve);}finally{pool.release(flight);}}
  configure(live);receive(live);configure(cold);receive(cold);
  assert.equal(calendar.evictionCandidates().length,2);assert.equal(calendar.needed,false);assert.ok(cache.bytes>0);
  t.after(()=>{pool.release(flight);calendar.clear();assert.equal(calendar.bytes,0);assert.equal(pool.activeFlights,0);});
  return {calendar,cache,pool,flight,reserve,configure,receive,evictions};
}

test('a cache HIT borrows each resident curve once and preserves the shifted repeat under the real 15 MiB pool',t=>{
  const h=fixture(t),at=now+8801,window=calendarWindow(at,'UTC',live),projection=1024+window.edges.length*256+window.dates.length*256;
  const curves=h.cache.bytes,headroom=Math.floor(curves/2);let padding=h.pool.budget-h.calendar.bytes-projection-headroom;
  assert.ok(padding>0);h.pool.register({get estimatedBytes(){return padding;},evictionCandidates:()=>[]});t.after(()=>{padding=0;});
  h.configure(live,at);assert.equal(h.calendar.needed,false);assert.deepEqual(h.evictions,[],'a HIT must not evict its own reusable proof to pay for a duplicate curve charge');
  const repeat:PeriodSelection={mode:'range',from:cold.from+8801,to:cold.to+8801};h.configure(repeat,at);
  assert.equal(h.calendar.needed,false,'the shifted edge still has reusable LIVE coverage');assert.equal(h.calendar.demand(),undefined);
  assert.deepEqual(h.calendar.state.value!.cells,section(repeat,at).value.cells,'all amounts, exact boundaries and validUntil survive the borrowed read');
  assert.equal(h.pool.activeFlights,0);assert.ok(h.pool.estimatedBytes<=h.pool.budget);
  t.diagnostic(JSON.stringify({budget:h.pool.budget,curves,projection,headroom,padding,evictions:h.evictions}));
});

for(const change of ['drop','clear','hide','replace','nested','throw','refuse'] as const)test(`borrowed calendar curves remain charged through ${change} and release after the read`,t=>{
  const h=fixture(t),before=h.cache.bytes,window=calendarWindow(now+8801,'UTC',live);let observed=0,calls=0;
  const read=()=>h.cache.read(window,live,now+8801,()=>{
    if(++calls>1)return true;
    if(change==='drop')for(const e of h.cache.evictionCandidates())e.drop();
    if(change==='clear'||change==='throw'||change==='refuse')h.cache.clear();
    if(change==='hide')h.calendar.configure(false,'same-context',now);
    if(change==='replace')h.calendar.configure(true,'replacement-authority',now);
    if(change==='nested'){
      const nested=h.cache.read(window,live,now+8801,()=>{h.cache.clear();assert.equal(h.cache.bytes,before);return true;});
      assert.equal(nested,null,'a clear retires the nested answer');
    }
    observed=h.cache.bytes;assert.equal(observed,before,'LRU/authority removal does not free storage still borrowed by a projection');
    if(change==='hide')assert.equal(h.calendar.bytes,before,'a hidden calendar still accounts outstanding borrows');
    if(change==='replace')assert.ok(h.calendar.bytes>before,'the replacement shell and outstanding borrows both remain charged');
    if(change==='throw')throw new Error('projection reservation failed');
    return change!=='refuse';
  });
  if(change==='throw')assert.throws(read,/projection reservation failed/);else{
    const result=read();if(change==='drop')assert.ok(result,'LRU removal alone does not change authority');else assert.equal(result,null,'retired or refused work cannot publish a cached answer');
  }
  assert.equal(calls,1);assert.equal(observed,before);assert.equal(h.cache.bytes,0,'the last borrowed owner releases storage on every exit');
});

for(const change of ['hide','replace','clear'] as const)test(`a reentrant ${change} during cache admission cannot restore the previous calendar context`,t=>{
  const h=fixture(t);let once=false;
  h.calendar.configure(true,'same-context',now+8801,false,live,()=>{
    if(once)return true;once=true;
    if(change==='hide')h.calendar.configure(false,'same-context',now);
    if(change==='replace')h.calendar.configure(true,'replacement-authority',now);
    if(change==='clear')h.calendar.clear();
    return true;
  });
  assert.equal(once,true);assert.equal(h.calendar.state.value===null,true,'the retired read cannot replace the newer empty shell');
  if(change==='hide'){assert.equal(h.calendar.visible,false);assert.equal(h.calendar.demand(),undefined);}
  if(change==='replace')assert.equal((h.calendar as unknown as {context:string}).context.includes('replacement-authority'),true);
});

test('the accepted numeric reading takes over its scratch charge before publication',t=>{
  const h=fixture(t),before=h.calendar.get();let held=0,seen=false;
  const stop=h.calendar.subscribe(()=>{if(h.calendar.get()!==before){seen=true;assert.equal(held,0,'a listener must not see resident cells plus their old projection reservation');}});
  try{h.calendar.configure(true,'same-context',now+8801,false,live,bytes=>{held=bytes;return true;});assert.equal(seen,true);assert.equal(h.calendar.needed,false);}finally{stop();}
});

test('LRU pressure can retire cache entries but cannot use borrowed storage to admit an oversized read',t=>{
  const h=fixture(t),before=h.cache.bytes,window=calendarWindow(now+8801,'UTC',live),projection=1024+window.edges.length*256+window.dates.length*256;
  let padding=h.pool.budget-h.calendar.bytes-projection+1;h.pool.register({get estimatedBytes(){return padding;},evictionCandidates:()=>[]});t.after(()=>{padding=0;});
  try{
    const result=h.cache.read(window,live,now+8801,bytes=>{const admitted=h.reserve(bytes);assert.equal(h.cache.bytes,before,'trim cannot pretend a borrowed curve was freed');assert.equal(admitted,false);return admitted;});
    assert.equal(result,null);assert.equal(h.evictions.length,2,'ordinary LRU still considers each cache owner');assert.equal(h.cache.bytes,0);
  }finally{h.pool.release(h.flight);}
  assert.ok(h.pool.estimatedBytes<=h.pool.budget);
});

test('genuine pressure retains ordinary LRU ordering across another history family',t=>{
  const h=fixture(t),window=calendarWindow(now+8801,'UTC',live),projection=1024+window.edges.length*256+window.dates.length*256;
  let victim=16_384,dropped=0,padding=h.pool.budget-h.calendar.bytes-projection-victim/2;
  h.pool.register({get estimatedBytes(){return padding+victim;},evictionCandidates:()=>victim?[{bytes:victim,shownAt:0,drop(){victim=0;dropped++;}}]:[]});t.after(()=>{padding=0;victim=0;});
  h.configure(live,now+8801);assert.equal(h.calendar.needed,false);assert.equal(dropped,1);assert.deepEqual(h.evictions,[]);assert.ok(h.pool.estimatedBytes<=h.pool.budget);
});

test('calendar projection overflow releases its borrowed curves on the exceptional exit',()=>{
  const part=section(live),value=structuredClone(part.value),cache=new CalendarCache(),staging=8192;
  // Fault injection bypasses wire decoding, which already rejects this overflow.
  value.proof!.patterns=[[0,Number.MAX_SAFE_INTEGER,H,-Number.MAX_SAFE_INTEGER]];
  value.proof!.sources[0].blocks=[Math.ceil(part.basis.range.from/H),0];
  cache.add(part.basis,value,()=>true,staging);assert.ok(cache.bytes>0);
  assert.throws(()=>cache.read(calendarWindow(now,'UTC',live),live,now,()=>{for(const entry of cache.evictionCandidates())entry.drop();return true;}),/calendar_overflow/);
  assert.equal(cache.bytes,0);
});
