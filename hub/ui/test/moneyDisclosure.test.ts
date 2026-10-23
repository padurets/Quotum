import type {KeyPart,Meter} from '../../server/domain/meters';
import {selectedAllowanceIds} from '../lib/moneySelection';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as money from '../lib/money';
import {defaultCurrencyContext,currencySymbol} from '../../server/domain/currency';
import {defaultFilters,walletRule,matchesWallet,fundsRule,matchesSelection} from '../../server/domain/dataFilters';
import {MAX_METERS} from '../../server/domain/meterHistory';
import {ApiError} from '../lib/http';
import {t,setLocale} from '../i18n';
import {focusReturnFixture} from './focusReturnFixture';

type Node={type:unknown;props:Record<string,any>};
const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?typeof value.type==='function'?nodes(value.type(value.props)):[value,...nodes(value.props.children),...nodes(value.props.trigger)]:[];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(compact=false){
  const dom=focusReturnFixture(false,true);
  const filters=defaultFilters();filters.wallet={mode:'only',values:[{source:'s',kind:'balance'},{source:'s',kind:'keyCap',key:'extra'}]};
  const source={id:'s',provider:'openrouter',keys:[] as KeyPart[],meters:[{id:'balance',kind:'balance',unit:'USD',amount:'12345678',limit:null,at:1,staleAfterMs:1000,stale:false,resetAt:null,minutes:null,scope:null,label:null}] as Meter[]};
  let cursor=0;const slots:any[]=[],effects:(()=>void)[]=[],flights:{resolve:(reply:unknown)=>void;reject:(error:unknown)=>void}[]=[];
  const hooks={useState:(initial:any)=>{const at=cursor++;if(!(at in slots))slots[at]=initial;return [slots[at],(next:any)=>slots[at]=typeof next==='function'?next(slots[at]):next];},useEffect:(run:()=>unknown,deps:unknown[])=>{const at=cursor++,previous=slots[at];if(!previous||deps.some((d,i)=>d!==previous.deps[i]))effects.push(()=>{previous?.cleanup?.();slots[at]={deps,cleanup:run()};});}};
  const modules:Record<string,unknown>={react:hooks,'./moneySelection':{selectedAllowanceIds},'./dataFilters':{useDataFilters:()=>({current:filters})},'./prefs':{usePref:()=>({unit:'USD'})},'../../server/domain/dataFilters':{walletRule},'./view':{keyShown:()=>true},'./http':{ApiError},'../../server/domain/meterHistory':{MAX_METERS},'./keyReads':{readKeyIds:()=>new Promise((resolve,reject)=>flights.push({resolve,reject}))}};
  const keys={exports:{} as typeof import('../lib/moneyKeys'),require:(name:string)=>modules[name],AbortController};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/moneyKeys.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,keys);
  const jsx=(type:unknown,props:Node['props'])=>({type,props}),context={useRemovalFocus:dom.focus.useRemovalFocus,exports:{} as {MoneyValues:(props:unknown)=>Node},require:()=>({jsx,jsxs:jsx}),...money,currencySymbol,t,useDataFilters:()=>({current:filters}),usePref:()=>({unit:'USD'}),walletRule,matchesWallet,fundsRule,matchesSelection,Popover:'popover',CreditBalanceValue:({children}:{children:unknown})=>children,ErrorLine:'error',CapMetrics:'unavailable-cap',BudgetKeyMetrics:'key',stamp:String,day:String,ApiError};
  const src=readFileSync(new URL('../components/MoneyCard.tsx',import.meta.url),'utf8');
  runInNewContext(ts.transpileModule(src.slice(src.indexOf('export function MoneyValues('),src.indexOf('/** Subscription funds')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  let latest:ReturnType<typeof keys.exports.useShownKeys>;
  const render=()=>{cursor=0;latest=keys.exports.useShownKeys(source as any,undefined,'board');effects.splice(0).forEach(run=>run());dom.hooks.begin();const tree=nodes(context.exports.MoneyValues({source,...latest,context:defaultCurrencyContext,compact}));dom.hooks.commit();return tree;};
  const key:KeyPart={id:'extra',name:'Laptop with the complete selected allowance name',disabled:false,presence:'observed',expiresAt:null,includeByok:false,at:1,staleAfterMs:1000,missCount:0,periods:{day:null,week:null,month:null}};
  return {render,flights,key,source,filters,dom,retry:()=>latest.retry(),cap:{...source.meters[0],id:'key:extra:cap',kind:'cap' as const,amount:'3000000',limit:'10000000'}};
}

for(const locale of ['en','ru'] as const)test(`${locale} selected allowance disclosure stays accessible while pending, missing, failed and ready`,async()=>{
  setLocale(locale);
  try{
    const f=fixture();
    const check=(message?:Parameters<typeof t>[0])=>{const tree=f.render(),popover=tree.find(n=>n.type==='popover');assert.ok(popover,'the selected scope owns its disclosure before any amount arrives');assert.equal(tree.find(n=>n.props['data-money'])?.props['data-money'],'12345678');assert.ok(String(popover.props.label).includes(t('money.selectedAllowances',{count:1})));if(message)assert.ok(tree.some(n=>n.props.children===t(message)));return tree;};
    check('period.loading');f.flights[0].resolve({keys:[f.key],meters:[]});await flush();check('quota.unavailable');
    f.retry();check();f.flights[1].reject(new ApiError(503,'unavailable'));await flush();const failed=check();
    const retry=failed.find(n=>n.type==='button'&&n.props.children===t('period.retry'));assert.ok(retry);retry.props.onClick();check();
    f.flights[2].resolve({keys:[f.key],meters:[f.cap]});await flush();assert.ok(check().some(n=>n.type==='key'));
    assert.equal(f.flights.length,3,'rendering disclosure labels adds no inventory reads');
  }finally{setLocale('en');}
});

test('compact balance disclosure renders selected allowances in the full detail layout',async()=>{
  const f=fixture(true);f.render();f.flights[0].resolve({keys:[f.key],meters:[f.cap]});await flush();
  const metric=f.render().find(n=>n.type==='key');assert.ok(metric);assert.notEqual(metric.props.compact,true,'full disclosure names must wrap instead of using the compact row ellipsis');
});

for(const compact of [false,true])for(const locale of ['en','ru'] as const)test(`${locale} ${compact?'compact':'dashboard'} actual extra allowance Retry keeps focus in its surviving disclosure`,async()=>{
  setLocale(locale);
  const f=fixture(compact);
  try{
    f.render();f.flights[0].reject(new ApiError(503,'unavailable'));await flush();
    const button=f.render().find(node=>node.type==='button'&&node.props.children===t('period.retry'))!;assert.ok(button);
    const leave=f.dom.attach(button.props.ref,f.dom.retry);f.dom.document.activeElement=f.dom.retry;
    button.props.onClick();f.render();const pending=f.render();assert.equal(pending.some(node=>node.type==='button'&&node.props.children===t('period.retry')),false);
    leave();f.dom.retry.remove();assert.equal(f.dom.document.activeElement,f.dom.trigger);
    f.flights[1].resolve({keys:[f.key],meters:[f.cap]});await flush();assert.ok(f.render().some(node=>node.type==='key'));assert.equal(f.dom.document.activeElement,f.dom.trigger);assert.equal(f.flights.length,2);
  }finally{f.dom.hooks.dispose();setLocale('en');}
});

for(const moved of [false,true])test(`automatic allowance recovery respects the actual focus owner (moved=${moved})`,async()=>{
  const f=fixture();
  try{
    f.render();f.flights[0].reject(new ApiError(503,'unavailable'));await flush();
    const button=f.render().find(node=>node.type==='button'&&node.props.children===t('period.retry'))!;
    const leave=f.dom.attach(button.props.ref,f.dom.retry);f.dom.document.activeElement=moved?f.dom.outside:f.dom.retry;
    f.source.keys.push(f.key);f.source.meters.push(f.cap);const recovered=f.render();assert.equal(recovered.some(node=>node.type==='button'&&node.props.children===t('period.retry')),false);
    leave();f.dom.retry.remove();assert.equal(f.dom.document.activeElement,moved?f.dom.outside:f.dom.trigger);assert.equal(f.flights.length,1,'new preview evidence needs no additional key read');
  }finally{f.dom.hooks.dispose();}
});

for(const compact of [false,true])test(`${compact?'compact':'dashboard'} mixed selected scope names the unavailable allowance beside the known one`,async()=>{
  const f=fixture(compact),known={...f.key,id:'known',name:'Known allowance'};
  f.source.keys.push(known);f.source.meters.push({...f.cap,id:'key:known:cap'});
  f.filters.wallet={mode:'only',values:[{source:'s',kind:'balance'},{source:'s',kind:'keyCap',key:'known'},{source:'s',kind:'keyCap',key:'extra'}]};
  f.render();f.flights[0].resolve({keys:[f.key],meters:[]});await flush();const tree=f.render();
  assert.ok(tree.some(n=>n.props.children===f.key.name),'a missing selected cap keeps its full name');
  assert.ok(tree.some(n=>n.props.children===t('quota.unavailable')));
  assert.ok(String(tree.find(n=>n.type==='popover')?.props.label).includes(t('money.selectedAllowances',{count:2})));
  assert.equal(tree.filter(n=>n.type==='key').length,1,'only the evidenced cap gets a scale');
});

test('automatic wallet allowance count excludes an uncapped preview key',()=>{
  const f=fixture(),known={...f.key,id:'known',name:'Known allowance'};
  f.source.keys.push(known,f.key);f.source.meters.push({...f.cap,id:'key:known:cap'});
  f.filters.wallet={mode:'auto',include:[],exclude:[]};const tree=f.render();
  assert.ok(String(tree.find(n=>n.type==='popover')?.props.label).includes(t('money.selectedAllowances',{count:1})));
  assert.equal(f.flights.length,0);
});

test('an explicit uncapped preview choice owns a named unavailable disclosure',()=>{
  const f=fixture();f.source.keys.push(f.key);const tree=f.render();
  assert.ok(tree.some(n=>n.props.children===f.key.name));assert.ok(tree.some(n=>n.props.children===t('quota.unavailable')));
  assert.equal(f.flights.length,0,'a known preview key needs no extra lookup');
});

test('a pending extra allowance cannot promote the next arrived cap before its logical order is known',async()=>{
  const f=fixture(),known={...f.key,id:'known',name:'Beta known'};
  f.key.name='Alpha selected extra';f.source.keys.push(known);f.source.meters.push({...f.cap,id:'key:known:cap'});
  f.filters.wallet={mode:'only',values:[{source:'s',kind:'keyCap',key:'known'},{source:'s',kind:'keyCap',key:'extra'}]};
  const primary=()=>f.render().find(n=>n.type==='popover'&&n.props.triggerClass==='money-primary-trigger')!;
  assert.equal(primary().props.trigger.type,'unavailable-cap','an unknown selected name may sort before the known key');
  f.flights[0].reject(new ApiError(503,'unavailable'));await flush();assert.equal(primary().props.trigger.type,'unavailable-cap');
  f.retry();primary();f.flights[1].resolve({keys:[f.key],meters:[]});await flush();
  assert.equal(primary().props.trigger.props.name,f.key.name,'missing first amount keeps the now known first identity');
  f.retry();primary();f.flights[2].resolve({keys:[f.key],meters:[f.cap]});await flush();
  assert.equal(primary().props.trigger.props.limit.scope.id,'extra');
});
