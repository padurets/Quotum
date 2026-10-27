import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,NOW,H} from './periodRuntimeFixture';
import {ACTIVITY} from '../../server/domain/widgets';
import {expandPeriod} from '../../server/domain/periodWire';
import type {PeriodRequest,PeriodReply} from '../../server/domain/periodRead';
import type {HistoryStore} from '../lib/history';
import type {HistoryTile} from '../lib/historyTiles';
import type {History} from '../../server/domain/history';
import type {HubEvent,PageEvent} from '../lib/board';
import {compose,expandHistory,targetOf} from '../../server/domain/history';
import {PeriodAccounting} from '../../server/domain/periodAccounting';
import {retainSamplesPrepared} from '../../server/domain/periodTape';
import {drain} from '../lib/prepare';

const buffers=(loader:HistoryStore)=>[...(loader as unknown as {grids:Map<number,Map<number,HistoryTile>>}).grids.values()].flatMap(grid=>
  [...grid.values()].flatMap(tile=>[...(tile as unknown as {series:Map<string,{values:Float64Array}>}).series.values()].map(row=>row.values)));
const historyEvents=(h:Awaited<ReturnType<typeof fixture>>)=>h.frames.filter(frame=>frame.type==='history').map(frame=>JSON.parse(frame.data) as Extract<HubEvent,{type:'history'}>['data']);
const nativeRows=(reply:PeriodReply)=>reply.quota?.state==='complete'?reply.quota.value.chunks.flatMap(chunk=>chunk.series??[]):[];

/** Real producer, reducer, follow subscription, transport, wire and tile cache. */
async function warm(t:TestContext){
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({creditFrom:NOW-40_000,creditTo:NOW-30_000});
  let d:Awaited<ReturnType<typeof drawings>>|undefined;
  t.after(async()=>{d?.close();await h.close();});
  const other=h.store.source('codex','d'.repeat(24),NOW-3*H);
  for(const person of [h.alice,h.bob])h.store.hold(other,person.id,NOW-3*H);
  h.store.share(h.board,other,h.alice.id,NOW-3*H);
  const record=(at:number,remaining=83)=>h.store.record(h.source,{observedAt:at,plan:'',resets:null,staleAfterMs:H,windows:[
    {id:'w',kind:'weekly',label:null,minutes:10080,used:100-remaining,remaining,resetAt:NOW+H},
    {id:'session',kind:'session',label:null,minutes:300,used:10,remaining:90,resetAt:NOW+H},
  ]});
  record(NOW-50_000);
  h.store.record(other,{observedAt:NOW-50_000,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:25,remaining:75,resetAt:NOW+H}]});
  h.store.creditWork(h.device,NOW-40_000,NOW-20_000,[{source:other,client:'codex',origin:'terminal',project:'Parallel project',folder:'',startedAt:NOW-3*H,identity:{kind:'stable',sessionId:'parallel-current-cell'}}]);
  const view=h.page.get().board!.view;
  h.directory.saveView(h.board,{...view,hidden:view.hidden.filter(id=>id!==ACTIVITY),shown:[...new Set([...view.shown,ACTIVITY])]},h.alice.id,NOW);
  h.events.flush();await flush();
  const replies:{request:PeriodRequest;reply:PeriodReply}[]=[],read=h.reader.read.bind(h.reader);
  t.mock.method(h.reader,'read',(...args:Parameters<typeof read>)=>{
    const json=read(...args);replies.push({request:structuredClone(args[2] as PeriodRequest),reply:expandPeriod(JSON.parse(json))});return json;
  });
  d=await drawings(h);
  const drawing=d;
  const activity=():History['activity']=>{const frame=drawing.renderActivity();assert.equal(frame.loading,false);assert.equal(frame.error,undefined);assert.ok(frame.history);return frame.history.activity;};
  const native=():History=>{const frame=drawing.renderFinancial();assert.equal(frame.loading,false);assert.equal(frame.error,undefined);assert.ok(frame.history);return frame.history;};
  assert.equal(native().series.length,3,'the cache contains several native series');
  assert.deepEqual([activity().activeMs,activity().agentMs,activity().agents],[20_000,30_000,2]);
  assert.ok(buffers(d.loader).length>=3);
  const published=[...replies].reverse().find(({reply})=>nativeRows(reply).length===3&&reply.quota?.state==='complete');
  assert.ok(published,'the actual cold baseline published full native cells');
  h.requests.length=0;h.frames.length=0;
  replies.length=0;
  return {h,d,other,record,replies,activity,native,published};
}

test('work-only live cells update exact Activity without resending unchanged native drawing rows',async t=>{
  const {h,d,replies,activity,native}=await warm(t);
  const authority=h.page.get().board!.workAuthority,nativeBefore=native(),financialBefore=d.loader.getFinancial(),owned=buffers(d.loader);
  const geometry=nativeBefore.series.map(row=>({source:row.sourceId,window:row.windowId,points:row.points}));
  const readout=nativeBefore.series.map(row=>[row.sourceId,row.windowId,row.remainingAtEnd]);
  let rows=0;
  for(let i=0;i<3;i++){
    const from=NOW-15_000+i*5_000,to=from+5_000,before=replies.length,reads=h.requests.length;
    h.frames.length=0;h.credit(from,to);h.events.flush();await flush();
    const notices=historyEvents(h);assert.ok(notices.length);
    assert.ok(notices.flatMap(event=>event.changes??[]).some(change=>change.source===h.source&&change.scope==='quota'&&change.workOnly===true&&change.workSince===from),'the server positively confirms independent work-only news');
    assert.ok(notices.flatMap(event=>event.changes??[]).every(change=>change.workOnly===true));
    assert.equal(h.page.get().board!.workAuthority,authority);
    assert.deepEqual([activity().activeMs,activity().agentMs,activity().agents],[25_000+i*5_000,35_000+i*5_000,2]);
    assert.deepEqual(native().series.map(row=>({source:row.sourceId,window:row.windowId,points:row.points})),geometry);
    assert.deepEqual(native().series.map(row=>[row.sourceId,row.windowId,row.remainingAtEnd]),readout);
    assert.equal(h.period.quotaAt({sourceId:h.source,windowId:'w'},NOW,'1h').remainingAtEnd,83);
    assert.equal(h.requests.length-reads,1,'the shared transport uses one HTTP read per credited interval');
    const current=replies.slice(before);assert.equal(current.length,1);
    assert.equal(current[0].request.selection.mode,'live');assert.ok(current[0].request.sessions);
    assert.ok(current[0].reply.quota?.state==='complete');assert.ok(current[0].reply.quota.value.chunks.length);
    rows+=nativeRows(current[0].reply).length;
  }
  assert.equal(rows,0,'activity refreshes must not repeat cached native drawing rows');
  assert.ok(owned.every(value=>buffers(d.loader).includes(value)),'work-only replacement retains the exact native typed buffers');
  assert.equal(d.loader.getFinancial(),financialBefore,'work-only replacement retains the native frame');
  assert.equal(h.pool.activeFlights,0);assert.ok(h.pool.estimatedBytes<=h.pool.budget);
});

for(const later of [false,true])for(const workFirst of [false,true])test(`coalesced native news ${later?'after':'at'} the work cutoff survives (${workFirst?'work first':'native first'})`,async t=>{
  const {h,replies,record,activity,native}=await warm(t);
  const authority=h.page.get().board!.workAuthority,from=NOW-15_000,at=from+(later?5_000:0);
  const credit=()=>h.credit(from,NOW-5_000),measure=()=>record(at,72);
  if(workFirst)credit();measure();if(!workFirst)credit();
  h.events.flush();await flush();
  const changes=historyEvents(h).flatMap(event=>event.changes??[]).filter(change=>change.source===h.source&&change.scope==='quota');
  assert.ok(changes.some(change=>change.workOnly===true&&change.workSince===from));
  assert.ok(changes.some(change=>change.workOnly!==true&&change.since===at),'the actual producer retains independent native news even when since >= workSince');
  assert.equal(h.page.get().board!.workAuthority,authority);
  assert.deepEqual([activity().activeMs,activity().agentMs,activity().agents],[30_000,40_000,2]);
  assert.equal(h.page.get().board!.cards[h.source].windows.find(window=>window.id==='w')!.remaining,72);
  assert.equal(h.period.quotaAt({sourceId:h.source,windowId:'w'},NOW,'1h').remainingAtEnd,72);
  const series=native().series.find(row=>row.sourceId===h.source&&row.windowId==='w');assert.ok(series);
  assert.equal(series.remainingAtEnd,72);assert.equal(series.points.at(-1)![1],72);
  assert.ok(replies.some(({reply})=>nativeRows(reply).some(row=>row.source===h.source&&row.window==='w')),'new native evidence must still produce native drawing rows');
  assert.ok(h.requests.some(request=>request.quota&&request.quota.cells!=='skip'));
  assert.equal(h.requests.length,1,'coalesced native and work intents share one HTTP read');
  assert.equal(h.pool.activeFlights,0);assert.ok(h.pool.estimatedBytes<=h.pool.budget);
});

/** Hold only notification delivery, preserving the actual producer and HTTP responses. */
function holdHistory(t:TestContext,h:Awaited<ReturnType<typeof fixture>>){
  const notices:Extract<HubEvent,{type:'history'}>[]=[],dispatch=h.page.dispatch;
  const gate=t.mock.method(h.page,'dispatch',(event:PageEvent)=>{
    if(event.type==='hub'&&event.event.type==='history')notices.push(event.event);
    else dispatch(event);
  });
  return {notices,release:()=>gate.mock.restore()};
}
const rawRemaining=(loader:HistoryStore,source:string)=>loader.getFinancial().history!.series.find(row=>row.sourceId===source&&row.windowId==='w')!.points.at(-1)![1];

for(const offset of [-5_000,0,10_000])test(`a newer independently adopted native ledger cannot qualify an older drawing for activity-only reuse: native at ${offset<0?'NOW-5000':offset===0?'NOW':'NOW+10000'}`,async t=>{
  const {h,d,record,replies,activity,published}=await warm(t);
  assert.ok(published.reply.quota?.state==='complete');const cursor=published.reply.quota.value.cellsCursor??published.reply.quota.value.tape?.cursor;assert.ok(cursor);
  const authority=h.page.get().board!.workAuthority;
  record(NOW+offset,72);
  // The server has changed, but its native SSE notification has not reached the drawing.
  await h.period.transport.read('quota',{...published.request.quota,cells:'skip',evidence:cursor,meta:''});await flush();
  const standalone=replies.find(({request,reply})=>request.quota?.cells==='skip'&&reply.quota?.state==='complete'&&reply.quota.value.tape?.cursor!==cursor);
  assert.ok(standalone?.reply.quota?.state==='complete');const newerCursor=standalone.reply.quota.value.tape!.cursor;
  const expected=offset<0?72:83;
  assert.equal(h.period.quotaAt({sourceId:h.source,windowId:'w'},NOW,'1h').remainingAtEnd,expected,'the adopted exact ledger excludes observations at or beyond the captured cutoff');
  assert.equal(rawRemaining(d.loader,h.source),83,'the actual native drawing still has its old cells');
  const lag=holdHistory(t,h);h.credit(NOW-15_000,NOW-5_000);h.events.flush();await flush();lag.release();
  const actual=lag.notices.at(-1);assert.ok(actual);
  const changes=actual.data.changes!.filter(change=>change.workOnly===true);assert.ok(changes.length);
  replies.length=0;h.requests.length=0;
  h.event({type:'history',data:{...actual.data,sources:[...new Set(changes.map(change=>change.source))],since:Math.min(...changes.map(change=>change.since)),changes}});await flush();
  assert.equal(h.page.get().board!.workAuthority,authority);
  assert.deepEqual([activity().activeMs,activity().agentMs,activity().agents],[30_000,40_000,2]);
  assert.equal(rawRemaining(d.loader,h.source),72,'the reader-local older drawing proof must cause full native fallback');
  assert.equal(h.period.quotaAt({sourceId:h.source,windowId:'w'},NOW,'1h').remainingAtEnd,expected);
  assert.ok(replies.some(({reply})=>nativeRows(reply).some(row=>row.source===h.source&&row.window==='w')));
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].quota?.cells,'activity');assert.equal(h.requests[0].quota?.cellsCursor,cursor,'the drawing offers its published proof separately from the exact ledger');assert.equal(h.requests[0].quota?.evidence,newerCursor);
  assert.notEqual(h.requests[0].quota?.cellsCursor,newerCursor);
  assert.equal(replies.length,1);assert.ok(replies[0].reply.quota?.state==='complete');
  assert.equal(replies[0].reply.quota.value.cells,undefined,'the changed native cell forces a full response, including at the cutoff and in its drawing horizon');
  const ordinaryRequest=JSON.parse(JSON.stringify({...published.request,sessions:undefined,sourceWork:undefined,quota:{...published.request.quota,from:String(NOW-H),to:String(NOW+60_000),cells:undefined,evidence:undefined,meta:''}}));
  const fresh=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,ordinaryRequest)));
  assert.equal(fresh.basis.evaluatedAt,NOW);assert.ok(fresh.quota?.state==='complete');
  const answer=expandHistory(fresh.quota.value),windows=new Set(nativeRows(fresh).map(row=>`${row.source} ${row.window}`));
  const ordinary=compose(answer.chunks,answer,targetOf(H,NOW,'1h'),windows);
  const geometry=(history:History)=>history.series.map(row=>({source:row.sourceId,window:row.windowId,points:row.points,remaining:row.remainingAtEnd}));
  assert.deepEqual(geometry(d.loader.getFinancial().history!),geometry(ordinary),'the full fallback matches an ordinary full native drawing on the same captured clock');
  const tape=fresh.quota.value.tape!;
  const accounting=new PeriodAccounting({...tape,quota:tape.quota.map(({samplesEncoding,...row})=>({...row,samples:drain(retainSamplesPrepared(row.samples,samplesEncoding==='delta'))}))},null);
  assert.equal(h.period.quotaAt({sourceId:h.source,windowId:'w'},NOW,'1h').remainingAtEnd,accounting.quotaSummary(h.source,'w',fresh.basis.range)!.remainingAtEnd,'the independent ordinary tape has the same exact endpoint value');
  h.event(actual);await flush();assert.equal(rawRemaining(d.loader,h.source),72,'late native news cannot restore the old drawing');
  assert.equal(h.pool.activeFlights,0);assert.ok(h.pool.estimatedBytes<=h.pool.budget);
});

test('legacy unconfirmed combined news refreshes native drawings and the accounting ledger',async t=>{
  const {h,d,record,replies,activity}=await warm(t),lag=holdHistory(t,h),from=NOW-15_000;
  record(from,72);h.credit(from,NOW-5_000);h.events.flush();await flush();lag.release();
  const actual=lag.notices.at(-1);assert.ok(actual);
  const changes=actual.data.changes!.filter(change=>change.source===h.source&&change.scope==='quota');
  assert.ok(changes.some(change=>change.workOnly===true));assert.ok(changes.some(change=>change.workOnly!==true));
  assert.equal(rawRemaining(d.loader,h.source),83);
  h.event({type:'history',data:{...actual.data,changes:[{source:h.source,scope:'quota',since:from,workSince:from}]}});await flush();
  assert.deepEqual([activity().activeMs,activity().agentMs,activity().agents],[30_000,40_000,2]);
  assert.equal(rawRemaining(d.loader,h.source),72);
  assert.equal(h.period.quotaAt({sourceId:h.source,windowId:'w'},NOW,'1h').remainingAtEnd,72,'an unconfirmed since === workSince must not hide native evidence');
  assert.ok(replies.some(({reply})=>nativeRows(reply).some(row=>row.source===h.source&&row.window==='w')));
  assert.equal(h.requests.length,1);
  assert.equal(h.pool.activeFlights,0);assert.ok(h.pool.estimatedBytes<=h.pool.budget);
});
