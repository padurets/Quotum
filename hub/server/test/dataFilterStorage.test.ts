import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultFilters,matchesSelection,matchesWallet,parseDataFilters,type FilterUpdate} from '../domain/dataFilters.js';
import {mergeStoredFilters,parseStoredFilters,projectStoredFilters,sameStoredFilters,type StoredFilters} from '../domain/dataFilterStorage.js';

const update=(filters=defaultFilters(),replace:FilterUpdate['replace']=['projects']):FilterUpdate=>({filters,replace,authority:'authority-storage'});
const allowed=(_family:unknown,ref:unknown)=>typeof ref==='object'&&ref!==null&&'source' in ref?ref.source!=='hidden':ref!=='hidden';

for(const included of [false,true])test(`repeated modes preserve a dormant explicit ${included?'on':'off'} until reset`,()=>{
  let raw:StoredFilters={filters:defaultFilters(),retained:[]};raw.filters.projects={mode:included?'include':'exclude',values:['hidden']};
  for(let i=0;i<4;i++){
    const draft=defaultFilters();draft.projects={mode:i%2?(included?'include':'exclude'):(included?'exclude':'include'),values:['visible']};
    raw=mergeStoredFilters(raw,update(draft),allowed)!;
    assert.equal(JSON.stringify(projectStoredFilters(raw,allowed).filters).includes('hidden'),false);
    assert.equal(projectStoredFilters(raw,allowed).unavailable.projects,1);
    assert.equal(matchesSelection(projectStoredFilters(raw,()=>true).filters.projects,'hidden'),included);
    raw=parseStoredFilters(JSON.parse(JSON.stringify(raw)))!;
  }
  const reset=mergeStoredFilters(raw,{...update(),resets:{projects:'all'}},allowed)!;
  assert.deepEqual(reset.retained,[]);assert.equal(matchesSelection(reset.filters.projects,'hidden'),true);
});

test('wallet automatic exclusions survive only mode without pinning the automatic preview',()=>{
  const hidden={source:'hidden',kind:'keyCap' as const,key:'cap'},visible={source:'visible',kind:'balance' as const};
  const raw:StoredFilters={filters:defaultFilters(),retained:[]};raw.filters.wallet={mode:'auto',include:[],exclude:[hidden]};
  const draft=defaultFilters();draft.wallet={mode:'only',values:[visible]};
  const only=mergeStoredFilters(raw,update(draft,['wallet']),allowed)!;assert.deepEqual(only.retained,[{family:'wallet',ref:hidden,included:false}]);
  const auto=mergeStoredFilters(only,update(defaultFilters(),['wallet']),allowed,()=>true)!;
  assert.equal(matchesWallet(auto.filters.wallet,hidden,true),false);assert.equal(auto.filters.wallet.mode,'auto');
  if(auto.filters.wallet.mode==='auto')assert.deepEqual(auto.filters.wallet.include,[]);
});

test('unit branches keep opposite dormant decisions and materialize only the named branch',()=>{
  const raw:StoredFilters={filters:defaultFilters(),retained:[]};raw.filters.legacy={fundsByUnit:{USD:{mode:'exclude',values:['hidden']},EUR:{mode:'include',values:['hidden']}}};
  const draft=defaultFilters();draft.legacy={fundsByUnit:{USD:{mode:'include',values:['visible']},EUR:{mode:'exclude',values:['visible']}}};
  const switched=mergeStoredFilters(raw,update(draft,['funds']),allowed)!;
  assert.deepEqual(switched.retained.map(d=>[d.unit,d.included]),[['EUR',true],['USD',false]]);
  const materialized=mergeStoredFilters(switched,{...update(draft,['funds']),materialize:{funds:'USD'}},allowed)!;
  assert.equal(materialized.filters.legacy,undefined);assert.equal(matchesSelection(materialized.filters.funds,'hidden'),false);
  assert.ok(materialized.retained.every(d=>d.unit===undefined));assert.ok(materialized.retained.filter(d=>d.ref==='hidden').every(d=>d.included===false));
});

test('authorized changes and explicit checkbox decisions replace latent membership; raw equality includes it',()=>{
  const raw:StoredFilters={filters:defaultFilters(),retained:[{family:'projects',ref:'hidden',included:true}]};
  const draft=defaultFilters();draft.projects={mode:'include',values:[]};
  const changed=mergeStoredFilters(raw,update(draft),()=>true)!;assert.equal(matchesSelection(changed.filters.projects,'hidden'),false);assert.deepEqual(changed.retained,[]);
  const checkbox=mergeStoredFilters(raw,{...update(draft),decisions:[{family:'projects',ref:'hidden',included:false}]},allowed)!;
  assert.equal(matchesSelection(projectStoredFilters(checkbox,()=>true).filters.projects,'hidden'),false);
  assert.equal(sameStoredFilters(checkbox,{filters:checkbox.filters,retained:[]}),false);
});

test('the private wrapper has a strict total bound and never extends the public codec',()=>{
  const plain=defaultFilters();assert.deepEqual(parseStoredFilters(plain),{filters:plain,retained:[]});
  const wrapped={filters:plain,retained:[{family:'projects',ref:'hidden',included:false}]};
  assert.ok(parseStoredFilters(wrapped));assert.equal(parseDataFilters(wrapped),null);
  assert.equal(parseStoredFilters({...wrapped,extra:true}),null);
  assert.equal(parseStoredFilters({...wrapped,retained:[{family:'sources',ref:'bad',included:false}]}),null);
  assert.equal(parseStoredFilters({...wrapped,retained:[{family:'projects',ref:'hidden',included:false,unit:'USD'}]}),null);
  const filters=defaultFilters();filters.projects.values=Array.from({length:2400},(_,i)=>`${i}`.padStart(90,'p'));
  assert.ok(parseDataFilters(filters));assert.equal(parseStoredFilters({filters,retained:Array.from({length:1000},(_,i)=>({family:'projects',ref:`${i}`.padStart(60,'x'),included:false}))}),null);
});
