import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as currency from '../../server/domain/currency';
import * as agents from '../lib/agents';
import * as widgets from '../../server/domain/widgets';
import * as periods from '../lib/periods';
import * as forecast from '../lib/forecastSort';
import * as table from '../lib/moneyTable';
import * as selection from '../lib/moneySelection';
import type {Card} from '../lib/types';
import {DataFilterState} from '../lib/filterState';
import {seedDataFilters} from '../lib/filterSeed';
import {publishDataFilters} from '../lib/filterSelection';
import {defaultFilters,type FilterEnvelope} from '../../server/domain/dataFilters';

const card=(id:string,provider='codex'):Card=>({id,provider,plan:'',windows:[],successAt:1,stale:false,error:null,resets:null,owners:[],staleAfterMs:1000,measureIntervalMs:null,
  meters:[{id:provider==='codex'?'balance:credits':'balance',kind:'balance',unit:provider==='codex'?'credits:codex':'USD',amount:'1000000',limit:null,at:1,staleAfterMs:1000,stale:false,scope:null,label:null,resetAt:null,minutes:null}]});

test('ordinary funds retain a global legacy subset through boards, hidden resources and reload',()=>{
  const old={unit:'USD',selected:{USD:[['a','balance:credits'],['c','balance:credits']]}},settings=selection.readMoney(old,'funds');
  assert.deepEqual(settings.selected,{});
  for(const ids of [['a','b'],['c','d'],['a','b']]){
    const cohort=ids.map(id=>card(id));
    assert.deepEqual(selection.moneySelection(cohort,[],settings,undefined,'funds').selection!.ids.map(([id])=>id),ids);
    selection.moneySelection(cohort,['source:'+ids[0]],settings,undefined,'funds');
  }
  const reloaded=selection.readMoney(JSON.parse(JSON.stringify(settings)),'funds');
  assert.deepEqual(reloaded,settings);
});

test('bounded funds admission uses immutable priority and retains explicit data choices at 33→32',()=>{
  const cards=Array.from({length:33},(_,i)=>card(String(i))),settings=selection.readMoney({selected:{USD:[['32','balance:credits']]}},'funds');
  const bounded=selection.moneySelection(cards,[],settings,undefined,'funds');
  assert.equal(bounded.selection!.ids.length,32);assert.equal(bounded.omitted,1);assert.equal(bounded.selection!.ids.some(([id])=>id==='32'),true);
  const ordinary=selection.moneySelection(cards.slice(0,32),[],settings,undefined,'funds');
  assert.equal(ordinary.selection!.ids.length,32);
  const explicit={...settings,selected:{USD:[['31','balance:credits']] as [string,string][]}};
  for(const cohort of [cards,cards.slice(0,32)])assert.deepEqual(selection.moneySelection(cohort,[],explicit,undefined,'funds').selection!.ids,[['31','balance:credits']]);
  assert.deepEqual(settings.legacySelected!.USD,[['32','balance:credits']]);
});

test('funds migration priority belongs to the filter codec after reset, Restore and adoption',()=>{
  const cards=Array.from({length:33},(_,i)=>card(String(i))),legacy=selection.readMoney({selected:{USD:[['32','balance:credits']]}},'funds'),clean=selection.readMoney({},'funds'),original=structuredClone(legacy);
  const envelope=(revision:number):FilterEnvelope=>({filters:defaultFilters(),revision,authority:'funds-priority-test',unavailable:{sources:0,windows:0,wallet:0,funds:0,projects:0,devices:0,clients:0}});
  const open=(revision:number)=>{const state=new DataFilterState({seed:filters=>seedDataFilters(filters,cards,selection.DEFAULT_MONEY,legacy),save:async()=>envelope(1)});state.open('u','b');state.accept(envelope(revision));return state;};
  const cohort=(settings=legacy)=>selection.moneySelection(cards,[],settings,undefined,'funds').selection!.ids;
  const check=(state:DataFilterState,preferred:boolean)=>{publishDataFilters(state.get().current);assert.deepEqual(cohort(),cohort(clean),'old browser preferences cannot replace the active filter contract');assert.equal(cohort().some(([id])=>id==='32'),preferred);};
  try{
    const first=open(0);assert.deepEqual(first.get().current!.legacy?.fundsPreferredByUnit?.USD,['32']);check(first,true);
    first.reset('funds','all');assert.equal(first.get().current!.legacy?.fundsPreferredByUnit,undefined);check(first,false);
    first.restore();check(first,false);check(open(1),false);
    publishDataFilters(null,false);assert.equal(cohort().some(([id])=>id==='32'),true,'the compatibility reader keeps its old priority before filter activation');
    assert.deepEqual(legacy,original);
  }finally{publishDataFilters(null,false);}
});

test('budget selection retires usage without replacing an explicit empty choice with defaults',()=>{
  const pairs=Array.from({length:16},(_,i)=>[['wallet',`key:${i}:usage`],['wallet',`key:${i}:cap`]]).flat() as [string,string][];
  const settings=selection.readMoney({unit:'USD',selected:{USD:pairs}});
  assert.deepEqual(new Set(settings.selected.USD.map(pair=>JSON.stringify(pair))),new Set(Array.from({length:16},(_,i)=>JSON.stringify(['wallet',`key:${i}:cap`]))));
  const account=card('wallet','openrouter');
  for(const ids of [[['wallet','key:k:usage']],[['wallet','fx:EUR:key:k:usage']],[['wallet','usage'],['wallet','credits']]]) {
    const retired=selection.readMoney({unit:'USD',selected:{USD:ids}});
    assert.deepEqual(retired.selected.USD,[]);
    const reloaded=selection.readMoney(JSON.parse(JSON.stringify(retired)));
    assert.deepEqual(selection.moneySelection([account],[],reloaded).selection!.ids,[]);
    assert.equal(selection.moneySelection([account],[],selection.DEFAULT_MONEY).selection!.ids.length,1,'only Reset restores defaults');
  }
  const saved:[string,string][]=[['wallet','key:k:usage'],['wallet','key:k:cap'],['other-board','key:a:cap'],['other-board','balance']];
  assert.deepEqual(selection.moneyChoices([account],saved,'USD'),saved.slice(1));
  const chosen=Array.from({length:31},(_,i)=>[String(i),'balance'] as [string,string]);
  const full=selection.toggleMoneyChoice(chosen,'wallet',['key:k:cap'],true);
  assert.equal(full.length,32);
  assert.deepEqual(selection.toggleMoneyChoice(full,'wallet',['key:other:cap'],true),full);
  assert.deepEqual(selection.toggleMoneyChoice(full,'wallet',['key:k:cap'],false),chosen);
});

test('legacy components and duplicate currency representations select one evidenced account total',()=>{
  const source=card('wallet','deepseek');
  source.meters=['balance:USD','balance:CNY','granted:CNY','topped_up:CNY'].map(id=>({...source.meters![0],id,unit:id.endsWith('CNY')?'CNY':'USD'}));
  const ids:[string,string][]=[['wallet','balance:USD'],['wallet','fx:USD:balance:CNY'],['wallet','fx:USD:granted:CNY'],['wallet','topped_up:CNY'],['other-board','balance']];
  assert.deepEqual(selection.moneyChoices([source],ids,'USD'),[['wallet','balance:USD'],['other-board','balance']]);
  assert.deepEqual(ids[2],['wallet','fx:USD:granted:CNY'],'normalization never mutates saved global intent');
});

function preferences(saved:object){
  let raw=JSON.stringify(saved);
  const modules:Record<string,unknown>={react:{useSyncExternalStore:(_subscribe:unknown,read:()=>unknown)=>read()},'./agents':agents,'../../server/domain/widgets':widgets,'./periods':periods,'./forecastSort':forecast,'./moneySelection':selection,'./moneyTable':table,'../../server/domain/currency':currency};
  const context={exports:{} as typeof import('../lib/prefs'),require:(name:string)=>modules[name],localStorage:{getItem:()=>raw,setItem:(_key:string,value:string)=>{raw=value;}}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/prefs.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return {...context.exports,saved:()=>JSON.parse(raw)};
}

test('old legend masks are ignored while data choices and unrelated preferences survive reload',()=>{
  const p=preferences({money:{unit:'USD',selected:{USD:[['wallet','balance']]}},funds:{selected:{USD:[['a','balance:credits']]}},muted:{'["budget-history","wallet","balance"]':true,'["wallet","balance","balance","USD"]':true},moneySort:{column:'value',descending:true}});
  assert.equal(Object.hasOwn(p.prefs(),'muted'),false);
  assert.deepEqual(JSON.parse(JSON.stringify(p.prefs().money.selected.USD)),[['wallet','balance']]);
  assert.equal(p.prefs().moneySort?.column,'value');
  p.setPrefs({sessionSort:null});
  const reloaded=preferences(p.saved());
  assert.equal(Object.hasOwn(reloaded.prefs(),'muted'),false);
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded.prefs().money.selected.USD)),[['wallet','balance']]);
  assert.equal(reloaded.prefs().moneySort?.column,'value');
});

test('wallet details and history share logical cap choices across automatic, explicit and excluded scopes',()=>{
  const source=card('wallet','openrouter');
  source.keys=Array.from({length:6},(_,i)=>({id:`key${i}`,name:`Allowance ${i}`,disabled:false,expiresAt:null,includeByok:false,at:1,staleAfterMs:1000,presence:'observed',missCount:0,periods:{day:null,week:null,month:null}}));
  source.meters!.push(...source.keys.filter((_,i)=>i!==1).map(key=>({...source.meters![0],id:`key:${key.id}:cap`,kind:'cap' as const,limit:'10000000'})));
  const filters=defaultFilters();
  const check=(expected:string[])=>{
    publishDataFilters(filters);
    const scope=selection.selectedAllowanceIds(source,undefined,'USD',filters);
    const reads=selection.moneySelection([source],[],selection.DEFAULT_MONEY).selection!.ids.flatMap(([,id])=>selection.keyMeter(id)?.[1]??[]);
    assert.deepEqual(scope,expected);assert.deepEqual(new Set(reads),new Set(expected));
  };
  try{
    check(['key0','key2','key3','key4']);
    filters.wallet={mode:'only',values:[{source:'wallet',kind:'balance'},{source:'wallet',kind:'keyCap',key:'key1'},{source:'wallet',kind:'keyCap',key:'unknown'},{source:'wallet',kind:'keyCap',key:'unknown'}]};check(['key1','unknown']);
    filters.wallet={mode:'auto',include:[{source:'wallet',kind:'keyCap',key:'unknown'}],exclude:[{source:'wallet',kind:'keyCap',key:'key2'}]};check(['unknown','key0','key3','key4']);
    filters.wallet={mode:'only',values:[]};check([]);
    filters.wallet={mode:'only',values:[{source:'wallet',kind:'keyCap',key:'unknown'}]};filters.sources={mode:'include',values:[]};check([]);
  }finally{publishDataFilters(null,false);}
});
