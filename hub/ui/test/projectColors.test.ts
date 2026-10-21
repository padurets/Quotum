import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveProjectColors,OTHER_COLOR,projectColorReply} from '../lib/projectColors';
import {CATEGORY_COLORS as C} from '../../server/domain/categoryColors';
import {groupRegistry} from '../lib/plotRegistry';
import {INITIAL,reduce,projectColorsReady,type Snapshot,type PageState,type HubEvent} from '../lib/board';
import type {ProjectColorEnvelope,ProjectColorPins} from '../../server/domain/projectColors';

const group=(name:string|null)=>({key:JSON.stringify(name),name});
const colors=(names:(string|null)[],pins:ProjectColorPins=[],previous:ReturnType<typeof resolveProjectColors>=[])=>resolveProjectColors(names.map(group),pins,previous);
test('initial allocation reserves every present manual choice before assigning ranked automatic groups',()=>{
  assert.deepEqual(colors(['A','B','C'],[['A',C[2]]]).map(g=>g.color),[C[2],C[0],C[1]]);
  assert.deepEqual(colors(['A','B'],[['absent',C[0]]]).map(g=>g.color),[C[0],C[1]]);
  const duplicate=colors(['A','B',...Array.from({length:9},(_,i)=>'auto'+i)],[['A',C[0]],['B',C[0]]]);
  assert.deepEqual(duplicate.map(g=>g.color),[C[0],C[0],...C.slice(1),OTHER_COLOR]);
  assert.equal(duplicate.length,11);assert.notEqual(duplicate[0].key,duplicate[1].key);
  assert.equal(colors([null],[["null",C[8]]])[0].color,C[0]);
  assert.equal(colors(['__proto__'],[['__proto__',C[8]]])[0].color,C[8]);
});

test('late manual reservation displaces only its conflicting automatic survivor',()=>{
  const previous=colors(['A','B']);
  const next=colors(['A','B','Z'],[['Z',C[0]]],previous);
  assert.deepEqual(next.map(g=>g.color),[C[2],C[1],C[0]]);
  const changed=colors(['A','B','Z'],[['Z',C[1]]],next);
  assert.deepEqual(changed.map(g=>g.color),[C[2],C[0],C[1]]);
  const reset=colors(['A','B','Z'],[],changed);
  assert.deepEqual(reset.map(g=>g.color),[C[2],C[0],C[1]]);assert.equal(reset[2].manual,false);
  assert.deepEqual(colors(['Z','B','A'],[],reset).map(g=>g.color),[C[1],C[0],C[2]],'ranking does not recolour survivors');
});

test('released slots do not promote neutral survivors, while new entries may take them',()=>{
  const names=Array.from({length:10},(_,i)=>'P'+i),initial=colors(names);
  const next=colors([...names.slice(1),'new'],[],initial);
  assert.equal(next.find(g=>g.name==='P9')!.color,OTHER_COLOR);assert.equal(next.at(-1)!.color,C[0]);
  const manual=colors(['manual',...names],[['manual',C[0]]]);
  const reset=colors(['manual',...names],[],manual);
  assert.equal(reset.find(g=>g.name==='P8')!.color,OTHER_COLOR);assert.equal(reset[0].color,C[0]);
});

test('the navigation registry keeps offscreen seeds reserved, releases only retired transients and preserves old no-pin allocation',()=>{
  const seed=colors(['seed']),first=groupRegistry(seed,seed,[group('late'),group('other')]);
  const pinned=resolveProjectColors(first,[['seed',C[1]]],seed);
  assert.deepEqual(pinned.map(g=>g.color),[C[1],C[0],C[2]]);
  const reversed=groupRegistry(seed,pinned,[group('other'),group('late')]);
  assert.deepEqual(resolveProjectColors(reversed,[['seed',C[1]]],pinned),pinned);
  const ordinary=groupRegistry(seed,seed,Array.from({length:11},(_,i)=>group('P'+i)));
  assert.deepEqual(resolveProjectColors(ordinary,[],seed).map(g=>g.color),ordinary.map(g=>g.color));
  const all=colors([...C.map((_,i)=>'manual'+i),'auto'],C.map((c,i)=>['manual'+i,c]));
  assert.equal(all.at(-1)!.color,OTHER_COLOR);
});

const view={version:5 as const,layout:{columns:6,places:{}},names:{},hidden:[],shown:[],windows:[],plans:{},unplanned:[],colors:{},columns:{},shownColumns:{}};
const baseline=(extra:Partial<Snapshot>={}):Snapshot=>({board:{id:'board',name:'Board',personal:true},view,historyStart:0,workAuthority:'work',sources:[],sessions:{},cadence:{},refresh:{},forecast:{},mine:[],boards:[],resets:{resets:{},trackers:[],past:{}},...extra});
const accept=(state:PageState,type:'hello'|'snapshot'|'board'|'projectColors'|'history',data:unknown)=>reduce(state,{type:'hub',event:{type,data} as HubEvent});
const envelope=(revision=1,authority='a'.repeat(43)):ProjectColorEnvelope=>({version:1,pins:[['A',C[0]]],revision,authority});

test('only matching configuration becomes ready and colour-only adoption preserves data and work authority',()=>{
  const e=envelope();
  const first=accept(INITIAL,'snapshot',baseline({projectColorsRevision:e.revision,projectColorsAuthority:e.authority}));
  assert.equal(projectColorsReady(first.board),false);
  assert.equal(accept(first,'projectColors',envelope(2)),first);
  const ready=accept(first,'projectColors',e);assert.ok(projectColorsReady(ready.board));
  const expected=accept(ready,'board',{projectColorsRevision:2,projectColorsAuthority:e.authority});
  assert.equal(expected.board!.projectColors,ready.board!.projectColors,'a missing frame is not Auto');
  assert.equal(projectColorsReady(expected.board),true,'an ordinary delta retains confirmed presentation');
  const changed=accept(expected,'projectColors',{...envelope(2),pins:[['A',C[1]]]});
  for(const key of ['cards','sessions','view','lineup','workAuthority'] as const)assert.equal(changed.board![key],ready.board![key]);
  assert.equal(accept(changed,'projectColors',e),changed);
  const retired=accept(changed,'snapshot',baseline({workAuthority:'revoked',projectColorsRevision:2,projectColorsAuthority:'b'.repeat(43)}));
  assert.equal(retired.board!.projectColors,undefined);assert.equal(accept(retired,'projectColors',envelope(2)),retired);
  assert.equal(projectColorsReady(accept(INITIAL,'snapshot',baseline()).board),true,'legacy means Auto');
  assert.equal(projectColorsReady(accept(INITIAL,'snapshot',baseline({projectColorsRevision:1})).board),false,'partial refs are not legacy');
});

for(const revision of [1,2])test(`a reconnect requires matching configuration for revision ${revision} in its own generation`,()=>{
  const e=envelope(),first=accept(INITIAL,'snapshot',baseline({projectColorsRevision:1,projectColorsAuthority:e.authority,projectColors:e}));
  const hello=accept(first,'hello',{epoch:'next'}),authority='b'.repeat(43);
  assert.equal(projectColorsReady(hello.board),false);
  const reopened=accept(hello,'snapshot',baseline({projectColorsRevision:revision,projectColorsAuthority:authority}));
  assert.equal(projectColorsReady(reopened.board),false);
  assert.equal(reopened.board!.projectColors,first.board!.projectColors,'previous paint is retained without confirming the new baseline');
  assert.equal(accept(reopened,'projectColors',e),reopened);
  const lateResponse={type:'project-colors-response' as const,board:'board',generation:0,workAuthority:'work',expected:e,colors:envelope(revision,authority)};
  assert.equal(reduce(reopened,lateResponse),reopened);
  const matched=accept(reopened,'projectColors',envelope(revision,authority));
  assert.equal(projectColorsReady(matched.board),true);
  assert.equal(matched.board!.projectColors!.authority,authority);
});

test('even unchanged colour references need confirmation after a new hello',()=>{
  const e=envelope(),first=accept(INITIAL,'snapshot',baseline({projectColorsRevision:1,projectColorsAuthority:e.authority,projectColors:e}));
  const reopened=accept(accept(first,'hello',{epoch:'same'}),'snapshot',baseline({projectColorsRevision:1,projectColorsAuthority:e.authority}));
  assert.equal(projectColorsReady(reopened.board),false);
  const confirmed=accept(reopened,'projectColors',e);
  assert.equal(confirmed.board!.projectColors,reopened.board!.projectColors);
  assert.equal(projectColorsReady(confirmed.board),true);
});

test('HTTP colour responses adopt atomically and cannot roll back events or cross a board lifetime',()=>{
  const e=envelope(),first=accept(INITIAL,'snapshot',baseline({projectColorsRevision:1,projectColorsAuthority:e.authority,projectColors:e}));
  const response={type:'project-colors-response' as const,board:'board',generation:0,workAuthority:'work',expected:e,colors:{...e,revision:2,pins:[['A',C[1]]] as ProjectColorPins}};
  const saved=reduce(first,response);assert.equal(saved.board!.projectColors?.revision,2);assert.equal(saved.board!.cards,first.board!.cards);
  const olderSnapshot=accept(saved,'snapshot',baseline({projectColorsRevision:1,projectColorsAuthority:e.authority,projectColors:e}));
  assert.equal(olderSnapshot.board!.projectColors,saved.board!.projectColors);assert.equal(olderSnapshot.board!.projectColorsRevision,2);
  assert.equal(projectColorsReady(olderSnapshot.board),true);
  const latest=accept(accept(saved,'board',{projectColorsRevision:3,projectColorsAuthority:'b'.repeat(43)}),'projectColors',envelope(3,'b'.repeat(43)));
  assert.equal(reduce(latest,response),latest);
  const revoked=accept(saved,'history',{sources:[],since:0,workAuthority:'revoked'});assert.equal(reduce(revoked,response),revoked);assert.equal(accept(revoked,'projectColors',e),revoked);
  const reopened=accept(reduce(first,{type:'board-close'}),'snapshot',baseline({projectColorsRevision:1,projectColorsAuthority:e.authority,projectColors:e}));
  assert.equal(reduce(reopened,response),reopened);
  assert.deepEqual(projectColorReply({...e,error:'project_colors_conflict'}),e);
  assert.deepEqual(projectColorReply({...e,error:'project_colors_context_changed'}),e);
  assert.equal(projectColorReply({...e,error:'unexpected'}),null);
});
