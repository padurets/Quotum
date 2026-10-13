import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {ResetFeed} from '../resets.js';
import {Events,type Frame} from '../events.js';
import {HistoryTiles,HistoryLimit} from '../history.js';
import {PeriodReader} from '../periodRead.js';
import {config} from '../config.js';
import {Projection} from '../projection.js';
import type {Hub} from '../api.js';
const at=Date.UTC(2026,9,12,12),M=60_000;
function fixture(){
 const store=new Store(':memory:',at-120*M),directory=new Directory(store.db),owner=directory.createUser('one@example.test','One','x',at-120*M),reader=directory.createUser('two@example.test','Two','x',at-120*M),board=directory.createBoard('Team',owner.id,at-120*M).id;directory.addMember(board,reader.id,at-120*M);
 const device=directory.saveDevice({userId:owner.id,machine:{id:'machine-0123456789',name:'Laptop',os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},at-120*M).id;
 const hub={store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{})} as Hub;
 const events=new Events(hub,{...config.events,recheckMs:0},{now:()=>at,after:()=>()=>{}},null),tiles=new HistoryTiles(store),period=new PeriodReader(hub,tiles,events);events.attach();events.onClientHistory=(user,since,device)=>{tiles.touchClient(user,since,device);period.touchClient(user,since,device);};events.onHistory=(source,since,scopes,work)=>{tiles.touch(source,since,scopes);period.touch(source,since,scopes,work);};
 directory.createSession('synthetic-reader',reader.id,at-120*M,86_400_000);const reading={user:reader.id,secret:'synthetic-reader',board};
 const credit=(from:number,to:number,source:string|null=null)=>store.creditWork(device,from,to,[{source,client:'opencode',origin:'terminal',project:'P',folder:'wt',startedAt:at-120*M,identity:{kind:'stable',sessionId:'b'.repeat(32)}}]);
 const toggle=(enabled:boolean)=>store.setDeviceSessions(board,device,owner.id,enabled,store.sessionDevices(board,owner.id)[0].revision,at);
 return {hub,store,directory,owner,reader,board,device,events,tiles,period,reading,credit,toggle,close:()=>{events.close();store.close();}};
}

test('source-less boards receive work news and closed empty tiles invalidate without watchers',t=>{
 const h=fixture();t.after(h.close);const read=()=>h.tiles.read(h.board,M,at-60*M,at,at,h.store.shown(h.board,[]));assert.equal(JSON.parse(read()[0]).activity.cells.length,0);let calls=0;const original=h.store.cells.bind(h.store);t.mock.method(h.store,'cells',(...args:Parameters<Store['cells']>)=>{calls++;return original(...args);});h.credit(at-30*M,at-M);assert.ok(JSON.parse(read()[0]).activity.cells.length>0);assert.equal(calls,1);
 const frames:Frame[]=[],opened=h.events.open({...h.reading,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});assert.ok(opened&&opened!=='limit');h.credit(at-M,at-30_000);h.events.flush();const history=frames.filter(f=>f.type==='history').map(f=>JSON.parse(f.data));assert.equal(history.length,1);assert.deepEqual(history[0].sources,[]);assert.equal(history[0].workSince,at-M);assert.equal(history[0].workAuthority,h.store.workKey(h.board));
});

for(const flush of [false,true])test(`queued poll work is withdrawn ${flush?'after':'before'} producer flush, including same-clock OFF/ON`,async t=>{
 const h=fixture();t.after(h.close);const first=await h.events.poll(h.reading,undefined);assert.ok(first&&first!=='limit');h.credit(at-M,at-30_000);h.events.flush();h.toggle(false);if(flush)h.events.flush();const off=await h.events.poll(h.reading,first.lease);assert.ok(off&&off!=='limit');assert.deepEqual(off.frames.map(f=>f.type),['snapshot']);const value=JSON.parse(off.frames[0].data);assert.deepEqual(value,new Projection(h.hub).snapshot(h.reader.id,h.board,at));assert.deepEqual(value!.unattributedSessions,[]);
 h.toggle(true);const on=await h.events.poll(h.reading,first.lease);assert.ok(on&&on!=='limit');assert.deepEqual(on.frames.map(f=>f.type),['snapshot']);assert.notEqual(JSON.parse(on.frames[0].data).workAuthority,value!.workAuthority);
});

test('a later SSE reader rechecks session authority after an earlier reader revokes it',t=>{
 const h=fixture();t.after(h.close);let revoke=false;const open=(send:(batch:Frame[])=>void)=>{const value=h.events.open({...h.reading,kind:'stream',send,end:()=>{}});assert.ok(value&&value!=='limit');};open(()=>{if(revoke){revoke=false;h.toggle(false);}});const later:Frame[]=[];open(batch=>later.push(...batch));
 h.hub.ingest.live.report(h.device,h.owner.id,[{source:null,clientId:'opencode',sessionId:'b'.repeat(32),device:{id:h.device,name:'Laptop'},origin:'terminal',project:'P',folder:'wt',startedAt:at-M,sentStartedAt:at-M,lastWorkedAt:at,working:true}],at);revoke=true;h.events.flush();assert.deepEqual(later.map(f=>f.type),['snapshot']);assert.deepEqual(JSON.parse(later[0].data).unattributedSessions,[]);
});

test('resource visibility and financial grants preserve the session cursor while a device revoke retires it',t=>{
 t.mock.method(Date,'now',()=>at);const h=fixture();t.after(h.close);const source=h.store.source('codex','a'.repeat(24),at-M);h.store.hold(source,h.owner.id,at-M);h.store.share(h.board,source,h.owner.id,at-M);h.credit(at-M,at-30_000,source);
 const body={version:1,selection:{mode:'live',periodMs:60*M},evaluatedAt:at,sessions:{}};const first=JSON.parse(h.period.read(h.board,h.reader.id,body));const cursor=first.sessions.value.cursor;
 h.store.setBudget(h.board,source,h.owner.id,true,h.store.sources(h.board)[0].budget!.revision,at);h.directory.saveView(h.board,{...h.directory.view(h.board),hidden:['source:'+source]},h.owner.id,at);
 const still=JSON.parse(h.period.read(h.board,h.reader.id,{...body,sessions:{cursor}}));assert.equal(still.sessions.state,'delta');assert.equal(still.sessions.value.refs.length,0);
 h.toggle(false);const gone=JSON.parse(h.period.read(h.board,h.reader.id,{...body,sessions:{cursor}}));assert.equal(gone.sessions.state,'complete');assert.equal(gone.sessions.value.available,false);assert.deepEqual(gone.sessions.value.refs,[]);
});

test('session revoke is the first SSE delivery and removes the complete old cohort and presence',t=>{
 const h=fixture();t.after(h.close);h.hub.ingest.live.report(h.device,h.owner.id,[{source:null,clientId:'opencode',sessionId:'b'.repeat(32),device:{id:h.device,name:'Laptop'},origin:'terminal',project:'P',folder:'wt',startedAt:at-M,sentStartedAt:at-M,lastWorkedAt:at,working:true}],at);
 const frames:Frame[]=[],opened=h.events.open({...h.reading,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});assert.ok(opened&&opened!=='limit');assert.equal(JSON.parse(opened.frames[1].data).unattributedSessions.length,1);
 h.toggle(false);h.events.flush();assert.deepEqual(frames.map(f=>f.type),['snapshot']);const current=JSON.parse(frames[0].data);assert.deepEqual(current.unattributedSessions,[]);assert.deepEqual(current.sessions,{});assert.equal(current.workAuthority,h.store.workKey(h.board));
});

test('late pre-grant work news starts at admission instead of exposing the private capture endpoint',t=>{
 const h=fixture();t.after(h.close);h.toggle(false);h.toggle(true);const frames:Frame[]=[],opened=h.events.open({...h.reading,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});assert.ok(opened&&opened!=='limit');h.credit(at-10*M,at+M);h.events.flush();const change=JSON.parse(frames.find(f=>f.type==='history')!.data);assert.equal(change.workSince,at);assert.equal(change.since,at);assert.deepEqual(change.sources,[]);assert.ok(!JSON.stringify(change).includes(String(at-10*M)));
});

test('empty closed tiles charge retained device dependencies; financial tiles keep no work dependencies',t=>{
 const h=fixture();t.after(h.close);for(let i=0;i<100;i++)h.directory.saveDevice({userId:h.owner.id,machine:{id:'extra-machine-'+i,name:'Saved '+i,os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},at-M);
 const cache=new HistoryTiles(h.store,5000);let reads=0;const cells=h.store.cells.bind(h.store);t.mock.method(h.store,'cells',(...args:Parameters<Store['cells']>)=>{reads++;return cells(...args);});
 const read=(scope?:'budget')=>cache.read(h.board,M,at-60*M,at,at,h.store.shown(h.board,[]),undefined,scope);
 assert.throws(()=>read(),HistoryLimit);assert.throws(()=>read(),HistoryLimit);assert.equal(reads,0,'an over-budget access snapshot fails before cells or cache allocation');read('budget');read('budget');assert.equal(reads,1,'budget-only tiles retain their independent small footprint');
 const bounded=new HistoryTiles(h.store,5000),reader=new PeriodReader(h.hub,bounded,h.events),body={version:1,selection:{mode:'live',periodMs:60*M},evaluatedAt:at,sessions:{},budget:{cell:String(M),from:String(at-M),to:String(at),unit:'USD',meters:'[]'}};
 const result=JSON.parse(reader.read(h.board,h.reader.id,body));assert.equal(result.sessions.state,'error');assert.equal(result.sessions.error,'history_limit');assert.equal(result.budget.state,'complete');assert.equal(JSON.parse(reader.read(h.board,h.reader.id,{...body,sessions:undefined})).budget.state,'complete','failed snapshot reservations are released');
});

test('financial period cursors survive unrelated work journal overflow without allocating a work snapshot',t=>{
 const h=fixture();t.after(h.close);const source=h.store.source('openrouter','d'.repeat(24),at-M);h.store.hold(source,h.owner.id,at-M);h.store.share(h.board,source,h.owner.id,at-M);
 h.store.record(source,{type:'meters',observedAt:at-M,staleAfterMs:60*M,meters:[{id:'balance:USD',kind:'balance',unit:'USD',amount:'37000000',at:at-M,staleAfterMs:60*M,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null}],keys:[],inventoryComplete:true,inventoryError:null});
 t.mock.method(h.store,'workAccess',()=>{throw new Error('financial reads cannot allocate work admission');});
 const body={version:1,selection:{mode:'live',periodMs:60*M},evaluatedAt:at,budget:{cell:String(M),from:String(at-M),to:String(at),unit:'USD',currency:'USD',meters:JSON.stringify([[source,'balance:USD']])}},first=JSON.parse(h.period.read(h.board,h.reader.id,body));assert.equal(first.budget.state,'complete');assert.equal(first.budget.value.tape.money[0].readings[0].amount,'37000000');
 for(let i=0;i<2100;i++)h.period.touchClient('another-owner',at-M);
 const next=JSON.parse(h.period.read(h.board,h.reader.id,{...body,budget:{...body.budget,evidence:first.budget.value.tape.cursor}}));assert.equal(next.budget.state,'complete');assert.equal(next.budget.value.tape.replaceTo,at,'unrelated work retirement cannot force a new financial baseline');assert.deepEqual(next.budget.value.tape.money,[]);
});
