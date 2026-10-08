import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrateAnalytics, reconcileAnalytics} from '../domain/analyticsView.js';
import {EMPTY_VIEW, parseView, VIEW_BODY_LIMIT} from '../domain/view.js';
import {widgetVisible} from '../domain/widgets.js';
import {supportsQuota, supportsBudget} from '../domain/providers.js';
import {STEPS, migrate} from '../store/schema.js';
import {Directory} from '../store/directory.js';

const quota = {id: 'q', provider: 'claude'}, budget = {id: 'b', provider: 'deepseek'};
const legacy = () => {const {version, ...view} = EMPTY_VIEW; return structuredClone(view);};

test('migration splits visible families, preserves exact anchors and is idempotent', () => {
  for (const resources of [[quota], [budget], [quota,budget], []]) {
    const before = {...legacy(), layout: {columns: 6, places: {history: {x: 3,y: 99,w: 3,h: 8}, forecast: {x: 0,y: 100,w: 6}, activity: {x: 0,y: 0,w: 6}, 'source:old': {x: 0,y: 7,w: 3,h: 5}}}, names: {q: 'Original'}, colors: {q: '#abcdef'}};
    const result = migrateAnalytics(before, resources), family = resources.length === 1 && resources[0] === budget ? 'budget' : 'quota';
    assert.deepEqual(result.layout.places[family+'-history'], before.layout.places.history);
    assert.deepEqual(result.layout.places[family+'-table'], before.layout.places.forecast);
    assert.deepEqual(result.layout.places.activity, before.layout.places.activity);
    assert.deepEqual(result.layout.places['source:old'], before.layout.places['source:old']);
    assert.deepEqual(result.names, before.names); assert.deepEqual(result.colors, before.colors);
    assert.equal(result.shown.length, resources.length * 2);
    assert.equal(result.layout.places.history, undefined);
    assert.equal(migrateAnalytics(result, resources), result);
    assert.ok(parseView(result));
    if (resources.length === 2) assert.ok(result.layout.places['budget-history'].y > 100);
  }
});

test('hidden legacy panels stay hidden across later capabilities and explicit empty additions stay placed', () => {
  const hidden = migrateAnalytics({...legacy(), hidden: ['history']}, []);
  const later = reconcileAnalytics(hidden, [quota,budget]);
  assert.deepEqual(later.hidden, ['quota-history','budget-history']);
  assert.equal(widgetVisible(later,'quota-history',2), false);
  assert.equal(widgetVisible(later,'budget-history',2), false);
  assert.equal(widgetVisible(later,'quota-table',2), true);
  const explicit = migrateAnalytics({...legacy(), enabledWhenEmpty: ['history']}, []);
  for (const id of ['quota-history','budget-history']) assert.equal(widgetVisible(explicit,id,0), true);
  assert.equal(reconcileAnalytics(explicit, []), explicit);
});

test('resource descriptors admit both families without consulting a balance or funding classification', () => {
  const both = {meterKinds:['window','balance'], monetary:{}};
  assert.equal(supportsQuota(both),true); assert.equal(supportsBudget(both),true);
  assert.equal(supportsQuota({meterKinds:['cap']}),false);
  assert.equal(supportsBudget({meterKinds:['balance']}),false);
  const placed = reconcileAnalytics(EMPTY_VIEW,[quota,budget]);
  assert.equal(placed.shown.length,4);
  assert.equal(reconcileAnalytics(placed,[]),placed);
});

test('pre-grid conversion retains absent cards, widths and independent table column choices', () => {
  const result = migrateAnalytics({...legacy(), order:['forecast','source:missing','history'], sizes:{history:6,'source:missing':4}, columns:{forecast:['value','spending','topup','remaining','futuretoken']}, shownColumns:{forecast:['during','agenthours']}}, [quota,budget]);
  assert.equal(result.layout.places['quota-history'].w,3);
  assert.equal(result.layout.places['source:missing'].w,2);
  assert.deepEqual(result.columns['quota-table'],['remaining','futuretoken']);
  assert.deepEqual(result.columns['budget-table'],['value','spending','topup']);
  assert.deepEqual(result.shownColumns['quota-table'],['during','agenthours']);
  assert.equal(result.order,undefined); assert.equal(result.sizes,undefined);
});

test('near-limit legacy documents retain every entry and fit the bounded migration reserve', () => {
  for (const resources of [[],[quota],[budget],[quota,budget]]) for (const pregrid of [false,true]) {
    const input = legacy();
    input.hidden = Array.from({length:198},(_,i) => 'é'.repeat(50)+i);
    input.hidden.push('history','forecast');
    input.names = Object.fromEntries(Array.from({length:100},(_,i) => ['n'+i, 'é'.repeat(60)]));
    input.columns.forecast = Array.from({length:20},(_,i) => String.fromCharCode(97+i).repeat(20));
    input.layout.places.history = {x:3,y:99999,w:3,h:200};
    if (pregrid) {
      input.order = ['forecast','history',...Array.from({length:198},(_,i)=>'source:ordered-'+i)];
      input.sizes = Object.fromEntries(Array.from({length:200},(_,i)=>['source:sized-'+i,12]));
      input.layout.places = {};
      for(let i=0;i<500;i++){const id='é'.repeat(50)+i;const next={...input,windows:[...input.windows,id]};if(Buffer.byteLength(JSON.stringify(next))>65536)break;input.windows=next.windows;}
    }
    for (let i=0;!pregrid;i++) {
      const id = 'source:'+i, next = {...input, layout:{columns:6,places:{...input.layout.places,[id]:{x:0,y:i,w:3}}}};
      if (Buffer.byteLength(JSON.stringify(next)) > 65536) break;
      input.layout = next.layout;
    }
    const migrated = migrateAnalytics(input,resources);
    assert.ok(Buffer.byteLength(JSON.stringify(input)) > 65400);
    assert.ok(Buffer.byteLength(JSON.stringify(migrated)) <= VIEW_BODY_LIMIT);
    assert.ok(parseView(migrated));
    for (const [id,place] of Object.entries(input.layout.places)) if (!['history','forecast'].includes(id)) assert.deepEqual(migrated.layout.places[id],place);
    assert.deepEqual(migrated.names,input.names);
    if(pregrid) {assert.equal(Object.keys(input.layout.places).length,0);for(const id of [...input.order!,...Object.keys(input.sizes!)])if(!['history','forecast'].includes(id))assert.ok(migrated.layout.places[id]);}
    assert.deepEqual(migrated.windows,input.windows);
    assert.equal(migrated.hidden.length,202);
  }
});

for (const version of [16,18]) test(`schema ${version} conversion is atomic, freezes legacy receipt targets and reconciles defaults once`, () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const step of STEPS.slice(0,version)) db.exec(step);
    db.exec(`PRAGMA user_version=${version}; INSERT INTO boards VALUES('board','',1,'owner',0); INSERT INTO sources(id,provider,account,created_at) VALUES('q','claude','account',0); INSERT INTO holders VALUES('q','owner',0)`);
    db.prepare('INSERT INTO views VALUES(?,?,?,?,?)').run('board',JSON.stringify(legacy()),'owner',0,7);
    db.prepare('INSERT INTO board_additions(id,owner_id,request_id,board_id,item,state,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run('receipt','owner','request','board',JSON.stringify({kind:'widget',widgetId:'history'}),'complete',0,0,100);
    migrate(db,1);
    assert.equal(db.prepare('SELECT widget_targets FROM board_additions').get()!.widget_targets,'["quota-history"]');
    const directory = new Directory(db), first = directory.viewState('board');
    assert.equal(first.revision,8);
    assert.deepEqual(directory.viewState('board'),first); migrate(db,2);
    assert.deepEqual(directory.viewState('board'),first);
    db.exec("INSERT INTO sources(id,provider,account,created_at) VALUES('b','deepseek','b',0); INSERT INTO holders VALUES('b','owner',0)");
    const expanded = directory.viewState('board');
    assert.equal(expanded.revision,9); assert.equal(expanded.view.shown.length,4);
    assert.deepEqual(directory.viewState('board'),expanded);
    assert.equal(db.prepare('SELECT updated_by FROM views').get()!.updated_by,'owner');
  } finally {db.close();}
});
