import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,M} from './periodRuntimeFixture';

for(const personal of [false,true])test(`unrelated wallet hold, grant and drop leave actual ${personal?'personal':'shared'} table work and HTTP unchanged`,async t=>{
 t.mock.method(Date,'now',()=>NOW);const h=await fixture({personal,ownerDevice:true,tableOnly:true,transportLive:true,current:true,privateWork:true,unknown:true});
 try{
  const key=h.store.workKey(h.board),rows=h.period.get().rows,summary=h.period.activitySummaryAt('project',NOW),wallet=h.store.source('openrouter','e'.repeat(24),NOW-M);
  h.store.hold(wallet,h.owner,NOW-M);h.events.flush();await flush();assert.equal(h.store.workKey(h.board),key);assert.equal(h.requests.length,0);
  if(!personal){h.store.share(h.board,wallet,h.owner,NOW-M);h.events.flush();await flush();assert.equal(h.store.workKey(h.board),key);assert.equal(h.requests.length,0);}
  h.store.release(wallet,h.owner);h.events.flush();await flush();assert.equal(h.store.workKey(h.board),key);assert.equal(h.requests.length,0);
  assert.equal(h.period.get().rows,rows);assert.deepEqual(h.period.activitySummaryAt('project',NOW),summary);assert.equal(rows[0].source,null);assert.equal(rows[0].sourceStatus,undefined,'a NULL raw source is never inferred from the new holding');assert.ok(rows[0].currentPresence);
 }finally{await h.close();}
});

for(const personal of [false,true])test(`related unheld funding changes category and actual ${personal?'personal':'shared'} authority while preserving raw identity and credit`,async t=>{
 t.mock.method(Date,'now',()=>NOW);const h=await fixture({personal,ownerDevice:true,tableOnly:true,transportLive:true,current:true,privateWork:true});
 try{
  const raw=h.store.source('codex','b'.repeat(24),NOW-M),row=h.period.get().rows[0],captured=h.store.workAccess(h.board),key=h.store.workKey(h.board,undefined,captured),gate=h.hold();assert.equal(row.source,null);assert.equal(row.sourceStatus,undefined);
  h.store.hold(raw,h.owner,NOW);h.events.flush();await flush();assert.notEqual(h.store.workKey(h.board),key);assert.equal(h.store.workKey(h.board,undefined,captured),key,'a retained access snapshot never reads the new live revision');assert.equal(h.period.get().rows.length,0);
  gate.release();await flush();let after=h.period.get().rows[0];assert.equal(after.workedMs,row.workedMs);assert.equal(after.ref,row.ref);assert.equal(after.presenceKey,row.presenceKey);assert.ok(after.currentPresence);
  if(personal)assert.equal(after.source,raw);else{
   assert.equal(after.source,null);assert.equal(after.sourceStatus,'notProvided');const heldKey=h.store.workKey(h.board);
   h.store.share(h.board,raw,h.owner,NOW);h.events.flush();await flush();assert.notEqual(h.store.workKey(h.board),heldKey);after=h.period.get().rows[0];assert.equal(after.source,raw);assert.equal(after.ref,row.ref);assert.equal(after.presenceKey,row.presenceKey);
  }
  const providedKey=h.store.workKey(h.board);h.store.release(raw,h.owner);h.events.flush();await flush();assert.notEqual(h.store.workKey(h.board),providedKey);after=h.period.get().rows[0];assert.equal(after.source,null);assert.equal(after.sourceStatus,undefined);assert.equal(after.workedMs,row.workedMs);assert.equal(after.presenceKey,row.presenceKey);assert.ok(after.currentPresence);
 }finally{await h.close();}
});

test('ordinary new contexts and first work on a new held source keep the actual small delta cursor',async t=>{
 t.mock.method(Date,'now',()=>NOW);const h=await fixture({ownerDevice:true,tableOnly:true,transportLive:true});
 try{
  const key=h.store.workKey(h.board),raw=h.store.source('codex','d'.repeat(24),NOW-M);h.store.hold(raw,h.owner,NOW-M);h.events.flush();await flush();assert.equal(h.requests.length,0);assert.equal(h.store.workKey(h.board),key);
  h.store.creditWork(h.device,NOW-M,NOW-30_000,[{source:raw,client:'opencode',origin:'terminal',project:'New',folder:'',startedAt:NOW-M,identity:{kind:'stable',sessionId:'d'.repeat(32)}}]);h.events.flush();await flush();
  assert.equal(h.store.workKey(h.board),key);assert.equal(h.requests.length,1);assert.ok(h.requests[0].sessions?.cursor,'new evidence patches the existing index instead of asking for a full baseline');assert.equal(h.period.get().rows.length,2);assert.equal(h.period.get().rows.find((row:{project:string})=>row.project==='New')!.sourceStatus,'notProvided');
 }finally{await h.close();}
});

test('idle current-only source facts participate in relevant holding and share withdrawal without a second ledger',async t=>{
 t.mock.method(Date,'now',()=>NOW);const h=await fixture({ownerDevice:true,tableOnly:true,transportLive:true});
 try{
  const raw=h.store.source('codex','f'.repeat(24),NOW-M);h.hub.ingest.live.report(h.device,h.owner,[{source:raw,clientId:'opencode',sessionId:'f'.repeat(32),device:{id:h.device,name:'Work laptop'},origin:'terminal',project:'Idle only',folder:null,startedAt:NOW-M,sentStartedAt:NOW-M,lastWorkedAt:null,working:false}],NOW);h.events.flush();await flush();
  assert.equal(h.period.get().rows.length,1);assert.equal(h.period.get().rows[0].project,'Work project');const key=h.store.workKey(h.board),presence=h.page.get().board!.unattributedSessions![0].presenceKey;
  h.store.hold(raw,h.owner,NOW);h.events.flush();await flush();assert.notEqual(h.store.workKey(h.board),key);assert.equal(h.page.get().board!.unattributedSessions![0].sourceStatus,'notProvided');assert.equal(h.page.get().board!.unattributedSessions![0].presenceKey,presence);
  h.store.share(h.board,raw,h.owner,NOW);h.events.flush();await flush();assert.equal(h.page.get().board!.sessions[raw][0].presenceKey,presence);
  const held=h.store.workKey(h.board);h.store.release(raw,h.owner);h.events.flush();await flush();assert.notEqual(h.store.workKey(h.board),held);const unknown=h.page.get().board!.unattributedSessions![0];assert.equal(unknown.sourceStatus,undefined);assert.equal(unknown.presenceKey,presence);assert.equal(h.period.get().rows.length,1,'an idle live context never becomes retained positive work');
 }finally{await h.close();}
});
