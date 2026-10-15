import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {Projection} from '../projection.js';
import {workedSessions} from '../domain/periodWork.js';
import {expandPeriod,type PeriodWireReply} from '../domain/periodWire.js';
import {PeriodAccounting} from '../domain/periodAccounting.js';
import {compose} from '../domain/history.js';
import {readHistory} from './historyRead.js';
const M=60_000;
import {centralFixture as fixture,at} from './centralFixture.js';

test('shared device session controls use the actual own-device API, CAS, and personal-board restriction',async t=>{
 t.mock.method(Date,'now',()=>at+M);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});const url=`/api/boards/${h.board}/shares`,initial=(await h.call('GET',url)).json().sessionDevices[0];assert.equal(initial.enabled,true);assert.equal((await h.call('GET',url,undefined,true)).json().sessionDevices.length,0);
 const put=(body:object,other=false)=>h.call('PUT',url+`/devices/${h.device.id}/sessions`,body,other);
 assert.equal((await put({enabled:false,expectedRevision:initial.revision},true)).statusCode,404);assert.equal((await put({enabled:false,expectedRevision:initial.revision,extra:true})).statusCode,400);
 const changed=await put({enabled:false,expectedRevision:initial.revision});assert.equal(changed.statusCode,200);assert.equal(changed.json().device.enabled,false);assert.equal((await put({enabled:true,expectedRevision:initial.revision})).statusCode,409);
 const confirmed=(await h.call('GET',url)).json().sessionDevices[0];assert.deepEqual(confirmed,changed.json().device,'GET resolves a lost PUT reply');
 const personal=h.directory.boards(h.owner.id).find(b=>b.personal)!.id;assert.equal((await h.call('PUT',`/api/boards/${personal}/shares/devices/${h.device.id}/sessions`,{enabled:true,expectedRevision:confirmed.revision})).statusCode,403);
});

test('one physical extraction keeps full admitted sessions and independently clipped quota work inside a cell',async t=>{
 t.mock.method(Date,'now',()=>at+M);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});const source=h.store.source('codex','a'.repeat(24),at-M);h.store.hold(source,h.owner.id,at-M);h.store.share(h.board,source,h.owner.id,at+30_000);
 const key={source,client:'opencode',origin:'terminal' as const,project:'P',folder:'wt',startedAt:at,identity:{kind:'stable' as const,sessionId:'private-producer-canary'}};h.store.creditWork(h.device.id,at,at+M,[key]);
 for(const [time,used] of [[at+30_000,10],[at+M-1,20]])h.store.record(source,{observedAt:time,plan:'pro',staleAfterMs:M,resets:null,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used,remaining:100-used,resetAt:null}]});
 let reads=0;const raw=h.store.agentWork.bind(h.store);t.mock.method(h.store,'agentWork',(...args:Parameters<Store['agentWork']>)=>{reads++;return raw(...args);});
 const response=await h.call('POST',`/api/boards/${h.board}/period`,{version:1,selection:{mode:'live',periodMs:60*M},evaluatedAt:at+M,sessions:{},quota:{cell:String(M),from:String(at),to:String(at+M)}});assert.equal(response.statusCode,200);assert.equal(reads,1);
 const reply=expandPeriod(response.json<PeriodWireReply>());if(reply.sessions?.state!=='complete'||reply.quota?.state!=='complete')throw new Error('incomplete');
 assert.equal(workedSessions(reply.sessions.value,reply.basis.range,at+M)[0].workedMs,M);assert.equal(reply.quota.value.tape!.quota[0].workFrom,at+30_000);
 const accounting=new PeriodAccounting(reply.quota.value.tape!,reply.sessions.value);assert.equal(accounting.quotaSummary(source,'w',reply.basis.range)?.work?.ms,30_000);
 const legacy=readHistory(h.store,h.board,at,M,{to:at+M});assert.equal(legacy.activity.agentMs,M);assert.equal(legacy.series[0].work?.ms,30_000);assert.equal(legacy.series[0].work?.agentMs,30_000);
 const chunks=reply.quota.value.chunks;assert.deepEqual(chunks[0].activity.sourceWork,[[source,0,30_000,30_000]]);
 const beforeFixed=reads,fixed=expandPeriod((await h.call('POST',`/api/boards/${h.board}/period`,{version:1,selection:{mode:'range',from:at-15*M+50_000,to:at+50_000},evaluatedAt:at+M,sessions:{},quota:{cell:String(M),from:String(at),to:String(at+M)}})).json<PeriodWireReply>());if(fixed.sessions?.state!=='complete'||fixed.quota?.state!=='complete')throw new Error('incomplete fixed work');
 assert.equal(workedSessions(fixed.sessions.value,fixed.basis.range,at+M)[0].workedMs,50_000);assert.equal(fixed.quota.value.tape!.fixed!.quota.find(series=>series.sourceId===source&&series.windowId==='w')?.work?.ms,20_000,'fixed summaries keep the separate inside-cell source-grant boundary');assert.equal(reads,beforeFixed+1,'each composite read still extracts its raw ledger once');

 if(!('known' in reply.quota.value))throw new Error('missing metadata');
 const decoded=compose(chunks,reply.quota.value,{cell:M,k0:at/M,k1:at/M,length:M,live:true,key:'',now:at+M},new Set([`${source} w`]));assert.equal(decoded.activity.agentMs,M);assert.equal(decoded.series[0].work?.ms,30_000);assert.ok(!response.body.includes('private-producer-canary'));
});

test('source disclosure moves to neutral fallback without changing immutable presence or admitted cohort',async t=>{
 t.mock.method(Date,'now',()=>at+M);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});const source=h.store.source('codex','c'.repeat(24),at);h.store.hold(source,h.owner.id,at);h.store.share(h.board,source,h.owner.id,at);
 const current={source,clientId:'opencode',sessionId:'b'.repeat(32),device:{id:h.device.id,name:'Laptop'},origin:'terminal' as const,project:'P',folder:'wt',startedAt:at,sentStartedAt:at,lastWorkedAt:at,working:true};h.hub.ingest.live.report(h.device.id,h.owner.id,[current,{...current,source:null,sessionId:'d'.repeat(32)}],at);
 let admissions=0;const originalAccess=h.store.workAccess.bind(h.store);t.mock.method(h.store,'workAccess',(...args:Parameters<Store['workAccess']>)=>{admissions++;return originalAccess(...args);});const projection=new Projection(h.hub),before=projection.snapshot(h.reader.id,h.board,at)!;assert.equal(admissions,1,'one snapshot shares its admission across roster, cards and authority');assert.equal(before.sessions[source].length,1);assert.equal(before.unattributedSessions.length,1);const binding=before.sessions[source][0].presenceKey;
 h.store.creditWork(h.device.id,at,at+M,[{source,client:'opencode',origin:'terminal',project:'P',folder:'wt',startedAt:at,identity:{kind:'stable',sessionId:'b'.repeat(32)}}]);
 h.store.unshare(h.board,source);const after=projection.snapshot(h.reader.id,h.board,at)!;assert.equal(after.unattributedSessions.length,2);assert.equal(after.unattributedSessions[0].presenceKey,binding);assert.equal(after.unattributedSessions[0].sourceStatus,'notProvided');assert.ok(!JSON.stringify(after).includes(source));
 const retainedReply=expandPeriod((await h.call('POST',`/api/boards/${h.board}/period`,{version:1,selection:{mode:'live',periodMs:60*M},evaluatedAt:at+M,sessions:{}})).json<PeriodWireReply>());if(retainedReply.sessions?.state!=='complete')throw new Error('missing retained source context');const retainedRef=retainedReply.sessions.value.refs[0];assert.equal(retainedRef.source,null);assert.equal(retainedRef.sourceStatus,'notProvided');assert.equal(retainedRef.presenceKey,binding);assert.equal(retainedRef.currentPresence?.working,true);
 const policy=h.store.sessionDevices(h.board,h.owner.id)[0];h.store.setDeviceSessions(h.board,h.device.id,h.owner.id,false,policy.revision,at);const off=projection.snapshot(h.reader.id,h.board,at)!;assert.deepEqual(off.unattributedSessions,[]);
 const response=await h.call('POST',`/api/boards/${h.board}/period`,{version:1,selection:{mode:'live',periodMs:60*M},evaluatedAt:at+M,sessions:{}});const reply=expandPeriod(response.json<PeriodWireReply>());assert.equal(reply.sessions?.state,'complete');if(reply.sessions?.state==='complete'){assert.equal(reply.sessions.value.available,false);assert.equal(reply.sessions.value.knownFrom,at+M);}
});


test('source-less device onboarding uses its durable receipt, completes without view placement and releases the pending limit',async t=>{
 t.mock.method(Date,'now',()=>at+M);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
 const view=h.directory.view(h.board),revision=h.directory.viewRevision(h.board),requestId=randomUUID();
 assert.equal((await h.call('POST','/api/additions',{requestId:randomUUID(),boardId:h.board,item:{kind:'sources',sourceIds:[]}})).statusCode,400);
 const reserved=await h.call('POST','/api/device-onboarding',{requestId,boardId:h.board});assert.equal(reserved.statusCode,200);const intent=reserved.json();
 for(let i=0;i<19;i++)assert.equal((await h.call('POST','/api/device-onboarding',{requestId:randomUUID(),boardId:h.board})).statusCode,200);
 assert.equal((await h.call('POST','/api/device-onboarding',{requestId:randomUUID(),boardId:h.board})).statusCode,429);
 const selection={requestId:randomUUID(),deviceId:h.device.id,sourceIds:[]},url=`/api/device-onboarding/${intent.id}/selection`,selected=await h.call('POST',url,selection);assert.equal(selected.statusCode,200);const operation=selected.json();assert.equal(operation.deviceId,h.device.id);
 assert.equal((await h.call('POST',url,selection)).json().id,operation.id,'a lost selection reply reuses the frozen receipt');
 const completed=await h.call('POST',`/api/additions/${operation.id}/run`,{});assert.equal(completed.statusCode,200);assert.equal(completed.json().state,'complete');assert.deepEqual(completed.json().result.sourceIds,[]);
 assert.equal((await h.call('GET',`/api/device-onboarding/${intent.id}`)).json().status,'complete');
 assert.equal((await h.call('POST','/api/device-onboarding',{requestId:randomUUID(),boardId:h.board})).statusCode,200,'completing the empty receipt frees its intent slot');
 assert.equal((await h.call('POST',`/api/additions/${operation.id}/run`,{})).json().state,'complete');assert.equal((await h.call('POST',url,selection)).json().deviceId,h.device.id);
 assert.equal(h.directory.viewRevision(h.board),revision);assert.deepEqual(h.directory.view(h.board),view);assert.deepEqual(h.store.sources(h.board),[]);
 const recovered=(await h.call('GET','/api/additions?limit=20')).json().operations.find((o:{id:string})=>o.id===operation.id);assert.equal(recovered.deviceId,h.device.id);assert.equal(recovered.state,'complete');
 assert.equal((await h.call('GET',`/api/additions/${operation.id}`,undefined,true)).statusCode,404,'device receipt is owner-private');
});

test('source holdings outside the admitted-owner cohort cannot change work authority or expire its actual period cursor',async t=>{
 t.mock.method(Date,'now',()=>at+M);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});const source=h.store.source('codex','d'.repeat(24),at-M);h.store.hold(source,h.owner.id,at-M);h.store.share(h.board,source,h.owner.id,at-M);
 h.store.creditWork(h.device.id,at,at+M,[{source,client:'opencode',origin:'terminal',project:'P',folder:'',startedAt:at,identity:{kind:'stable',sessionId:'b'.repeat(32)}}]);
 const body={version:1,selection:{mode:'live',periodMs:60*M},evaluatedAt:at+M,sessions:{}},first=expandPeriod((await h.call('POST',`/api/boards/${h.board}/period`,body)).json<PeriodWireReply>());if(first.sessions?.state!=='complete')throw new Error('missing baseline');
 const cursor=first.sessions.value.cursor,key=h.store.workKey(h.board),outsider=h.directory.createUser('outside@example.test','Outside','x',at-M);
 for(const user of [outsider.id,h.reader.id]){
   h.store.hold(source,user,at);const access=h.store.workAccess(h.board);assert.deepEqual([...access.sources.get(source)!.holders],[h.owner.id],'nonmembers and members without admitted devices allocate no work holder dependency');assert.equal(h.store.workKey(h.board),key);
   const next=expandPeriod((await h.call('POST',`/api/boards/${h.board}/period`,{...body,sessions:{cursor}})).json<PeriodWireReply>());assert.equal(next.sessions?.state,'delta');
   h.store.release(source,user);assert.equal(h.store.workKey(h.board),key);
 }
 h.store.release(source,h.owner.id);assert.notEqual(h.store.workKey(h.board),key,'the captured device owner’s holding changes actual funding disclosure');const changed=expandPeriod((await h.call('POST',`/api/boards/${h.board}/period`,{...body,sessions:{cursor}})).json<PeriodWireReply>());assert.equal(changed.sessions?.state,'complete');
});

test('related funding revisions commit atomically, remain immutable in captured access and are deleted with their board',async t=>{
 t.mock.method(Date,'now',()=>at+M);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});const source=h.store.source('codex','f'.repeat(24),at);
 h.store.creditWork(h.device.id,at,at+M,[{source,client:'opencode',origin:'terminal',project:'P',folder:'',startedAt:at,identity:{kind:'stable',sessionId:'f'.repeat(32)}}]);
 const captured=h.store.workAccess(h.board),before=h.store.workKey(h.board,undefined,captured);
 assert.throws(()=>h.directory.transaction(()=>{h.store.hold(source,h.owner.id,at+M);throw new Error('rollback');}),/rollback/);assert.equal(h.store.holds(h.owner.id,source),false);assert.equal(h.store.workKey(h.board),before);
 h.store.hold(source,h.owner.id,at+M);const held=h.store.workKey(h.board);assert.notEqual(held,before);assert.equal(h.store.workKey(h.board,undefined,captured),before);
 h.store.hold(source,h.owner.id,at+M);assert.equal(h.store.workKey(h.board),held,'a no-op holding never advances funding authority');
 h.store.share(h.board,source,h.owner.id,at+M);const shared=h.store.workKey(h.board);h.store.share(h.board,source,h.owner.id,at+M);assert.equal(h.store.workKey(h.board),shared,'a no-op share keeps authority');
 h.store.release(source,h.owner.id);assert.equal(h.store.sources(h.board).length,0,'orphan cleanup withdraws the supplied association');assert.notEqual(h.store.workKey(h.board),shared);
 assert.ok(h.store.db.prepare("SELECT value FROM meta WHERE key=?").get('workFunding::'+h.board));h.directory.deleteBoard(h.board);assert.equal(h.store.db.prepare("SELECT value FROM meta WHERE key=?").get('workFunding::'+h.board),undefined);
});

test('provided quota sources without admitted devices preserve the empty work cursor until device admission',async t=>{
 t.mock.method(Date,'now',()=>at+M);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});const policy=h.store.sessionDevices(h.board,h.owner.id)[0],off=h.store.setDeviceSessions(h.board,h.device.id,h.owner.id,false,policy.revision,at);
 const body={version:1,selection:{mode:'live',periodMs:60*M},evaluatedAt:at+M,sessions:{}},first=expandPeriod((await h.call('POST',`/api/boards/${h.board}/period`,body)).json<PeriodWireReply>());if(first.sessions?.state!=='complete')throw new Error('missing baseline');const cursor=first.sessions.value.cursor,key=h.store.workKey(h.board),source=h.store.source('codex','e'.repeat(24),at);
 h.store.hold(source,h.owner.id,at);h.store.share(h.board,source,h.owner.id,at);assert.equal(h.store.workAccess(h.board).sources.get(source)!.holders.size,0);assert.equal(h.store.workKey(h.board),key,'a provided source has no work coverage while every device is OFF');
 const next=expandPeriod((await h.call('POST',`/api/boards/${h.board}/period`,{...body,sessions:{cursor}})).json<PeriodWireReply>());assert.equal(next.sessions?.state,'delta');
 h.store.setDeviceSessions(h.board,h.device.id,h.owner.id,true,off.revision,at+M);assert.notEqual(h.store.workKey(h.board),key);const admitted=expandPeriod((await h.call('POST',`/api/boards/${h.board}/period`,{...body,sessions:{cursor}})).json<PeriodWireReply>());assert.equal(admitted.sessions?.state,'complete');
});
