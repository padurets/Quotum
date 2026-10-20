import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters,parseDataFilters,parseFilterUpdate,parseWorkFilter,sameFilters,matchesWork,matchesWallet,workFilter,type DataFilters,type FilterUpdate,type MoneyRef} from '../domain/dataFilters.js';
import {filtersFromView,mergeFilters,projectFilters,resetFilter,setSelection} from '../domain/dataFilterMerge.js';
import {executableWorkFilters} from '../dataFilters.js';

const update=(filters:DataFilters,replace:FilterUpdate['replace']):FilterUpdate=>({filters,replace,authority:'a'.repeat(32)});
const cap=(key:string):MoneyRef=>({source:'openrouter:s',kind:'keyCap',key});

test('one strict codec canonicalizes every reference without changing explicit empty intent',()=>{
  const a=defaultFilters(),b=defaultFilters();
  a.sources={mode:'include',values:[{source:'codex:a'},{status:'unknown'},{source:'codex:a'}]};
  b.sources={mode:'include',values:[{status:'unknown'},{source:'codex:a'}]};
  a.wallet={mode:'only',values:[{key:'K',kind:'keyCap',source:'openrouter:s'}]};b.wallet={mode:'only',values:[cap('K')]};
  assert.ok(sameFilters(a,b));assert.equal(parseDataFilters({...a,typo:true}),null);
  assert.equal(parseDataFilters({...a,projects:{mode:'include',values:[null],typo:true}}),null);
  assert.equal(parseDataFilters({...a,wallet:{mode:'only',values:[{source:'s',kind:'usage'}]}}),null);
  assert.equal(parseDataFilters({...a,legacy:{walletByUnit:{arbitrary:{mode:'only',values:[]}}}}),null);
  assert.equal(parseWorkFilter({...workFilter(a),wallet:a.wallet}),null);
  assert.equal(parseFilterUpdate({...update(a,['wallet']),materialize:{wallet:'USD'},typo:true}),null);
  assert.equal(parseFilterUpdate({...update(a,['wallet']),materialize:{wallet:'USD'}})?.materialize?.wallet,'USD');
});

test('work predicates intersect funding, corrected project, device and actual client',()=>{
  const filters=defaultFilters(),row={source:'codex:a',project:'A',device:'d',clientId:'opencode'};
  assert.ok(matchesWork(filters,row));assert.ok(matchesWork(filters,{...row,source:null,project:null,clientId:null}));
  filters.projects={mode:'include',values:['A']};filters.clients={mode:'include',values:['opencode']};
  assert.ok(matchesWork(filters,row));assert.equal(matchesWork(filters,{...row,project:'B'}),false);
  filters.devices={mode:'exclude',values:['d']};assert.equal(matchesWork(filters,row),false);
  filters.devices={mode:'exclude',values:[]};filters.sources={mode:'include',values:[{status:'notProvided'}]};
  assert.equal(matchesWork(filters,row),false);assert.ok(matchesWork(filters,{...row,source:null,sourceStatus:'notProvided'}));
  filters.projects={mode:'include',values:[]};assert.equal(matchesWork(filters,{...row,source:null,sourceStatus:'notProvided'}),false);
  filters.projects={mode:'include',values:[null]};assert.equal(matchesWork(filters,{...row,source:null,sourceStatus:'notProvided',project:'Без проекта'}),false);
});

test('auto wallet previews are bounded defaults, exclusions win, explicit only never broadens',()=>{
  const rule={mode:'auto' as const,include:[cap('pinned'),cap('off')],exclude:[cap('off')]};
  assert.ok(matchesWallet(rule,cap('preview'),true));assert.ok(matchesWallet(rule,cap('pinned'),false));
  assert.equal(matchesWallet(rule,cap('outside'),false),false);assert.equal(matchesWallet(rule,cap('off'),true),false);
  assert.equal(matchesWallet({mode:'only',values:[]},cap('preview'),true),false);
});

for(const mode of ['include','exclude'] as const)test(`dormant ${mode} decisions survive projected and unrelated saves`,()=>{
  const raw=defaultFilters();raw.sources={mode,values:[{source:'hidden'}]};raw.windows={mode,values:[['hidden','week']]};raw.funds={mode,values:['hidden']};
  raw.wallet={mode:'auto',include:[cap('hidden')],exclude:[cap('off')]};
  const allowed=(_family:unknown,ref:unknown)=>!JSON.stringify(ref).includes('hidden')&&!JSON.stringify(ref).includes('off');
  const projected=projectFilters(raw,allowed);assert.deepEqual(projected.filters.sources,{mode,values:[]});assert.equal(projected.unavailable.sources,1);
  const draft=structuredClone(projected.filters);draft.projects={mode:'include',values:['P']};
  const saved=mergeFilters(raw,update(draft,['projects']),allowed)!;
  assert.deepEqual(saved.sources,raw.sources);assert.deepEqual(saved.wallet,raw.wallet);
  const again=mergeFilters(saved,update(draft,['sources','windows','wallet','funds']),allowed)!;
  assert.deepEqual(again.sources,raw.sources);assert.deepEqual(again.windows,raw.windows);assert.deepEqual(again.wallet,raw.wallet);assert.deepEqual(again.funds,raw.funds);
  const cleared=mergeFilters(saved,{...update(draft,['sources']),resets:{sources:'all'}},allowed)!;
  assert.deepEqual(cleared.sources,{mode:'exclude',values:[]});assert.deepEqual(cleared.wallet,raw.wallet);
});

test('mode changes preserve the boolean membership of dormant explicit decisions',()=>{
  const raw=defaultFilters();raw.projects={mode:'include',values:['hidden']};
  let draft=defaultFilters();draft.projects={mode:'exclude',values:['visible']};
  let saved=mergeFilters(raw,update(draft,['projects']),(_family,ref)=>ref!=='hidden')!;
  assert.equal(saved.projects.mode,'exclude');assert.deepEqual(saved.projects.values,['visible']);
  raw.projects={mode:'exclude',values:['hidden']};draft.projects={mode:'include',values:['visible']};
  saved=mergeFilters(raw,update(draft,['projects']),(_family,ref)=>ref!=='hidden')!;
  assert.deepEqual(saved.projects,{mode:'include',values:['visible']});
});

test('off before revoke persists through the final explicit decision, and reset discards old dormant rules',()=>{
  const raw=defaultFilters(),draft=defaultFilters();
  const saved=mergeFilters(raw,{...update(draft,['sources']),decisions:[{family:'sources',ref:{source:'revoked'},included:false}]},()=>false)!;
  assert.deepEqual(saved.sources,{mode:'exclude',values:[{source:'revoked'}]});
  assert.deepEqual(resetFilter(saved,'sources','none').sources,{mode:'include',values:[]});
});

test('unit materialization preserves only the named raw branch and its dormant choices',()=>{
  const raw=defaultFilters();raw.legacy={walletByUnit:{USD:{mode:'only',values:[cap('C'),cap('U')]},EUR:{mode:'only',values:[cap('C'),cap('E')]}},fundsByUnit:{USD:{mode:'include',values:['funds']}}};
  const allowed=(_family:unknown,ref:unknown)=>JSON.stringify(ref).includes('"C"');
  const draft=projectFilters(raw,allowed).filters;
  const untouched=mergeFilters(raw,update(draft,['wallet']),allowed)!;assert.deepEqual(untouched.legacy,raw.legacy);
  for(const unit of ['USD','EUR']){
    const edit=structuredClone(draft);edit.wallet={mode:'only',values:[]};delete edit.legacy!.walletByUnit;
    const result=mergeFilters(raw,{...update(edit,['wallet']),materialize:{wallet:unit},decisions:[{family:'wallet',ref:cap('C'),included:false}]},allowed)!;
    assert.deepEqual(result.wallet,{mode:'only',values:[cap(unit==='USD'?'U':'E')]});
    assert.equal(result.legacy?.walletByUnit,undefined);assert.deepEqual(result.legacy?.fundsByUnit,raw.legacy.fundsByUnit);
    assert.equal(mergeFilters(raw,update(edit,['wallet']),allowed),null,'a missing unit must not silently pick a branch');
  }
  const reset=mergeFilters(raw,{...update(draft,['wallet']),resets:{wallet:'all'}},allowed)!;
  assert.deepEqual(reset.wallet,{mode:'auto',include:[],exclude:[]});assert.equal(reset.legacy?.walletByUnit,undefined);
});

test('v4 migration separates native windows and key caps without excluding hidden cards',()=>{
  const filters=filtersFromView({windows:['claude:a/week','openrouter:s/key:off'],shown:['openrouter:s/key:pinned','openrouter:s/key:off','budget-history']});
  assert.deepEqual(filters.sources,{mode:'exclude',values:[]});assert.deepEqual(filters.windows,{mode:'exclude',values:[['claude:a','week']]});
  assert.deepEqual(filters.wallet,{mode:'auto',include:[cap('pinned')],exclude:[cap('off')]});
});

test('v4 native window IDs retain key prefixes and slash scopes as window exclusions',()=>{
  const windows=['key:session','scope/key:x:session','scope/key:x:weekly'];
  for(const provider of ['claude','codex','antigravity']){
    const source=provider+':a',filters=filtersFromView({windows:windows.map(id=>source+'/'+id),shown:[]});
    assert.deepEqual(filters.windows,{mode:'exclude',values:windows.map(id=>[source,id])});
    assert.deepEqual(filters.wallet,{mode:'auto',include:[],exclude:[]});
  }
});

test('metadata that fits storage can still be too large for an executable work request',()=>{
  const filters=defaultFilters();filters.projects={mode:'include',values:Array.from({length:1000},(_,i)=>String(i).padStart(4,'0')+'p'.repeat(79))};
  assert.ok(parseDataFilters(filters));assert.equal(executableWorkFilters(filters),false);
  filters.projects=setSelection({mode:'include',values:[]},'P',true);assert.ok(executableWorkFilters(filters));
});
