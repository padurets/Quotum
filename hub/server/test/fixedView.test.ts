import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {EMPTY_VIEW, decodeView, decodeUnifiedView, encodeView, encodeUnifiedView, VIEW_BODY_LIMIT, VIEW_DECODED_LIMIT, type UnifiedView} from '../domain/view.js';
import {migrateFixed, fixedWidgetTargets} from '../domain/fixedView.js';
import {reconcileAnalytics} from '../domain/analyticsView.js';
import {WIDGETS, widgetVisible} from '../domain/widgets.js';
import {Directory} from '../store/directory.js';
import {migrate, STEPS} from '../store/schema.js';

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
  assert.deepEqual(Object.keys(next.layout.places),['quota-history','quota-session-history','source:q','quota-table','quota-session-table','budget-history','budget-spending-history','budget-table','budget-spending-table']);
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
  assert.deepEqual(next.columns['budget-spending-table'],['topup']);
  for (const key of ['names','colors','windows','plans','unplanned'] as const) assert.deepEqual(next[key],view[key]);
  assert.equal(migrateFixed(next,resources),next);
  assert.equal(next.layout.places['source:b'],undefined,'implicit cards are not materialized');
});

test('explicit empty widgets split independently and existing sibling fields are retained', () => {
  const input = {...old(),shown:['quota-history','budget-table'],hidden:['budget-history'],
    columns:{'quota-table':['spent'],'quota-session-table':['work']},layout:{columns:6,places:{'quota-session-history':{x:3,w:3,y:0,h:9},'quota-history':{x:0,w:3,y:1,h:12}}}};
  const next = migrateFixed(input,[]);
  for (const id of ['quota-history','quota-session-history','budget-table','budget-spending-table']) assert.ok(widgetVisible(next,id,0));
  assert.ok(next.hidden.includes('budget-spending-history'));
  assert.equal(next.layout.places['quota-session-history'].h,9);
  assert.deepEqual(next.columns['quota-session-table'],['work']);
});

test('fresh fixed defaults follow catalogue capabilities, grants and sticky owner intent', () => {
  for (const provider of ['claude','deepseek','openrouter','codex']) {
    const view = migrateFixed(undefined,[{id:'s',provider}]);
    const expected = provider==='claude'?['quota-session-history','quota-session-table','quota-history','quota-table']:
      provider==='deepseek'?['budget-history','budget-table']:
      provider==='openrouter'?['budget-history','budget-table','budget-spending-history','budget-spending-table']:
      ['quota-session-history','quota-session-table','quota-history','quota-table','subscription-funds'];
    assert.deepEqual(view.shown,expected);
    assert.equal(reconcileAnalytics(view,[{id:'s',provider}]),view);
  }
  const denied=migrateFixed(undefined,[{id:'s',provider:'codex',budget:{enabled:false}}]);
  assert.ok(!denied.shown.includes('subscription-funds'));
  const hidden={...old(),hidden:parents};
  const migrated=reconcileAnalytics(migrateFixed(hidden,resources),resources);
  for(const id of WIDGETS.filter(id=>id.includes('quota')||id.includes('budget')))assert.ok(migrated.hidden.includes(id));
  assert.deepEqual(fixedWidgetTargets(['quota-history','quota-history','budget-table']),['quota-history','quota-session-history','budget-table','budget-spending-table']);
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
  const maps=Object.fromEntries([...parents.filter(id=>id.endsWith('table')).map(id=>[id,columns]),...Array.from({length:202},(_,i)=>['c'+i,[]])]);
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
  for(const input of [encoded,decoded]) {
    assert.ok(decodeUnifiedView(encodeUnifiedView(input)));
    const next=migrateFixed(input,resources);
    assert.ok(bytes(encodeView(next))<=VIEW_BODY_LIMIT);assert.ok(bytes(next)<=VIEW_DECODED_LIMIT);
    assert.ok(next.hidden.length<=211&&next.shown.length<=215&&Object.keys(next.columns).length<=211);
    assert.deepEqual({...decodeView(encodeView(next)),shown:next.shown},next);
    for(const key of ['names','windows','plans','colors','unplanned'] as const)assert.deepEqual(next[key],input[key]);
    for(const [id,columns] of Object.entries(input.columns))assert.deepEqual(next.columns[id],columns);
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
