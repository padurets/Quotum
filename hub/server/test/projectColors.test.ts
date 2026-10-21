import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {STEPS,migrate} from '../store/schema.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {centralFixture,at} from './centralFixture.js';
import {newSecret} from '../domain/auth.js';
import {CATEGORY_COLORS} from '../domain/categoryColors.js';
import {parseProjectColors,PROJECT_COLOR_BYTES,PROJECT_COLOR_PIN_LIMIT,type ProjectColorEnvelope} from '../domain/projectColors.js';
import {readProjectColors,saveProjectColors} from '../store/projectColors.js';
import {ProjectColors} from '../projectColors.js';
import {Events,sse,type Frame} from '../events.js';
import {Projection} from '../projection.js';
import {buildApp} from '../api.js';
import {KEEP_MS} from '../sessions.js';

const M=60_000;
async function fixture(){
  const f=await centralFixture(),token=newSecret('qt_s'),memberToken=newSecret('qt_s');
  f.directory.createSession(token,f.owner.id,Date.now(),86_400_000);
  f.directory.createSession(memberToken,f.reader.id,Date.now(),86_400_000);
  const url=`/api/boards/${f.board}/project-colors`;
  const request=(method:'GET'|'PUT'|'POST',suffix='',body?:object,revision?:number,member=false)=>f.app.inject({method,url:url+suffix,payload:body,
    headers:{cookie:`quotum_session=${member?memberToken:token}`,...(revision===undefined?{}:{'if-match':`"${revision}"`})}});
  const get=async()=>(await request('GET')).json<ProjectColorEnvelope>();
  const pin=async(project:string,color:string|null,current?:ProjectColorEnvelope)=>{const e=current??await get();return request('PUT','',{version:1,authority:e.authority,project,color},e.revision);};
  const credit=(names:string[],device=f.device.id)=>f.store.creditWork(device,at,at+M,names.map((project,i)=>({source:null,client:'codex',origin:'terminal' as const,startedAt:at,project,folder:'',identity:{kind:'legacy' as const,ordinal:i}})));
  const aliases=(suffix:string,payload:object)=>f.app.inject({method:'POST',url:'/api/projects'+suffix,payload,headers:{cookie:`quotum_session=${token}`}});
  return {...f,request,get,pin,credit,aliases,sessionSecret:token};
}

test('exact names and repeated swatches share one bounded canonical codec',()=>{
  assert.equal(PROJECT_COLOR_PIN_LIMIT,89);
  const names=['__proto__','constructor','a\n\u0001','trailing ','😀','"\\'];
  assert.deepEqual(parseProjectColors({version:1,pins:names.map(name=>[name,CATEGORY_COLORS[0]])})?.pins.map(([name])=>name).sort(),names.sort());
  for(const pins of [[['A',CATEGORY_COLORS[0]],['A',CATEGORY_COLORS[1]]],[[null,CATEGORY_COLORS[0]]],[['A','#ffffff']],[['A'.repeat(121),CATEGORY_COLORS[0]]]])assert.equal(parseProjectColors({version:1,pins}),null);
  assert.equal(parseProjectColors({version:1,pins:[],extra:1}),null);
  const pins=Array.from({length:89},(_,i)=>[String.fromCharCode(i+1)+'\u0001'.repeat(119),CATEGORY_COLORS[0]]);
  assert.ok(parseProjectColors({version:1,pins}));
  assert.ok(Buffer.byteLength(JSON.stringify({version:1,pins}))<=PROJECT_COLOR_BYTES);
  assert.equal(parseProjectColors({version:1,pins:[...pins,['ninety',CATEGORY_COLORS[0]]]}),null);
});

test('owner patches preserve dormant pins, reject stale writers and leave work and layout alone',async t=>{
  const f=await fixture();t.after(async()=>{await f.app.close();f.store.close();});
  f.credit(['A','B','__proto__']);
  const original=await f.get(),work=f.store.workKey(f.board),layout=f.directory.viewState(f.board);
  assert.deepEqual(original.pins,[]);assert.equal(original.revision,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM board_project_colors').get()!.n,0);
  assert.equal((await f.pin('A',CATEGORY_COLORS[0],original)).statusCode,200);
  assert.equal((await f.pin('B',CATEGORY_COLORS[0])).statusCode,200);
  const current=await f.get();assert.equal(current.revision,2);assert.equal(current.pins.length,2);
  assert.equal((await f.pin('B',CATEGORY_COLORS[0])).json().revision,2);
  const stale=await f.pin('__proto__',CATEGORY_COLORS[1],original);assert.equal(stale.statusCode,409);assert.equal(stale.json().error,'project_colors_conflict');
  assert.equal((await f.pin('absent',CATEGORY_COLORS[1])).statusCode,400);
  assert.equal((await f.request('PUT','',{version:1,project:'A',color:CATEGORY_COLORS[1],authority:current.authority},current.revision,true)).statusCode,403);
  f.directory.saveView(f.board,layout.view,f.owner.id,Date.now());
  assert.deepEqual((await f.get()).pins,current.pins);assert.equal(f.store.workKey(f.board),work);
  assert.deepEqual(layout.view,f.directory.viewState(f.board).view);
  f.store.setDeviceSessions(f.board,f.device.id,f.owner.id,false,f.store.sessionDevices(f.board,f.owner.id)[0].revision,Date.now());
  const hidden=await f.get();assert.deepEqual(hidden.pins,[]);
  assert.equal(readProjectColors(f.store.db,f.board).pins.length,2);
  const conflict=await f.pin('A',CATEGORY_COLORS[1],current);assert.equal(conflict.statusCode,409);assert.ok(!conflict.body.includes('"A"'));
  const reset=await f.request('POST','/reset',{version:1,authority:hidden.authority},hidden.revision);
  assert.equal(reset.statusCode,200);assert.deepEqual(reset.json().pins,[]);assert.equal(reset.json().revision,3);
  assert.equal((await f.request('POST','/reset',{version:1,authority:reset.json().authority},3)).json().revision,3);
  assert.equal(readProjectColors(f.store.db,f.board).pins.length,0);
});

test('capacity counts dormant assignments and reset recovers it without revealing their names',async t=>{
  const f=await fixture();t.after(async()=>{await f.app.close();f.store.close();});f.credit(['visible']);
  const pins=Array.from({length:89},(_,i):[string,typeof CATEGORY_COLORS[0]]=>['private-'+i,CATEGORY_COLORS[0]]);
  saveProjectColors(f.store.db,f.board,pins,f.owner.id,at);
  const e=await f.get();assert.deepEqual(e.pins,[]);
  const full=await f.pin('visible',CATEGORY_COLORS[1],e);assert.equal(full.statusCode,413);assert.equal(full.json().error,'project_colors_limit');assert.ok(!full.body.includes('private-'));
  assert.deepEqual(readProjectColors(f.store.db,f.board).pins,pins.sort(([a],[b])=>a<b?-1:1));
  assert.equal((await f.request('POST','/reset',{version:1,authority:e.authority},e.revision)).statusCode,200);
  assert.equal((await f.pin('visible',CATEGORY_COLORS[1])).statusCode,200);
});

test('choices page admitted retained work literally and cursors bind context, board and search',async t=>{
  const f=await fixture();t.after(async()=>{await f.app.close();f.store.close();});
  const names=Array.from({length:57},(_,i)=>'Project '+String(i).padStart(2,'0'));f.credit([...names,'literal%_','ordinary']);
  const first=(await f.request('GET','/choices')).json();assert.equal(first.projects.length,50);assert.ok(first.nextCursor);
  const second=(await f.request('GET','/choices?cursor='+encodeURIComponent(first.nextCursor))).json();assert.equal(second.projects.length,9);assert.equal(second.nextCursor,undefined);
  assert.deepEqual((await f.request('GET','/choices?query=%25_')).json().projects,['literal%_']);
  assert.equal((await f.request('GET','/choices?query=other&cursor='+encodeURIComponent(first.nextCursor))).statusCode,400);
  f.store.setDeviceSessions(f.board,f.device.id,f.owner.id,false,f.store.sessionDevices(f.board,f.owner.id)[0].revision,Date.now());
  const revoked=await f.request('GET','/choices?cursor='+encodeURIComponent(first.nextCursor));assert.equal(revoked.statusCode,409);assert.ok(!revoked.body.includes('Project '));
});

test('one private key gives stable authority, while a new hub preserves pins and retires old intent',async t=>{
  const f=await fixture();t.after(async()=>{await f.app.close();f.store.close();});f.credit(['A']);await f.pin('A',CATEGORY_COLORS[0]);
  const a=f.hub.projectColors!,e=a.context(f.board).envelope;
  assert.equal(a.context(f.board).envelope.authority,e.authority);
  const restarted=new ProjectColors(f.store,f.hub.ingest),next=restarted.context(f.board).envelope;
  assert.equal(next.revision,e.revision);assert.deepEqual(next.pins,e.pins);assert.notEqual(next.authority,e.authority);
  assert.notEqual(a.context(f.directory.boards(f.owner.id)[0].id).envelope.authority,e.authority);
});

test('browser configuration is separate and colour-only events never reach native readers',async t=>{
  const f=await fixture();t.after(async()=>{await f.app.close();f.store.close();});f.credit(['A']);
  const events=new Events(f.hub,undefined,{now:()=>at+M,after:()=>()=>{}},null);events.attach();t.after(()=>events.close());
  const browser:Frame[]=[],native:Frame[]=[];
  const base={user:f.owner.id,secret:'local',board:f.board,kind:'stream' as const,end:()=>{}};
  // Local-only transport guards are exercised separately; this tests the shared delivery projection.
  const browserOpen=events.open({...base,send:frames=>browser.push(...frames)}),nativeOpen=events.open({...base,desktop:true,send:frames=>native.push(...frames)});
  assert.ok(browserOpen&&browserOpen!=='limit');assert.ok(nativeOpen&&nativeOpen!=='limit');
  assert.ok(browserOpen.frames.some(frame=>frame.type==='projectColors'));
  assert.ok(!JSON.stringify(nativeOpen.frames).includes('projectColors'));
  browser.length=0;native.length=0;
  const work=f.store.workKey(f.board);await f.pin('A',CATEGORY_COLORS[0]);events.flush();
  assert.ok(browser.some(frame=>frame.type==='projectColors'));assert.ok(!browser.some(frame=>frame.type==='history'));
  assert.deepEqual(native,[]);assert.equal(f.store.workKey(f.board),work);
  const snapshot=new Projection(f.hub).snapshot(f.owner.id,f.board,at+M)!;
  assert.ok(snapshot.projectColorsAuthority);assert.equal('projectColors' in snapshot,false);
});

test('whole renames and restores transfer once on personal and unwatched device-only shared boards',async t=>{
  const f=await fixture();t.after(async()=>{await f.app.close();f.store.close();});f.credit(['A']);
  const personal=f.directory.boards(f.owner.id).find(board=>board.personal)!.id;
  for(const board of [personal,f.board])saveProjectColors(f.store.db,board,[['A',CATEGORY_COLORS[0]]],f.owner.id,at);
  assert.equal((await f.aliases('',{groups:['A'],name:'B\nC'})).statusCode,200);
  for(const board of [personal,f.board])assert.deepEqual(readProjectColors(f.store.db,board),{version:1,pins:[['B\nC',CATEGORY_COLORS[0]]],revision:2});
  assert.equal((await f.aliases('/restore',{reported:['A']})).statusCode,200);
  for(const board of [personal,f.board])assert.deepEqual(readProjectColors(f.store.db,board).pins,[['A',CATEGORY_COLORS[0]]]);
  // A dormant target is its own saved choice and takes precedence on a genuine rename.
  saveProjectColors(f.store.db,f.board,[['A',CATEGORY_COLORS[0]],['Target',CATEGORY_COLORS[1]]],f.owner.id,at);
  assert.equal((await f.aliases('',{groups:['A'],name:'Target'})).statusCode,200);
  assert.deepEqual(readProjectColors(f.store.db,f.board).pins,[['Target',CATEGORY_COLORS[1]]]);
});

for(const manualTarget of [false,true])test(`merge preserves the target's ${manualTarget?'manual':'Auto'} setting and a restored part recovers its dormant pin`,async t=>{
  const f=await fixture();t.after(async()=>{await f.app.close();f.store.close();});f.credit(['A','B']);
  const pins:[string,typeof CATEGORY_COLORS[number]][]=[['A',CATEGORY_COLORS[0]],...(manualTarget?[["B",CATEGORY_COLORS[1]] as [string,typeof CATEGORY_COLORS[number]]]:[])];
  saveProjectColors(f.store.db,f.board,pins,f.owner.id,at);
  const before=readProjectColors(f.store.db,f.board);
  assert.equal((await f.aliases('',{groups:['A'],name:'B'})).statusCode,200);
  assert.deepEqual(readProjectColors(f.store.db,f.board),before,'merge keeps the source dormant without a spurious colour revision');
  assert.deepEqual((await f.get()).pins,manualTarget?[['B',CATEGORY_COLORS[1]]]:[]);
  assert.equal((await f.aliases('/restore',{reported:['A']})).statusCode,200);
  assert.deepEqual((await f.get()).pins,pins);
});

test('another participant remaining under the old name prevents transfer irrespective of filters or funding',async t=>{
  const f=await fixture();t.after(async()=>{await f.app.close();f.store.close();});f.credit(['A']);
  const other=f.directory.saveDevice({userId:f.reader.id,machine:{id:'reader-machine-0123456789',name:'Other',os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},at);
  f.credit(['A'],other.id);await f.pin('A',CATEGORY_COLORS[0]);
  assert.equal((await f.aliases('',{groups:['A'],name:'B'})).statusCode,200);
  assert.deepEqual((await f.get()).pins,[['A',CATEGORY_COLORS[0]]]);
  const choices=f.hub.projectColors!.choices(f.board,'');assert.equal(choices.changed,false);if(!choices.changed)assert.deepEqual(choices.projects,['A','B']);
});

test('accepted full capacity permits maximum escaped renames and rolls back every board on an internal failure',async t=>{
  const f=await fixture();t.after(async()=>{await f.app.close();f.store.close();});f.credit(['A']);
  const personal=f.directory.boards(f.owner.id).find(board=>board.personal)!.id;
  const pins:[string,typeof CATEGORY_COLORS[number]][]=[['A',CATEGORY_COLORS[0]],...Array.from({length:88},(_,i):[string,typeof CATEGORY_COLORS[number]]=>['dormant-'+i,CATEGORY_COLORS[1]])];
  for(const board of [personal,f.board])saveProjectColors(f.store.db,board,pins,f.owner.id,at);
  const target='\u0001'.repeat(120);
  assert.equal((await f.aliases('',{groups:['A'],name:target})).statusCode,200);
  for(const board of [personal,f.board]){
    const state=readProjectColors(f.store.db,board);assert.equal(state.pins.length,89);assert.equal(new Map(state.pins).get(target),CATEGORY_COLORS[0]);
    assert.ok(Buffer.byteLength(JSON.stringify({version:1,pins:state.pins}))<=PROJECT_COLOR_BYTES);
  }
  f.store.db.prepare('UPDATE board_project_colors SET revision=? WHERE board_id=?').run(Number.MAX_SAFE_INTEGER,f.board);
  const states=[personal,f.board].map(board=>readProjectColors(f.store.db,board));
  assert.equal((await f.aliases('/restore',{reported:['A']})).statusCode,500);
  assert.equal(f.store.projectNames(f.owner.id).get('A'),target);
  assert.deepEqual([personal,f.board].map(board=>readProjectColors(f.store.db,board)),states,'the other board and aliases share the rollback');
});

test('a valid 327620-byte native baseline keeps its last sixty bytes free with all eighty-nine pins',async t=>{
  const f=await fixture();t.after(async()=>{await f.app.close();f.store.close();});
  const token=newSecret('qt_m');f.directory.createToken(token,'fixture',f.owner.id,'fixture',at);
  const credential=f.hub.ingest.authenticate('Bearer '+token);assert.ok(credential&&credential!=='revoked');
  const sessions=Array.from({length:200},(_,i)=>({clientId:i<178?'opencode-x':'opencode',sessionId:i.toString(16).padStart(32,'0'),source:null,origin:'terminal',
    project:String.fromCodePoint(0x1f600+i)+'😀'.repeat(119),folder:i?'😀'.repeat(120):'😀'.repeat(90)+'a'.repeat(30),startedAt:new Date(at).toISOString(),working:false}));
  assert.equal(f.hub.ingest.sessions(credential,{version:1,agent:'fixture',machine:{id:'machine-0123456789',name:'😀'.repeat(95),os:'linux',arch:'x86_64'},sentAt:new Date(at).toISOString(),sessions:[],clientSessions:sessions},at).accepted,200);
  f.credit(sessions.slice(0,89).map(row=>row.project));
  saveProjectColors(f.store.db,f.board,sessions.slice(0,89).map(row=>[row.project,CATEGORY_COLORS[0]]),f.owner.id,at);
  const events=new Events(f.hub,undefined,{now:()=>at,after:()=>()=>{}},null);events.attach();t.after(()=>events.close());
  const native:Frame[]=[],browser:Frame[]=[],base={user:f.owner.id,secret:'fixture',board:f.board,kind:'stream' as const,end:()=>{}};
  const open=(desktop:boolean)=>{const result=events.open({...base,desktop,send:frames=>(desktop?native:browser).push(...frames)});assert.ok(result&&result!=='limit');return result;};
  const ordinary=open(false),first=open(true),reconnected=open(true);
  const snapshot=(frames:Frame[])=>frames.filter(frame=>frame.type==='snapshot');
  assert.equal(Buffer.byteLength(sse(snapshot(first.frames))),327620);
  assert.equal(Buffer.byteLength(sse(snapshot(reconnected.frames))),327620);
  assert.ok(Buffer.byteLength(sse(snapshot(ordinary.frames)))>320*1024,'adding even references would exceed the native decoder before dispatch');
  assert.ok(!JSON.stringify(first.frames).includes('projectColors'));
  const projected=ordinary.frames.find(frame=>frame.type==='projectColors')!;
  assert.equal(JSON.parse(projected.data).pins.length,89);assert.ok(Buffer.byteLength(sse([projected]))<68*1024);
  const {projectColorsRevision:_revision,projectColorsAuthority:_authority,...legacy}=JSON.parse(snapshot(ordinary.frames)[0].data);
  assert.deepEqual(JSON.parse(snapshot(first.frames)[0].data),legacy,'reader projection leaves the common browser baseline intact');
  f.store.nameProjects(f.owner.id,[sessions[0].project],'Renamed');events.flush();
  assert.ok(native.some(frame=>frame.type==='snapshot'));assert.ok(!JSON.stringify(native).includes('projectColors'));
});

test('a palette reply rechecks admission after asynchronous HTTP hooks, including conflicts and choices',async t=>{
  const f=await fixture();f.credit(['private-canary']);await f.pin('private-canary',CATEGORY_COLORS[0]);await f.app.close();
  let retire=false;
  const app=await buildApp(f.hub,app=>{
    app.addHook('onSend',async(request,_reply,payload)=>{
      if(retire&&request.url.includes('/project-colors')){
        retire=false;const policy=f.store.sessionDevices(f.board,f.owner.id)[0];
        f.store.setDeviceSessions(f.board,f.device.id,f.owner.id,false,policy.revision,Date.now());
      }
      return payload;
    });
  });
  t.after(async()=>{await app.close();f.store.close();});
  const request=(url:string)=>app.inject({method:'GET',url,headers:{cookie:`quotum_session=${f.sessionSecret}`}});
  retire=true;
  const palette=await request(`/api/boards/${f.board}/project-colors`);
  assert.equal(palette.statusCode,200);assert.deepEqual(palette.json().pins,[]);assert.ok(!palette.body.includes('private-canary'));
  const policy=f.store.sessionDevices(f.board,f.owner.id)[0];f.store.setDeviceSessions(f.board,f.device.id,f.owner.id,true,policy.revision,at);
  retire=true;
  const choices=await request(`/api/boards/${f.board}/project-colors/choices`);
  assert.ok([200,409].includes(choices.statusCode));assert.ok(!choices.body.includes('private-canary'));
});

test('queued poll configuration is reprojected when a live-only pinned name expires without a work-authority change',async t=>{
  const f=await fixture();t.after(async()=>{await f.app.close();f.store.close();});
  let now=Date.now();const token=newSecret('qt_m');f.directory.createToken(token,'fixture',f.owner.id,'fixture',now);
  const credential=f.hub.ingest.authenticate('Bearer '+token);assert.ok(credential&&credential!=='revoked');
  f.hub.ingest.sessions(credential,{version:1,agent:'fixture',machine:{id:'machine-0123456789',name:'Laptop',os:'linux',arch:'x86_64'},sentAt:new Date(now).toISOString(),sessions:[],
    clientSessions:[{clientId:'opencode',sessionId:'a'.repeat(32),source:null,origin:'terminal',project:'live-private-canary',startedAt:new Date(now).toISOString(),working:false}]},now);
  await f.pin('live-private-canary',CATEGORY_COLORS[0]);
  const events=new Events(f.hub,undefined,{now:()=>now,after:()=>()=>{}},null);events.attach();t.after(()=>events.close());
  const reader={user:f.owner.id,secret:f.sessionSecret,board:f.board},first=await events.poll(reader,undefined);assert.ok(first&&first!=='limit');
  assert.ok(JSON.stringify(first.frames).includes('live-private-canary'));
  await f.pin('live-private-canary',CATEGORY_COLORS[1]);events.flush();const work=f.store.workKey(f.board);
  now+=KEEP_MS+1;
  const next=await events.poll(reader,first.lease);assert.ok(next&&next!=='limit');assert.equal(f.store.workKey(f.board),work);
  assert.ok(next.frames.some(frame=>frame.type==='projectColors'));assert.ok(!JSON.stringify(next.frames).includes('live-private-canary'));
});

for(const encoding of ['identity','gzip'])test(`overview retires private pins before ${encoding} delivery after admission changes`,async t=>{
  const f=await fixture();f.credit(['private-overview-canary']);await f.pin('private-overview-canary',CATEGORY_COLORS[0]);await f.app.close();
  let retire=true;
  const app=await buildApp(f.hub,app=>{
    app.addHook('onSend',async(request,_reply,payload)=>{
      if(retire&&request.url.startsWith('/api/overview')){retire=false;const policy=f.store.sessionDevices(f.board,f.owner.id)[0];f.store.setDeviceSessions(f.board,f.device.id,f.owner.id,false,policy.revision,Date.now());}
      return payload;
    });
  });
  t.after(async()=>{await app.close();f.store.close();});
  const response=await app.inject({method:'GET',url:'/api/overview?board='+f.board,headers:{cookie:`quotum_session=${f.sessionSecret}`,'accept-encoding':encoding}});
  assert.equal(response.statusCode,200);assert.equal(response.headers['content-encoding'],undefined);
  assert.deepEqual(response.json().projectColors.pins,[]);assert.ok(!response.body.includes('private-overview-canary'));
});


test('layout 33 upgrades lazily and persisted board colours survive reopening and board deletion',t=>{
  const legacy=new DatabaseSync(':memory:');
  try{for(const step of STEPS.slice(0,33))legacy.exec(step);legacy.exec('PRAGMA user_version=33');migrate(legacy,at);assert.deepEqual(readProjectColors(legacy,'absent'),{version:1,pins:[],revision:0});assert.equal(legacy.prepare('SELECT count(*) n FROM board_project_colors').get()!.n,0);}finally{legacy.close();}
  const dir=mkdtempSync(path.join(tmpdir(),'quotum-project-colors-')),file=path.join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let store=new Store(file,at),directory=new Directory(store.db);const owner=directory.createUser('colors@example.test','Owner','x',at),board=directory.createBoard('Colours',owner.id,at).id;
  directory.transaction(()=>saveProjectColors(store.db,board,[['persisted',CATEGORY_COLORS[0]]],owner.id,at));store.close();
  store=new Store(file,at);directory=new Directory(store.db);
  try{assert.deepEqual(readProjectColors(store.db,board),{version:1,pins:[['persisted',CATEGORY_COLORS[0]]],revision:1});directory.deleteBoard(board);assert.equal(store.db.prepare('SELECT count(*) n FROM board_project_colors').get()!.n,0);}finally{store.close();}
});
