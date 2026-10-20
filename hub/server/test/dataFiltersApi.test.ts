import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {buildApp} from '../api.js';
import {Cadence} from '../cadence.js';
import {Duty} from '../duty.js';
import {Ingest} from '../ingest.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';
import {newSecret} from '../domain/auth.js';
import {defaultFilters,type FilterEnvelope,type FilterUpdate} from '../domain/dataFilters.js';
import {EMPTY_VIEW,decodeView,decodeFixedView,encodeFixedView,VIEW_VERSION_HEADER,encodeView,type FixedView} from '../domain/view.js';
import {migrate,STEPS} from '../store/schema.js';

async function fixture(t:TestContext){
  const now=Date.now(),store=new Store(':memory:',now),directory=new Directory(store.db);
  const owner=directory.createUser('owner@fixture.example','Owner','unused',now),member=directory.createUser('member@fixture.example','Member','unused',now);
  const board=directory.createBoard('Shared',owner.id,now);directory.addMember(board.id,member.id,now);
  const source=store.source('claude','test',now);store.hold(source,owner.id,now);store.share(board.id,source,owner.id,now);
  const cookies=new Map<string,string>();for(const user of [owner,member]){const token=newSecret('qt_s');directory.createSession(token,user.id,now,60_000);cookies.set(user.id,'quotum_session='+token);}
  const app=await buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null});
  t.after(async()=>{await app.close();store.close();});
  const get=async(user=owner)=>(await app.inject({method:'GET',url:'/api/boards/'+board.id+'/filters',headers:{cookie:cookies.get(user.id)}})).json<FilterEnvelope>();
  const put=(basis:FilterEnvelope,body:Partial<FilterUpdate>={},user=owner)=>app.inject({method:'PUT',url:'/api/boards/'+board.id+'/filters',headers:{cookie:cookies.get(user.id),origin:'http://localhost','if-match':'"'+basis.revision+'"'},payload:{filters:basis.filters,authority:basis.authority,replace:[],...body}});
  return {now,store,directory,owner,member,board,source,app,cookies,get,put};
}

test('only explicit owner Save adopts opening defaults; revisions and layout saves are independent',async t=>{
  const h=await fixture(t),initial=await h.get(),view=h.directory.viewState(h.board.id);
  assert.equal(initial.revision,0);assert.deepEqual(initial.filters,defaultFilters());
  assert.equal((await h.put(initial,{},h.member)).statusCode,403);
  let reply=await h.put(initial);assert.equal(reply.statusCode,200,reply.body);const saved=reply.json<FilterEnvelope>();assert.equal(saved.revision,1);
  assert.equal((await h.put(initial)).statusCode,409,'two initial equal saves still require CAS');
  reply=await h.put(saved);assert.equal(reply.json().revision,1,'adopted semantic no-op does not increment revision');
  assert.deepEqual(h.directory.viewState(h.board.id),view);
  const change={...view.view,hidden:[...view.view.hidden,'source:'+h.source]};h.directory.saveView(h.board.id,change,h.owner.id,h.now+1);
  assert.deepEqual(await h.get(),saved,'layout does not enter filter authority or revision');
  const draft=structuredClone(saved.filters);draft.sources={mode:'include',values:[]};
  reply=await h.put(saved,{filters:draft,replace:['sources']});assert.equal(reply.statusCode,200);assert.equal(reply.json().revision,2);
  assert.deepEqual(h.directory.view(h.board.id),change);assert.deepEqual((await h.get(h.member)).filters.sources,{mode:'include',values:[]});
});

test('revocation and regrant preserve dormant intent without exposing it in projections',async t=>{
  const h=await fixture(t),initial=await h.get();
  const draft=structuredClone(initial.filters);draft.sources={mode:'exclude',values:[{source:h.source}]};
  let reply=await h.put(initial,{filters:draft,replace:['sources']});assert.equal(reply.statusCode,200);const old=reply.json<FilterEnvelope>();
  h.store.unshare(h.board.id,h.source);
  const revoked=await h.get();assert.equal(revoked.revision,old.revision);assert.notEqual(revoked.authority,old.authority);
  assert.equal(JSON.stringify(revoked).includes(h.source),false);assert.equal(revoked.unavailable.sources,1);
  reply=await h.put(old,{filters:draft,replace:['sources']});assert.equal(reply.statusCode,409);assert.equal(reply.json().error,'filters_context_changed');
  const unrelated=structuredClone(revoked.filters);unrelated.clients={mode:'include',values:['opencode']};
  reply=await h.put(revoked,{filters:unrelated,replace:['clients']});assert.equal(reply.statusCode,200);
  h.store.share(h.board.id,h.source,h.owner.id,h.now+1);
  const regranted=await h.get();assert.deepEqual(regranted.filters.sources,draft.sources);
  reply=await h.put(regranted,{replace:['sources'],resets:{sources:'all'}});assert.equal(reply.statusCode,200);
  assert.deepEqual(reply.json().filters.sources,{mode:'exclude',values:[]});
});

test('filter endpoints enforce membership, origin, preconditions, strict shapes and body limits',async t=>{
  const h=await fixture(t),basis=await h.get(),url='/api/boards/'+h.board.id+'/filters',headers={cookie:h.cookies.get(h.owner.id),origin:'http://localhost'};
  assert.equal((await h.app.inject({method:'GET',url})).statusCode,401);
  assert.equal((await h.app.inject({method:'PUT',url,headers,payload:{filters:basis.filters}})).statusCode,428);
  assert.equal((await h.app.inject({method:'PUT',url,headers:{...headers,'if-match':'"0"'},payload:{filters:basis.filters,replace:[]}})).statusCode,428);
  assert.equal((await h.put(basis,{replace:['sources','sources']})).statusCode,400);
  assert.equal((await h.app.inject({method:'PUT',url,headers:{...headers,origin:'https://foreign.example','if-match':'"0"'},payload:{...basis,replace:[]}})).statusCode,403);
  const large=JSON.stringify({filters:basis.filters,authority:basis.authority,replace:[],padding:'x'.repeat(273*1024)});
  const reply=await h.app.inject({method:'PUT',url,headers:{...headers,'content-type':'application/json','if-match':'"0"'},payload:large});
  assert.equal(reply.statusCode,413);assert.equal(reply.json().error,'filters_limit');assert.equal(h.directory.filtersState(h.board.id).revision,0);
});

test('source mode cycles store private dormant decisions and a reset clears them even with an equal projection',async t=>{
  const h=await fixture(t),other=h.store.source('claude','other-account',h.now);h.store.hold(other,h.owner.id,h.now);h.store.share(h.board.id,other,h.owner.id,h.now);
  const initial=await h.get(),first=structuredClone(initial.filters);first.sources={mode:'exclude',values:[{source:h.source}]};
  assert.equal((await h.put(initial,{filters:first,replace:['sources']})).statusCode,200);
  h.store.unshare(h.board.id,h.source);
  let basis=await h.get(),draft=structuredClone(basis.filters);draft.sources={mode:'include',values:[{source:other}]};
  let reply=await h.put(basis,{filters:draft,replace:['sources']});assert.equal(reply.statusCode,200,reply.body);assert.equal(reply.body.includes(h.source),false);assert.equal(reply.body.includes('retained'),false);
  assert.equal(h.directory.filtersState(h.board.id).retained.length,1);
  basis=reply.json();draft=structuredClone(basis.filters);draft.sources={mode:'exclude',values:[]};
  reply=await h.put(basis,{filters:draft,replace:['sources']});assert.equal(reply.statusCode,200,reply.body);
  h.store.share(h.board.id,h.source,h.owner.id,h.now+1);basis=await h.get();assert.deepEqual(basis.filters.sources,{mode:'exclude',values:[{source:h.source}]});
  h.store.unshare(h.board.id,h.source);basis=await h.get();const revision=basis.revision;
  reply=await h.put(basis,{replace:['sources'],resets:{sources:'all'}});assert.equal(reply.statusCode,200);assert.equal(reply.json().revision,revision+1);assert.deepEqual(h.directory.filtersState(h.board.id).retained,[]);
});

test('layout 32 upgrades window/key choices atomically, keeping hidden geometry and rejecting old writers',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());for(const step of STEPS.slice(0,32))db.exec(step);
  db.exec("PRAGMA user_version=32; INSERT INTO boards VALUES('b','',1,'u',0)");
  const legacy:FixedView={...structuredClone(EMPTY_VIEW),version:4,hidden:['source:wallet'],shown:['budget-history','wallet/key:extra'],windows:['wallet/key:off','claude:a/gemini-2.5:session','claude:a/週期:weekly','antigravity:a/key:session','antigravity:a/scope/key:x:session'],layout:{columns:6,places:{'source:wallet':{x:0,w:3,y:0,h:7},'budget-history':{x:3,w:3,y:1,h:10}}}};
  db.prepare('INSERT INTO views VALUES (?,?,?,?,?)').run('b',JSON.stringify(encodeFixedView(legacy)),'u',0,8);
  assert.ok(decodeFixedView(encodeFixedView(legacy)));assert.equal(decodeView(encodeFixedView(legacy)),null);
  migrate(db,1);const directory=new Directory(db),view=directory.viewState('b'),filters=directory.filtersState('b');
  assert.equal(view.revision,9);assert.equal(view.view.version,5);assert.deepEqual(view.view.windows,[]);assert.deepEqual(view.view.hidden,legacy.hidden);assert.deepEqual(view.view.layout,legacy.layout);
  assert.deepEqual(view.view.shown,['budget-history']);assert.equal(filters.revision,0);
  assert.deepEqual(filters.filters.windows,{mode:'exclude',values:[['antigravity:a','key:session'],['antigravity:a','scope/key:x:session'],['claude:a','gemini-2.5:session'],['claude:a','週期:weekly']]});
  assert.deepEqual(filters.filters.wallet,{mode:'auto',include:[{source:'wallet',kind:'keyCap',key:'extra'}],exclude:[{source:'wallet',kind:'keyCap',key:'off'}]});
  const before=db.prepare('SELECT * FROM views').get();migrate(db,2);assert.deepEqual(db.prepare('SELECT * FROM views').get(),before);
  const h=await fixture(t),state=h.directory.viewState(h.board.id);
  const reply=await h.app.inject({method:'POST',url:'/api/boards/'+h.board.id+'/view',headers:{cookie:h.cookies.get(h.owner.id),origin:'http://localhost',[VIEW_VERSION_HEADER]:'4','if-match':'"'+state.revision+'"'},payload:encodeFixedView({...state.view,version:4})});
  assert.equal(reply.statusCode,428);assert.deepEqual(h.directory.viewState(h.board.id),state);
  assert.equal(decodeView(encodeView({...state.view,windows:['s/week']})),null,'reserved v5 windows cannot become a second selector');
});
