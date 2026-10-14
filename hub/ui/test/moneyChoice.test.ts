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

const card=(id:string,provider='codex'):Card=>({id,provider,plan:'',windows:[],successAt:1,stale:false,error:null,resets:null,owners:[],staleAfterMs:1000,measureIntervalMs:null,
  meters:[{id:provider==='codex'?'balance:credits':'balance',kind:'balance',unit:provider==='codex'?'credits:codex':'USD',amount:'1000000',limit:null,at:1,staleAfterMs:1000,stale:false,scope:null,label:null,resetAt:null,minutes:null}]});

test('ordinary funds retain a global legacy subset through boards, hidden resources and reload',()=>{
  const old={unit:'USD',selected:{USD:[['a','balance:credits'],['c','balance:credits']]}},settings=selection.readMoney(old,'funds');
  assert.deepEqual(settings.selected,{});
  for(const ids of [['a','b'],['c','d'],['a','b']]){
    const cohort=ids.map(id=>card(id));
    assert.deepEqual(selection.moneySelection(cohort,[],settings,undefined,'funds').selection!.ids.map(([id])=>id),ids);
    assert.deepEqual(ids.filter(id=>!selection.fundsLegacyMuted(settings,id,'balance:credits')),ids.filter(id=>id==='a'||id==='c'));
    selection.moneySelection(cohort,['source:'+ids[0]],settings,undefined,'funds');
  }
  const reloaded=selection.readMoney(JSON.parse(JSON.stringify(settings)),'funds');
  assert.deepEqual(reloaded,settings);
  assert.equal(selection.fundsLegacyMuted(reloaded,'c','balance:credits'),false);
  assert.equal(selection.fundsLegacyMuted(reloaded,'b','balance:credits'),true);
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

test('logical key choices commit atomically, preserve legacy halves at capacity and remove both',()=>{
  const selected=Array.from({length:31},(_,i)=>[String(i),'balance'] as [string,string]),meters=['key:k:usage','key:k:cap'];
  assert.deepEqual(selection.toggleMoneyChoice(selected,'wallet',meters,true),selected);
  const enough=selection.toggleMoneyChoice(selected.slice(0,30),'wallet',meters,true);
  assert.equal(enough.length,32);assert.deepEqual(enough.slice(-2),meters.map(m=>['wallet',m]));
  assert.deepEqual(selection.toggleMoneyChoice(enough,'wallet',meters,false),selected.slice(0,30));
  const account=card('wallet','openrouter');
  account.meters!.push(...meters.map(id=>({...account.meters![0],id,kind:id.endsWith(':cap')?'cap' as const:'counter' as const})));
  const half=[...selected,['wallet',meters[0]] as [string,string]];
  assert.deepEqual(selection.moneyChoices([account],half,'USD'),half);
  assert.deepEqual(selection.moneyChoices([account],[['wallet',meters[0]]],'USD'),meters.map(m=>['wallet',m]));
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

test('scoped legend overrides isolate sibling charts, preserve explicit unmute and never alter data choices',()=>{
  const p=preferences({kind:'session',money:{view:'spending',unit:'USD',selected:{USD:[['wallet','balance']]}},funds:{selected:{USD:[['a','balance:credits']]}},muted:{'["wallet","balance","balance","USD"]':true},moneySort:{column:'value',descending:true}});
  assert.equal(Object.hasOwn(p.prefs(),'kind'),false);assert.equal(Object.hasOwn(p.prefs().money,'view'),false);
  assert.deepEqual(JSON.parse(JSON.stringify(p.prefs().spendingSort)),{column:'value',descending:true});
  const sibling=p.useChartMuted(widgets.BUDGET_SPENDING_HISTORY),before=p.prefs().money;
  const key=p.chartMuteKey(widgets.BUDGET_HISTORY,'wallet','balance');
  p.setMuted(key,false);
  assert.equal(p.chartMuteKey(widgets.BUDGET_HISTORY,'wallet','fx:EUR:balance'),key,'display conversion keeps the native visibility identity');
  assert.equal(p.chartSeriesMuted(p.useChartMuted(widgets.BUDGET_HISTORY),widgets.BUDGET_HISTORY,'wallet','balance',true),false);
  assert.equal(p.useChartMuted(widgets.BUDGET_SPENDING_HISTORY),sibling);
  assert.equal(p.prefs().money,before);assert.equal(p.prefs().funds.selected.USD,undefined);
  const reloaded=preferences(p.saved());
  assert.equal(reloaded.chartSeriesMuted(reloaded.prefs().muted,widgets.BUDGET_HISTORY,'wallet','balance',true),false);
  assert.equal(selection.fundsLegacyMuted(reloaded.prefs().funds,'b','balance:credits'),true);
  assert.equal(selection.fundsLegacyMuted(reloaded.prefs().funds,'a','fx:EUR:balance:credits'),false);
  p.setPrefs({sessionSort:null,spendingSort:null});
  assert.equal(preferences(p.saved()).prefs().spendingSort,null,'an explicit reset cannot resurrect the inherited sort');
});
