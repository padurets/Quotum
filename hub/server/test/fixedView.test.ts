import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EMPTY_VIEW, decodeView, decodeUnifiedView, encodeView, encodeUnifiedView, VIEW_BODY_LIMIT, VIEW_DECODED_LIMIT, type UnifiedView} from '../domain/view.js';
import {migrateFixed, fixedWidgetTargets} from '../domain/fixedView.js';
import {reconcileAnalytics} from '../domain/analyticsView.js';
import {WIDGETS, widgetVisible} from '../domain/widgets.js';
import {Directory} from '../store/directory.js';
import {migrate, STEPS} from '../store/schema.js';
import {Store} from '../store/store.js';
import {ordered} from '../domain/layout.js';
import {BoardAdditions} from '../additions.js';
import type {Credentials} from '../secrets/index.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const old = (): UnifiedView => ({...structuredClone(EMPTY_VIEW),version:3});
const parents = ['quota-history','quota-table','budget-history','budget-table'];
const resources = [{id:'q',provider:'claude'},{id:'b',provider:'openrouter'}];

test('fixed siblings preserve geometry, reading order, hidden intent and every owner field', () => {
  const view = {...old(),names:{q:'Team'},colors:{q:'#123456'},windows:['q/weekly'],plans:{q:[100,0,0,0,0,0,0]},unplanned:['b'],
    hidden:['quota-table','source:b'],shown:parents,columns:{'quota-table':['spent'],'budget-table':['topup']},shownColumns:{'quota-table':['during']},
    layout:{columns:6,places:{'quota-history':{x:0,w:3,y:2,h:17},'source:q':{x:3,w:3,y:5},'quota-table':{x:0,w:6,y:6,h:10},'budget-history':{x:0,w:6,y:8},'budget-table':{x:0,w:6,y:9,h:5}}}};
  const next = migrateFixed(view,resources),roundtrip = decodeView(encodeView(next));
  assert.deepEqual({...roundtrip,shown:next.shown},next);
  assert.deepEqual(Object.keys(next.layout.places),['quota-history','quota-session-history','source:q','quota-table','quota-session-table','budget-history','budget-table']);
  for (const id of Object.keys(view.layout.places)) {
    const {y:before,...geometry} = view.layout.places[id as keyof typeof view.layout.places];
    const {y:after,...retained} = next.layout.places[id];
    assert.deepEqual(retained,geometry);assert.ok(before>=0&&after>=0);
  }
  assert.deepEqual(next.layout.places['quota-session-history'],{x:0,w:3,y:1,h:17});
  assert.ok(next.hidden.includes('quota-session-table'));
  assert.equal(widgetVisible(next,'quota-session-table',2),false);
  assert.deepEqual(next.columns['quota-session-table'],['spent']);
  assert.deepEqual(next.shownColumns['quota-session-table'],['during']);
  assert.deepEqual(next.columns['budget-table'],['topup']);
  assert.equal(next.columns['budget-spending-table'],undefined);
  for (const key of ['names','colors','windows','plans','unplanned'] as const) assert.deepEqual(next[key],view[key]);
  assert.equal(migrateFixed(next,resources),next);
  assert.equal(next.layout.places['source:b'],undefined,'implicit cards are not materialized');
});

test('explicit empty widgets split independently and existing sibling fields are retained', () => {
  const input = {...old(),shown:['quota-history','budget-table'],hidden:['budget-history'],
    columns:{'quota-table':['spent'],'quota-session-table':['work']},layout:{columns:6,places:{'quota-session-history':{x:3,w:3,y:0,h:9},'quota-history':{x:0,w:3,y:1,h:12}}}};
  const next = migrateFixed(input,[]);
  for (const id of ['quota-history','quota-session-history','budget-table']) assert.ok(widgetVisible(next,id,0));
  assert.ok(next.hidden.includes('budget-history'));
  assert.ok(!next.hidden.includes('budget-spending-history'));
  assert.equal(next.layout.places['quota-session-history'].h,9);
  assert.deepEqual(next.columns['quota-session-table'],['work']);
});

test('fresh fixed defaults follow catalogue capabilities, grants and sticky owner intent', () => {
  for (const provider of ['claude','deepseek','openrouter','codex']) {
    const view = migrateFixed(undefined,[{id:'s',provider}]);
    const expected = provider==='claude'?['quota-session-history','quota-session-table','quota-history','quota-table']:
      provider==='deepseek'?['budget-history','budget-table']:
      provider==='openrouter'?['budget-history','budget-table']:
      ['quota-session-history','quota-session-table','quota-history','quota-table','subscription-funds'];
    assert.deepEqual(view.shown,expected);
    assert.equal(reconcileAnalytics(view,[{id:'s',provider}]),view);
  }
  const denied=migrateFixed(undefined,[{id:'s',provider:'codex',budget:{enabled:false}}]);
  assert.ok(!denied.shown.includes('subscription-funds'));
  const hidden={...old(),hidden:parents};
  const migrated=reconcileAnalytics(migrateFixed(hidden,resources),resources);
  for(const id of WIDGETS.filter(id=>id.includes('quota')||id.includes('budget')))assert.ok(migrated.hidden.includes(id));
  assert.deepEqual(fixedWidgetTargets(['quota-history','quota-history','budget-table']),['quota-history','quota-session-history','budget-table']);
});

test('the released v3 aliases remain frozen and only v4 is accepted by the active writer', () => {
  const ids=['agents','activity','quota-history','budget-history','quota-table','budget-table','subscription-funds'];
  for(const [alias,id] of ids.entries()) {
    const v3=[3,[[alias,3]],4,[1<<alias]];
    assert.ok(decodeUnifiedView(v3)?.shown.includes(id));assert.equal(decodeView(v3),null);
    assert.ok(decodeView([4,[[alias,3]],4,[1<<alias]])?.shown.includes(id));
  }
  assert.equal(decodeUnifiedView([3,[[7,3]],0]),null);
  assert.equal(decodeView([4,[[11,3]],0]),null);
  assert.equal(decodeView([4,[],4,[2048]]),null);
  for(let mask=0;mask<2048;mask++) {
    const view={...EMPTY_VIEW,shown:WIDGETS.filter((_,i)=>mask&1<<i)};
    assert.deepEqual(new Set(decodeView(encodeView(view))!.shown),new Set(view.shown));
  }
});

const v3Bytes=(view:UnifiedView)=>bytes(encodeUnifiedView(view));
const maximumFields=():UnifiedView=>{
  const columns=Array.from({length:20},(_,i)=>String.fromCharCode(97+i)+'x'.repeat(19));
  const maps=Object.fromEntries([...parents.map(id=>[id,columns]),...Array.from({length:200},(_,i)=>['c'+i,[]])]);
  return {...old(),shown:['agents','activity','quota-history','budget-history','quota-table','budget-table','subscription-funds',...Array.from({length:204},(_,i)=>'s'+i)],hidden:[...parents,...Array.from({length:200},(_,i)=>'h'+i)],columns:maps,shownColumns:structuredClone(maps),
    layout:{columns:6,places:Object.fromEntries(parents.map((id,i)=>[id,{x:0,w:6,y:i,h:200}]))}};
};

test('combined legacy encoded, decoded and collection maxima migrate, reload and save losslessly', () => {
  const base=maximumFields();
  let encoded={...base,names:Object.fromEntries(Array.from({length:200},(_,i)=>['n'+i,'я'.repeat(60)])),windows:Array.from({length:200},(_,i)=>'я'.repeat(55)+String(i).padStart(3,'0'))};
  for(let i=0;v3Bytes(encoded)<76*1024;i++) {
    const left=76*1024-v3Bytes(encoded),length=left>123&&left<127?left-7:Math.min(120,left-3);
    assert.ok(length>0);
    encoded={...encoded,windows:[...encoded.windows,('p'+i).padEnd(length,'x').slice(0,length)]};
  }
  assert.equal(v3Bytes(encoded),76*1024);
  const draft=(count:number):UnifiedView=>({...base,layout:{columns:6,places:{...base.layout.places,...Object.fromEntries(Array.from({length:count},(_,i)=>['p'+i,{x:0,w:3,y:i+4}]))}}});
  let low=0,high=5000;
  while(low+1<high){const middle=Math.floor((low+high)/2);if(decodeUnifiedView(encodeUnifiedView(draft(middle))))low=middle;else high=middle;}
  let decoded=decodeUnifiedView(encodeUnifiedView(draft(low)))!;
  const overhead=bytes({...decoded,names:{pad:'x'}})-bytes(decoded)-1;
  if(128*1024-bytes(decoded)<=overhead)decoded=decodeUnifiedView(encodeUnifiedView(draft(--low)))!;
  decoded={...decoded,names:{pad:'x'.repeat(128*1024-bytes(decoded)-overhead)}};
  assert.equal(bytes(decoded),128*1024);
  for(const input of [decoded,encoded]) {
    assert.ok(decodeUnifiedView(encodeUnifiedView(input)));
    const next=migrateFixed(input,resources);
    assert.ok(bytes(encodeView(next))<=VIEW_BODY_LIMIT);assert.ok(bytes(next)<=VIEW_DECODED_LIMIT);
    assert.ok(next.hidden.length<=211&&next.shown.length<=215&&Object.keys(next.columns).length<=211);
    assert.deepEqual({...decodeView(encodeView(next)),shown:next.shown},next);
    for(const key of ['names','windows','plans','colors','unplanned'] as const)assert.deepEqual(next[key],input[key]);
    for(const field of ['columns','shownColumns'] as const) {
      for(const [id,columns] of Object.entries(input[field]))assert.deepEqual(next[field][id],columns);
      assert.deepEqual(next[field]['quota-session-table'],input[field]['quota-table']);
      assert.equal(next[field]['budget-spending-table'],undefined);
    }
    const db=new DatabaseSync(':memory:');
    try {
      for(const step of STEPS.slice(0,25))db.exec(step);
      db.exec("PRAGMA user_version=25; INSERT INTO boards VALUES('b','',1,'u',0)");
      db.prepare('INSERT INTO views VALUES(?,?,?,?,?)').run('b',JSON.stringify(encodeUnifiedView(input)),'u',0,7);
      migrate(db,10);
      const saved=db.prepare('SELECT payload,revision FROM views WHERE board_id=?').get('b') as {payload:string;revision:number};
      assert.equal(saved.revision,8);
      assert.deepEqual({...decodeView(JSON.parse(saved.payload)),shown:next.shown},next);
      migrate(db,11);
      assert.deepEqual(db.prepare('SELECT payload,revision FROM views WHERE board_id=?').get('b'),saved);
    } finally {db.close();}
  }
});

for(const version of [19,22,25])test(`layout ${version} upgrades atomically with one revision and idempotent v4 storage`,()=>{
  const db=new DatabaseSync(':memory:');
  try {
    for(const step of STEPS.slice(0,version))db.exec(step);
    db.exec(`PRAGMA user_version=${version}`);
    db.exec("INSERT INTO boards VALUES('b','',1,'u',0); INSERT INTO sources(id,provider,account,created_at) VALUES('q','claude','q',0); INSERT INTO holders VALUES('q','u',0)");
    const view={...old(),shown:['quota-history','quota-table'],hidden:['budget-history','budget-table'],layout:{columns:6,places:{'quota-history':{x:0,w:3,y:0,h:12},'quota-table':{x:3,w:3,y:1,h:8}}}};
    const payload=version<22?{...view,version:2}:encodeUnifiedView(view);
    db.prepare('INSERT INTO views VALUES(?,?,?,?,?)').run('b',JSON.stringify(payload),'u',0,7);
    migrate(db,10);
    const directory=new Directory(db),state=directory.viewState('b');
    assert.equal(state.revision,8);assert.equal(state.view.version,4);
    assert.ok(widgetVisible(state.view,'quota-session-history',1));assert.ok(widgetVisible(state.view,'quota-session-table',1));
    assert.equal(directory.saveView('b',state.view,'u',11),8);
    const saved=db.prepare('SELECT payload,revision FROM views WHERE board_id=?').get('b');
    migrate(db,12);assert.deepEqual(db.prepare('SELECT payload,revision FROM views WHERE board_id=?').get('b'),saved);
  } finally {db.close();}
});

for(const version of [19,22,25])test(`layout ${version} preserves NULL receipt intent on resume and completed replay`,async()=>{
  const folder=mkdtempSync(path.join(os.tmpdir(),'quotum-fixed-receipt-')),file=path.join(folder,'hub.sqlite'),db=new DatabaseSync(file);
  const ready=parents.map(widgetId=>({id:randomUUID(),widgetId})),complete=parents.map(widgetId=>({id:randomUUID(),widgetId}));
  for(const step of STEPS.slice(0,version))db.exec(step);
  db.exec(`PRAGMA user_version=${version}`);
  db.exec("INSERT INTO users VALUES('u','owner@fixture.example','Owner','unused',0); INSERT INTO boards VALUES('b','',1,'u',0); INSERT INTO members VALUES('b','u','owner',0)");
  const input={...old(),hidden:parents},payload=version<22?{...input,version:2}:encodeUnifiedView(input);
  db.prepare('INSERT INTO views VALUES(?,?,?,?,?)').run('b',JSON.stringify(payload),'u',0,7);
  for(const [state,receipts] of [['ready',ready],['complete',complete]] as const)for(const receipt of receipts) {
    db.prepare('INSERT INTO board_additions(id,owner_id,request_id,board_id,item,state,result,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(receipt.id,'u',randomUUID(),'b',JSON.stringify({kind:'widget',widgetId:receipt.widgetId}),state,state==='complete'?JSON.stringify({sourceIds:[],appliedAt:0,placement:'added'}):null,0,0,100_000);
  }
  db.close();
  const store=new Store(file,100),directory=new Directory(store.db),additions=new BoardAdditions(store,directory,{} as Credentials,()=>100);
  try {
    assert.equal(directory.viewRevision('b'),8);
    const saved=store.db.prepare('SELECT id,item,widget_targets FROM board_additions ORDER BY id').all();
    migrate(store.db,101);assert.deepEqual(store.db.prepare('SELECT id,item,widget_targets FROM board_additions ORDER BY id').all(),saved);
    for(const receipt of ready) {
      const resumed=await additions.run('u',receipt.id,undefined,()=>true);
      assert.equal(resumed.state,'complete');assert.deepEqual(resumed.widgetIds,fixedWidgetTargets([receipt.widgetId]));
      assert.ok(resumed.current.widgets!.every(widget=>widget.placement==='visible'));
      assert.deepEqual(resumed.item,{kind:'widget',widgetId:receipt.widgetId});
    }
    const hidden={...directory.view('b'),hidden:fixedWidgetTargets(parents),shown:[]};directory.saveView('b',hidden,'u',102);
    const revision=directory.viewRevision('b');
    for(const receipt of [...ready,...complete]) {
      const replay=await additions.run('u',receipt.id,undefined,()=>true);
      assert.deepEqual(replay.widgetIds,fixedWidgetTargets([receipt.widgetId]));assert.ok(replay.current.widgets!.every(widget=>widget.placement==='hidden'));
    }
    assert.equal(directory.viewRevision('b'),revision,'completed replay never resurrects later hidden widgets');
    const modern=additions.reserve('u',randomUUID(),'b',{kind:'widget',widgetId:'quota-history'});
    const added=await additions.run('u',modern.id,undefined,()=>true);
    assert.deepEqual(added.widgetIds,['quota-history']);assert.ok(widgetVisible(directory.view('b'),'quota-history',0));
    assert.equal(widgetVisible(directory.view('b'),'quota-session-history',0),false,'a new v4 action adds only the requested widget');
  } finally {store.close();rmSync(folder,{recursive:true,force:true});}
});


test('retired preview spending aliases read losslessly but are never active or added by defaults',()=>{
  const retired=['budget-spending-history','budget-spending-table'];
  const view={...structuredClone(EMPTY_VIEW),shown:retired,columns:{'budget-spending-table':['spending']},layout:{columns:6,places:Object.fromEntries(retired.map((id,y)=>[id,{x:0,w:6,y}]))}};
  const wire=encodeView(view),decoded=decodeView(wire)!;
  assert.deepEqual(wire[1].map(place=>place[0]),[9,10]);
  assert.deepEqual(decoded,view);
  assert.equal(migrateFixed(decoded,resources),decoded,'unrelated preview layout fields are not reset');
  assert.equal(widgetVisible(decoded,'source:wallet',10),true,'retiring a builtin never hides implicit source cards');
  assert.equal(widgetVisible({...decoded,hidden:['source:wallet']},'source:wallet',10),false,'source visibility still respects the saved hide');
  for(const id of retired){assert.ok(!WIDGETS.includes(id as typeof WIDGETS[number]));assert.equal(widgetVisible(decoded,id,10),false);}
  const fresh=migrateFixed(undefined,resources);
  assert.ok(retired.every(id=>!fresh.shown.includes(id)&&!fresh.layout.places[id]));
});

test('retired Add receipts stay immutable and never save or resurrect removed widgets',async()=>{
  const store=new Store(':memory:',100),directory=new Directory(store.db);
  const additions=new BoardAdditions(store,directory,{} as Credentials,()=>100);
  try {
    store.db.exec("INSERT INTO users VALUES('u','owner@fixture.example','Owner','unused',0); INSERT INTO boards VALUES('b','',1,'u',0); INSERT INTO members VALUES('b','u','owner',0)");
    directory.saveView('b',{...structuredClone(EMPTY_VIEW),hidden:['budget-history','budget-table']},'u',0);
    const revision=directory.viewRevision('b');
    const reserve=(state:string,item:string,targets:string[])=>{
      const id=randomUUID();
      store.db.prepare('INSERT INTO board_additions(id,owner_id,request_id,board_id,item,state,result,widget_targets,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'u',randomUUID(),'b',item,state,state==='complete'?JSON.stringify({sourceIds:[],appliedAt:0,placement:'added'}):null,JSON.stringify(targets),0,0,100_000);
      return id;
    };
    const item=JSON.stringify({kind:'widget',widgetId:'budget-spending-history'});
    for(const state of ['ready','complete']) {
      const id=reserve(state,item,['budget-spending-history']);
      const answer=await additions.run('u',id,undefined,()=>true);
      assert.equal(answer.state,state==='ready'?'needs_input':'complete');
      if(state==='ready')assert.equal(answer.error,'addition_unavailable');
      assert.deepEqual(answer.widgetIds,[]);assert.deepEqual(answer.current.widgets,[]);
      assert.equal(directory.viewRevision('b'),revision);
      assert.equal(widgetVisible(directory.view('b'),'budget-history',1),false);
      assert.equal(store.db.prepare('SELECT item FROM board_additions WHERE id=?').get(id)!.item,item);
    }
    assert.throws(()=>additions.reserve('u',randomUUID(),'b',{kind:'widget',widgetId:'budget-spending-history' as never}),/addition_invalid/);
    const mixed=reserve('ready',JSON.stringify({kind:'widget',widgetId:'budget-history'}),['budget-history','budget-spending-history']);
    const answer=await additions.run('u',mixed,undefined,()=>true);
    assert.equal(answer.state,'complete');assert.deepEqual(answer.widgetIds,['budget-history']);
    assert.equal(widgetVisible(directory.view('b'),'budget-history',1),true);
    assert.equal(widgetVisible(directory.view('b'),'budget-spending-history',1),false);
  }finally{store.close();}
});


test('the actual split-view upgrade preserves source order independently of the visibility predicate',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    for(const step of STEPS.slice(0,19))db.exec(step);
    db.exec("PRAGMA user_version=19; INSERT INTO boards VALUES('b','',1,'u',0); INSERT INTO sources(id,provider,account,created_at) VALUES('A','claude','A',0),('B','claude','B',1); INSERT INTO holders VALUES('A','u',0),('B','u',1)");
    const input={...structuredClone(EMPTY_VIEW),version:2,shown:['agents'],hidden:['activity','quota-history','quota-table','budget-history','budget-table','subscription-funds'],layout:{columns:6,places:{'source:A':{x:0,w:3,y:10}}}};
    const ids=['source:A','source:B','agents'];
    assert.deepEqual(ordered(input.layout,ids).map(item=>item.id),ids);
    db.prepare('INSERT INTO views VALUES(?,?,?,?,?)').run('b',JSON.stringify(input),'u',0,7);
    migrate(db,10);
    const row=db.prepare('SELECT payload,revision FROM views WHERE board_id=?').get('b') as {payload:string;revision:number};
    const view=decodeView(JSON.parse(row.payload))!;
    assert.deepEqual(ordered(view.layout,ids).map(item=>item.id),ids,'saved and implicit cards keep their original reading order');
    assert.equal(row.revision,8);
  }finally{db.close();}
});
