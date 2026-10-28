import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarCellAt,calendarRangeAt,WorkCalendar} from '../lib/workCalendar.js';
import {expandPeriod} from '../../server/domain/periodWire.js';
import {calendarPartition} from '../../server/domain/workCalendar.js';
import {HistoryPool} from '../lib/historyPool.js';
import {fixture,flush,NOW,M} from './periodRuntimeFixture.js';

const DAY=86_400_000;

test('a quiet live calendar follows an overnight heartbeat without publishing data or reading history',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({heatmap:true,clocked:true,periodName:'24h'});t.after(()=>h.close());
  const calendar=h.period.calendar,reading=calendar.state,generation=calendar.generation;
  assert.ok(reading.integral);let notifications=0;const stop=calendar.subscribe(()=>notifications++);t.after(stop);
  h.requests.length=0;now+=8*3_600_000;h.jump(now);await flush();
  const stamp=h.events.workStamp(h.board);assert.ok(stamp);assert.equal(calendar.acceptFreshness(stamp),true);
  const range=calendarRangeAt(reading,now),actual=calendarCellAt(reading,range.from,range.to,now);
  assert.deepEqual(range,{from:now-DAY,to:now});assert.equal(actual.to,now);
  const fresh=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs:DAY},evaluatedAt:now,calendar:{zone:reading.window.zone,freshness:true}})));
  if(fresh.calendar?.state!=='complete')throw new Error('missing oracle');
  assert.equal(actual.agentMs,fresh.calendar.value.cells.reduce((sum,cell)=>sum+(cell.agentMs??0),0));
  assert.equal(calendar.state,reading);assert.equal(calendar.generation,generation);assert.equal(notifications,0);
  assert.equal(h.requests.filter(request=>request.calendar).length,0);
});

test('an old heartbeat cannot replace the work version accepted by an actual history reply',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true});t.after(()=>h.close());
  const calendar=h.period.calendar,old=calendar.state.integral?.stamp;assert.ok(old);
  h.credit(NOW-M,NOW);h.events.flush();await flush();
  const reading=calendar.state,stamp=reading.integral?.stamp;assert.ok(stamp);assert.ok(stamp.seq>old.seq);
  assert.equal(calendar.acceptFreshness({...old,at:NOW+M}),false);
  assert.equal(calendar.state,reading);assert.equal(calendar.matchesFreshness(stamp),true);
});

test('disconnect preserves confirmed quiet coverage while the live window keeps moving',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({heatmap:true,clocked:true,periodName:'24h'});t.after(()=>h.close());
  const calendar=h.period.calendar,reading=calendar.state;assert.ok(reading.integral);
  now+=8*3_600_000;h.jump(now);await flush();
  const stamp=h.events.workStamp(h.board);assert.ok(stamp);calendar.acceptFreshness(stamp);
  const range=calendarRangeAt(reading,now),confirmed=calendarCellAt(reading,range.from,range.to,now);
  assert.equal(confirmed.to,now);
  h.disconnect();
  assert.deepEqual(calendarCellAt(reading,range.from,range.to,now),confirmed,'confirmed coverage survives the lost connection');
  now+=M;h.jump(now);await flush();
  const later=calendarRangeAt(reading,now),offline=calendarCellAt(reading,later.from,later.to,now);
  assert.deepEqual(later,{from:now-DAY,to:now});assert.equal(offline.to,stamp.at,'offline time gains no unconfirmed coverage');
  h.reconnect();await flush();
  const recovered=calendar.state,current=calendarRangeAt(recovered,now);
  assert.equal(calendarCellAt(recovered,current.from,current.to,now).to,now,'reconnection recovers the live tail automatically');
});

test('a same-version heartbeat between HTTP capture and adoption does not strand the calendar',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({heatmap:true,transportLive:true,clocked:true});t.after(()=>h.close());
  now=NOW+24_999;h.jump(now);await flush();h.requests.length=0;
  const held=h.hold();h.credit(NOW-M,now);h.events.flush();await flush();
  const captured=held.reply?.calendar;if(!captured||captured.state==='error')throw new Error('held calendar reply');
  const stamp=captured.value.workStamp;assert.ok(stamp);
  now++;h.jump(now);await flush();
  assert.ok(h.frames.some(frame=>frame.type==='ping'&&JSON.parse(frame.data).workStamp?.at===now),'the production SSE heartbeat reached Live while the HTTP reply was held');
  held.release();await flush();
  assert.equal(h.period.calendar.state.integral?.stamp.seq,stamp.seq);
  assert.equal(h.period.calendar.needed,false);assert.equal(h.period.calendar.state.loading,false);
  assert.equal(h.requests.filter(request=>request.calendar).length,1);
});

test('displayed anonymous roots stay charged after cache eviction and release with their last reading',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true});t.after(()=>h.close());
  const calendar=h.period.calendar,reading=calendar.state;assert.ok(reading.integral);
  const release=calendar.retain(reading),before=calendar.bytes;
  for(const candidate of calendar.evictionCandidates()){assert.equal(candidate.bytes,0);candidate.drop();}
  assert.equal(calendar.bytes,before,'eviction cannot reclaim a root held by the display');
  calendar.clear();assert.ok(calendar.bytes>=reading.integral.bytes);
  release();assert.equal(calendar.bytes,0);
});

test('refusing a fresh proof leaves no adopted integral and the same bounded reply can recover',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({heatmap:true});t.after(()=>h.close());
  const part=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs:DAY},evaluatedAt:NOW,calendar:{zone:h.period.calendar.state.window.zone,freshness:true}}))).calendar;
  if(part?.state!=='complete')throw new Error('missing fresh baseline');
  const calendar=new WorkCalendar();calendar.configure(true,'fresh proof',NOW,false,{mode:'live',periodMs:DAY});
  calendar.receive(part,calendar.generation,()=>false);
  assert.equal(calendar.state.integral,undefined);assert.equal(calendar.state.value,null);assert.equal(calendar.state.error,'history_limit');
  assert.equal(calendar.evictionCandidates().length,0);
  calendar.receive(part,calendar.generation,()=>true);assert.ok(calendar.state.integral);assert.equal(calendar.state.error,null);
  calendar.clear();assert.equal(calendar.bytes,0);
});

test('an unfinished delta projection keeps its new root charged after cache eviction',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({heatmap:true,periodName:'30d'});t.after(()=>h.close());
  const calendar:WorkCalendar=h.period.calendar,reading=calendar.state;assert.ok(reading.integral);assert.ok(reading.value);
  now+=1000;h.jump(now);await flush();h.credit(now-M,now);
  const part=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs:30*DAY},evaluatedAt:now,calendar:{zone:reading.window.zone,freshness:true,cursor:reading.value.cursor}}))).calendar;
  if(part?.state!=='delta')throw new Error('expected sparse work delta');
  let evicted=false;
  calendar.receive(part,calendar.generation,{reserve:()=>{
    const candidate=calendar.evictionCandidates().find(candidate=>candidate.shownAt===now);
    if(!evicted&&calendar.state===reading&&candidate){
      evicted=true;assert.equal(candidate.bytes,0);const before=calendar.bytes;candidate.drop();
      assert.equal(calendar.bytes,before,'the projection still owns the evicted root');
    }
    return true;
  },handoff:()=>true});
  assert.ok(evicted);assert.notEqual(calendar.state,reading);assert.ok(calendar.state.integral);assert.equal(calendar.state.error,null);
});

test('a tight shared pool cannot admit projection cells by dropping their leased curve',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({heatmap:true,periodName:'30d'});t.after(()=>h.close());
  const pool=new HistoryPool(),calendar=new WorkCalendar(),flight={role:'visible' as const};let padding=0;
  pool.register({get estimatedBytes(){return calendar.bytes;},evictionCandidates:()=>calendar.evictionCandidates()});
  pool.register({get estimatedBytes(){return padding;},evictionCandidates:()=>[]});
  t.after(()=>{padding=0;pool.release(flight);calendar.clear();assert.equal(pool.estimatedBytes,0);});
  calendar.configure(true,'tight pool',now,false,{mode:'live',periodMs:30*DAY});
  const read=(cursor?:string)=>expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs:30*DAY},evaluatedAt:now,calendar:{zone:calendar.state.window.zone,freshness:true,...(cursor?{cursor}:{})}}))).calendar;
  const complete=read();if(complete?.state!=='complete')throw new Error('initial proof');
  calendar.receive(complete,calendar.generation,bytes=>pool.reserve(flight,bytes));pool.release(flight);
  const reading=calendar.state;assert.ok(reading.integral);assert.ok(reading.value);
  now+=1000;h.jump(now);await flush();h.credit(now-M,now);
  const part=read(reading.value.cursor);if(part?.state!=='delta')throw new Error('sparse delta');
  const projection=calendar.incomingBytes(part)+calendarPartition(part.basis.range).length*256;
  let baseline=0,calibrated=false;const refused:number[]=[];
  calendar.receive(part,calendar.generation,{reserve:bytes=>{
    if(!baseline)baseline=calendar.bytes;
    if(!calibrated&&calendar.evictionCandidates().some(candidate=>candidate.shownAt===now)){
      calibrated=true;const rootBytes=calendar.bytes-baseline;assert.ok(rootBytes>0);
      padding=pool.budget-baseline-projection-Math.floor(rootBytes/2);assert.ok(padding>0);
    }
    const accepted=pool.reserve(flight,bytes);if(!accepted)refused.push(bytes);return accepted;
  },handoff:bytes=>pool.reserve(flight,bytes)});
  assert.ok(calibrated);assert.ok(refused.includes(projection),'the cells and their leased root exceed the same pool');
  assert.equal(calendar.state.integral,reading.integral);assert.equal(calendar.state.error,'history_limit');
  pool.release(flight);assert.ok(pool.estimatedBytes<=pool.budget,'failed admission releases its temporary owner');
});
