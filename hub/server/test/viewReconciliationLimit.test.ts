import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../api.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Ingest} from '../ingest.js';
import {Pairing} from '../pairing.js';
import {ResetFeed} from '../resets.js';
import {Setup} from '../setup.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';
import {reconcileAnalytics} from '../domain/analyticsView.js';
import {decodeView,encodeView,viewBytes,VIEW_BODY_LIMIT,VIEW_DECODED_LIMIT,VIEW_VERSION,VIEW_VERSION_HEADER,type View} from '../domain/view.js';
import {showWidgets,widgetVisible} from '../domain/widgets.js';

const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));

/** Fill the encoded UTF-8 allowance with valid owner fields, without padding the HTTP body. */
function encodedMaximum(base:View):View {
  let view={...base,names:Object.fromEntries(Array.from({length:200},(_,i)=>['s'+i,'я'.repeat(60)])),windows:Array.from({length:200},(_,i)=>'я'.repeat(57)+String(i).padStart(3,'0'))};
  for(let n=200;viewBytes(view)<VIEW_BODY_LIMIT;n++) {
    const left=VIEW_BODY_LIMIT-viewBytes(view);
    assert.ok(left>=6);
    const length=Math.min(120,left-3),id=('w'+String(n).padStart(3,'0')).padEnd(length,'x');
    view={...view,windows:[...view.windows,id]};
  }
  assert.equal(viewBytes(view),VIEW_BODY_LIMIT);
  assert.ok(decodeView(encodeView(view)));
  return view;
}

/** Short place ids reach the decoded bound while their compact tuples still fit the wire. */
function decodedMaximum(base:View):View {
  const draft=(count:number):View=>({...base,layout:{columns:6,places:{...base.layout.places,...Object.fromEntries(Array.from({length:count},(_,i)=>['p'+i,{x:0,w:3,y:i+2}]))}}});
  let low=0,high=5000;
  while(low+1<high){const middle=Math.floor((low+high)/2);if(decodeView(encodeView(draft(middle))))low=middle;else high=middle;}
  let view=decodeView(encodeView(draft(low)))!;
  const overhead=bytes({...view,names:{pad:'x'}})-bytes(view)-1;
  if(VIEW_DECODED_LIMIT-bytes(view)<=overhead)view=decodeView(encodeView(draft(--low)))!;
  view={...view,names:{pad:'x'.repeat(VIEW_DECODED_LIMIT-bytes(view)-overhead)}};
  assert.equal(bytes(view),VIEW_DECODED_LIMIT);
  assert.ok(viewBytes(view)<VIEW_BODY_LIMIT);
  assert.ok(decodeView(encodeView(view)));
  return view;
}

async function fixture() {
  const store=new Store(':memory:'),directory=new Directory(store.db);
  const app=await buildApp({store,directory,resets:new ResetFeed(undefined,()=>{}),ingest:new Ingest(store,directory,new Duty(),new Cadence()),pairing:new Pairing(directory),setup:new Setup(true,'BCDF-GHJK'),local:null});
  const signup=await app.inject({method:'POST',url:'/api/auth/signup',payload:{email:'limit@example.test',name:'Limit',password:'correct horse',setupCode:'BCDF-GHJK'}});
  assert.equal(signup.statusCode,200);
  const board=signup.json().boards.find((board:{personal:boolean})=>board.personal).id as string;
  const cookie=String(signup.headers['set-cookie']).split(';')[0],user=directory.credentials('limit@example.test')!.user.id,now=Date.now();
  const initial=store.source('claude','initial',now);store.hold(initial,user,now);
  const headers={cookie,origin:'http://localhost',[VIEW_VERSION_HEADER]:String(VIEW_VERSION)};
  const save=(view:View,revision:number)=>app.inject({method:'POST',url:'/api/boards/'+board+'/view',headers:{...headers,'If-Match':'"'+revision+'"'},payload:encodeView(view)});
  const overview=()=>app.inject({method:'GET',url:'/api/overview?board='+board,headers});
  const persisted=()=>store.db.prepare('SELECT payload,revision,updated_by,updated_at FROM views WHERE board_id=?').get(board)!;
  const touches:{revision:number;transaction:boolean}[]=[];
  const observe=()=>directory.setObserver({touchBoards:ids=>{assert.deepEqual(ids,[board]);touches.push({revision:Number(persisted().revision),transaction:store.db.isTransaction});},touchSources:()=>{},touchUser:()=>{},touchHub:()=>{},history:()=>{},dropSessions:()=>{},dropMember:()=>{},dropBoard:()=>{}});
  return {app,store,directory,board,user,now,headers,save,overview,persisted,touches,observe,close:async()=>{await app.close();store.close();}};
}

for(const bound of ['encoded','decoded'] as const)test(`automatic defaults preserve a view at its ${bound} bound and retry after recovery`,async t=>{
  const h=await fixture();t.after(h.close);
  const full=(bound==='encoded'?encodedMaximum:decodedMaximum)(h.directory.view(h.board));
  let reply=await h.save(full,h.directory.viewRevision(h.board));assert.equal(reply.statusCode,200);
  const revision=reply.json().revision as number,saved=reply.json().view as View,before=h.persisted();
  h.observe();
  assert.equal((await h.overview()).statusCode,200);
  const later=h.store.source('codex','new-family',h.now+1);h.store.hold(later,h.user,h.now+1);
  const expanded=reconcileAnalytics(saved,h.store.sources(h.board));
  if(bound==='encoded')assert.ok(viewBytes(expanded)>VIEW_BODY_LIMIT);
  else {assert.ok(viewBytes(expanded)<VIEW_BODY_LIMIT);assert.equal(decodeView(encodeView(expanded)),null);}
  for(let attempt=0;attempt<2;attempt++) {
    reply=await h.overview();assert.equal(reply.statusCode,200,reply.body);
    assert.deepEqual(reply.json().view,saved);assert.equal(reply.json().viewRevision,revision);
    assert.ok(reply.json().sources.some((source:{id:string})=>source.id===later));
    assert.equal(widgetVisible(reply.json().view,'source:'+later,2),true,'new source cards stay implicit and visible');
    assert.equal(widgetVisible(reply.json().view,'subscription-funds',2),false,'derived analytics stay pending');
    assert.deepEqual(h.persisted(),before);assert.deepEqual(h.touches,[]);
  }
  const overflow=bound==='encoded'?{...saved,windows:[...saved.windows,'overflow']}:{...saved,layout:{...saved.layout,places:{...saved.layout.places,overflow:{x:0,w:3,y:5000}}}};
  reply=await h.save(overflow,revision);assert.equal(reply.statusCode,bound==='encoded'?413:400);
  assert.throws(()=>h.directory.saveView(h.board,overflow,h.user,h.now+2),/view_limit/);
  assert.deepEqual(h.persisted(),before);assert.deepEqual(h.touches,[]);
  reply=await h.save(saved,revision-1);assert.equal(reply.statusCode,409);assert.equal(reply.json().revision,revision);assert.deepEqual(reply.json().view,saved);
  reply=await h.save(saved,revision);assert.equal(reply.statusCode,200);assert.equal(reply.json().revision,revision);
  assert.deepEqual(h.persisted(),before);assert.deepEqual(h.touches,[]);

  const smaller=bound==='encoded'?{...saved,windows:saved.windows.slice(1)}:{...saved,layout:{...saved.layout,places:Object.fromEntries(Object.entries(saved.layout.places).filter(([id])=>!['p0','p1','p2'].includes(id)))}};
  if(bound==='encoded') {
    reply=await h.save(smaller,revision);assert.equal(reply.statusCode,200,reply.body);
    assert.equal(reply.json().revision,revision+2,'the response includes both the owner save and retried defaults');
    assert.deepEqual(h.touches,[{revision:revision+2,transaction:false},{revision:revision+2,transaction:false}]);
  } else {
    assert.equal(h.directory.saveView(h.board,smaller,h.user,h.now+2),revision+1);
    assert.equal(decodeView(JSON.parse(String(h.persisted().payload)))!.shown.includes('subscription-funds'),false);
    assert.deepEqual(h.touches,[{revision:revision+1,transaction:false}]);
    reply=await h.overview();assert.equal(reply.statusCode,200);assert.equal(reply.json().viewRevision,revision+2);
    assert.deepEqual(h.touches,[{revision:revision+1,transaction:false},{revision:revision+2,transaction:false}]);
  }
  const recovered=h.directory.viewState(h.board),after=h.persisted();
  assert.equal(recovered.view.shown.includes('subscription-funds'),true);
  assert.deepEqual(recovered.view,decodeView(encodeView(reconcileAnalytics(smaller,h.store.sources(h.board)))));
  assert.equal(recovered.revision,revision+2);assert.ok(viewBytes(recovered.view)<=VIEW_BODY_LIMIT);assert.ok(bytes(recovered.view)<=VIEW_DECODED_LIMIT);
  const touches=h.touches.slice();
  assert.equal((await h.overview()).statusCode,200);assert.deepEqual(h.persisted(),after);assert.deepEqual(h.touches,touches);
  reply=await h.save(smaller,revision);assert.equal(reply.statusCode,409);assert.equal(reply.json().revision,revision+2);assert.deepEqual(h.persisted(),after);
});

test('an explicit oversized widget addition still rolls back its view and committed notifications',async t=>{
  const h=await fixture();t.after(h.close);
  const full=encodedMaximum(h.directory.view(h.board));
  let reply=await h.save(full,h.directory.viewRevision(h.board));assert.equal(reply.statusCode,200);
  assert.ok(viewBytes(showWidgets(full,['agents']))>VIEW_BODY_LIMIT);
  const before=h.persisted();h.observe();
  const later=h.store.source('codex','new-family',h.now+1);h.store.hold(later,h.user,h.now+1);
  const requestId=randomUUID(),payload={requestId,boardId:h.board,item:{kind:'widget',widgetId:'agents'}};
  reply=await h.app.inject({method:'POST',url:'/api/additions',headers:h.headers,payload});assert.equal(reply.statusCode,200,reply.body);
  const operation=reply.json().id as string;
  for(let attempt=0;attempt<2;attempt++) {
    reply=await h.app.inject({method:'POST',url:'/api/additions/'+operation+'/run',headers:h.headers,payload:{}});
    assert.equal(reply.statusCode,200,reply.body);assert.equal(reply.json().state,'needs_input');assert.equal(reply.json().result,undefined);
    assert.equal(reply.json().current.widgets[0].placement,'hidden');
    assert.deepEqual(h.persisted(),before);assert.deepEqual(h.touches,[]);
    assert.deepEqual(h.directory.view(h.board),decodeView(JSON.parse(String(before.payload))));
  }
  reply=await h.app.inject({method:'POST',url:'/api/additions',headers:h.headers,payload});assert.equal(reply.statusCode,200);assert.equal(reply.json().id,operation);
  assert.equal((h.store.db.prepare('SELECT count(*) AS count FROM board_additions').get() as {count:number}).count,1);
});
