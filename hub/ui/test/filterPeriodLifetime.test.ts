import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,H} from './periodRuntimeFixture';
import {defaultFilters,workFilter} from '../../server/domain/dataFilters';
import {publishDataFilters} from '../lib/filterSelection';
import {lineWork,workText} from '../lib/work';
import {workHours} from '../lib/format';
import {HISTORY_BYTES_PER_MEASUREMENT} from '../../bench/budget';
import {PeriodAccounting} from '../../server/domain/periodAccounting';
import {expandPeriod} from '../../server/domain/periodWire';
import {moneyWorkValues} from '../lib/moneyTable';
import type {MeterHistory} from '../../server/domain/meterHistory';

test('an open filter shares one full raw extraction with incremental sessions and source work',async t=>{
  t.mock.method(Date,'now',()=>NOW);publishDataFilters(defaultFilters());const h=await fixture();
  let stop:undefined|(()=>void);
  try{
    stop=h.period.demandFacets();await flush();h.requests.length=0;
    const ranges:[number,number][]=[];const original=h.store.agentWork.bind(h.store);
    t.mock.method(h.store,'agentWork',(...args:Parameters<typeof original>)=>{ranges.push([args[0],args[1]]);return original(...args);});
    h.store.creditWork(h.device,NOW-120_000,NOW-60_000,[{source:h.source,client:'codex',origin:'terminal',project:'New project',folder:'',startedAt:NOW-120_000,identity:{kind:'stable',sessionId:'new-project'}}]);
    h.events.flush();await flush();
    assert.equal(h.requests.length,1,'the production coordinator coalesces work consumers');
    const request=h.requests[0];assert.ok(request.sessions?.cursor);assert.ok(request.sourceWork?.cursor);assert.equal(request.facets,true);
    assert.deepEqual(ranges,[[NOW-H,NOW]],'the raw ledger is extracted once for the complete consumer range');
    assert.deepEqual(h.period.getFacets().value?.projects,['New project','Work project']);
    assert.ok(h.period.get().rows.some((row:{project:string|null})=>row.project==='New project'));
    assert.ok(h.pool.estimatedBytes<h.pool.budget);assert.equal(h.pool.activeFlights,0);
  }finally{stop?.();publishDataFilters(null,false);await h.close();}
});

test('a late fixed source-wide reply leaves selected quota hours pending until the current predicate completes',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({fixed:true});
  try{
    const a=defaultFilters();a.projects={mode:'include',values:['Work project']};const gate=h.hold();publishDataFilters(a);h.period.changed();await flush();
    assert.ok(h.requests.at(-1)?.quota);assert.ok(h.requests.at(-1)?.sessions);
    const b=defaultFilters();b.projects={mode:'include',values:[]};publishDataFilters(b);h.period.changed();await flush();gate.release();await flush();
    assert.equal(h.period.get().rows.length,0);assert.equal(h.pool.activeFlights,0);
    assert.ok(h.requests.some(request=>request.quota&&request.workFilter?.projects.mode==='include'&&!request.workFilter.projects.values.length));
    const selected=h.period.tapes.get('quota').tape.fixed.quota.map((row:any)=>row.selectedWork);
    assert.ok(selected.length);assert.ok(selected.every((work:any)=>work?.ms===0&&work.agentMs===0),JSON.stringify(selected));
  }finally{publishDataFilters(null,false);await h.close();}
});

test('a late fixed wallet reply preserves supplier estimates and reads confirmed empty selected hours',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({fixed:true,personal:true});
  try{
    const source=h.store.source('openrouter','wallet-filter',NOW-3*H);h.store.hold(source,h.alice.id,NOW-3*H);
    const meter=(id:string,at:number,amount:string)=>({id,at,amount,kind:'counter' as const,unit:'USD',stale:false,staleAfterMs:2*H,limit:null,resetAt:null,minutes:null,scope:null,label:null});
    for(const [at,amount] of [[NOW-H,'0'],[NOW-1,'1000000']] as const)h.store.record(source,{type:'meters',observedAt:at,staleAfterMs:2*H,meters:[meter('usage',at,amount),meter('credits',at,'15000000')],keys:[],inventoryComplete:true,inventoryError:null});
    h.store.creditWork(h.device,NOW-H,NOW-1,[{source,client:'opencode',origin:'terminal',project:'Wallet project',folder:'',startedAt:NOW-H,identity:{kind:'stable',sessionId:'wallet-context'}}]);h.events.flush();await flush();
    const queries=h.period.queries.bind(h.period);
    h.period.queries=(board:any,range:any)=>({...queries(board,range),budget:{cell:'60000',from:String(range.from),to:String(range.to),unit:'USD',meters:JSON.stringify([[source,'balance']]),cells:'skip',work:'1'}});
    publishDataFilters(defaultFilters());h.period.changed();await flush();h.requests.length=0;
    const a=defaultFilters();a.projects={mode:'include',values:['Wallet project']};const gate=h.hold();publishDataFilters(a);h.period.changed();await flush();
    const b=defaultFilters();b.projects={mode:'include',values:[]};publishDataFilters(b);h.period.changed();await flush();gate.release();await flush();
    assert.equal(h.pool.activeFlights,0);assert.equal(h.period.get().rows.length,0);
    const current=h.requests.find(request=>request.budget&&request.workFilter?.projects.mode==='include'&&!request.workFilter.projects.values.length);assert.ok(current,'the current predicate must complete fixed wallet hours');
    const expected=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,current)));
    assert.equal(expected.budget?.state,'complete');if(expected.budget?.state!=='complete')throw new Error('missing budget');
    const fixed=expected.budget.value.tape?.fixed;assert.ok(fixed?.moneyWork);
    const expectedWork=fixed.moneyWork.find(row=>row.source===source);
    const actual=h.period.moneyWorkAt(source,NOW,h.period.workRangeKey),series={sourceId:source,meterId:'balance',kind:'balance',role:'total',unit:'USD',end:'14000000'} as MeterHistory;
    assert.deepEqual(moneyWorkValues(series,actual),moneyWorkValues(series,expectedWork));
    assert.equal(moneyWorkValues(series,actual).active,'0');assert.equal(moneyWorkValues(series,actual).rate,'1000000');
  }finally{publishDataFilters(null,false);await h.close();}
});

test('a shifted retained fixed period never restores rows from a previous work predicate',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({fixed:true});
  try{
    publishDataFilters(defaultFilters());h.period.changed();await flush();assert.equal(h.period.get().rows.length,1);
    const empty=defaultFilters();empty.projects={mode:'include',values:[]};publishDataFilters(empty);h.period.changed();await flush();assert.equal(h.period.get().rows.length,0);
    h.selectRange({from:NOW-3_600_000-1,to:NOW-1});assert.equal(h.period.get().rows.length,0);await flush();assert.equal(h.period.get().rows.length,0);
    assert.ok(h.requests.at(-1)?.workFilter);assert.deepEqual(h.requests.at(-1)?.workFilter?.projects,empty.projects);
  }finally{publishDataFilters(null,false);await h.close();}
});

test('revocation retires cached facets while closed and reopening reads the authorized universe',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();
  try{
    const stop=h.period.demandFacets();await flush();assert.ok(h.period.getFacets().value.projects.includes('Work project'));stop();h.requests.length=0;
    let published=0;const unlisten=h.period.subscribeFacets(()=>{published++;});h.remove();
    assert.equal(h.period.getFacets().value,null);assert.ok(published>0);await flush();
    assert.ok(h.requests.every(request=>!request.facets));const close=h.period.demandFacets();await flush();
    assert.deepEqual(h.period.getFacets().value.projects,[]);close();unlisten();
  }finally{await h.close();}
});

test('authorized absent choices follow the current predicate and late replies cannot restore revoked labels',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();let stop:undefined|(()=>void);
  try{
    h.store.creditWork(h.device,NOW-120_000,NOW-60_000,[{source:h.source,client:'codex',origin:'terminal',project:'Other project',folder:'',startedAt:NOW-120_000,identity:{kind:'stable',sessionId:'other-absent-choice'}}]);h.events.flush();await flush();
    h.selectRange({from:NOW-3*H,to:NOW-2*H});const filters=defaultFilters();filters.projects={mode:'exclude',values:['Other project','Work project']};publishDataFilters(filters);h.period.changed();await flush();
    h.requests.length=0;stop=h.period.demandFacets();await flush();assert.equal(h.requests.length,1);assert.equal(h.requests[0].sessions,undefined,'first opening follows a settled baseline');assert.deepEqual(h.requests[0].workFilter?.projects,filters.projects);
    assert.deepEqual(h.period.getFacets().value.projects,[]);assert.deepEqual(h.period.getFacets().value.retained.projects,filters.projects.values);
    const partial=defaultFilters();partial.projects={mode:'exclude',values:['Other project']};publishDataFilters(partial);h.period.changed();await flush();
    assert.deepEqual(h.period.getFacets().value.retained.projects,['Other project'],'restoring one absent choice preserves the other exclusion');
    stop!();h.requests.length=0;publishDataFilters(defaultFilters());h.period.changed();await flush();assert.ok(h.requests.every(request=>!request.facets),'closed controls never read for changed explicit choices');
    stop=h.period.demandFacets();await flush();assert.equal(h.period.getFacets().value.retained,undefined,'the same fixed range revalidates its explicit choice metadata');
    publishDataFilters(filters);h.period.changed();await flush();assert.deepEqual(h.period.getFacets().value.retained.projects,filters.projects.values);
    const gate=h.hold();h.store.creditWork(h.device,NOW-10*60_000,NOW-9*60_000,[{source:h.source,client:'codex',origin:'terminal',project:'New live work',folder:'',startedAt:NOW-10*60_000,identity:{kind:'stable',sessionId:'facet-receipt'}}]);h.events.flush();await flush();
    h.remove();assert.equal(h.period.getFacets().value,null);gate.release();await flush();
    assert.equal(JSON.stringify(h.period.getFacets().value).includes('Work project'),false);
  }finally{stop?.();publishDataFilters(null,false);await h.close();}
});

test('closed facet controls invalidate ordinary work changes and fetch the new choices only when reopened',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();
  try{
    const stop=h.period.demandFacets();await flush();assert.deepEqual(h.period.getFacets().value.projects,['Work project']);stop();h.requests.length=0;
    const authority=h.page.get().board!.workAuthority;assert.ok(authority);
    h.store.creditWork(h.device,NOW-120000,NOW-60000,[{source:h.source,client:'opencode',origin:'terminal',project:'New project while closed',folder:'',startedAt:NOW-120000,identity:{kind:'stable',sessionId:'new-facet-project'}}]);h.events.flush();await flush();
    assert.equal(h.page.get().board!.workAuthority,authority);assert.ok(h.period.get().rows.some((row:any)=>row.project==='New project while closed'));
    assert.equal(h.requests.filter(request=>request.facets).length,0,'closed controls do not add reads');
    const close=h.period.demandFacets();await flush();assert.deepEqual(h.period.getFacets().value.projects,['New project while closed','Work project']);assert.ok(h.period.getFacets().value.clients.includes('opencode'));close();
    const reads=h.requests.filter(request=>request.facets).length,again=h.period.demandFacets();await flush();assert.equal(h.requests.filter(request=>request.facets).length,reads,'the same facts and evaluated range reuse their cache');again();
  }finally{await h.close();}
});

test('a late facet reply cannot acknowledge changes received after its last consumer closed',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();
  try{
    const gate=h.hold(),stop=h.period.demandFacets();await flush();const old=h.period.intent();stop();
    h.event({type:'sessions',data:{source:h.source,sessions:[]}} as any);assert.equal(h.period.intent().revision,old.revision,'closed invalidation leaves unrelated work flights alone');
    gate.release();await flush();assert.equal(h.period.getFacets().value,null,'an older receipt is not a current cached universe');
    const reads=h.requests.filter(request=>request.facets).length,close=h.period.demandFacets();await flush();assert.ok(h.period.getFacets().value.projects.includes('Work project'));assert.equal(h.requests.filter(request=>request.facets).length,reads+1);close();
  }finally{await h.close();}
});

test('reopening live facets rechecks the moving range without a timer or a closed-menu read',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({periodName:'1h'});
  try{
    const stop=h.period.demandFacets();await flush();stop();h.requests.length=0;
    now=NOW+59*60_000;h.advance(now);await flush();assert.equal(h.requests.filter(request=>request.facets).length,0);
    const close=h.period.demandFacets();await flush();assert.deepEqual(h.period.getFacets().value.projects,[]);assert.equal(h.requests.filter(request=>request.facets).length,1);close();
  }finally{await h.close();}
});

test('facets are charged before adoption and retained in the same history pool',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();let pinned=0;
  try{
    const baseline=h.pool.estimatedBytes,intent=h.period.intent(),basis=h.period.get().basis;
    const value={projects:Array.from({length:10000},(_,i)=>`${i}`.padStart(100,'p')),devices:[],clients:[],funding:[]};
    await h.period.receive({basis,facets:{state:'complete',basis,value}},intent);
    assert.equal(h.period.getFacets().value,value);assert.ok(h.pool.estimatedBytes>baseline+3_000_000);
    pinned=h.pool.budget-h.pool.estimatedBytes-1024;h.pool.register({get estimatedBytes(){return pinned;},evictionCandidates:()=>[]});
    await h.period.receive({basis,facets:{state:'complete',basis,value:{...value,projects:[...value.projects,'another']}}},intent);
    assert.equal(h.period.getFacets().value,null);assert.equal(h.period.getFacets().error,'history_limit');assert.ok(h.pool.estimatedBytes<=h.pool.budget);
  }finally{pinned=0;await h.close();}
});

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
