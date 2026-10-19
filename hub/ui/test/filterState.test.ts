import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DataFilterState} from '../lib/filterState';
import {defaultFilters,type FilterEnvelope,type FilterUpdate} from '../../server/domain/dataFilters';

const envelope=(revision=0):FilterEnvelope=>({filters:defaultFilters(),revision,authority:'authority-filter-test',unavailable:{sources:0,windows:0,wallet:0,funds:0,projects:0,devices:0,clients:0}});
const storage=()=>{const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};};

test('current filters stay local, restore uses the latest baseline, and a fresh tab gets saved defaults',()=>{
  const saved=envelope(1),memory=storage(),state=new DataFilterState({storage:memory,save:async()=>saved});
  state.open('user','board');state.accept(saved);state.toggle('projects','A',false);
  assert.deepEqual(state.get().current?.projects,{mode:'exclude',values:['A']});assert.equal(state.get().dirty,true);
  state.open('user','other');state.accept(envelope(1));assert.deepEqual(state.get().current?.projects,{mode:'exclude',values:[]});
  state.open('user','board');assert.deepEqual(state.get().current?.projects,{mode:'exclude',values:['A']});
  const reloaded=new DataFilterState({storage:memory,save:async()=>saved});reloaded.open('user','board');reloaded.accept(saved);assert.deepEqual(reloaded.get().current?.projects,state.get().current?.projects);
  const foreign=envelope(2);foreign.filters.clients={mode:'include',values:['opencode']};state.accept(foreign);
  assert.deepEqual(state.get().current?.clients,{mode:'exclude',values:[]},'foreign saves update Restore, not the current view');
  state.restore();assert.deepEqual(state.get().current,foreign.filters);assert.equal(state.get().dirty,false);
  const otherUser=new DataFilterState({storage:memory,save:async()=>saved});otherUser.open('other-user','board');otherUser.accept(saved);assert.deepEqual(otherUser.get().current,saved.filters);
});

test('a save acknowledges only its captured edits and cannot overwrite another board or newer intent',async()=>{
  let resolve!:(value:FilterEnvelope)=>void;const writes:{board:string;revision:number;update:FilterUpdate}[]=[];
  const state=new DataFilterState({save:async(board,revision,update)=>{writes.push({board,revision,update});return new Promise<FilterEnvelope>(yes=>{resolve=yes;});}});
  state.open('user','A');state.accept(envelope());state.toggle('projects','P',false);
  const flight=state.save();state.toggle('projects','Q',false);
  const saved=envelope(1);saved.filters=writes[0].update.filters;resolve(saved);await flight;
  assert.deepEqual(state.get().saved?.filters.projects,{mode:'exclude',values:['P']});assert.deepEqual(state.get().current?.projects,{mode:'exclude',values:['P','Q']});assert.equal(state.get().dirty,true);assert.equal(writes.length,1);
  const next=state.save();state.open('user','B');state.accept(envelope());resolve({...envelope(2),filters:writes[1].update.filters});await next;
  assert.deepEqual(state.get().current?.projects,{mode:'exclude',values:[]});state.open('user','A');assert.deepEqual(state.get().saved?.filters.projects,{mode:'exclude',values:['P','Q']});
});

test('same-revision regrant restores untouched raw decisions and preserves explicit draft off decisions',()=>{
  const state=new DataFilterState({save:async()=>envelope()}),before=envelope(1);state.open('user','board');state.accept(before);state.toggle('projects','Y',false);
  const regrant=envelope(1);regrant.authority='regranted-authority';regrant.filters.sources={mode:'exclude',values:[{source:'X'}]};state.accept(regrant);
  assert.deepEqual(state.get().current?.sources,regrant.filters.sources);assert.deepEqual(state.get().current?.projects,{mode:'exclude',values:['Y']});
  state.toggle('sources',{source:'X'},true);const revoked=envelope(1);revoked.authority='revoked-authority';state.accept(revoked);state.accept(regrant);
  assert.deepEqual(state.get().current?.sources,{mode:'exclude',values:[]},'a current explicit checkbox decision wins over newly exposed raw rules');
});

test('automatic and clear reset only their family and the first equal Save adopts revision zero',async()=>{
  let writes=0;const state=new DataFilterState({save:async(_board,_revision,update)=>{writes++;return {...envelope(1),filters:update.filters};}});
  state.open('user','board');state.accept(envelope());await state.save();assert.equal(writes,1);assert.equal(state.get().saved?.revision,1);
  state.toggle('projects','P',false);state.reset('wallet','none');assert.deepEqual(state.get().current?.wallet,{mode:'only',values:[]});
  state.reset('wallet','all');assert.deepEqual(state.get().current?.wallet,{mode:'auto',include:[],exclude:[]});assert.deepEqual(state.get().current?.projects,{mode:'exclude',values:['P']});
});

test('compact consumes saved defaults without changing the dashboard draft',()=>{
  const state=new DataFilterState({save:async()=>envelope(1)}),saved=envelope(1);
  state.open('u','b');state.accept(saved);state.toggle('projects','P',false);
  const current=state.get().current;
  state.open('u','b',true);state.accept(saved);assert.deepEqual(state.get().current,saved.filters);
  state.open('u','b');state.accept(saved);assert.deepEqual(state.get().current,current);assert.equal(state.get().dirty,true);
});

test('a stale-authority Save response keeps its revision floor and refreshes without retrying the write',async()=>{
  let resolve!:(reply:FilterEnvelope)=>void,writes=0;
  const latest={...envelope(2),authority:'new-context'};
  const state=new DataFilterState({save:()=>{writes++;return new Promise<FilterEnvelope>(yes=>{resolve=yes;});},refresh:async()=>latest});
  state.open('user','board');state.accept(envelope(1));state.toggle('projects','P',false);
  const saving=state.save();state.accept({...envelope(1),authority:'new-context'});
  resolve(envelope(2));await saving;
  assert.equal(writes,1);assert.equal(state.get().saved?.revision,2);assert.equal(state.get().saved?.authority,'new-context');
  state.accept(envelope(1));assert.equal(state.get().saved?.revision,2);
  assert.deepEqual(state.get().current?.projects,{mode:'exclude',values:['P']});
});
