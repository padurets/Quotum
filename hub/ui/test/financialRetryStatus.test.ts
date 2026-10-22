import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,NOW,H,M} from './periodRuntimeFixture';
import {defaultFilters,workFilter} from '../../server/domain/dataFilters';
import type {PeriodRequest} from '../../server/domain/periodRead';
import {publishDataFilters} from '../lib/filterSelection';
import {ApiError} from '../lib/http';

for(const days of [1/24,30])test(`${days===30?'30d':'1h'} exact native recovery clears its actual financial consumer error`,async test=>{
 test.mock.method(Date,'now',()=>NOW);
 const h=await fixture({personal:true,fixed:true,periodName:days===30?'30d':'1h'});
 if(days===30){h.selectRange({from:NOW-30*24*H-M,to:NOW-M});await flush();}
 const d=await drawings(h,false);const transport=h.period.transport,send=transport.send;let fail=true;const attempts:PeriodRequest[]=[];let stop=()=>{};
 transport.send=async function(board:string,body:PeriodRequest,...rest:any[]){attempts.push(structuredClone(body));if(fail)throw new ApiError(503,'unavailable');return send.call(this,board,body,...rest);};
 try{
  const native=d.loader.getFinancial();assert.ok(native.history);assert.equal(native.error,undefined);
  const financial=h.period.getFinancialProjectionRevision('quota'),initial=h.period.getFinancialProjectionSnapshot('quota');assert.equal(h.period.projectionState(native.history,'quota').ready,true);
  const statuses:typeof initial[]=[];stop=h.period.subscribeProjection('quota',()=>{const next=h.period.getFinancialProjectionSnapshot('quota');if(next!==(statuses.at(-1)??initial))statuses.push(next);});
  const filters=defaultFilters();filters.projects={mode:'exclude',values:['Absent project']};publishDataFilters(filters,true);h.period.changed();d.loader.setWorkFilter(JSON.stringify([h.page.get().hubEpoch,workFilter(filters)]),filters);await flush();
  assert.equal(attempts.length,1);assert.equal(attempts[0].quota?.cells,'skip','the failed owner is exact native evidence, not the drawing transport');
  assert.equal(d.loader.getFinancial().error,undefined,'native drawing remains valid and has no local read error');
  const failed=d.renderFinancial();assert.equal(failed.error,'history_failed');assert.ok(failed.history);
  const failedStatus=h.period.getFinancialProjectionSnapshot('quota');assert.notEqual(failedStatus,initial);assert.equal(failedStatus.error,'history_failed');
  fail=false;h.period.retry();await flush();assert.equal(h.period.get().error,null);assert.equal(h.period.projectionState(native.history,'quota').error,'history_failed');
  d.loader.retry();await flush();const recovered=d.renderFinancial(),after=attempts.length;
  assert.equal(after,3);assert.ok(attempts[2].quota);assert.equal(h.period.projectionState(native.history,'quota').ready,true);assert.equal(h.period.projectionState(native.history,'quota').error,undefined);
  assert.equal(d.loader.getFinancial().error,undefined);assert.equal(h.period.getFinancialProjectionRevision('quota'),financial,'unchanged native facts legitimately preserve financial authority');
  d.loader.retry();await flush();const repeated=d.renderFinancial();assert.equal(attempts.length,after,'a recovered resource legitimately needs no second HTTP');
  assert.equal(recovered.error,undefined,'a successful quota retry must clear the actual financial hook, not retain its stale cached error');
  assert.equal(repeated.error,undefined);
  const recoveredStatus=h.period.getFinancialProjectionSnapshot('quota');assert.notEqual(recoveredStatus,failedStatus);assert.equal(recoveredStatus.error,undefined);assert.equal(recoveredStatus.ready,true);assert.equal(h.period.getFinancialProjectionSnapshot('quota'),recoveredStatus,'unchanged status is a stable subscription snapshot');
  assert.ok(statuses.includes(failedStatus),'the subscription observes the failure without a numeric revision');assert.equal(statuses.at(-1),recoveredStatus,'the subscription also observes successful recovery');
 }finally{stop();d.close();await h.close();publishDataFilters(null,false);}
});
