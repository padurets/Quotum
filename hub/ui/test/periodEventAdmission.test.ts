import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
const total=(h:any)=>h.period.calendar.get().value?.cells.reduce((sum:number,cell:any)=>sum+(cell.agentMs??0),0)??null;
for(const kind of ['after','at','before'] as const)test(`actual historical calendar work notification ${kind} the exclusive endpoint`,async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({heatmap:true,periodName:'3h',creditFrom:NOW-2*H+M,creditTo:NOW-2*H+2*M});t.after(()=>h.close());
 const range={from:NOW-2*H,to:NOW-H};h.selectRange(range);await flush();
 const prior=total(h),authority=h.page.get().board!.workAuthority;h.requests.length=0;h.frames.length=0;
 const from=kind==='after'?NOW-M:kind==='at'?range.to:range.to-2*M,to=from+M;
 h.credit(from,to);h.events.flush();await flush();
 const reads=h.requests.map((r:any)=>({calendar:!!r.calendar,sessions:!!r.sessions,values:r.values?.length??0,sections:['quota','budget','funds'].filter(name=>r[name])}));
 const events=h.frames.filter(f=>f.type==='history').map(f=>JSON.parse(f.data));
 const calendarReads=reads.filter(r=>r.calendar).length;
 assert.ok(events.length,'the real producer delivered a newly credited history event');
 assert.equal(authority,h.page.get().board!.workAuthority);
 if(kind==='before'){assert.ok(calendarReads>0,'relevant newly registered work must refresh');assert.ok(total(h)!>prior!,'relevant evidence must reach the calendar');}
 else {assert.equal(total(h),prior,'outside work must not change the selected integral');assert.equal(calendarReads,0,'work entirely at or after selected.to must not read historical calendar');}
});
test('actual hard authority retirement rejects the held earlier calendar generation',async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({heatmap:true,periodName:'3h',creditFrom:NOW-2*H+M,creditTo:NOW-2*H+2*M});t.after(()=>h.close());
 const range={from:NOW-2*H,to:NOW-H};h.selectRange(range);await flush();
 h.credit(range.to-4*M,range.to-3*M);h.events.flush();await flush();assert.ok(total(h)!>0);
 const held=h.hold();h.credit(range.to-2*M,range.to-M);h.events.flush();await flush();
 const generation=h.period.calendar.generation;h.remove();assert.equal(h.period.calendar.get().value,null,'hard authority retires synchronously');assert.ok(h.period.calendar.generation>generation);
 held.release();await flush();assert.ok(total(h)===null||total(h)===0,'late old facts do not revive the revoked device');

});

test('a changed work authority retires and rereads history independently of its notification timestamp',async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({heatmap:true,periodName:'3h',creditFrom:NOW-2*H+M,creditTo:NOW-2*H+2*M});t.after(()=>h.close());
 h.selectRange({from:NOW-2*H,to:NOW-H});await flush();assert.ok(h.period.get().rows.length);
 const old=h.page.get().board!.workAuthority;h.disconnect();h.remove();
 const authority=h.store.workKey(h.board,h.store.authorizedSources(h.board));assert.notEqual(authority,old);
 const gate=h.hold();h.requests.length=0;
 h.event({type:'history',data:{sources:[],since:NOW-M,workSince:NOW-M,workAuthority:authority}});
 assert.equal(h.period.get().rows.length,0);assert.equal(h.period.calendar.get().value,null);
 await flush();assert.ok(h.requests.some(r=>r.sessions),'timestamp filtering cannot leave a new authority without a replacement');
 gate.release();await flush();assert.equal(h.period.get().rows.length,0);
});

const stats=(h:any)=>({retained:h.period.retained.size,valueCache:h.period.valueCache.size,proofEpoch:h.period.proofEpoch,workAuthority:h.page.get().board!.workAuthority});
for(const heatmap of [false,true])for(const future of [false,true])test(`cached A-B-A ${heatmap?'actual calendar enabled':'actual calendar disabled'} ${future?'future work':'untouched'}`,async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({heatmap,periodName:'3h',creditFrom:NOW-2*H+M,creditTo:NOW-2*H+2*M});t.after(()=>h.close());
 const A={from:NOW-2*H,to:NOW-H},B={from:NOW-3*H,to:NOW-2*H};
 h.selectRange(A);await flush();const evidenceA=JSON.stringify(h.period.get().value),rowsA=JSON.stringify(h.period.get().rows),valueA=JSON.stringify(h.period.getValue(h.source).value);
 h.selectRange(B);await flush();const before=stats(h);assert.ok(before.retained>0);
 h.requests.length=0;h.frames.length=0;
 if(future){h.credit(NOW-M,NOW);h.events.flush();await flush();}
 const afterEvent=stats(h),eventReads=h.requests.map((r:any)=>({calendar:!!r.calendar,sessions:!!r.sessions,values:r.values?.length??0,sections:['quota','budget','funds'].filter(name=>r[name])}));
 h.requests.length=0;h.selectRange(A);await flush();
 const returnReads=h.requests.map((r:any)=>({calendar:!!r.calendar,sessions:!!r.sessions,values:r.values?.length??0,sections:['quota','budget','funds'].filter(name=>r[name])}));
 assert.equal(afterEvent.workAuthority,before.workAuthority);
 assert.equal(afterEvent.proofEpoch,before.proofEpoch,'future work cannot invalidate the selected proof');
 assert.equal(JSON.stringify(h.period.get().rows),rowsA,'selected work facts stay identical');
 assert.equal(JSON.stringify(h.period.getValue(h.source).value),valueA,'historical value facts stay identical');
 assert.equal(JSON.stringify(h.period.get().value),evidenceA,'the exact complete work evidence is restored');
 assert.equal(eventReads.length,0,'the unrelated event does not itself require another admitted reader');
 assert.equal(returnReads.length,0,'future work cannot discard complete historical A evidence');
});

for(const heatmap of [false,true])test(`a cached later target is invalidated independently of the active earlier range, calendar ${heatmap}`,async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const h=await fixture({heatmap,periodName:'3h',creditFrom:NOW-3*H+M,creditTo:NOW-3*H+2*M});t.after(()=>h.close());
 const A={from:NOW-2*H,to:NOW-H},B={from:NOW-3*H,to:NOW-2*H};
 h.selectRange(A);await flush();assert.equal(h.period.get().rows.length,0);
 h.selectRange(B);await flush();h.requests.length=0;
 h.credit(A.from+M,A.from+2*M);h.events.flush();await flush();
 assert.equal(h.requests.length,0,'new work after active B does not read B');
 h.selectRange(A);await flush();assert.ok(h.requests.length>0,'cached A cannot reuse facts changed within A');
 assert.equal(h.period.get().rows.reduce((sum:number,row:any)=>sum+row.workedMs,0),M);
 if(heatmap)assert.equal(total(h),M);
 h.selectRange(B);await flush();h.requests.length=0;
 h.selectRange(A);await flush();assert.equal(h.requests.length,0,'the complete replacement can itself be retained and restored');
});
