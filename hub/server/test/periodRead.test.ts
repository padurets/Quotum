import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {buildApp,type Hub} from '../api.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';
import {newSecret} from '../domain/auth.js';
import type {PeriodReply,PeriodRequest} from '../domain/periodRead.js';
import {mergeTape,type PeriodTape} from '../domain/periodTape.js';
import {mergeWork,workedSessions} from '../domain/periodWork.js';
import {deepSeekMeasurement} from '../connectors/deepseek.js';
import {periodValues,nearbyPeriodValues} from '../periodValues.js';
import {periodValueAt,hasPeriodValue,withValueStates} from '../domain/periodValues.js';
import {HistoryLimit,HistoryTiles} from '../history.js';
import {PeriodReader,periodInputBytes} from '../periodRead.js';
import {Events} from '../events.js';
import {sharedWork} from '../periodWork.js';
import {expandPeriod,type PeriodWireReply} from '../domain/periodWire.js';
import {HISTORY_BYTES_PER_MEASUREMENT} from '../../bench/budget.js';
import {PeriodAccounting} from '../domain/periodAccounting.js';
import {shifted,canShift} from '../domain/periodShift.js';
import {expandHistory,type HistoryBasis} from '../domain/history.js';
import {transaction} from '../touches.js';
import {defaultFilters,workFilter} from '../domain/dataFilters.js';
import {PeriodCurves,sourceWorkCurves} from '../domain/periodCurves.js';

const M=60_000,H=60*M,now=1_800_000_000_000;

test('project selection precedes live and fixed union, facets and cursor-bound details',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const start=now-2*H;
  for(const [project,from,to] of [['A',0,60],['B',30,90],['C',75,120]] as const)h.store.creditWork(h.device,start+from*M,start+to*M,[{source:h.source,client:'opencode',origin:'terminal',startedAt:start,project,folder:'',identity:{kind:'stable',sessionId:project}}]);
  const filters=defaultFilters();filters.projects={mode:'include',values:['A','B']};
  const predicate=workFilter(filters),selection={mode:'live' as const,periodMs:2*H};
  const quota={cell:String(M),from:String(start),to:String(now),cells:'skip'};
  let reads=0;const original=h.store.agentWork.bind(h.store);t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{reads++;return original(...args);});
  const result=await h.read({version:1,selection,evaluatedAt:now,sessions:{},workFilter:predicate,facets:true,quota,sourceWork:{}});
  assert.equal(result.statusCode,200,result.body);const live=result.json<PeriodReply>();
  if(live.sessions?.state!=='complete'||live.facets?.state!=='complete'||live.sourceWork?.state!=='complete')throw new Error('incomplete selected period');
  assert.equal(reads,1,'selected work, source estimates and facets share one raw extraction');
  const rows=workedSessions(live.sessions.value,live.basis.range,now);assert.deepEqual(rows.map(row=>row.project),['A','B']);
  assert.equal(rows.reduce((sum,row)=>sum+row.workedMs,0),120*M);
  assert.equal(new PeriodCurves(live.sessions.value).all.read(live.basis.range,true),90*M);
  assert.deepEqual(live.facets.value.projects,['A','B','C'],'facets do not consume the selected cohort');
  assert.deepEqual(live.facets.value.funding,[],'a board with only disclosed work has no neutral funding choices');
  const source=sourceWorkCurves(live.sourceWork.value).groups.source.get(h.source)!;
  assert.equal(source.read(live.basis.range,true),120*M);assert.equal(source.read(live.basis.range),165*M);
  assert.equal(JSON.stringify(live.sourceWork.value).includes('"project"'),false);
  const fixed=(await h.read({version:1,selection:{mode:'range',from:start,to:now},evaluatedAt:now,sessions:{},workFilter:predicate})).json<PeriodReply>();
  if(fixed.sessions?.state!=='complete')throw new Error('incomplete fixed period');
  assert.equal(fixed.sessions.value.spans.length,0);assert.equal(fixed.sessions.value.packed,undefined);
  assert.equal(fixed.sessions.value.fixed?.activity.activeMs,90*M);assert.equal(fixed.sessions.value.fixed?.activity.agentMs,120*M);
  const detail={version:1,selection,evaluatedAt:now,cursor:live.sessions.value.cursor,refs:rows.map(row=>row.ref),workFilter:predicate};
  const matching=await h.details(detail);assert.equal(matching.statusCode,200,matching.body);assert.equal(matching.json().sessions.value.length,2);
  filters.projects={mode:'include',values:['C']};
  assert.equal((await h.details({...detail,workFilter:workFilter(filters)})).statusCode,400);
  const other=(await h.read({version:1,selection,evaluatedAt:now,sessions:{cursor:live.sessions.value.cursor},workFilter:workFilter(filters)})).json<PeriodReply>();
  assert.equal(other.sessions?.state,'complete','a changed predicate never produces a delta for an old cohort');
  filters.projects={mode:'include',values:[]};
  const empty=(await h.read({version:1,selection,evaluatedAt:now,sessions:{},workFilter:workFilter(filters),quota,sourceWork:{}})).json<PeriodReply>();
  if(empty.sessions?.state!=='complete'||empty.sourceWork?.state!=='complete')throw new Error('incomplete empty period');
  assert.equal(empty.sessions.value.refs.length,0);assert.notEqual(empty.sessions.value.available,false);
  assert.equal(sourceWorkCurves(empty.sourceWork.value).groups.source.get(h.source)!.read(empty.basis.range,true),120*M);
});
async function fixture(start=now-3*H) {
  const store=new Store(':memory:',start),directory=new Directory(store.db);
  const user=directory.createUser('a@example.com','A','unused',start),board=directory.boards(user.id)[0].id;
  const token=newSecret('qt_s');directory.createSession(token,user.id,Date.now(),24*H);
  const source=store.source('codex','a'.repeat(24),start);store.hold(source,user.id,start);
  const device=directory.saveDevice({userId:user.id,machine:{id:'machine-0123456789',name:'Laptop',os:'linux',arch:'x86_64'},agent:'quotum/0.6.0',tokenId:null},start).id;
  const hub:Hub={store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null};
  const app=await buildApp(hub);
  const read=(body:PeriodRequest,asBoard=board)=>app.inject({method:'POST',url:`/api/boards/${asBoard}/period`,headers:{origin:'http://localhost',cookie:`quotum_session=${token}`},payload:body});
  const credit=(from:number,to:number,id='stable')=>store.creditWork(device,from,to,[{source,origin:'terminal',startedAt:start,project:'Project',folder:'folder',identity:{kind:'stable',sessionId:id}}]);
  const details=(body:unknown)=>app.inject({method:'POST',url:`/api/boards/${board}/period/sessions`,headers:{origin:'http://localhost',cookie:`quotum_session=${token}`},payload:body as object});
  return {store,directory,hub,app,user,board,source,device,read,credit,details};
}

test('period cells and baseline tapes borrow only matching captured metadata',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  h.store.record(h.source,{observedAt:now-3*M,plan:'pro',resets:null,staleAfterMs:H,windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used:25,remaining:75,resetAt:now+H}]});
  h.credit(now-2*M,now-M);
  const body:PeriodRequest={version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,quota:{cell:String(M),from:String(now-4*M),to:String(now),meta:'',evidence:'skip'}};
  const seed=await h.read(body);assert.equal(seed.statusCode,200,seed.body);
  const initial=expandPeriod(seed.json<PeriodWireReply>()).quota!;
  if(initial.state!=='complete'||!('known' in initial.value))throw new Error('missing full metadata');
  const prior:HistoryBasis={run:initial.value.run,now:initial.value.now,historyStart:initial.value.historyStart,known:initial.value.known,meta:initial.value.meta};
  const retained=JSON.stringify(prior),request={...body,quota:{...body.quota!,meta:prior.meta}};
  const response=await h.read(request);assert.equal(response.statusCode,200,response.body);
  const restored=expandPeriod(response.json<PeriodWireReply>());
  if(restored.quota?.state!=='complete')throw new Error('missing quota');
  assert.deepEqual(expandHistory(restored.quota.value,prior).chunks,initial.value.chunks);
  assert.equal(JSON.stringify(prior),retained,'decoding cannot mutate retained metadata');
  assert.equal((await h.read(request)).body,response.body,'reading cannot change cached server cells');
  const baseline:PeriodRequest={...body,selection:{mode:'range',from:now-H,to:now},quota:{...body.quota!,cells:'skip',evidence:undefined,meta:''}};
  const full=(await h.read(baseline)).json<PeriodReply>(),compactResponse=await h.read({...baseline,quota:{...baseline.quota!,meta:prior.meta}});
  assert.equal(compactResponse.statusCode,200,compactResponse.body);
  const compact=compactResponse.json<PeriodReply>();
  if(full.quota?.state!=='complete'||compact.quota?.state!=='complete')throw new Error('missing baseline');
  assert.ok('known' in full.quota.value);assert.equal('known' in compact.quota.value,false);
  assert.deepEqual(expandHistory(compact.quota.value,prior),expandHistory(full.quota.value),'baseline tapes and all native facts survive metadata borrowing');
  assert.ok(compactResponse.body.length<JSON.stringify(full).length);
  const source=h.store.source('codex','b'.repeat(24),now-H);h.store.hold(source,h.user.id,now-H);
  const changed=(await h.read(request)).json();
  assert.ok(changed.quota.value.known.sources[source]!==undefined,'a changed source set supplies fresh metadata');
  const known=h.store.historyKnown.bind(h.store);
  t.mock.method(h.store,'historyKnown',(...args:Parameters<Store['historyKnown']>)=>{const value=known(...args);return {...value,sources:Object.fromEntries(Object.entries(value.sources).reverse())};});
  const reordered=(await h.read(body)).json().quota.value;
  const reorderedRequest={...body,quota:{...body.quota!,meta:reordered.meta}};
  const reorderedReply=(await h.read(reorderedRequest)).json().quota.value;
  assert.equal('known' in reorderedReply,false,'the reversed metadata token really matched');
  assert.equal(reorderedReply.chunks[0].series[0].source,h.source,'captured key order preserves literal source IDs');
});

test('independent source and session delta frontiers share their complete raw range',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const body:PeriodRequest={version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,quota:{cell:String(M),from:String(now-H),to:String(now),cells:'skip',evidence:'skip'},sessions:{},sourceWork:{},workFilter:workFilter(defaultFilters())};
  const baseline=(await h.read(body)).json<PeriodReply>();
  if(baseline.sessions?.state!=='complete'||baseline.sourceWork?.state!=='complete')throw new Error('baseline');
  h.credit(now-30*M,now-25*M,'old');
  const sessions=(await h.read({...body,sessions:{cursor:baseline.sessions.value.cursor},sourceWork:undefined})).json<PeriodReply>();
  if(sessions.sessions?.state!=='delta')throw new Error('sessions');
  h.credit(now-2*M,now-M,'new');
  const ranges:[number,number][]=[];const original=h.store.agentWork.bind(h.store);
  t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{ranges.push([args[0],args[1]]);return original(...args);});
  const reply=await h.read({...body,sessions:{cursor:sessions.sessions.value.cursor},sourceWork:{cursor:baseline.sourceWork.value.cursor}});
  assert.equal(reply.statusCode,200,reply.body);const delta=reply.json<PeriodReply>();
  if(delta.sessions?.state!=='delta'||delta.sourceWork?.state!=='delta')throw new Error('independent deltas');
  assert.deepEqual(ranges,[[now-30*M,now]],'the older source cursor must widen the first extraction');
  assert.equal(delta.sessions.value.replaceFrom,now-2*M);assert.equal(delta.sourceWork.value.replaceFrom,now-30*M);
  const rows=workedSessions(mergeWork(mergeWork(baseline.sessions.value,sessions.sessions.value),delta.sessions.value),delta.basis.range,now);
  assert.deepEqual(rows.map(row=>row.workedMs).sort((a,b)=>a-b),[M,5*M]);
  assert.equal(sourceWorkCurves(delta.sourceWork.value).groups.source.get(h.source)!.read(delta.basis.range,true),6*M);
  ranges.length=0;
  const reverse=(await h.read({...body,sessions:{cursor:baseline.sessions.value.cursor},sourceWork:{cursor:delta.sourceWork.value.cursor}})).json<PeriodReply>();
  if(reverse.sessions?.state!=='delta'||reverse.sourceWork?.state!=='delta')throw new Error('reverse deltas');
  assert.deepEqual(ranges,[[now-30*M,now]],'an older sessions cursor remains independent of a current source cursor');
  assert.equal(reverse.sessions.value.replaceFrom,now-30*M);assert.equal(reverse.sourceWork.value.replaceFrom,now);
  assert.equal(workedSessions(mergeWork(baseline.sessions.value,reverse.sessions.value),reverse.basis.range,now).reduce((sum,row)=>sum+row.workedMs,0),6*M);
});

test('funding facets describe authorized work before selection and exclude absent categories',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const board=h.directory.createBoard('Work only',h.user.id,now-3*H).id;
  h.store.creditWork(h.device,now-H,now,[{source:h.source,client:'codex',origin:'terminal',project:'Private funding',folder:'',startedAt:now-H,identity:{kind:'stable',sessionId:'known'}}]);
  const filters=defaultFilters();filters.projects={mode:'include',values:[]};
  const request={version:1 as const,selection:{mode:'live' as const,periodMs:2*H},evaluatedAt:now,workFilter:workFilter(filters),facets:true as const};
  const read=async()=>{const reply=(await h.read(request,board)).json<PeriodReply>();if(reply.facets?.state!=='complete')throw new Error('incomplete facets');return reply.facets.value;};
  assert.deepEqual((await read()).funding,['notProvided']);
  h.store.creditWork(h.device,now-H,now,[{source:null,client:'opencode',origin:'terminal',project:'Unknown funding',folder:'',startedAt:now-H,identity:{kind:'stable',sessionId:'unknown'}}]);
  const both=await read();assert.deepEqual(both.funding,['notProvided','unknown']);
  assert.deepEqual(both.projects,['Private funding','Unknown funding'],'empty selection does not erase available values');
});

test('fixed facets exclude current-only roster values outside their historical range',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  h.credit(now-90*M,now-80*M);
  h.hub.ingest.live.report(h.device,h.user.id,[{clientId:'codex',source:h.source,sessionId:'current-only',device:{id:h.device,name:'Laptop'},origin:'terminal',project:'Current only',folder:null,startedAt:now-M,sentStartedAt:now-M,lastWorkedAt:now,working:true}],now);
  const request={version:1 as const,evaluatedAt:now,facets:true as const};
  const fixed=(await h.read({...request,selection:{mode:'range',from:now-2*H,to:now-H}})).json<PeriodReply>();
  const live=(await h.read({...request,selection:{mode:'live',periodMs:2*H}})).json<PeriodReply>();
  if(fixed.facets?.state!=='complete'||live.facets?.state!=='complete')throw new Error('facets');
  assert.deepEqual(fixed.facets.value.projects,['Project']);assert.ok(live.facets.value.projects.includes('Current only'));
  const filters=defaultFilters();filters.projects={mode:'exclude',values:['Current only']};
  const chosen=(await h.read({...request,selection:{mode:'range',from:now-2*H,to:now-H},workFilter:workFilter(filters)})).json<PeriodReply>();
  if(chosen.facets?.state!=='complete')throw new Error('explicit choices');
  assert.deepEqual(chosen.facets.value.projects,['Project']);assert.deepEqual(chosen.facets.value.retained?.projects,['Current only'],'authorized current-only choices remain removable outside a fixed range');
});

test('fixed facets keep authorized explicit choices removable without enlarging the period universe',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  for(const [project,from,to] of [['A',150,140],['B',135,130],['C',30,20]] as const)h.store.creditWork(h.device,now-from*M,now-to*M,[{source:h.source,client:'codex',origin:'terminal',project,folder:'',startedAt:now-from*M,identity:{kind:'stable',sessionId:project}}]);
  const idle=h.directory.saveDevice({userId:h.user.id,machine:{id:'idle-0123456789',name:'Idle laptop',os:'linux',arch:'x86_64'},agent:'quotum/0.6.0',tokenId:null},now-3*H).id;
  const filters=defaultFilters();filters.projects={mode:'exclude',values:['A','B']};filters.devices={mode:'exclude',values:[idle]};filters.clients={mode:'exclude',values:['offline-client']};filters.sources={mode:'exclude',values:[{status:'unknown'}]};
  const body:PeriodRequest={version:1,selection:{mode:'range',from:now-H,to:now},evaluatedAt:now,facets:true,workFilter:workFilter(filters),sessions:{}};
  let reads=0;const original=h.store.agentWork.bind(h.store);t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{reads++;return original(...args);});
  const response=await h.read(body);assert.equal(response.statusCode,200,response.body);const result=response.json<PeriodReply>();
  if(result.facets?.state!=='complete')throw new Error('facets');
  assert.equal(reads,1,'choice authorization does not extract a second raw ledger');assert.deepEqual(result.facets.value.projects,['C']);
  assert.deepEqual(result.facets.value.retained,{projects:['A','B'],devices:[{id:idle,name:'Idle laptop'}],clients:['offline-client'],funding:['unknown']});
  const board=h.directory.createBoard('Shared work',h.user.id,now-3*H).id;
  const allowed=(await h.read(body,board)).json<PeriodReply>();if(allowed.facets?.state!=='complete')throw new Error('shared facets');
  assert.deepEqual(allowed.facets.value.retained?.projects,['A','B']);
  for(const device of h.store.sessionDevices(board,h.user.id))h.store.setDeviceSessions(board,device.id,h.user.id,false,device.revision,now);
  const revoked=(await h.read(body,board)).json<PeriodReply>();if(revoked.facets?.state!=='complete')throw new Error('revoked facets');
  assert.deepEqual(revoked.facets.value.projects,[]);assert.deepEqual(revoked.facets.value.retained?.projects,[]);assert.deepEqual(revoked.facets.value.retained?.devices,[]);
  for(const value of ['"A"','"B"','Idle laptop',idle])assert.equal(JSON.stringify(revoked.facets).includes(value),false);
});

test('a period response rechecks authentication after cooperative preparation',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const original=PeriodAccounting.prepare;
  t.mock.method(PeriodAccounting,'prepare',function*(...args:Parameters<typeof original>){
    setImmediate(()=>h.directory.deleteSessions(h.user.id));
    const until=performance.now()+12;do{yield;}while(performance.now()<until);
    return yield*original(...args);
  });
  const response=await h.read({version:1,selection:{mode:'range',from:now-H,to:now-M},evaluatedAt:now,quota:{cell:String(M),from:String(now-H),to:String(now),cells:'skip'}});
  assert.equal(response.statusCode,401);assert.deepEqual(response.json(),{error:'unauthorized'});
});

test('device-admitted client periods retain exact work and identity on personal and shared boards',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const foreign=h.store.source('codex','f'.repeat(24),now-H),shared=h.directory.createBoard('Shared',h.user.id,now-H).id;
  const contexts=[{client:'opencode',source:null},{client:'codex',source:foreign}];
  const keys=contexts.map(context=>({...context,origin:'terminal' as const,startedAt:now-H,project:'Private',folder:'private-folder',identity:{kind:'stable' as const,sessionId:'same-producer'}}));
  h.store.creditWork(h.device,now-3*M,now-2*M,keys);
  h.hub.ingest.live.report(h.device,h.user.id,contexts.map(({client,source})=>({clientId:client,source,sessionId:'same-producer',device:{id:h.device,name:'Laptop'},origin:'terminal',startedAt:now-H,sentStartedAt:now-H,project:'Private',folder:'private-folder',lastWorkedAt:now-M,working:client==='opencode'})),now);
  const selection={mode:'live' as const,periodMs:H},quota={cell:String(M),from:String(now-4*M),to:String(now)};
  const body={version:1 as const,selection,evaluatedAt:now,sessions:{},quota};
  let reads=0;const original=h.store.agentWork.bind(h.store);
  t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{reads++;return original(...args);});
  const reply=(await h.read(body)).json<PeriodReply>();assert.equal(reads,1,'cells and the roster share their private work read');
  if(reply.sessions?.state!=='complete'||reply.quota?.state!=='complete')throw new Error('incomplete period');
  const rows=workedSessions(reply.sessions.value,reply.basis.range,now);
  assert.deepEqual(rows.map(r=>[r.clientId,r.source,r.workedMs,r.currentPresence?.working]),[['opencode',null,M,true],['codex',null,M,false]]);
  assert.equal(new Set(rows.map(r=>r.ref)).size,2,'client namespaces never share presence or identity');
  assert.ok('known' in reply.quota.value&&reply.quota.value.known.sessions!==null);assert.equal(reply.quota.value.known.own,undefined,'new replies use the common sessions boundary without a private alias');
  const wire=JSON.stringify(reply);assert.ok(!wire.includes(foreign)&&!wire.includes('same-producer'));
  const cutoff=now-150_000;
  const fixed=(await h.read({...body,selection:{mode:'range',from:now-H,to:cutoff}})).json<PeriodReply>();
  if(fixed.sessions?.state!=='complete')throw new Error('incomplete fixed period');
  assert.deepEqual(workedSessions(fixed.sessions.value,fixed.basis.range,now).map(r=>r.workedMs),[30_000,30_000]);
  assert.deepEqual(fixed.sessions.value.fixed?.activity.by.source.map(g=>g.key),['unknown']);
  const other=(await h.read(body,shared)).json<PeriodReply>();
  if(other.sessions?.state!=='complete'||other.quota?.state!=='complete')throw new Error('incomplete shared period');
  assert.equal(other.sessions.value.refs.length,2);assert.ok('known' in other.quota.value);assert.equal(other.quota.value.known.own,undefined);
  h.store.creditWork(h.device,now-M,now-30_000,keys);
  const delta=(await h.read({...body,sessions:{cursor:reply.sessions.value.cursor}})).json<PeriodReply>();
  if(delta.sessions?.state!=='delta')throw new Error('missing private delta');
  assert.equal(delta.sessions.value.replaceFrom,now-M,'private credit invalidates the retained frontier');
  assert.deepEqual(workedSessions(mergeWork(reply.sessions.value,delta.sessions.value),delta.basis.range,now).map(r=>r.workedMs),[90_000,90_000]);
  h.store.hold(foreign,h.user.id,now);const view=h.directory.view(h.board);
  h.directory.saveView(h.board,{...view,hidden:[...view.hidden,'source:'+foreign]},h.user.id,now);
  const hidden=(await h.read(body)).json<PeriodReply>();
  if(hidden.sessions?.state!=='complete')throw new Error('incomplete hidden period');
  assert.deepEqual(hidden.sessions.value.refs.map(r=>r.clientId),['opencode','codex'],'hiding a quota card preserves admitted work');
});

test('converted credit changes and heartbeats retain one bounded exact period tail',async t=>{
  const current=now+12345;t.mock.method(Date,'now',()=>current);
  const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const query={cell:String(5*M),from:String(Math.floor((current-M)/(5*M))*5*M),to:String(Math.ceil(current/(5*M))*5*M),unit:'USD',currency:'USD',meters:JSON.stringify([[h.source,'balance:credits']])};
  let evidence:string|undefined,meta='',retained:PeriodTape|null=null;
  for(const [i,amount] of ['2500','2499','2498','2498','2498'].entries()){
    const at=current-25000+i*2000;
    h.store.record(h.source,{observedAt:at,staleAfterMs:H,plan:'pro',resets:null,windows:[],resourceStatus:{windows:'missing',resets:'missing'},balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount,hasCredits:true}]});
    const response=await h.read({version:1,selection:{mode:'live',periodMs:24*H},evaluatedAt:current,funds:{...query,evidence,meta}});
    assert.equal(response.statusCode,200,response.body);
    const reply=expandPeriod(response.json<PeriodWireReply>()),part=reply.funds;if(part?.state!=='complete')throw new Error('funds');
    const headers=`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([key,value])=>`${key}: ${value}\r\n`).join('')}\r\n`;
    const bytes=Buffer.byteLength(response.body)+Buffer.byteLength(headers);
    assert.ok(bytes<=HISTORY_BYTES_PER_MEASUREMENT,`${i}: ${bytes} bytes including HTTP headers`);
    const extra=part.value.chunks.flatMap(c=>c.meterSeries??[]).flatMap(s=>s.cells).at(-1)![5]!;
    assert.equal(extra.semantics!.conversion!.original.amount,amount);
    assert.equal(extra.semantics!.conversion!.original.at,at);
    assert.equal(extra.semantics!.conversion!.rate.to,'40000');
    retained=retained?mergeTape(retained,part.value.tape!):part.value.tape!;assert.equal(retained.money[0].readings.at(-1)!.amount,amount,'complete and delta replies preserve one exact retained ledger');
    evidence=part.value.tape!.cursor;meta=part.value.meta??'';
  }
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM readings WHERE source_id=?').get(h.source)?.n,3,'heartbeats do not invent ledger readings');
});

test('period values use the last batch strictly before the boundary and keep expired evidence',()=>{
  const store=new Store(':memory:',now-3*H);
  try {
    const directory=new Directory(store.db),user=directory.createUser('a@example.com','A','x',now).id;
    const id=store.source('codex','a'.repeat(24),now-3*H),sources=[{id,provider:'codex'}];
    const record=(at:number,used:number,extra=false)=>store.record(id,{observedAt:at,plan:'',resets:null,staleAfterMs:M,windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used,remaining:100-used,resetAt:now-M},...(extra?[{id:'session',kind:'session' as const,label:null,minutes:300,used:0,remaining:100,resetAt:now+H}]:[])]});
    record(now-3*M,90,true);record(now-2*M,30);record(now-M,5);
    const read=(to:number)=>periodValues(store,sources,user,to,()=>{})[0];
    assert.equal(read(now-4*M).windows.length,0);
    assert.deepEqual(read(now-M).windows.map(w=>[w.id,w.remaining,w.observedAt,w.stale]),[['weekly',70,now-2*M,true]]);
    assert.equal(read(now-2*M+1).windows[0].stale,false);
    assert.equal(read(now).windows[0].remaining,95);
    assert.equal(read(now).windows[0].stale,true);
    const retained=read(now-2*M+1),interval=retained.validFor!;
    assert.ok(interval.from<=now-2*M+1&&interval.to>now-2*M+1);
    for(const edge of [interval.from,interval.to-1])assert.deepEqual(read(edge).windows,retained.windows);
    assert.notDeepEqual(read(interval.to).windows,retained.windows,'a stale boundary or new observation ends reuse');
  }finally{store.close();}
});

test('nearby card states cross exclusive observations and deadlines without interpolating money',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const wallet=h.store.source('deepseek','b'.repeat(24),now-3*H);h.store.hold(wallet,h.user.id,now-3*H);
  for(const [at,used,amount] of [[now-3*M,90,'9007199254.740993'],[now-M,30,'9007199254.740991']] as const){
    h.store.record(h.source,{observedAt:at,plan:'',resets:null,staleAfterMs:M,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used,remaining:100-used,resetAt:now-M}]});
    h.store.record(wallet,deepSeekMeasurement({is_available:true,balance_infos:[{currency:'USD',total_balance:amount,granted_balance:'0',topped_up_balance:amount}]},at));
  }
  const sources=[{id:h.source,provider:'codex'},{id:wallet,provider:'deepseek'}];let held=0;
  const values=nearbyPeriodValues(h.store,sources,h.user.id,now-2*M,2*M,bytes=>{held+=bytes;},bytes=>{held-=bytes;assert.ok(held>=0);});assert.ok(held>0);
  for(const to of [now-4*M,now-3*M,now-3*M+1,now-2*M,now-2*M+1,now-M,now-M+1,now]){
    const fresh=periodValues(h.store,sources,h.user.id,to,()=>{});
    for(const [i,value] of values.entries()){
      assert.ok(hasPeriodValue(value,to),String(to));const {states:_states,...snapshot}=periodValueAt(value,to)!;assert.deepEqual(snapshot,fresh[i]);
    }
  }
});

test('neighboring endpoint cells retain exact quota, work and cards through a native repeat',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const wallet=h.store.source('deepseek','b'.repeat(24),now-H);h.store.hold(wallet,h.user.id,now-H);
  for(let i=0;i<12;i++){
    const at=now-(24-2*i)*M;
    h.store.record(h.source,{observedAt:at,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:i+.125,remaining:100-i-.125,resetAt:now+H}]});
    h.store.record(wallet,deepSeekMeasurement({is_available:true,balance_infos:[{currency:'USD',total_balance:`9007199254.7409${String(93-i).padStart(2,'0')}`,granted_balance:'0',topped_up_balance:`9007199254.7409${String(93-i).padStart(2,'0')}`}]},at));
  }
  h.credit(now-25*M,now-3*M);
  const sources=[{id:h.source,provider:'codex'},{id:wallet,provider:'deepseek'}],edge=now-10*M;
  const read=async(to:number)=>{
    const response=await h.read({version:1,selection:{mode:'range',from:to-24*H,to},evaluatedAt:now,values:sources.map(s=>s.id),sessions:{},quota:{cell:String(5*M),from:String(now-H),to:String(now),cells:'skip'}});
    assert.equal(response.statusCode,200,response.body);const reply=expandPeriod(response.json<PeriodWireReply>());
    if(reply.values?.state!=='complete'||reply.quota?.state!=='complete'||reply.sessions?.state!=='complete')throw new Error('incomplete period');
    return {values:reply.values.value,fixed:reply.quota.value.tape!.fixed!,work:reply.sessions.value.fixed!};
  };
  const retained=await read(edge),before=JSON.stringify(retained);
  const plain=<T extends object>(value:T,key:string)=>{const {[key]:_,...rest}=value as Record<string,unknown>;return rest;};
  // A real return/repeat moved 165,715 ms after the live plot lost its future area.
  // This remains inside a five-minute cell, but exceeds a one-minute neighborhood.
  for(const offset of [165715,-165715,-4*M,-M,-.25,0,.25,1,M,4*M]){
    const to=edge+offset,fresh=await read(Math.floor(to));
    assert.ok(canShift(retained.fixed,{from:to-24*H,to}),String(offset));
    assert.deepEqual(plain(shifted(retained.fixed,{from:to-24*H,to})!,'shift'),plain(shifted(fresh.fixed,{from:to-24*H,to})!,'shift'));
    assert.ok(canShift(retained.work,{from:to-24*H,to}),String(offset));
    assert.deepEqual(plain(shifted(retained.work,{from:to-24*H,to})!,'shift'),plain(shifted(fresh.work,{from:to-24*H,to})!,'shift'));
    // Protocol positions are integer milliseconds; fractional replay keeps that admission.
    const actual=periodValues(h.store,sources,h.user.id,Math.floor(to),()=>{});
    for(const [i,value]of retained.values.entries())assert.deepEqual(plain(periodValueAt(value,to)!,'states'),actual[i]);
  }
  const outside=edge+8*M;
  assert.equal(canShift(retained.fixed,{from:outside-24*H,to:outside}),false);
  assert.ok(retained.values.some(value=>!hasPeriodValue(value,outside)),'positions beyond retained evidence require another read');
  const fresh=await read(outside),actual=periodValues(h.store,sources,h.user.id,outside,()=>{});
  for(const [i,value]of fresh.values.entries())assert.deepEqual(plain(value,'states'),actual[i]);
  assert.notDeepEqual(fresh.values.map(v=>v.windows),retained.values.map(v=>v.windows));
  assert.equal(JSON.stringify(retained),before,'reads and replays preserve the original retained projection');
});

test('unchanged spending anchors preserve sparse financial card states and period replies',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const start=now-8*H,wallet=h.store.source('openrouter','dense-values',start),sources=[{id:wallet,provider:'openrouter'}];h.store.hold(wallet,h.user.id,start);
  transaction(h.store.db,()=>{
    for(let at=start;at<=now;at+=2*M)h.store.record(wallet,{type:'meters',observedAt:at,staleAfterMs:45*M,
      meters:['usage','credits'].map(id=>({id,at,amount:id==='usage'?'0':'60000000',kind:'counter' as const,unit:'USD',stale:false,staleAfterMs:45*M,limit:null,resetAt:null,minutes:null,scope:null,label:null})),keys:[],inventoryComplete:true,inventoryError:null});
  });
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM readings WHERE source_id=? AND pair_anchor=1').get(wallet)?.n,240);
  const queries=new Set<string>(),prepare=h.store.db.prepare.bind(h.store.db);
  t.mock.method(h.store.db,'prepare',(sql:string)=>{if(sql.includes('FROM readings'))queries.add(sql);return prepare(sql);});
  const edge=now-2*H,read=()=>periodValues(h.store,sources,h.user.id,edge,()=>{},now),nearby=()=>nearbyPeriodValues(h.store,sources,h.user.id,edge,2*H,()=>{},()=>{},now);
  const request={version:1 as const,selection:{mode:'range' as const,from:now-3*H,to:edge},evaluatedAt:now,values:[wallet]};
  const dense=read(),denseNearby=nearby(),denseReply=await h.read(request);assert.equal(denseReply.statusCode,200,denseReply.body);
  const densePart=denseReply.json<PeriodReply>().values;assert.equal(densePart?.state,'complete');
  if(densePart?.state!=='complete')throw new Error('missing financial values');assert.equal(densePart.value[0].id,wallet);
  for(const sql of queries){
    const query=prepare('EXPLAIN QUERY PLAN '+sql),names=[...sql.matchAll(/:(\w+)/g)].map(match=>match[1]);
    const plan=names.length?query.all(Object.fromEntries(names.map(name=>[name,0]))):query.all(...Array.from({length:(sql.match(/\?/g)??[]).length},()=>0));
    const readings=plan.filter(row=>/\b(?:SEARCH|SCAN) readings\b/.test(String(row.detail)));
    assert.ok(readings.length>0&&readings.every(row=>String(row.detail).includes('readings_sparse')),'actual financial queries must avoid dense anchors: '+sql);
    if(sql.startsWith('WITH changes'))assert.ok(readings.every(row=>String(row.detail).includes('COVERING INDEX')),'financial card boundaries must not fetch table rows for deadlines and resets');
  }
  // Keep every financial observation, current value and availability span unchanged.
  h.store.db.prepare('DELETE FROM readings WHERE source_id=? AND pair_anchor=1').run(wallet);
  assert.deepEqual(dense,read(),'private work endpoints cannot shorten financial value reuse');
  assert.deepEqual(denseNearby,nearby(),'neighboring cards contain only financial state boundaries');
  const sparseReply=await h.read(request);assert.equal(sparseReply.statusCode,200,sparseReply.body);
  assert.deepEqual(denseReply.json<PeriodReply>().values,sparseReply.json<PeriodReply>().values,'the public period path preserves sparse card states');
});

test('sparse card states preserve optional fields and unchanged key context in either direction',()=>{
  const base={id:'s',provider:'deepseek',windows:[],meters:[],keys:[]};
  const values=Array.from({length:80},(_,i)=>({...base,validFor:{from:i*100,to:(i+1)*100},
    keys:[{id:'key',name:'A long retained key name',disabled:false,expiresAt:null,includeByok:false,at:i,staleAfterMs:100,presence:'observed' as const,missCount:0,periods:{day:null,week:null,month:null},byokUsage:{total:null,day:null,week:null,month:null}}],
    ...(i%3?{currencyUnavailable:true}:{}),
  }));
  const packed=withValueStates(values[40],values,()=>{});
  assert.ok(JSON.stringify(packed).length<JSON.stringify(values).length/2);
  const roundtrip=JSON.parse(JSON.stringify(packed));
  let restored=roundtrip;
  for(const to of [7999,0,4199,100,7899,1,4099]){
    const {states:_states,...value}=periodValueAt(roundtrip,to)!;
    assert.deepEqual(value,values[Math.floor(to/100)]);
    restored=periodValueAt(restored,to)!;
    const {states:_retained,...repeated}=restored;
    assert.deepEqual(repeated,value,'a moved value keeps its original replay base');
  }
  assert.equal(periodValueAt(roundtrip,8000),undefined);
  assert.equal(periodValueAt(roundtrip,-1),undefined);
  assert.deepEqual(roundtrip,packed,'replay never mutates the shared sequence');
});

test('a cached cell range reads exact totals and boundaries without rebuilding cells',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  h.store.record(h.source,{observedAt:now-M,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:now+H}]});
  let work=0;const original=h.store.agentWork.bind(h.store);t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{work++;return original(...args);});
  const response=await h.read({version:1,selection:{mode:'range',from:now-H,to:now-1},evaluatedAt:now,quota:{cell:String(M),from:String(now-H),to:String(now),cells:'skip'}});
  assert.equal(response.statusCode,200,response.body);const part=response.json<PeriodReply>().quota!;if(part.state!=='complete')throw new Error('quota');
  assert.deepEqual(part.value.chunks,[]);assert.deepEqual(part.value.tape!.quota,[]);assert.equal(part.value.tape!.fixed!.quota[0].remainingAtEnd,83);assert.equal(work,1);
});

test('an oversized section does not discard siblings or retain its failed reservation',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const limited=t.mock.method(h.store,'agentWork',()=>{throw new HistoryLimit();});
  const request:PeriodRequest={version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,quota:{cell:String(M),from:String(now-H),to:String(now)},sessions:{},values:[h.source]};
  const reply=(await h.read(request)).json<PeriodReply>();
  assert.equal(reply.quota?.state,'error');assert.equal(reply.sessions?.state,'error');assert.equal(reply.values?.state,'complete');
  limited.mock.restore();const next=(await h.read(request)).json<PeriodReply>();
  assert.equal(next.quota?.state,'complete');assert.equal(next.sessions?.state,'complete');assert.equal(next.values?.state,'complete');
});

test('a failed calendar releases its partial reply before source work is prepared',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture(now-100*24*H);t.after(async()=>{await h.app.close();h.store.close();});
  h.credit(now-25*H,now);
  const tiles=new HistoryTiles(h.store),events=new Events(h.hub,undefined,{now:()=>now,after:()=>()=>{}},null),reader=new PeriodReader(h.hub,tiles,events);
  t.after(()=>events.close());
  const pin=tiles.reservation();pin.add(32*1024*1024-40_000);t.after(()=>pin.close());
  const body:PeriodRequest={version:1,selection:{mode:'live',periodMs:25*H},evaluatedAt:now,sourceWork:{},quota:{cell:String(15*M),from:String(Math.floor((now-25*H)/(15*M))*15*M),to:String(Math.ceil(now/(15*M))*15*M),cells:'skip',evidence:'skip'}};
  const read=(calendar:boolean)=>expandPeriod(JSON.parse(reader.read(h.board,h.user.id,{...body,...(calendar?{calendar:{zone:'UTC'}}:{})})));
  const control=read(false);assert.equal(control.sourceWork?.state,'complete');assert.equal(control.quota?.state,'complete');
  const failed=read(true);assert.deepEqual(failed.calendar,{state:'error',error:'history_limit'});
  assert.equal(failed.sourceWork?.state,'complete','the failed optional projection must leave capacity for its sibling');assert.equal(failed.quota?.state,'complete');
});

test('fixed resource sections retain endpoint deadlines when card values exceed the shared capacity',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  h.store.record(h.source,{observedAt:now-M,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:now+H}],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'123',hasCredits:true}]});
  const wallet=h.store.source('openrouter','b'.repeat(24),now-2*H);h.store.hold(wallet,h.user.id,now-2*H);
  h.store.record(wallet,{type:'meters',observedAt:now-M,staleAfterMs:H,meters:[],keys:Array.from({length:100},(_,i)=>({id:i.toString(16).padStart(12,'a'),name:'N'.repeat(80),disabled:false,expiresAt:null,includeByok:false,at:now-M,staleAfterMs:H,presence:'observed',missCount:0,periods:{day:null,week:null,month:null}})),inventoryComplete:true,inventoryError:null});
  const tiles=new HistoryTiles(h.store),events=new Events(h.hub,undefined,{now:()=>now,after:()=>()=>{}},null),reader=new PeriodReader(h.hub,tiles,events);t.after(()=>events.close());
  const pin=tiles.reservation();pin.add(32*1024*1024-100_000);t.after(()=>pin.close());
  const range={from:now-H,to:now+2*H},query={cell:String(M),from:String(range.from),to:String(range.to),cells:'skip' as const};
  const reply=expandPeriod(JSON.parse(reader.read(h.board,h.user.id,{version:1,selection:{mode:'range',...range},evaluatedAt:now,quota:query,funds:{...query,unit:'USD',meters:JSON.stringify([[h.source,'balance:credits']])},values:[h.source,wallet]})));
  assert.deepEqual(reply.values,{state:'error',error:'history_limit'});
  for(const scope of ['quota','funds'] as const){
    const part=reply[scope];assert.equal(part?.state,'complete');if(part?.state!=='complete')throw Error(scope);
    const fixed=part.value.tape!.fixed!,row=scope==='quota'?fixed.quota[0]:fixed.money[0];assert.equal(row.endValidUntil,now-M+H+1);
  }
});

test('a chart-only past tile reads only its work, and extraction replacement releases its reservation',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  h.credit(now-2*H,now-H);h.credit(now-30*M,now-M,'later');
  const original=h.store.agentWork.bind(h.store),ranges:number[][]=[];
  t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{ranges.push(args.slice(0,2) as number[]);return original(...args);});
  const response=await h.read({version:1,selection:{mode:'range',from:now-2*H,to:now-M},evaluatedAt:now,quota:{cell:String(M),from:String(now-2*H),to:String(now-H),evidence:'skip'}});
  assert.equal(response.json<PeriodReply>().quota?.state,'complete');assert.deepEqual(ranges,[[now-2*H,now-H]]);
  let used=0,peak=0,accessBytes=0;
  const capture=h.store.workAccess.bind(h.store);
  t.mock.method(h.store,'workAccess',(...args:Parameters<Store['workAccess']>)=>capture(args[0],args[1],bytes=>{accessBytes+=bytes;args[2]?.(bytes);}));
  const read=sharedWork(h.hub,h.store.authorizedSources(h.board),null,bytes=>{used+=bytes;peak=Math.max(peak,used);},bytes=>{used-=bytes;assert.ok(used>=0);},null,now,h.board);
  const metadata=used;assert.ok(metadata>0,'the common captured access is charged before extraction');
  assert.equal(metadata,accessBytes,'only the captured access remains charged after authority hashing');
  assert.ok(peak>metadata,'temporary authority hashing is released before extraction starts');peak=used;
  const first=read(now-2*H,now-H),before=used;
  assert.equal(first.length,1);assert.ok(before>0);
  const second=read(now-2*H,now);
  assert.equal(second.length,2);assert.equal(peak,used,'replacement does not retain the former extraction');
  read(now-90*M,now-M);assert.equal(peak,used,'contained reads reuse the extraction');
  const final=used;t.mock.method(h.store,'agentWork',(_from:number,_to:number,_sources?:string[],_owner?:string|null,reserve?:(bytes:number)=>void)=>{reserve?.(64);throw new HistoryLimit();});
  assert.throws(()=>read(now-3*H,now),HistoryLimit);assert.equal(used,metadata,'failed extraction releases every raw byte while its request keeps the common access');assert.equal(peak,final);
});

test('money retains exact amounts, compressed anchors and accepted interruption',()=>{
  const store=new Store(':memory:',now-3*H);
  try {
    const directory=new Directory(store.db),user=directory.createUser('a@example.com','A','x',now).id;
    const id=store.source('deepseek','b'.repeat(24),now-3*H),sources=[{id,provider:'deepseek'}];
    const answer={is_available:true,balance_infos:[{currency:'USD',total_balance:'9007199254.740993',granted_balance:'0',topped_up_balance:'9007199254.740993'}]};
    store.record(id,deepSeekMeasurement(answer,now-3*M));store.record(id,deepSeekMeasurement(answer,now-M));
    const read=(to:number)=>periodValues(store,sources,user,to,()=>{})[0].meters.find(m=>m.id==='balance:USD')!;
    assert.equal(read(now-2*M).at,now-3*M,'no invented heartbeat inside a compressed span');
    assert.equal(read(now).amount,'9007199254740993');assert.equal(read(now).at,now-M);
    store.record(id,deepSeekMeasurement({is_available:true,balance_infos:[]},now));
    assert.equal(read(now).stale,true,'exclusive interruption ends availability without erasing the number');
    assert.equal(read(now).amount,'9007199254740993');
  }finally{store.close();}
});

test('ended sessions are clipped, composite reads share extraction, and deltas replace their tail',async t=>{
  t.mock.method(Date,'now',()=>now);
  const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  h.credit(now-2*H,now-H);
  const from=now-90*M,to=now-60*M;
  let reads=0;const original=h.store.agentWork.bind(h.store);t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{reads++;return original(...args);});
  const response=await h.read({version:1,selection:{mode:'range',from,to},evaluatedAt:now,quota:{cell:String(M),from:String(from),to:String(to)},sessions:{}});
  assert.equal(response.statusCode,200,response.body);const reply=response.json<PeriodReply>();
  assert.equal(reply.quota?.state,'complete');assert.equal(reply.sessions?.state,'complete');assert.equal(reads,1);
  if(reply.sessions?.state!=='complete')throw new Error('sessions');
  const trace=reply.sessions.value,rows=workedSessions(trace,{from,to},now);
  assert.equal(rows.length,1);assert.equal(rows[0].workedMs,30*M);assert.equal(rows[0].currentPresence,undefined);
  assert.equal(response.body.includes('producer_id'),false);assert.equal(response.body.includes(h.user.id),false);assert.equal(response.body.includes('"stable"'),false);
  const live={mode:'live' as const,periodMs:H};
  const baseline=(await h.read({version:1,selection:live,evaluatedAt:now,sessions:{}})).json<PeriodReply>();
  if(baseline.sessions?.state!=='complete')throw new Error('baseline');
  h.credit(now-5*M,now-M);
  const next=(await h.read({version:1,selection:live,evaluatedAt:now,sessions:{cursor:baseline.sessions.value.cursor}})).json<PeriodReply>();
  if(next.sessions?.state!=='delta')throw new Error('delta');
  const once=mergeWork(baseline.sessions.value,next.sessions.value),twice=mergeWork(once,next.sessions.value);
  assert.deepEqual(once,twice);assert.equal(workedSessions(once,{from:now-H,to:now},now)[0].workedMs,4*M);
  assert.equal(workedSessions(once,{from:now-3*M,to:now},now)[0].workedMs,2*M);
  assert.equal(workedSessions(once,{from:now,to:now+H},now).length,0);
});

test('period access is rechecked, malformed sections fail, and the legacy route keeps its contract',async t=>{
  t.mock.method(Date,'now',()=>now);
  const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const request:PeriodRequest={version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,values:[h.source]};
  assert.equal((await h.read(request,'missing')).statusCode,404);
  assert.equal((await h.read({...request,values:['private']})).statusCode,404);
  assert.equal((await h.read({...request,quota:{scope:'quota'}})).statusCode,400);
  assert.equal((await h.read(request)).statusCode,200);
  h.store.db.prepare('DELETE FROM holders WHERE source_id=?').run(h.source);
  assert.equal((await h.read(request)).statusCode,404);
});

test('fixed work follows device admission independently of later subscription sharing',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const shared=h.directory.createBoard('Shared',h.user.id,now-3*H).id;
  h.store.share(shared,h.source,h.user.id,now-2*H);h.credit(now-3*H,now-H);
  const selection={mode:'range' as const,from:now-3*H,to:now-150*M};
  const reply=(await h.read({version:1,selection,evaluatedAt:now,sessions:{}},shared)).json<PeriodReply>();
  if(reply.sessions?.state!=='complete')throw new Error('incomplete shared period');
  assert.equal(reply.sessions.value.knownFrom,now-3*H);
  assert.equal(reply.sessions.value.fixed?.activity.since,now-3*H);
  assert.deepEqual(reply.sessions.value.fixed?.activity.known,{from:selection.from,to:selection.to});
  assert.deepEqual(workedSessions(reply.sessions.value,selection,now).map(r=>r.workedMs),[30*M]);
});

test('shared fixed quota hours stay unknown before admission and become zero only in a known empty suffix',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const shared=h.directory.createBoard('Boundary',h.user.id,now-3*H).id,known=now-H;
  h.store.share(shared,h.source,h.user.id,now-3*H);
  let policy=h.store.sessionDevices(shared,h.user.id)[0];h.store.setDeviceSessions(shared,h.device,h.user.id,false,policy.revision,now-2*H);
  policy=h.store.sessionDevices(shared,h.user.id)[0];h.store.setDeviceSessions(shared,h.device,h.user.id,true,policy.revision,known);
  for(const at of [now-3*H,now-2*H,known,now-1])h.store.record(h.source,{observedAt:at,plan:'',resets:null,staleAfterMs:4*H,windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:now+H}]});
  const summary=async(from:number,to:number,filters=defaultFilters())=>{
    const response=await h.read({version:1,selection:{mode:'range',from,to},evaluatedAt:now,sessions:{},workFilter:workFilter(filters),quota:{cell:String(M),from:String(from),to:String(to),cells:'skip'},sourceWork:{}},shared);
    assert.equal(response.statusCode,200,response.body);const reply=expandPeriod(response.json<PeriodWireReply>());
    if(reply.quota?.state!=='complete')throw new Error('incomplete shared quota');
    const row=reply.quota.value.tape?.fixed?.quota.find(row=>row.windowId==='weekly');assert.ok(row);return row;
  };
  for(const to of [known-M,known,known+M]){
    const row=await summary(now-2*H,to),expected=to>known?0:null;
    assert.equal(row.selectedWork?.ms,expected);assert.equal(row.selectedWork?.from,known);
  }
  h.credit(known+15*M,known+30*M);
  const full=await summary(known,now),filters=defaultFilters();filters.projects={mode:'include',values:[]};
  const empty=await summary(known,now,filters);
  assert.equal(full.work?.ms,15*M);assert.equal(empty.selectedWork?.ms,0);assert.equal(empty.selectedWork?.agentMs,0);
  assert.deepEqual(empty.work,full.work,'a known empty selection preserves the supplier estimate cohort');
});

for(const selected of [false,true])test(`matcher pressure preserves native budget with ${selected?'selected sessions':'an unused predicate'}`,async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const tiles=new HistoryTiles(h.store),events=new Events(h.hub,undefined,{now:()=>now,after:()=>()=>{}},null),reader=new PeriodReader(h.hub,tiles,events);t.after(()=>events.close());
  const wallet=h.store.source('openrouter','matcher-wallet',now-3*H);h.store.hold(wallet,h.user.id,now-3*H);
  const meter=(id:string,amount:string)=>({id,at:now-M,amount,kind:'counter' as const,unit:'USD',stale:false,staleAfterMs:4*H,limit:null,resetAt:null,minutes:null,scope:null,label:null});
  h.store.record(wallet,{type:'meters',observedAt:now-M,staleAfterMs:4*H,meters:[meter('usage','0'),meter('credits','15000000')],keys:[],inventoryComplete:true,inventoryError:null});
  const filters=defaultFilters();filters.projects={mode:'include',values:Array.from({length:1000},(_,i)=>String(i).padStart(4,'0')+'x'.repeat(60))};
  const request:PeriodRequest={version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,workFilter:workFilter(filters),...(selected?{sessions:{}}:{}),budget:{cell:String(M),from:String(now-H),to:String(now),cells:'skip',unit:'USD',meters:JSON.stringify([[wallet,'balance']])}};
  let used=0;const reservation=tiles.reservation.bind(tiles);
  t.mock.method(tiles,'reservation',()=>{const own=reservation();let bytes=0;return {add:(size:number)=>{own.add(size);bytes+=size;used+=size;},remove:(size:number)=>{own.remove(size);bytes-=size;used-=size;},close:()=>{own.close();used-=bytes;bytes=0;}};});
  const pin=tiles.reservation(),pinned=32*1024*1024-periodInputBytes(request)-100_000;pin.add(pinned);t.after(()=>pin.close());
  const native={...request,workFilter:undefined,sessions:undefined},padding=periodInputBytes(request)-periodInputBytes(native);pin.add(padding);
  const read=async(body:PeriodRequest)=>expandPeriod(JSON.parse(await reader.readAsync(h.board,h.user.id,body)) as PeriodWireReply);
  const control=await read(native);assert.equal(control.budget?.state,'complete');pin.remove(padding);
  const reply=await read(request);assert.equal(reply.budget?.state,'complete');
  if(reply.budget?.state!=='complete')throw new Error('native sibling failed');
  assert.equal(reply.budget.value.tape!.money[0].paired!.readings[0].amount,'15000000');
  if(selected)assert.deepEqual(reply.sessions,{state:'error',error:'history_limit'});else assert.equal(reply.sessions,undefined);
  assert.equal(used,pinned,'all failed preparation and input charges are released');
  pin.close();assert.equal(used,0);
  const recovered=await read(request);assert.equal(recovered.budget?.state,'complete');if(selected)assert.equal(recovered.sessions?.state,'complete');assert.equal(used,0);
});

test('source cursor planning pressure cannot discard an independent native budget and recovers without a new planner',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const tiles=new HistoryTiles(h.store),events=new Events(h.hub,undefined,{now:()=>now,after:()=>()=>{}},null),reader=new PeriodReader(h.hub,tiles,events);t.after(()=>events.close());
  const wallet=h.store.source('openrouter','source-plan-wallet',now-3*H);h.store.hold(wallet,h.user.id,now-3*H);
  const meter=(id:string,amount:string)=>({id,at:now-M,amount,kind:'counter' as const,unit:'USD',stale:false,staleAfterMs:4*H,limit:null,resetAt:null,minutes:null,scope:null,label:null});
  h.store.record(wallet,{type:'meters',observedAt:now-M,staleAfterMs:4*H,meters:[meter('usage','0'),meter('credits','15000000')],keys:[],inventoryComplete:true,inventoryError:null});
  for(let i=0;i<1998;i++){const source=h.store.source('codex','source-plan-'+i,now-3*H);h.store.hold(source,h.user.id,now-3*H);}
  const query={cell:String(M),from:String(now-H),to:String(now),cells:'skip'};
  const request:PeriodRequest={version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,sourceWork:{},quota:{...query,evidence:'skip',sources:'[]'},budget:{...query,unit:'USD',meters:JSON.stringify([[wallet,'balance']])}};
  let used=0;const refused:number[]=[],reservation=tiles.reservation.bind(tiles);
  t.mock.method(tiles,'reservation',()=>{const own=reservation();let bytes=0;return {add:(size:number)=>{try{own.add(size);}catch(error){refused.push(size);throw error;}bytes+=size;used+=size;},remove:(size:number)=>{own.remove(size);bytes-=size;used-=size;},close:()=>{own.close();used-=bytes;bytes=0;}};});
  const pin=tiles.reservation(),pinned=32*1024*1024-periodInputBytes(request)-200_000;pin.add(pinned);t.after(()=>pin.close());
  const native={...request,sourceWork:undefined,quota:undefined},padding=periodInputBytes(request)-periodInputBytes(native);pin.add(padding);
  const read=async(body:PeriodRequest)=>expandPeriod(JSON.parse(await reader.readAsync(h.board,h.user.id,body)) as PeriodWireReply);
  assert.equal((await read(native)).budget?.state,'complete','native evidence fits beside the same input charge');pin.remove(padding);
  const reply=await read(request);assert.equal(reply.budget?.state,'complete');assert.deepEqual(reply.sourceWork,{state:'error',error:'history_limit'});
  if(reply.budget?.state!=='complete')throw new Error('native budget failed');assert.equal(reply.budget.value.tape!.money[0].paired!.readings[0].amount,'15000000');
  const scratch=256+[...h.store.authorizedSources(h.board).keys()].reduce((bytes,id)=>bytes+128+id.length*4,0);assert.ok(refused.includes(scratch),'the actual cursor plan reservation was refused');
  assert.equal(used,pinned,'access, plan and response staging are released');pin.close();assert.equal(used,0);
  const recovered=await read(request);assert.equal(recovered.sourceWork?.state,'complete');assert.equal(recovered.quota?.state,'complete');assert.equal(recovered.budget?.state,'complete');assert.equal(used,0);
});

test('a refused source-curve publication cannot escape through a sibling fixed section and recovers after capacity returns',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const start=now-H,tiles=new HistoryTiles(h.store),events=new Events(h.hub,undefined,{now:()=>now,after:()=>()=>{}},null),reader=new PeriodReader(h.hub,tiles,events);
  t.after(()=>events.close());const ceiling=32*1024*1024;let used=0;
  const reservation=tiles.reservation.bind(tiles);
  t.mock.method(tiles,'reservation',()=>{
    const own=reservation();let bytes=0;
    return {add:(size:number)=>{own.add(size);bytes+=size;used+=size;},remove:(size:number)=>{own.remove(size);bytes-=size;used-=size;},close:()=>{own.close();used-=bytes;bytes=0;}};
  });
  const pin=tiles.reservation();t.after(()=>pin.close());
  const wallet=h.store.source('openrouter','fixed-source-wallet',now-3*H);h.store.hold(wallet,h.user.id,now-3*H);
  h.store.record(h.source,{observedAt:start,plan:'',resets:null,staleAfterMs:4*H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:now+H}]});
  const meter=(id:string,at:number,amount:string)=>({id,at,amount,kind:'counter' as const,unit:'USD',stale:false,staleAfterMs:4*H,limit:null,resetAt:null,minutes:null,scope:null,label:null});
  for(const [at,amount] of [[start,'0'],[now-1,'1000000']] as const)h.store.record(wallet,{type:'meters',observedAt:at,staleAfterMs:4*H,meters:[meter('usage',at,amount),meter('credits',at,'15000000')],keys:[],inventoryComplete:true,inventoryError:null});
  for(let i=0;i<128;i++)h.store.creditWork(h.device,start+10*M+i,start+20*M+i,[{source:wallet,client:'opencode',origin:'terminal',project:'P'+i,folder:'',startedAt:start,identity:{kind:'stable',sessionId:String(i)}}]);
  let refused:PeriodCurves['groups']['source']|undefined,reused=0;
  const prepare=PeriodCurves.prepare;
  t.mock.method(PeriodCurves,'prepare',function*(...args:Parameters<typeof prepare>){
    const curves=yield*prepare(...args);
    if(args[0].refs.length===128&&!refused){refused=curves.groups.source;pin.add(ceiling-used-curves.bytes+1);}
    return curves;
  });
  const accounting=PeriodAccounting.prepare;
  t.mock.method(PeriodAccounting,'prepare',function*(...args:Parameters<typeof accounting>){if(refused&&args[6]?.groups.source===refused)reused++;return yield*accounting(...args);});
  const filters=defaultFilters();filters.projects={mode:'include',values:[]};
  const query={cell:String(M),from:String(start),to:String(now),cells:'skip'};
  const request:PeriodRequest={version:1,selection:{mode:'range',from:start,to:now},evaluatedAt:now,workFilter:workFilter(filters),quota:query,budget:{...query,unit:'USD',meters:JSON.stringify([[wallet,'balance']]),work:'1'},values:[h.source]};
  const failed=JSON.parse(reader.read(h.board,h.user.id,request)) as PeriodReply;
  assert.ok(refused);assert.equal(failed.quota?.state,'error');assert.equal(reused,0,'no sibling consumes a candidate whose retained charge failed');
  assert.equal(failed.values?.state,'complete','unrelated values remain independently readable');
  pin.close();assert.equal(used,0,'every failed producer/request reservation is released');
  const recovered=expandPeriod(JSON.parse(reader.read(h.board,h.user.id,request)) as PeriodWireReply);
  assert.equal(recovered.quota?.state,'complete');assert.equal(recovered.budget?.state,'complete');
  if(recovered.budget?.state!=='complete')throw new Error('budget did not recover');
  const value=recovered.budget.value.tape!.fixed!.moneyWork![0];
  assert.equal(value.activeMs,10*M+127);assert.equal(value.selectedWork?.activeMs,0);assert.equal(reused,0);assert.equal(used,0);
});


test('a fixed range summarizes its own work without rewriting the retained live index',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  h.credit(now-2*H,now-30*M);
  const request:PeriodRequest={version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,sessions:{}};
  const initial=(await h.read(request)).json<PeriodReply>().sessions!;if(initial.state!=='complete')throw new Error('baseline');
  const original=h.store.agentWork.bind(h.store),ranges:number[][]=[];
  t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{ranges.push(args.slice(0,2) as number[]);return original(...args);});
  const past={mode:'range' as const,from:now-2*H,to:now-H};
  const extended=(await h.read({...request,selection:past,sessions:{cursor:initial.value.cursor}})).json<PeriodReply>().sessions!;
  if(extended.state!=='complete')throw new Error('fixed range');
  assert.deepEqual(ranges,[[now-2*H-M,now-H+M]]);
  const value=extended.value;
  assert.equal(value.anchor,now-2*H-M);assert.equal(value.cut,now-H+M);assert.deepEqual(value.fixed?.range,{from:past.from,to:past.to});assert.deepEqual(value.spans,[]);
  assert.equal(workedSessions(value,past,now)[0].workedMs,H);
  assert.equal(workedSessions(initial.value,{from:now-H,to:now},now)[0].workedMs,30*M);
  const detailRequest={version:1,selection:past,evaluatedAt:now,cursor:extended.value.cursor,refs:[value.refs[0].ref]};
  const detail=await h.details(detailRequest);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().sessions.value[0].workedMs,H);
  assert.equal((await h.details({...detailRequest,refs:Array(101).fill(value.refs[0].ref)})).statusCode,400);
  h.credit(now-10*M,now-5*M,'another');
  assert.equal((await h.details(detailRequest)).statusCode,200,'later credit outside a fixed cursor’s cut does not revoke its evidence');
  h.credit(now-90*M,now-89*M,'intersecting');assert.equal((await h.details(detailRequest)).statusCode,400,'credit inside its cut revokes a stale detail cursor');
});


test('quota unavailability ends both historical values and exact tape coverage at its exclusive boundary',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const at=now-2*M,boundary=now-M;
  h.store.record(h.source,{observedAt:at,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:now+H}]});
  h.store.db.prepare("INSERT INTO events(source_id,at,kind,detail) VALUES (?,?,'quota_unavailable','')").run(h.source,boundary);
  const request:PeriodRequest={version:1,selection:{mode:'range',from:now-H,to:boundary},evaluatedAt:now,values:[h.source],quota:{cell:String(M),from:String(now-H),to:String(now)}};
  const response=await h.read(request);assert.equal(response.statusCode,200,response.body);
  const reply=response.json<PeriodReply>();if(reply.values?.state!=='complete'||reply.quota?.state!=='complete')throw new Error('period');
  const value=reply.values.value[0].windows[0];assert.equal(value.remaining,83);assert.equal(value.validUntil,boundary);assert.equal(value.stale,true);
  const summary=reply.quota.value.tape!.fixed!.quota[0];assert.equal(summary.remainingAtEnd,null);assert.equal(summary.points.at(-1)![3],boundary);
  const before=periodValues(h.store,h.store.sources(h.board),h.user.id,boundary-1,()=>{})[0];
  assert.equal(before.windows[0].stale,false);assert.equal(before.validFor!.to,boundary);
});


test('heatmap uses the exact common range, filters and one extraction with sessions and facets',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture(now-100*24*H);t.after(async()=>{await h.app.close();h.store.close();});
  for(let i=0;i<4;i++)h.credit(now-3*H,now-H,'parallel'+i);
  h.credit(now-20*24*H,now-20*24*H+H,'outside');
  const original=h.store.agentWork.bind(h.store);let reads=0;t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{reads++;return original(...args);});
  const body:PeriodRequest={version:1,selection:{mode:'range',from:now-2*H+17,to:now-H-23},evaluatedAt:now,calendar:{zone:'UTC'},sessions:{},facets:true};
  const result=await h.read(body);assert.equal(result.statusCode,200,result.body);const reply=expandPeriod(result.json());
  if(reply.calendar?.state!=='complete'||reply.sessions?.state!=='complete'||reply.facets?.state!=='complete')throw new Error('heatmap baseline');
  const total=reply.calendar.value.cells.reduce((n,c)=>n+(c.agentMs??0),0);
  assert.equal(total,4*(H-40));assert.equal(reads,1);assert.deepEqual(reply.calendar.basis.range,reply.basis.range);
  assert.equal(workedSessions(reply.sessions.value,reply.basis.range,now).reduce((n,r)=>n+r.workedMs,0),total);
  assert.deepEqual(reply.facets.value.ranges,[reply.basis.range]);
  const filters=defaultFilters();filters.projects={mode:'include',values:[]};
  const empty=expandPeriod((await h.read({...body,workFilter:workFilter(filters)})).json());
  if(empty.calendar?.state!=='complete')throw new Error('empty heatmap');assert.equal(empty.calendar.value.cells.reduce((n,c)=>n+(c.agentMs??0),0),0);assert.ok(empty.calendar.value.cells.some(c=>c.agentMs===0));
});

test('heatmap-only deltas replace fine intervals, bind selection, and read no financial or presence data',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture(now-100*24*H);t.after(async()=>{await h.app.close();h.store.close();});h.credit(now-30*M,now-20*M);
  for(const method of ['financialGroups','cells'] as const)t.mock.method(h.store,method,()=>{throw new Error('unrelated history');});
  t.mock.method(h.hub.ingest.live,'presenceSnapshot',()=>{throw new Error('no presence dependency');});
  const body:PeriodRequest={version:1,selection:{mode:'range',from:now-H,to:now},evaluatedAt:now,calendar:{zone:'UTC'}};
  const initial=expandPeriod((await h.read(body)).json<PeriodWireReply>());if(initial.calendar?.state!=='complete')throw new Error('baseline');
  h.credit(now-20*M,now-19*M);
  const result=await h.read({...body,calendar:{...body.calendar!,cursor:initial.calendar.value.cursor}});assert.equal(result.statusCode,200,result.body);
  const legacyWire=result.json();assert.equal(legacyWire.calendar.value.relative,undefined,'requests without the capability retain absolute timestamps');
  const delta=expandPeriod(legacyWire);if(delta.calendar?.state!=='delta')throw new Error('delta');
  const opted=await h.read({...body,calendar:{...body.calendar!,cursor:initial.calendar.value.cursor,relative:true}});assert.equal(opted.statusCode,200,opted.body);
  const relativeWire=opted.json();assert.equal(relativeWire.calendar.value.relative,true);assert.deepEqual(expandPeriod(relativeWire).calendar,delta.calendar);
  const cells=initial.calendar.value.cells.slice();for(const [i,c] of delta.calendar.value.updates)cells[i]=c;
  assert.equal(cells.reduce((n,c)=>n+(c.agentMs??0),0),11*M);assert.ok(!result.body.includes('edges'));assert.ok(!result.body.includes('producer'));
  const retry=expandPeriod((await h.read({...body,calendar:{...body.calendar!,cursor:initial.calendar.value.cursor}})).json<PeriodWireReply>());assert.deepEqual(retry.calendar,delta.calendar);
  const foreign=expandPeriod((await h.read({...body,selection:{mode:'range',from:now-2*H,to:now-H},calendar:{...body.calendar!,cursor:initial.calendar.value.cursor}})).json<PeriodWireReply>());assert.equal(foreign.calendar?.state,'complete');
  if(foreign.calendar?.state!=='complete')throw new Error('historical baseline');
  const unchanged=expandPeriod((await h.read({...body,selection:{mode:'range',from:now-2*H,to:now-H},calendar:{zone:'UTC',cursor:foreign.calendar.value.cursor}})).json<PeriodWireReply>());if(unchanged.calendar?.state!=='delta')throw new Error('historical delta');assert.deepEqual(unchanged.calendar.value.updates,[],'time after the fixed endpoint does not dirty padding');
});

test('heatmap request derives its bounded partition and rejects independent reader edges',async t=>{
  t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
  const body:PeriodRequest={version:1,selection:{mode:'live',periodMs:H},evaluatedAt:now,calendar:{zone:'UTC'}};
  for(const calendar of [{zone:'invalid/zone'},{zone:'UTC',edges:[now-H,now]},{zone:'UTC',cursor:'é'},{zone:'UTC',cursor:'x'.repeat(2049)},{zone:'UTC',relative:false},{zone:'UTC',relative:'true'}])assert.equal((await h.read({...body,calendar:calendar as never})).statusCode,400);
  assert.equal((await h.read({...body,selection:{mode:'live',periodMs:32*24*H}})).statusCode,400);
  const first=expandPeriod((await h.read(body)).json<PeriodWireReply>());if(first.calendar?.state!=='complete')throw new Error('availability');
  assert.ok(first.calendar.value.cells.length<=2880);assert.ok(first.calendar.value.cells.some(c=>c.agentMs===0));assert.ok(first.calendar.value.cells.some(c=>c.agentMs===null));
});

test('current-day drill evaluates native states at elapsed time and keeps the full selected date',async t=>{
  const at=Date.UTC(2027,0,1,0,1);t.mock.method(Date,'now',()=>at);const h=await fixture(at-24*H);t.after(async()=>{await h.app.close();h.store.close();});
  const from=at-M,to=from+24*H;
  h.store.record(h.source,{observedAt:from,plan:'',resets:null,staleAfterMs:15*M,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:to+H}]});
  const result=await h.read({version:1,selection:{mode:'range',from,to},evaluatedAt:at,values:[h.source],sessions:{}});assert.equal(result.statusCode,200,result.body);
  const reply=expandPeriod(result.json());assert.deepEqual(reply.basis.range,{from,to});assert.equal(reply.basis.evidenceCut,at);
  if(reply.values?.state!=='complete')throw new Error('values');assert.equal(reply.values.value[0].windows[0].stale,false);assert.equal(reply.values.value[0].windows[0].validUntil,from+15*M+1);
});


test('retention replaces only selected historical intervals while later work stays outside the range',async t=>{
  let at=Date.UTC(2026,10,2,12);t.mock.method(Date,'now',()=>at);const h=await fixture(at-100*24*H);t.after(async()=>{await h.app.close();h.store.close();});
  const oldest=at-90*24*H;h.credit(oldest,oldest+H,'oldest');
  const request:PeriodRequest={version:1,selection:{mode:'range',from:oldest,to:oldest+H},evaluatedAt:at,calendar:{zone:'UTC'}};
  const initial=expandPeriod((await h.read(request)).json<PeriodWireReply>());if(initial.calendar?.state!=='complete')throw new Error('baseline');assert.equal(initial.calendar.value.cells.reduce((n,c)=>n+(c.agentMs??0),0),H);
  at+=10*M;h.credit(at-2*M,at-M,'outside');
  const result=await h.read({...request,evaluatedAt:at,calendar:{zone:'UTC',cursor:initial.calendar.value.cursor}});assert.equal(result.statusCode,200,result.body);
  const reply=expandPeriod(result.json<PeriodWireReply>());if(reply.calendar?.state!=='delta')throw new Error('delta');
  const cells=initial.calendar.value.cells.slice();for(const [i,c] of reply.calendar.value.updates)cells[i]=c;assert.equal(cells.reduce((n,c)=>n+(c.agentMs??0),0),50*M);
  assert.deepEqual(reply.calendar.basis.range,request.selection.mode==='range'?{from:request.selection.from,to:request.selection.to}:null);
});
