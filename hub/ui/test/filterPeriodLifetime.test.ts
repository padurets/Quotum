import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW} from './periodRuntimeFixture';
import {defaultFilters,workFilter} from '../../server/domain/dataFilters';
import {publishDataFilters} from '../lib/filterSelection';
import {lineWork,workText} from '../lib/work';
import {workHours} from '../lib/format';
import {HISTORY_BYTES_PER_MEASUREMENT} from '../../bench/budget';
import {PeriodAccounting} from '../../server/domain/periodAccounting';

test('changing filters while the selected baseline waits retires each generation and retains supplier evidence',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();
  try{
    const a=defaultFilters();a.projects={mode:'include',values:['Work project']};
    const first=h.hold();publishDataFilters(a);h.period.changed();await flush();
    assert.equal(h.period.get().loading,true);
    const b=defaultFilters();b.projects={mode:'include',values:[]};
    publishDataFilters(b);h.period.changed();await flush();
    first.release();await flush();
    assert.equal(h.period.get().rows.length,0);assert.equal(h.period.get().error,null);
    assert.deepEqual(h.requests.at(-1)?.workFilter,workFilter(b));
    assert.ok(h.requests.filter(request=>request.quota?.evidence!=='skip'&&request.quota).length<=1,'a work-filter edit reuses its supplier baseline');
    publishDataFilters(a);h.period.changed();await flush();
    assert.equal(h.period.get().rows.length,1);assert.equal(h.pool.activeFlights,0);
  }finally{publishDataFilters(null,false);await h.close();}
});

test('an inherited oversized work selection keeps unfiltered recovery facets and never sends an oversized predicate',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();
  try{
    const large=defaultFilters();large.projects={mode:'include',values:Array.from({length:1600},(_,i)=>String(i).padStart(4,'0')+'x'.repeat(60))};
    publishDataFilters(large);h.period.changed();const stop=h.period.demandFacets();await flush();
    assert.equal(h.period.get().error,'filters_limit');
    assert.ok(h.requests.every(request=>new TextEncoder().encode(JSON.stringify(request)).byteLength<=76*1024));
    assert.ok(h.requests.every(request=>!request.sessions&&!request.workFilter));
    assert.ok(h.period.getFacets().value?.projects.includes('Work project'),'recovery choices use the unfiltered authorized universe');
    stop();publishDataFilters(defaultFilters());h.period.changed();await flush();
    assert.equal(h.period.get().error,null);assert.equal(h.period.get().rows.length,1);
  }finally{publishDataFilters(null,false);await h.close();}
});

test('a source-work error retires supplier estimates while selected direct hours remain available',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();
  try{
    publishDataFilters(defaultFilters());h.period.changed();await flush();
    const tape=h.period.tapes.get('quota'),window=tape.tape.quota[0].window;
    const read=()=>h.period.quotaAt({sourceId:h.source,windowId:window},NOW,'1h');
    assert.ok(read().work.ms>0);const selected=read().selectedWork.ms,sourceBaseline=h.period.sourceTape;
    const intent=h.period.intent();
    await h.period.receive({basis:h.period.get().basis,sourceWork:{state:'error',error:'unavailable'}},intent);
    assert.equal(read().work,null);assert.equal(read().selectedWork.ms,selected);
    const line=read(),cells=lineWork({...line,current:line.remainingAtEnd,minutes:60},false,null,NOW)!;
    assert.deepEqual(cells.work,{value:selected});assert.deepEqual(cells.perwork,{none:'unknown'});
    assert.equal(workText('work',cells.work,line.work,NOW-3_600_000,null,null,line.selectedWork).content,workHours(selected));
    assert.equal(h.period.get().error,null);
    await h.period.receive({basis:h.period.get().basis,sourceWork:{state:'complete',basis:h.period.get().basis,value:sourceBaseline}},intent);
    assert.ok(read().work.ms>0,'recovering identical evidence rebuilds estimates retired by the error');
  }finally{publishDataFilters(null,false);await h.close();}
});

test('live source deltas stay small on a board with many known empty resources',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({personal:true});
  try{
    for(let i=0;i<80;i++){const source=h.store.source('codex',String(i).padStart(24,'0'),NOW-7_200_000);h.store.hold(source,h.alice.id,NOW-7_200_000);}
    const quota={from:String(NOW-3_600_000),to:String(NOW),cell:'60000',cells:'skip',meta:''};
    const request={version:1,selection:{mode:'live',periodMs:3_600_000},evaluatedAt:NOW,quota,sessions:{},sourceWork:{},workFilter:workFilter(defaultFilters())};
    const baseline=JSON.parse(h.reader.read(h.board,h.alice.id,request));
    assert.ok(baseline.sourceWork.value.sources.length>80);
    h.reader.touch(h.source,NOW-60_000,['quota'],true);
    const json=h.reader.read(h.board,h.alice.id,{...request,quota:{...quota,evidence:baseline.quota.value.tape.cursor,meta:baseline.quota.value.meta??''},sessions:{cursor:baseline.sessions.value.cursor},sourceWork:{cursor:baseline.sourceWork.value.cursor}});
    const delta=JSON.parse(json);
    assert.equal(delta.sourceWork.state,'delta');assert.equal(delta.sourceWork.value.sources.length,0);
    assert.ok(Buffer.byteLength(json)+512<HISTORY_BYTES_PER_MEASUREMENT,`${Buffer.byteLength(json)} bytes before HTTP headers: ${JSON.stringify(Object.fromEntries(Object.entries(delta).map(([key,value])=>[key,JSON.stringify(value).length])))}`);
    const narrowed=JSON.parse(h.reader.read(h.board,h.alice.id,{...request,quota:{...quota,sources:JSON.stringify([h.source]),evidence:delta.quota.value.tape.cursor},sourceWork:{cursor:delta.sourceWork.value.cursor}}));
    assert.equal(narrowed.sourceWork.state,'delta','independent resource selections must not replace the shared source cursor with another cohort');
  }finally{publishDataFilters(null,false);await h.close();}
});

test('an unchanged source sweep never wakes the budget table projection',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();
  try{
    publishDataFilters(defaultFilters());h.period.changed();await flush();
    const old=h.period.tapes.get('quota'),source=h.period.sourceTape;
    const reading={id:'usage',at:NOW-60_000,kind:'counter',unit:'USD',amount:'1000000',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:3_600_000};
    const tape={...old.tape,quota:[],money:[{source:h.source,meter:'balance',readings:[{...reading,id:'balance',kind:'balance'}],spans:[],workCounter:{source:h.source,unit:'USD',knownFrom:NOW-3_600_000,readings:[reading],spans:[]}}]};
    h.period.tapes.set('budget',{...old,tape,accounting:new PeriodAccounting(tape as any,h.period.work.value)});
    const revision=h.period.getProjectionRevision('budget');
    await h.period.receive({basis:h.period.get().basis,sourceWork:{state:'delta',basis:h.period.get().basis,value:{...source,patterns:[],sources:[],replaceFrom:source.cut,replaceTo:source.cut}}},h.period.intent());
    assert.equal(h.period.getProjectionRevision('budget'),revision);
  }finally{publishDataFilters(null,false);await h.close();}
});

test('fixed wallet estimates survive a missing selected baseline and retire with supplier evidence',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({fixed:true});
  try{
    publishDataFilters(defaultFilters());h.period.changed();await flush();
    const old=h.period.tapes.get('quota'),work={source:h.source,unit:'USD',activeMs:3_600_000,agentMs:3_600_000,spent:'1000000',duringWork:'1000000',eligibleActiveMs:3_600_000,eligibleAgentMs:3_600_000,coveredMs:3_600_000,knownFrom:NOW-3_600_000,partial:false,estimate:true,selectedWork:{from:NOW-3_600_000,activeMs:null,agentMs:0}};
    const tape={...old.tape,quota:[],money:[],fixed:{...old.tape.fixed,moneyWork:[work]}};
    h.period.tapes.set('budget',{...old,tape,accounting:new PeriodAccounting(tape,null)});
    h.period.work={value:null,basis:null,loading:false,error:'unavailable'};h.period.workRangeKey='unavailable';
    const value=h.period.moneyWorkAt(h.source,NOW,old.rangeKey);
    assert.equal(value.eligibleActiveMs,3_600_000);assert.equal(value.selectedWork.activeMs,null);
    const financial=h.period.getFinancialProjectionRevision('budget');h.period.retireWork();
    assert.equal(h.period.moneyWorkAt(h.source,NOW,old.rangeKey),undefined,'an evidence reset retires old estimates even when the access authority did not change');
    assert.equal(h.period.getFinancialProjectionRevision('budget'),financial);
  }finally{publishDataFilters(null,false);await h.close();}
});
