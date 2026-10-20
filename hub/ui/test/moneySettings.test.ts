import {DataFilterState} from '../lib/filterState';
import {defaultFilters,type FilterEnvelope} from '../../server/domain/dataFilters';
import * as filterModel from '../../server/domain/dataFilters';
import {publishDataFilters} from '../lib/filterSelection';
import * as currency from '../../server/domain/currency';
import {defaultCurrencyContext,type CurrencyContext} from '../../server/domain/currency';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {archivedKeyGroups,keyMeter,moneySelection,readMoney,moneyChoices,toggleMoneyChoice} from '../lib/moneySelection';
import {Store} from '../../server/store/store';
import {deepSeekMeasurement} from '../../server/connectors/deepseek';
import {ApiError} from '../lib/http';
import * as providers from '../../server/domain/providers';
import {referenceBalance,budgetVisible,balanceGroups,balanceRoleLabel,keyName} from '../lib/money';
import type {Named} from '../lib/board';
import type {KeyPage} from '../lib/moneyKeys';
import type {Meter} from '../../server/domain/meters';
import * as keyBounds from '../../server/domain/sourceKeys';

type Node={type:unknown;props:Record<string,unknown>;key?:string};
const component=(name:string)=>({name});
const switchRow=component('switch');
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
const meter=(id:string,amount='1'):Meter=>({id,amount,kind:id.endsWith(':cap')?'cap':'balance',unit:'USD',at:1,staleAfterMs:1000,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null});

function fixture(selected:[string,string][]=[],budget?:{source:Named;context:CurrencyContext;others?:Named[]}) {
  const hooks=preparationFixture();
  const state=new DataFilterState({save:async()=>{throw new Error('explicit save only');}});
  state.open('u','b');const filters=defaultFilters();filters.wallet={mode:'only',values:[{source:budget?.source.id??'s',kind:'balance'},...selected.filter(([,id])=>id.endsWith(':cap')).map(([source,id])=>({source,kind:'keyCap' as const,key:id.slice(4,-4)}))]};
  state.accept({filters,revision:1,authority:'a',unavailable:{}} as FilterEnvelope);
  state.subscribe(()=>publishDataFilters(state.get().current));publishDataFilters(state.get().current);
  let active=true,revision=1,prefs={money:readMoney(budget?{unit:'USD',...(selected.length?{selected:{USD:selected}}:{})}:{unit:'USD',selected:{USD:[['s','balance'],...selected]}})};
  let source:Named={id:'s',title:'Account',provider:'openrouter',plan:'',successAt:revision,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:1000,measureIntervalMs:null,meters:[meter('balance')],keys:[],keysCount:20};
  if(budget)source=budget.source;
  const reads:string[]=[];
  let paused=false;
  const pending:{signal?:AbortSignal;reply:KeyPage;resolve:(reply:KeyPage)=>void}[]=[];
  const call=async(_method:string,path:string,_body?:unknown,_timeout?:number,signal?:AbortSignal):Promise<KeyPage>=>{
    reads.push(path);const query=new URL(path,'https://fixture.invalid').searchParams;
    const all=Array.from({length:20},(_,i)=>({id:String(i),name:`Key ${i} revision ${revision}`,disabled:false,expiresAt:null,includeByok:false,at:revision,staleAfterMs:1000,presence:'observed' as const,missCount:0,periods:{day:null,week:null,month:null}}));
    const ids=query.get('ids'),from=Number(query.get('after')??0),keys=ids?all.filter(k=>(JSON.parse(ids) as string[]).includes(k.id)):all.slice(from,from+10);
    if(ids&&(JSON.parse(ids) as string[]).length>50)throw new ApiError(400,'invalid_request');
    const reply:KeyPage={keys,meters:keys.flatMap(k=>[meter(`key:${k.id}:usage`),...(revision===1?[meter(`key:${k.id}:cap`)]:[])]),total:20,inventory:null,next:ids||from===10?null:'10'};
    if(ids&&paused)return new Promise(resolve=>pending.push({signal,reply,resolve}));
    return reply;
  };
  const keyContext={exports:{} as typeof import('../lib/keyReads'),require:(name:string)=>name.endsWith('/http')?{ApiError,call}:keyBounds};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/keyReads.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,keyContext);
  const context={AbortController,exports:{} as {KeyMoneySettings:(props:{sources:Named[];hidden:string[];series:[];active:boolean})=>Node},require:(name:string)=>{
    if(name==='../../server/domain/dataFilters')return filterModel;
    if(name.endsWith('/dataFilters'))return {useDataFilters:state.get,dataFilters:state};
    if(name==='react')return {useState:hooks.useState,useRef:hooks.useRef,useEffect:hooks.useLayoutEffect};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'],key?:string)=>({type,props,key}),jsxs:(type:unknown,props:Node['props'],key?:string)=>({type,props,key}),Fragment:'fragment'};
    if(name.endsWith('/board'))return {useBoardId:()=> 'b',useCurrencyContext:()=>budget?.context??defaultCurrencyContext};
    if(name.endsWith('/http'))return {ApiError,call};
    if(name.endsWith('/keyReads'))return keyContext.exports;
    if(name.endsWith('/moneySelection'))return {moneySelection,archivedKeyGroups,keyMeter,moneyChoices,toggleMoneyChoice};
    if(name.endsWith('/prefs'))return {usePref:(key:keyof typeof prefs)=>prefs[key],setPrefs:(patch:typeof prefs)=>{prefs=patch;}};
    if(name.endsWith('/money'))return {keyName,balanceRoleLabel,balanceGroups,referenceBalance,budgetVisible};
    if(name.endsWith('/providers'))return providers;
    if(name==='../../server/domain/currency')return currency;
    if(name.endsWith('/meterHistory'))return {MAX_METERS:32};
    if(name.endsWith('/view'))return {};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    if(name==='./Filters')return {FilterRow:switchRow};
    if(name==='./Popover')return {};
    if(name==='./KeyPages')return {KEYS_PER_PAGE:10};
    if(name==='./Kit')return {ErrorLine:component('error')};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MoneySettings.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  let tree:Node;
  const render=()=>{hooks.begin();tree=context.exports.KeyMoneySettings({sources:[source,...budget?.others??[]],hidden:[],series:[],active});hooks.commit();return nodes(tree);};
  const settle=async()=>{render();await flush();return render();};
  const more=()=>nodes(tree).find(n=>n.type==='button'&&n.props.className==='popover-row filter-load-more');
  const slots=()=>nodes(tree).filter(n=>typeof n.props.className==='string'&&n.props.className.includes('key-slot'));
  const keys=()=>nodes(tree).find(n=>n.type==='details'&&n.props.className==='filter-key-details');
  const openKeys=async(open=true)=>{const details=keys();assert.ok(details);(details.props.onToggle as (event:unknown)=>void)({currentTarget:{open}});await settle();};
  const loadMore=async()=>{const button=more();assert.ok(button);(button.props.onClick as ()=>void)();await settle();};
  return {settle,render,more,keys,slots,reads,openKeys,loadMore,pending,pauseMembership:()=>{paused=true;},resumeMembership:()=>{paused=false;pending.splice(0).forEach(({reply,resolve})=>resolve(reply));},setActive:(value:boolean)=>{active=value;},selection:()=>moneySelection([source],[],prefs.money,budget?.context).selection,switches:()=>nodes(tree).filter(n=>n.type===switchRow),refresh:()=>{revision++;source={...source,successAt:revision};}};
}

test('native and converted balance-only sources have balance switches without archived key controls',async t=>{
  const store=new Store(':memory:',1);t.after(()=>store.close());
  const source=(unit:string,account:string):Named=>{
    const id=store.source('deepseek',account,1),measurement=deepSeekMeasurement({is_available:true,balance_infos:[{currency:unit,total_balance:'110',granted_balance:'10',topped_up_balance:'100'}]},1);
    store.record(id,measurement);
    const quote=store.currencies.save({source:'ecb',base:'EUR',date:1,fetchedAt:1,rates:{EUR:'1000000',USD:'1000000',CNY:'7000000'}});
    if(unit==='CNY')for(const meter of measurement.meters)store.currencies.record(id,meter,'USD',quote);
    return {id,title:unit,provider:'deepseek',plan:'',successAt:1,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:1000,measureIntervalMs:null,keys:[],keysCount:0,meters:[...measurement.meters,...measurement.meters.flatMap(m=>store.currencies.project(id,m,'USD',1)??[])]};
  };
  const native=source('USD','1'.repeat(24)),converted=source('CNY','2'.repeat(24));
  for(const current of [native,converted]) {
    const f=fixture([],{source:current,context:defaultCurrencyContext});await f.settle();
    assert.equal(f.switches().length,1);assert.equal(f.slots().length,0);
    assert.equal(f.switches().filter(row=>row.props.on).length,1);assert.equal(f.reads.length,0);
    const component=f.switches()[0];(component.props.onChange as (on:boolean)=>void)(false);await f.settle();
    assert.equal(f.selection()!.ids.length,0);assert.equal(f.slots().length,0);
  }
  const multiple=fixture([],{source:converted,others:[native],context:defaultCurrencyContext});await multiple.settle();
  assert.equal(multiple.switches().length,2);assert.equal(multiple.render().some(n=>n.props.children==='money.selectedDetails'),false);
});

test('loading more keys appends rows without replacing a selected live key',async()=>{
  const f=fixture();await f.settle();await f.openKeys();
  const usage=f.switches().find(n=>n.key==='0')!;
  (usage.props.onChange as (on:boolean)=>void)(true);await f.settle();
  assert.ok(f.selection()!.ids.some(([,meter])=>meter==='key:0:cap'));
  assert.ok(!f.selection()!.ids.some(([,meter])=>meter==='key:0:usage'));
  const before=f.reads.length;await f.loadMore();
  assert.equal(f.slots().length,20);assert.equal(f.more(),undefined);
  assert.equal(f.switches().some(n=>n.key==='0'),true);
  assert.equal(f.reads.length,before+1,'only the new batch is read');
  const loaded=f.reads.length;await f.openKeys(false);await f.openKeys();assert.equal(f.reads.length,loaded,'reopening the disclosure reuses its rows');
});

test('selected archived scales remain removable beside the live key list',async()=>{
  const f=fixture([['s','key:gone:usage'],['s','key:gone:cap']]);await f.settle();await f.openKeys();
  assert.equal(f.slots().length,11);await f.loadMore();assert.equal(f.slots().length,21);
  const row=f.switches().find(n=>n.key==='gone')!;assert.equal(row.props.disabled,false);(row.props.onChange as (on:boolean)=>void)(false);await f.settle();assert.ok(!f.selection()!.ids.some(([,meter])=>meter.startsWith('key:gone:')));
  assert.equal(f.slots().length,20);assert.equal(f.more(),undefined);
});

test('a migrated selection above the key lookup limit keeps every archived cap individually removable',async()=>{
  const f=fixture(Array.from({length:51},(_,i)=>['s',`key:gone-${i}:cap`]));await f.settle();await f.openKeys();
  assert.equal(f.slots().length,61,'all 51 archived choices appear beside the first live page');
  const membership=()=>f.reads.filter(path=>new URL(path,'https://fixture.invalid').searchParams.has('ids'));
  assert.equal(membership().length,2);
  for(let i=0;i<20;i++){
    const row=f.switches().find(n=>n.key===`gone-${i}`);assert.ok(row);assert.equal(row.props.disabled,false);
    (row.props.onChange as (on:boolean)=>void)(false);await f.settle();
  }
  assert.equal(f.selection()!.ids.length,32);assert.equal(membership().length,2,'deselecting a covered key needs no new membership read');
});

test('closing a resource cancels selected key membership and reopening uses its refreshed identity',async()=>{
  const f=fixture([['s','key:gone:cap']]);f.pauseMembership();await f.settle();await f.openKeys();
  assert.equal(f.pending.length,1);assert.equal(f.slots().length,10);
  f.setActive(false);await f.settle();assert.equal(f.pending[0].signal?.aborted,true);
  f.resumeMembership();await f.settle();assert.equal(f.slots().length,10,'a closed consumer ignores its late membership response');
  f.refresh();await f.settle();const before=f.reads.length;
  f.setActive(true);await f.settle();
  assert.equal(f.reads.length,before+2,'the refreshed source reads its page and selected membership');
  assert.equal(f.slots().length,11);assert.equal(f.switches().find(n=>n.key==='gone')?.props.disabled,false);
});

test('an expanded key list refreshes names and caps without losing the loaded range',async()=>{
  const f=fixture();await f.settle();await f.openKeys();await f.loadMore();
  const before=f.reads.length;f.refresh();await f.settle();
  assert.equal(f.reads.length,before+2);assert.equal(f.slots().length,20);
  assert.ok(f.slots().every(n=>n.props.children===`Key ${Number(n.key)} revision 2`));
  const key=f.switches().find(n=>n.key==='10')!;assert.equal(key.props.disabled,true,'usage without a reported cap is not a balance choice');
  assert.equal(key.props.value,'money.noCap');
  assert.ok(!f.selection()!.ids.some(([,meter])=>meter==='key:10:usage'));
});

test('a collapsed resource pauses key reads and preserves its loaded rows until it reopens',async()=>{
  const f=fixture();await f.settle();await f.openKeys();await f.loadMore();const before=f.reads.length;
  f.setActive(false);f.refresh();await f.settle();
  assert.equal(f.reads.length,before);assert.equal(f.slots().length,20,'retained rows keep the disclosure geometry while hidden');
  f.setActive(true);await f.settle();
  assert.equal(f.reads.length,before+2);assert.equal(f.slots().length,20);
  assert.ok(f.slots().every(row=>row.props.children===`Key ${Number(row.key)} revision 2`));
});

test('chart settings contain only owner presentation controls',()=>{
  const popover=component('popover'),hide=component('hide');
  const modules:Record<string,unknown>={
    'react/jsx-runtime':{jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props})},
    '../i18n':{t:(key:string)=>key},'./Popover':{Popover:popover,HideRow:hide},
  };
  const context={exports:{} as {MoneyChartSettings:(props:unknown)=>Node|null},require:(name:string)=>modules[name]??{}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MoneySettings.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  for(const owner of [false,true]){
    const chart=context.exports.MoneyChartSettings({arrange:{owner},widget:'budget-history'});
    assert.equal(chart===null,!owner);
    assert.equal(nodes(chart).filter(node=>node.type===hide).length,Number(owner));
  }
});
