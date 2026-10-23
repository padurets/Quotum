import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {calendarProof,calendarCurve} from '../../server/domain/calendarWork';
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
  const decoded=expandCalendar(packCalendar(part,part.basis,()=>{}),part.basis,()=>{},()=>{});
  assert.ok(decoded?.state==='complete');assert.deepEqual(decoded.value.cells,cells,'the real proof codec preserves the independent row oracle');return decoded;
}
function proofBytes(selection:PeriodSelection){
  const cache=new CalendarCache(),part=section(selection);cache.add(part.basis,part.value,()=>true,0);return cache.bytes;
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
  assert.ok(cache.evictionCandidates().every(candidate=>candidate.bytes>0));
  assert.equal(cache.evictionCandidates().reduce((sum,candidate)=>sum+candidate.bytes,0),cache.bytes);
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

test('restoring a covered period can release unrelated calendar proofs under the shared budget',t=>{
  const h=fixture(t),older:PeriodSelection={mode:'range',from:now-75*DAY,to:now-46*DAY};
  h.configure(older);h.receive(older);assert.equal(h.cache.evictionCandidates().length,3);
  const part=section(cold),usedBytes=proofBytes(cold),unusedBytes=h.cache.bytes-usedBytes,window=calendarWindow(now,'UTC',cold);
  const projection=1024+window.edges.length*256+window.dates.length*256,headroom=projection-Math.floor(unusedBytes/2);
  let padding=h.pool.budget-h.calendar.bytes-headroom;
  assert.ok(usedBytes>0&&unusedBytes>0&&padding>0);
  h.pool.register({get estimatedBytes(){return padding;},evictionCandidates:()=>[]});t.after(()=>{padding=0;});
  h.configure(cold);
  assert.equal(h.calendar.needed,false,'unrelated proofs must remain evictable while a covered target is projected');
  assert.equal(h.calendar.demand(),undefined,'restoring the covered period needs no calendar HTTP');
  assert.deepEqual(h.calendar.get().value!.cells,part.value.cells,'every projected cell matches the production row oracle');
  assert.ok(h.evictions.some(bytes=>bytes>0),'admission releases real unused storage');
  assert.ok(h.cache.bytes>=usedBytes,'the used proof remains resident after the read');
  assert.ok(h.pool.estimatedBytes<=h.pool.budget);assert.equal(h.pool.activeFlights,0);
  t.diagnostic(JSON.stringify({budget:h.pool.budget,usedBytes,unusedBytes,projection,headroom,padding,evictions:h.evictions}));
});

for(const change of ['drop','clear','invalidate','hide','replace','nested','throw','refuse'] as const)test(`borrowed calendar curves remain charged through ${change} and release after the read`,t=>{
  const h=fixture(t),before=h.cache.bytes,usedBytes=proofBytes(live),window=calendarWindow(now+8801,'UTC',live);let observed=0,calls=0;
  const read=()=>h.cache.read(window,live,now+8801,()=>{
    if(++calls>1)return true;
    const candidates=h.cache.evictionCandidates();
    assert.equal(candidates.filter(candidate=>candidate.bytes===0).length,1,'the selected curve remains borrowed');
    assert.equal(candidates.reduce((bytes,candidate)=>bytes+candidate.bytes,0),before-usedBytes,'unused curves remain releasable');
    if(change==='drop')for(const e of h.cache.evictionCandidates())e.drop();
    if(change==='clear'||change==='throw'||change==='refuse')h.cache.clear();
    if(change==='invalidate')h.cache.invalidate(-Infinity);
    if(change==='hide')h.calendar.configure(false,'same-context',now);
    if(change==='replace')h.calendar.configure(true,'replacement-authority',now);
    if(change==='nested'){
      const nested=h.cache.read(window,live,now+8801,()=>{h.cache.clear();assert.equal(h.cache.bytes,usedBytes);return true;});
      assert.equal(nested,null,'a clear retires the nested answer');
    }
    observed=h.cache.bytes;assert.equal(observed,usedBytes,'LRU/authority removal releases only curves not borrowed by the projection');
    if(change==='hide')assert.equal(h.calendar.bytes,usedBytes,'a hidden calendar still accounts outstanding borrows');
    if(change==='replace')assert.ok(h.calendar.bytes>usedBytes,'the replacement shell and outstanding borrows both remain charged');
    if(change==='throw')throw new Error('projection reservation failed');
    return change!=='refuse';
  });
  if(change==='throw')assert.throws(read,/projection reservation failed/);else{
    const result=read();if(change==='drop')assert.ok(result,'LRU removal alone does not change authority');else assert.equal(result,null,'retired or refused work cannot publish a cached answer');
  }
  assert.equal(calls,1);assert.equal(observed,usedBytes);assert.equal(h.cache.bytes,0,'the last borrowed owner releases storage on every exit');
});

for(const change of ['evict','clear','nested','refuse','throw'] as const)test(`a multi-proof calendar projection owns every used curve through ${change}`,t=>{
  const h=fixture(t),older:PeriodSelection={mode:'range',from:now-75*DAY,to:now-46*DAY};
  h.configure(older);h.receive(older);
  const selection:PeriodSelection={mode:'range',from:now-31*DAY,to:now-DAY},window=calendarWindow(now,'UTC',selection);
  const usedBytes=proofBytes(live)+proofBytes(cold),unusedBytes=h.cache.bytes-usedBytes;
  assert.ok(unusedBytes>0);let called=0;
  const read=()=>h.cache.read(window,selection,now,()=>{
    called++;const candidates=h.cache.evictionCandidates();
    assert.equal(candidates.filter(candidate=>candidate.bytes===0).length,2,'both segments stay owned, even when they overlap');
    assert.equal(candidates.reduce((bytes,candidate)=>bytes+candidate.bytes,0),unusedBytes);
    if(change==='nested'){
      const nested=h.cache.read(window,selection,now,()=>{h.cache.clear();assert.equal(h.cache.bytes,usedBytes);return true;});
      assert.equal(nested,null);assert.equal(h.cache.bytes,usedBytes,'the outer read still owns both curves after the nested release');
    }else if(change==='clear')h.cache.clear();
    else for(const candidate of candidates)candidate.drop();
    assert.equal(h.cache.bytes,usedBytes);
    if(change==='throw')throw new Error('multi-proof reservation failed');
    return change!=='refuse';
  });
  if(change==='throw')assert.throws(read,/multi-proof reservation failed/);
  else{
    const reading=read();
    if(change==='evict'){assert.ok(reading);assert.deepEqual(reading.value!.cells,section(selection).value.cells);}
    else assert.equal(reading,null);
  }
  assert.equal(called,1);assert.equal(h.cache.bytes,0,'all used roots release after the last owner on every exit');
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
  if(change==='replace')assert.equal(h.calendar.presentationKey().includes('replacement-authority'),true);
});

test('the accepted numeric reading takes over its scratch charge before publication',t=>{
  const h=fixture(t),before=h.calendar.get();let held=0,seen=false;
  const stop=h.calendar.subscribe(()=>{if(h.calendar.get()!==before){seen=true;assert.equal(held,0,'a listener must not see resident cells plus their old projection reservation');}});
  try{h.calendar.configure(true,'same-context',now+8801,false,live,bytes=>{held=bytes;return true;});assert.equal(seen,true);assert.equal(h.calendar.needed,false);}finally{stop();}
});

test('LRU pressure can retire cache entries but cannot use borrowed storage to admit an oversized read',t=>{
  const h=fixture(t),usedBytes=proofBytes(live),unusedBytes=h.cache.bytes-usedBytes,window=calendarWindow(now+8801,'UTC',live),projection=1024+window.edges.length*256+window.dates.length*256;
  let padding=h.pool.budget-h.calendar.bytes-projection+unusedBytes+1;h.pool.register({get estimatedBytes(){return padding;},evictionCandidates:()=>[]});t.after(()=>{padding=0;});
  try{
    const result=h.cache.read(window,live,now+8801,bytes=>{const admitted=h.reserve(bytes);assert.equal(h.cache.bytes,usedBytes,'trim cannot pretend a borrowed curve was freed');assert.equal(admitted,false);return admitted;});
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

test('cache adoption releases curve construction scratch before its next allocation under the shared budget',t=>{
  const part=section(live),proof=part.value.proof!;let net=0,peak=0,cumulative=0;
  calendarCurve(proof,part.basis.range,part.basis.evidenceCut,part.value.availableFrom,size=>{net+=size;cumulative+=size;peak=Math.max(peak,net);},size=>{net-=size;});
  const staging=8192,honest=Math.max(peak,net+1024);assert.ok(cumulative>honest);
  const cache=new CalendarCache(),pool=new HistoryPool(),flight={role:'visible' as const};let padding=pool.budget-staging-honest-Math.floor((cumulative-honest)/2),refused=0;
  pool.register({get estimatedBytes(){return padding+cache.bytes;},evictionCandidates:()=>cache.evictionCandidates()});
  try{
    cache.add(part.basis,part.value,bytes=>{const accepted=pool.reserve(flight,bytes);if(!accepted)refused++;return accepted;},staging);
    assert.equal(cache.evictionCandidates().length,1,'released construction arrays must not prevent retaining the completed curve');assert.equal(refused,0);
    assert.ok(cache.read(calendarWindow(now,'UTC',live),live,now,()=>true));
    assert.ok(pool.estimatedBytes<=pool.budget);t.diagnostic(JSON.stringify({budget:pool.budget,staging,honest,cumulative,padding}));
  }finally{pool.release(flight);padding=0;cache.clear();assert.equal(pool.estimatedBytes,0);}
});

for(const stage of [1,2])for(const change of ['hide','replace','clear'] as const)test(`calendar adoption retires a ${change} during reservation ${stage} before cache or state ownership`,t=>{
  const h=fixture(t),part=section(cold);let calls=0;
  h.calendar.receive(part,h.calendar.generation,()=>{
    if(++calls!==stage)return true;
    if(change==='hide')h.calendar.configure(false,'same-context',now);
    if(change==='replace')h.calendar.configure(true,'replacement-authority',now);
    if(change==='clear')h.calendar.clear();
    return true;
  });
  assert.ok(calls>=stage);assert.equal(h.calendar.state.value===null,true,'the retired response cannot restore an old numeric result');
  assert.equal(h.cache.bytes,0,'a response retired before construction cannot enter the replacement cache');
  if(change==='replace')assert.equal(h.calendar.needed,true);else assert.equal(h.calendar.demand(),undefined);
});

test('each refused cache construction allocation leaves no entry and releases only accepted staging',()=>{
  const part=section(live),staging=8192;let last=staging,growth=0;
  new CalendarCache().add(part.basis,part.value,bytes=>{if(bytes>last)growth++;last=bytes;return true;},staging);
  assert.ok(growth>4);
  for(let denied=0;denied<growth;denied++){
    const cache=new CalendarCache(),pool=new HistoryPool(),flight={role:'visible' as const};let index=0,accepted=staging;
    pool.register({get estimatedBytes(){return cache.bytes;},evictionCandidates:()=>cache.evictionCandidates()});assert.equal(pool.reserve(flight,staging),true);
    try{
      cache.add(part.basis,part.value,bytes=>{if(bytes>accepted&&index++===denied)return false;const ok=pool.reserve(flight,bytes);if(ok)accepted=bytes;return ok;},staging);
      assert.equal(cache.bytes,0,'a rejected allocation cannot retain a partial curve');assert.equal(pool.estimatedBytes,staging,'the incoming response still owns its original staging');
    }finally{pool.release(flight);cache.clear();assert.equal(pool.estimatedBytes,0);}
  }
});

test('a refused cache shrink keeps the next allocation conservative until caller cleanup',()=>{
  const part=section(live),staging=8192;let cumulative=0;
  calendarCurve(part.value.proof!,part.basis.range,part.basis.evidenceCut,part.value.availableFrom,size=>{cumulative+=size;});
  const cache=new CalendarCache();let accepted=staging,refused=0;
  cache.add(part.basis,part.value,bytes=>{if(bytes<accepted){refused++;return false;}accepted=bytes;return true;},staging);
  assert.ok(refused>1,'construction and final caller staging both request a shrink');
  assert.equal(accepted,staging+cumulative+1024,'refused release cannot discount the next growth');assert.equal(cache.evictionCandidates().length,1);cache.clear();
});

for(const throwing of [false,true])test(`malformed cache proof preserves its decode error with ${throwing?'throwing':'accepted'} shrink`,()=>{
  const part=section(live),value=structuredClone(part.value),cache=new CalendarCache(),staging=8192;
  value.proof!.patterns[0][1]=-1;let accepted=staging,shrinks=0;
  assert.throws(()=>cache.add(part.basis,value,bytes=>{if(bytes<accepted){shrinks++;if(throwing)throw new Error('cleanup failed');}accepted=bytes;return true;},staging),/invalid_source_work/);
  assert.ok(shrinks>0);assert.equal(cache.bytes,0);if(!throwing)assert.equal(accepted,staging);
});

test('a throwing cache cleanup cannot replace the original allocation error',()=>{
  const part=section(live),cache=new CalendarCache(),staging=8192,primary=new Error('primary allocation failure');let accepted=staging,growth=0;
  assert.throws(()=>cache.add(part.basis,part.value,bytes=>{
    if(bytes<accepted)throw new Error('cleanup failed');
    if(bytes>accepted&&++growth===2)throw primary;
    accepted=bytes;return true;
  },staging),error=>error===primary);
  assert.equal(cache.bytes,0);
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
