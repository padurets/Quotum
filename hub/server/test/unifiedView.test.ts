import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {decodeView, encodeView, EMPTY_VIEW, parseSplitView, sameView, VIEW_BODY_LIMIT, type SplitView} from '../domain/view.js';
import {migrateUnified} from '../domain/unifiedView.js';
import {ordered} from '../domain/layout.js';
import {ANALYTICS, WIDGETS, widgetVisible} from '../domain/widgets.js';
import {reconcileAnalytics} from '../domain/analyticsView.js';
import {STEPS,migrate} from '../store/schema.js';
import {Directory} from '../store/directory.js';

const resources = [{id:'A',provider:'codex'},{id:'B',provider:'codex'},{id:'C',provider:'deepseek'}];
const before = (): SplitView => ({...structuredClone(EMPTY_VIEW),version:2});
const positions = (items: {id:string;x:number;w:number}[]) => items.map(({id,x,w})=>({id,x,w}));
const bytes = (value:unknown) => Buffer.byteLength(JSON.stringify(value));
const visible = (view: Parameters<typeof widgetVisible>[0], ids:string[]) => ids.filter(id => widgetVisible(view,id,resources.length));

test('hidden saved positions cannot move implicit visible neighbours during unified migration', () => {
  const old = reconcileAnalytics({...before(),hidden:['source:B'],layout:{columns:6,places:{'source:A':{x:0,y:100,w:3},'source:B':{x:3,y:10,w:3,h:8}}}},resources);
  const cards = resources.map(source=>'source:'+source.id).concat('agents');
  const expected = [...ordered(old.layout,visible(old,cards)),...ordered(old.layout,visible(old,ANALYTICS))];
  const next = decodeView(encodeView(migrateUnified(old,resources)))!;
  assert.deepEqual(positions(ordered(next.layout,visible(next,[...cards,...ANALYTICS]))),positions(expected));
  assert.deepEqual({...next.layout.places['source:B'],y:10},old.layout.places['source:B']);
  assert.equal(next.layout.places['source:C'],undefined);
  assert.equal(migrateUnified(next,resources),next);
  assert.equal(sameView(next,decodeView(encodeView(next))!),true);
});

test('all builtin shown subsets and 204 other ids survive the compact codec', () => {
  const other = Array.from({length:204},(_,i)=>String(i));
  for (let mask=0;mask<128;mask++) {
    const shown = WIDGETS.filter((_,i)=>mask & 1<<i).concat(other as typeof WIDGETS[number][]);
    const view = {...EMPTY_VIEW,shown};
    const decoded = decodeView(encodeView(view));
    assert.ok(decoded); assert.deepEqual(new Set(decoded.shown),new Set(shown));
    assert.equal(sameView(view,decoded),true);
  }
  assert.equal(decodeView([3,[[0,3],['agents',3]],0]),null);
  assert.equal(decodeView([3,[['x',3],['x',3]],0]),null);
  assert.equal(decodeView([3,[[7,3]],0]),null);
  assert.equal(decodeView([3,[],1024]),null);
  assert.equal(decodeView([3,[],4,[128]]),null);
  assert.equal(decodeView([3,[],4,[1,'agents']]),null);
  assert.equal(decodeView([3,[],4,[0,'x','x']]),null);
  assert.equal(decodeView([3,[],0,[]]),null);
  assert.deepEqual(decodeView([3,[['0',3]],0])?.layout.places['0'],{x:0,y:0,w:6});
});

for(const version of [19,21])test(`the largest sparse accepted v2 retains its owner fields through layout ${version} migration`, () => {
  const input = {version:2,layout:{columns:6,places:{}},names:Object.fromEntries(Array.from({length:200},(_,i)=>['source:'+String(i).padStart(12,'0'),'я'.repeat(60)])),windows:[...Array.from({length:399},(_,i)=>'я'.repeat(58)+String(i).padStart(3,'0')),'a'.repeat(73)]};
  assert.equal(bytes(input),VIEW_BODY_LIMIT); assert.ok(parseSplitView(input));
  const db = new DatabaseSync(':memory:');
  try {
    for (const step of STEPS.slice(0,version)) db.exec(step);
    db.exec(`PRAGMA user_version=${version}`);
    db.exec("INSERT INTO boards VALUES('b','',1,'u',0); INSERT INTO sources(id,provider,account,created_at) VALUES('A','codex','a',0); INSERT INTO holders VALUES('A','u',0); INSERT INTO sources(id,provider,account,created_at) VALUES('C','deepseek','c',0); INSERT INTO holders VALUES('C','u',0)");
    db.prepare('INSERT INTO views VALUES(?,?,?,?,?)').run('b',JSON.stringify(parseSplitView(input)),'u',0,7);
    migrate(db,1);
    const directory=new Directory(db), state=directory.viewState('b');
    assert.equal(state.revision,8);
    assert.deepEqual(state.view.names,input.names); assert.deepEqual(state.view.windows,input.windows);
    assert.equal(bytes(encodeView(state.view)),77808);
    assert.equal(directory.saveView('b',state.view,'u',2),8);
    assert.deepEqual(directory.viewState('b'),state);
    migrate(db,3); assert.deepEqual(directory.viewState('b'),state);
    const tooLarge={...state.view,windows:[...state.view.windows,'b'.repeat(120)]};
    assert.throws(()=>directory.saveView('b',tooLarge,'u',4),/view_limit/);
    assert.deepEqual(directory.viewState('b'),state);
  } finally {db.close();}
});

test('migration grows no implicit source places and preserves the accepted byte budget', () => {
  const sources=Array.from({length:500},(_,i)=>({id:String(i),provider:i%2?'codex':'deepseek'}));
  const tiny={version:2,layout:{columns:6,places:{}}};
  assert.equal(bytes(tiny),48);
  assert.equal(bytes(encodeView(migrateUnified(parseSplitView(tiny)!,sources))),49);
  for(let mask=0;mask<128;mask++) for(const saved of [0,1,20]) {
    const v={...before(),shown:WIDGETS.filter((_,i)=>mask&1<<i),layout:{columns:6,places:Object.fromEntries(sources.slice(0,saved).map((source,i)=>['source:'+source.id,{x:0,w:3,y:i*100}]))}};
    const migrated=migrateUnified(v,sources),wire=encodeView(migrated);
    assert.ok(bytes(wire)<=bytes(v));
    assert.equal(Object.keys(migrated.layout.places).filter(id=>id.startsWith('source:')).length,saved);
    const old=reconcileAnalytics(v,sources),cards=sources.map(source=>'source:'+source.id).concat('agents');
    const ids=[...cards,...ANALYTICS].filter(id=>widgetVisible(old,id,sources.length));
    assert.deepEqual(positions(ordered(decodeView(wire)!.layout,ids)),positions([...ordered(old.layout,cards.filter(id=>ids.includes(id))),...ordered(old.layout,ANALYTICS.filter(id=>ids.includes(id)))]));
  }
});
