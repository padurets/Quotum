import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DataFilterState} from '../lib/filterState';
import {defaultFilters,executableWorkFilters,sameFilters,type FilterEnvelope,type FilterUpdate} from '../../server/domain/dataFilters';
import {mergeStoredFilters,projectStoredFilters,type StoredFilters} from '../../server/domain/dataFilterStorage';
import {ApiError} from '../lib/http';

const envelope=(revision=0):FilterEnvelope=>({filters:defaultFilters(),revision,authority:'authority-filter-test',unavailable:{sources:0,windows:0,wallet:0,funds:0,projects:0,devices:0,clients:0}});
const storage=()=>{const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};};

test('Restore survives reload and fresh tabs without reapplying the legacy seed',()=>{
  const migrationStorage=storage(),drafts=storage();
  const seed=(filters:ReturnType<typeof defaultFilters>)=>({...filters,wallet:{mode:'only' as const,values:[{source:'openrouter:a',kind:'balance' as const}]},funds:{mode:'include' as const,values:['codex:a']}});
  const open=(tab=drafts)=>{const state=new DataFilterState({storage:tab,migrationStorage,seed,save:async()=>envelope(1)});state.open('u','b');state.accept(envelope());return state;};
  const first=open();assert.equal(first.get().current!.wallet.mode,'only');first.toggle('projects','P',false);first.restore();
  assert.equal(first.get().dirty,false);
  for(const tab of [drafts,storage()]){const next=open(tab);assert.deepEqual(next.get().current,envelope().filters);assert.equal(next.get().dirty,false);}
});

test('legacy seed consumption belongs to its user, board and explicitly edited family',()=>{
  const migrationStorage=storage();
  const seed=(filters:ReturnType<typeof defaultFilters>)=>({...filters,wallet:{mode:'only' as const,values:[{source:'openrouter:a',kind:'balance' as const}]},funds:{mode:'include' as const,values:['codex:a']}});
  const open=(user='u',board='b')=>{const state=new DataFilterState({storage:storage(),migrationStorage,seed,save:async()=>envelope(1)});state.open(user,board);state.accept(envelope());return state;};
  assert.equal(open().get().current!.wallet.mode,'only','an untouched seed remains available in a fresh tab');
  const first=open();first.toggle('wallet',{source:'openrouter:a',kind:'balance'},false);
  const next=open();assert.deepEqual(next.get().current!.wallet,envelope().filters.wallet);assert.deepEqual(next.get().current!.funds,{mode:'include',values:['codex:a']});
  for(const state of [open('other'),open('u','other')])assert.equal(state.get().current!.wallet.mode,'only');
  const rejected=open('rejected');rejected.toggle('wallet',{source:'invalid source',kind:'balance'},true);
  assert.ok(rejected.get().error);assert.equal(open('rejected').get().current!.wallet.mode,'only','a refused edit cannot consume migration');
  const left=open('concurrent'),right=open('concurrent');
  left.toggle('wallet',{source:'openrouter:a',kind:'balance'},false);right.toggle('funds','codex:a',false);
  assert.deepEqual(open('concurrent').get().current,envelope().filters,'two already open tabs cannot overwrite each other\'s family receipt');
});

for(const edit of ['toggle','reset'] as const)test(`a refused ${edit} publishes its error after restoring clean intents`,()=>{
  const saved=envelope(1);saved.filters.projects={mode:'include',values:Array.from({length:1600},(_,i)=>String(i).padStart(4,'0')+'x'.repeat(60))};
  if(edit==='toggle')while(!executableWorkFilters(saved.filters))saved.filters.projects.values.pop();
  const drafts=storage(),receipts=storage(),state=new DataFilterState({storage:drafts,migrationStorage:receipts,save:async()=>saved});
  state.open('u','b');state.accept(saved);const before=state.get().current;assert.equal(state.get().dirty,false);
  const dirty:boolean[]=[];state.subscribe(()=>dirty.push(state.get().dirty));
  if(edit==='toggle')state.toggle('projects','new-'+'y'.repeat(60),true);else state.reset('wallet','all');
  assert.equal(state.get().current,before);assert.equal((state.get().error as ApiError).code,'filters_limit');
  assert.equal(state.get().dirty,false);assert.deepEqual(dirty,[false],'subscribers never see rejected temporary intents');
  assert.equal(drafts.getItem('quotum.filters.'+JSON.stringify(['u','b'])),null);
  assert.equal(receipts.getItem('quotum.filters.migration.'+JSON.stringify(['u','b'])+'.wallet'),null);
});

test('a delayed conflict cannot publish an authority superseded by the stream',async()=>{
  let reject!:(error:unknown)=>void;const state=new DataFilterState({save:()=>new Promise<FilterEnvelope>((_yes,no)=>{reject=no;})});
  state.open('u','b');state.accept(envelope(1));const pending=state.save();
  const stale={...envelope(1),authority:'context-stale-B'};stale.filters.projects={mode:'exclude',values:['Private']};
  const revoked={...envelope(1),authority:'context-current-C'};revoked.unavailable.projects=1;
  state.accept(stale);state.accept(revoked);const current=state.get().current;reject(new ApiError(409,'filters_context_changed',stale));await pending;
  assert.equal(state.get().saved?.authority,revoked.authority);assert.deepEqual(state.get().saved?.filters.projects.values,[]);assert.equal(state.get().current,current);assert.equal(state.get().saved?.unavailable.projects,1);
});

test('a delayed Save refresh cannot publish over a newer stream authority',async()=>{
  let resolve!:(value:FilterEnvelope)=>void,refresh!:(value:FilterEnvelope)=>void;
  const state=new DataFilterState({save:()=>new Promise<FilterEnvelope>(yes=>{resolve=yes;}),refresh:()=>new Promise<FilterEnvelope>(yes=>{refresh=yes;})});
  state.open('u','b');state.accept(envelope(1));const pending=state.save();
  const stale={...envelope(2),authority:'context-stale-B'};stale.filters.projects={mode:'exclude',values:['Private']};
  state.accept({...envelope(2),authority:'context-C'});resolve(stale);await Promise.resolve();assert.ok(refresh);
  const revoked={...envelope(2),authority:'context-current-D'};revoked.unavailable.projects=1;state.accept(revoked);
  refresh(stale);await pending;assert.equal(state.get().saved?.authority,revoked.authority);assert.deepEqual(state.get().current?.projects.values,[]);assert.equal(state.get().saved?.unavailable.projects,1);
});

test('auth retirement drops clean loaded views, restores user drafts and rejects old-session Save publication',async()=>{
  const memory=storage(),initial=envelope(1),latest=envelope(2);latest.filters.projects={mode:'exclude',values:['Saved']};
  let resolve!:(value:FilterEnvelope)=>void;
  const state=new DataFilterState({storage:memory,save:()=>new Promise<FilterEnvelope>(yes=>{resolve=yes;})});
  state.open('u','b');state.accept(initial);state.retire();state.open('u','b');state.accept(latest);assert.deepEqual(state.get().current,latest.filters);assert.equal(state.get().dirty,false);
  state.toggle('projects','Draft',false);const pending=state.save();state.retire();state.open('u','b');state.accept(latest);
  assert.deepEqual(state.get().current?.projects.values,['Draft','Saved']);resolve({...envelope(3),filters:defaultFilters()});await pending;
  assert.deepEqual(state.get().current?.projects.values,['Draft','Saved']);assert.equal(state.get().saved?.revision,2);
  state.retire();state.open('u','b');state.accept(latest);assert.deepEqual(state.get().current?.projects.values,['Draft','Saved'],'old flight did not replace the persisted new-session draft');
  state.open('other','b');state.accept(initial);state.open('u','b');state.accept(latest);assert.deepEqual(state.get().current?.projects.values,['Draft','Saved']);
});

test('foreign owner tabs preserve a dormant exclusion through a complete mode cycle without checkbox decisions',async()=>{
  let raw:StoredFilters={filters:defaultFilters(),retained:[]},revision=1;const allowed=(_family:unknown,ref:unknown)=>ref!=='hidden';
  const baseline=()=>({...envelope(revision),...projectStoredFilters(raw,allowed)});
  const env={save:async(_board:string,_revision:number,update:FilterUpdate)=>{assert.deepEqual(update.resets,{});assert.deepEqual(update.decisions,[]);raw=mergeStoredFilters(raw,update,allowed)!;revision++;return baseline();}};
  const a=new DataFilterState(env),c=new DataFilterState(env),first=envelope(1);first.filters.projects={mode:'include',values:['visible']};
  a.open('u','b');a.accept(first);c.open('u','b');c.accept(envelope(1));
  raw.filters.projects={mode:'exclude',values:['hidden']};revision=2;a.accept(baseline());c.accept(baseline());
  await a.save();c.accept(baseline());await c.save();
  assert.deepEqual(projectStoredFilters(raw,()=>true).filters.projects,{mode:'exclude',values:['hidden']});
});

test('a delayed Save cannot undo Restore, even when its reply changes the saved baseline',async()=>{
  let resolve!:(value:FilterEnvelope)=>void;
  const saved=envelope(1),state=new DataFilterState({save:()=>new Promise<FilterEnvelope>(yes=>{resolve=yes;})});
  state.open('u','b');state.accept(saved);state.toggle('projects','A',false);const pending=state.save();
  state.restore();assert.equal(state.get().dirty,false);
  const reply=envelope(2);reply.filters.projects={mode:'exclude',values:['A']};resolve(reply);await pending;
  assert.deepEqual(state.get().current,saved.filters);assert.deepEqual(state.get().saved,reply);assert.equal(state.get().dirty,true);
});

test('a Save changing authority A to B cannot overwrite a subsequently accepted C at the same revision',async()=>{
  let resolve!:(value:FilterEnvelope)=>void;
  const latest={...envelope(2),authority:'authority-C-current'};
  const state=new DataFilterState({save:()=>new Promise<FilterEnvelope>(yes=>{resolve=yes;}),refresh:async()=>latest});
  state.open('u','b');state.accept(envelope(1));state.toggle('projects','A',false);const pending=state.save();
  const reply={...envelope(2),authority:'authority-B-save'};reply.filters.projects={mode:'exclude',values:['A']};
  state.accept(reply);state.accept(latest);resolve(reply);await pending;
  assert.equal(state.get().saved?.authority,latest.authority);assert.equal(state.get().saved?.revision,2);
});

test('an explicit reset remains dirty and survives reload when its dormant effect has no visible difference',async()=>{
  const memory=storage(),saved=envelope(1);saved.unavailable.sources=1;let update:FilterUpdate|undefined;
  const make=()=>new DataFilterState({storage:memory,save:async(_board,_revision,value)=>{update=value;return envelope(2);}});
  const state=make();state.open('u','b');state.accept(saved);state.reset('sources','all');
  assert.deepEqual(state.get().current,saved.filters);assert.equal(state.get().dirty,true);
  const reload=make();reload.open('u','b');reload.accept(saved);assert.equal(reload.get().dirty,true);await reload.save();
  assert.deepEqual(update?.resets,{sources:'all'});assert.equal(reload.get().dirty,false);
});

test('reload rebases newly exposed raw rules against the persisted origin projection',async()=>{
  const memory=storage(),before=envelope(1),after=envelope(1);after.authority='authority-regrant';after.filters.sources={mode:'exclude',values:[{source:'restored'}]};
  let update:FilterUpdate|undefined;
  const make=()=>new DataFilterState({storage:memory,save:async(_board,_revision,value)=>{update=value;return {...after,revision:2,filters:value.filters};}});
  const first=make();first.open('u','b');first.accept(before);first.toggle('projects','A',false);
  const reloaded=make();reloaded.open('u','b');reloaded.accept(after);
  assert.deepEqual(reloaded.get().current?.sources,after.filters.sources);await reloaded.save();assert.deepEqual(update?.filters.sources,after.filters.sources);
});

test('same-revision regrant rebases every unedited legacy unit branch before an unrelated Save',async()=>{
  const before=envelope(1);before.filters.legacy={walletByUnit:{USD:{mode:'only',values:[]},EUR:{mode:'only',values:[]}},fundsByUnit:{USD:{mode:'include',values:[]}},fundsPreferredByUnit:{USD:[]}};
  const after=structuredClone(before);after.authority='authority-unit-regrant';
  after.filters.legacy!.walletByUnit!.USD.values=[{source:'restored',kind:'keyCap',key:'usd'}];after.filters.legacy!.walletByUnit!.EUR.values=[{source:'restored',kind:'keyCap',key:'eur'}];
  after.filters.legacy!.fundsByUnit!.USD.values=['funds'];after.filters.legacy!.fundsPreferredByUnit!.USD=['funds'];
  let update:FilterUpdate|undefined;const state=new DataFilterState({save:async(_board,_revision,value)=>{update=value;return {...after,revision:2,filters:value.filters};}});
  state.open('u','b');state.accept(before);state.toggle('projects','A',false);state.accept(after);await state.save();
  assert.deepEqual(update?.filters.legacy,after.filters.legacy);
});

for(const order of [['sources','projects'],['projects','sources']] as const)test(`oversized current recovers through successive ${order.join('/')} resets and exact Restore`,async()=>{
  const saved=envelope(1);saved.filters.sources={mode:'include',values:Array.from({length:2000},(_,i)=>({source:`${i}`.padStart(24,'s')}))};saved.filters.projects={mode:'include',values:Array.from({length:1000},(_,i)=>`${i}`.padStart(83,'p'))};
  let writes=0;const state=new DataFilterState({save:async()=>{writes++;return saved;}});state.open('u','b');state.accept(saved);
  state.reset(order[0],'all');assert.equal(state.get().current?.[order[0]].mode,'exclude');assert.equal(executableWorkFilters(state.get().current!),false);await state.save();assert.equal(writes,0);
  state.reset(order[1],'all');assert.equal(executableWorkFilters(state.get().current!),true);assert.equal(state.get().error,null);
  state.restore();assert.equal(sameFilters(state.get().current!,saved.filters),true);assert.equal((state.get().error as {code:string}).code,'filters_limit');assert.equal(state.get().dirty,false);
});

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

test('the resource cross publishes one complete reset and leaves work dimensions unchanged',async()=>{
  let write:FilterUpdate|undefined;
  const state=new DataFilterState({save:async(_board,_revision,update)=>{write=update;return {...envelope(2),filters:update.filters};}}),saved=envelope(1);
  saved.filters.legacy={walletByUnit:{USD:{mode:'only',values:[]}},fundsByUnit:{USD:{mode:'include',values:[]}}};
  state.open('u','b');state.accept(saved);state.toggle('projects','P',false);state.toggle('sources',{source:'s'},false);state.toggle('windows',['s','weekly'],false);
  let notifications=0;const unsubscribe=state.subscribe(()=>{notifications++;});
  state.reset(['sources','windows','wallet','funds'],'all');unsubscribe();
  assert.equal(notifications,1);assert.deepEqual(state.get().current,{...defaultFilters(),projects:{mode:'exclude',values:['P']}});
  await state.save();assert.deepEqual(write?.resets,{sources:'all',windows:'all',wallet:'all',funds:'all'});
  assert.ok(write?.decisions?.every(decision=>decision.family==='projects'));
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
