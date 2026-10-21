import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters,type DataFilters} from '../../server/domain/dataFilters';
import {legendSelectionKey,type LegendKind} from '../lib/legendSelection';
import type {Card} from '../lib/types';
import * as filterRuntime from '../lib/filterSelection';
import * as filterModel from '../../server/domain/dataFilters';
import * as legendModel from '../lib/legendSelection';
import {DataFilterState} from '../lib/filterState';
import {workChange} from '../lib/workChanges';
import {preparationFixture} from './preparationFixture';
import {arbiter} from './seriesFocusFixture';

const cards=[{id:'q',provider:'codex',windows:[{id:'five',kind:'session'},{id:'week',kind:'weekly'}]},
  {id:'w',provider:'openrouter',windows:[]},{id:'cap',provider:'zai',windows:[]}] as unknown as Card[];
const kinds:LegendKind[]=['project','device','source','session','weekly','budget','funds'];
const changed=(edit:(filters:DataFilters)=>void)=>{const before=defaultFilters(),after=defaultFilters();edit(after);return kinds.filter(kind=>legendSelectionKey(before,{kind,unit:'USD'},cards)!==legendSelectionKey(after,{kind,unit:'USD'},cards));};

test('semantic projections reset just the relevant legend, independent of work data and history ranges',()=>{
  assert.deepEqual(changed(f=>f.projects.values=['Atlas']),['project']);
  assert.deepEqual(changed(f=>f.devices.values=['laptop']),['device']);
  assert.deepEqual(changed(f=>f.clients.values=['codex']),[]);
  assert.deepEqual(changed(f=>f.windows.values=[['q','week']]),['weekly']);
  assert.deepEqual(changed(f=>f.windows.values=[['q','five']]),['session']);
  assert.deepEqual(changed(f=>f.windows.values=[['q','unknown']]),['session','weekly']);
  assert.deepEqual(changed(f=>f.wallet={mode:'only',values:[{source:'w',kind:'balance'}]}),['budget']);
  assert.deepEqual(changed(f=>f.funds.values=['q']),['funds']);
  assert.deepEqual(changed(f=>f.sources.values=[{source:'w'}]),['source','budget']);
  assert.deepEqual(changed(f=>f.sources.values=[{source:'q'}]),['source','session','weekly','funds']);
  assert.deepEqual(changed(f=>f.sources.values=[{status:'unknown'}]),['source']);
});

test('canonical equivalent refs and inactive-unit legacy rules preserve the chosen set',()=>{
  const a=defaultFilters(),b=defaultFilters();a.sources.values=[{source:'q'},{source:'w'}];b.sources.values=[{source:'w'},{source:'q'},{source:'w'}];
  a.windows.values=[['q','week'],['q','five']];b.windows.values=[['q','five'],['q','week'],['q','week']];
  a.projects.values=['Atlas',null];b.projects.values=[null,'Atlas','Atlas'];
  a.wallet={mode:'auto',include:[{source:'w',kind:'balance'},{source:'w',kind:'keyCap',key:'k'}],exclude:[]};b.wallet={mode:'auto',include:[{source:'w',kind:'keyCap',key:'k'},{source:'w',kind:'balance'}],exclude:[]};
  for(const kind of kinds)assert.equal(legendSelectionKey(a,{kind,unit:'USD'},cards),legendSelectionKey(b,{kind,unit:'USD'},cards),kind);
  b.legacy={walletByUnit:{EUR:{mode:'only',values:[]}},fundsByUnit:{EUR:{mode:'include',values:[]}}};
  for(const kind of kinds)assert.equal(legendSelectionKey(a,{kind,unit:'USD'},cards),legendSelectionKey(b,{kind,unit:'USD'},cards),kind);
  for(const kind of ['budget','funds'] as const)assert.notEqual(legendSelectionKey(a,{kind,unit:'EUR'},cards),legendSelectionKey(b,{kind,unit:'EUR'},cards));
});

for(const kind of kinds)test(`${kind}: the mounted production hook follows applied edits, late saves and real revocation`,async()=>{
  const hooks=preparationFixture(),watchers=new Set<(event:any,state:any)=>void>();
  let board:any={id:'board',lineup:cards.map(card=>card.id),cards:Object.fromEntries(cards.map(card=>[card.id,{...card,budget:{enabled:true,since:0,anchor:0,revision:'grant-A'}}])),workAuthority:'work-A'};
  const page={get:()=>({board}),listen:(run:any)=>{watchers.add(run);return()=>watchers.delete(run);}};
  const h=arbiter({react:{useRef:hooks.useRef,useLayoutEffect:hooks.useLayoutEffect,useEffect:hooks.useLayoutEffect},'../lib/board':{page},'../lib/filterSelection':filterRuntime,'../lib/legendSelection':legendModel,'../../server/domain/dataFilters':filterModel,'../lib/workChanges':{workChange}});
  h.cleanup();
  const root={current:h.root};let context='board:'+kind,transient='R1';
  const render=()=>{hooks.begin();h.hook(root,context,{kind,unit:'USD'},transient);hooks.commit();};
  let resolveSave:(value:any)=>void=()=>{};
  const initial=defaultFilters(),envelope=(filters:DataFilters,revision=1)=>({filters,revision,authority:'test-authority-12345',unavailable:{sources:0,windows:0,wallet:0,funds:0,projects:0,devices:0,clients:0}});
  const state=new DataFilterState({save:()=>new Promise(yes=>{resolveSave=yes;})});state.open('u','board');state.accept(envelope(initial));
  const publish=state.subscribe(()=>filterRuntime.publishDataFilters(state.get().current));filterRuntime.publishDataFilters(state.get().current);
  try{
    render();h.click(h.a);h.click(h.b);assert.equal(h.a.pressed,'true');
    transient='R2';h.a.attached=false;render();assert.equal(h.b.pressed,'true');
    state.toggle('clients','codex',false);assert.equal(h.b.pressed,'true','unrelated work edits preserve every legend');
    const saving=state.save();assert.equal(h.b.pressed,'true','Save without another semantic edit preserves choices');
    state.toggle('devices','other-device',false);
    assert.equal(h.b.pressed,kind==='device'?'false':'true','only a device legend resets');
    h.click(h.c);
    resolveSave(envelope({...state.get().current!,devices:initial.devices},2));await saving;
    assert.equal(h.c.pressed,'true','a late save cannot erase choices made under an unchanged relevant rule');
    const relevant=kind==='project'?'projects':kind==='device'?'devices':kind==='source'?'sources':kind==='session'||kind==='weekly'?'windows':kind==='budget'?'wallet':'funds';
    const ref=kind==='project'?'Atlas':kind==='device'?'new-device':kind==='source'?{source:'q'}:kind==='session'?['q','five']:kind==='weekly'?['q','week']:kind==='budget'?{source:'w',kind:'balance'}:'q';
    state.toggle(relevant,ref as any,false,'USD');
    assert.equal(h.c.pressed,'false','a relevant edit resets immediately, before a history response');
    h.a.attached=true;transient='late-R1';render();assert.equal(h.a.pressed,'false','a delayed range answer cannot resurrect the old choice');
    h.click(h.a);filterRuntime.publishDataFilters(null);render();assert.equal(h.a.pressed,'true','pending is not an accepted selection edit');
    filterRuntime.publishDataFilters(state.get().current);render();assert.equal(h.a.pressed,'true');
    const event={type:'hub',event:{type:'snapshot'}};board={...board};for(const run of watchers)run(event,{board});assert.equal(h.a.pressed,'true','ordinary presentation revisions are not revocation');
    for(const [id,family] of [['q','funds'],['w','budget']] as const){
      board={...board,cards:{...board.cards,[id]:{...board.cards[id],budget:{...board.cards[id].budget,anchor:1}}}};
      for(const run of watchers)run(event,{board});assert.equal(h.a.pressed,'true','an ordinary first observation anchor preserves every choice');
      board={...board,cards:{...board.cards,[id]:{...board.cards[id],budget:{enabled:false,since:null,anchor:null,revision:'grant-B'}}}};
      for(const run of watchers)run(event,{board});assert.equal(h.a.pressed,kind===family?'false':'true','a same-source financial revocation resets only its money legend');
      board={...board,cards:{...board.cards,[id]:{...board.cards[id],budget:{enabled:true,since:10,anchor:null,revision:'grant-C'}}}};
      for(const run of watchers)run(event,{board});assert.equal(h.a.pressed,kind===family?'false':'true','regranting the same source cannot restore revoked choices');
      if(kind===family)h.click(h.a);
    }
    context='other-board:'+kind;render();assert.equal(h.a.pressed,'false');h.click(h.a);
    board=null;for(const run of watchers)run({type:'board-close'},{board});assert.equal(h.a.pressed,'false','access close clears immediately');
  }finally{hooks.unmount();publish();filterRuntime.publishDataFilters(null,false);assert.equal(h.events.size,0);assert.equal(h.globalEvents.size,0);assert.equal(watchers.size,0);}
});
