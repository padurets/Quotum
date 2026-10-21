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

type Node={type:unknown;props:Record<string,any>};
const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?typeof value.type==='function'?nodes(value.type(value.props)):[value,...nodes(value.props.children),...nodes(value.props.trigger)]:[];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(compact=false){
  const filters=defaultFilters();filters.wallet={mode:'only',values:[{source:'s',kind:'balance'},{source:'s',kind:'keyCap',key:'extra'}]};
  const source={id:'s',provider:'openrouter',keys:[],meters:[{id:'balance',kind:'balance',unit:'USD',amount:'12345678',limit:null,at:1,staleAfterMs:1000,stale:false,resetAt:null,minutes:null,scope:null,label:null}]};
  let cursor=0;const slots:any[]=[],effects:(()=>void)[]=[],flights:{resolve:(reply:unknown)=>void;reject:(error:unknown)=>void}[]=[];
  const hooks={useState:(initial:any)=>{const at=cursor++;if(!(at in slots))slots[at]=initial;return [slots[at],(next:any)=>slots[at]=typeof next==='function'?next(slots[at]):next];},useEffect:(run:()=>unknown,deps:unknown[])=>{const at=cursor++,previous=slots[at];if(!previous||deps.some((d,i)=>d!==previous.deps[i]))effects.push(()=>{previous?.cleanup?.();slots[at]={deps,cleanup:run()};});}};
  const modules:Record<string,unknown>={react:hooks,'./dataFilters':{useDataFilters:()=>({current:filters})},'./prefs':{usePref:()=>({unit:'USD'})},'../../server/domain/dataFilters':{walletRule},'./view':{keyShown:()=>true},'./http':{ApiError},'../../server/domain/meterHistory':{MAX_METERS},'./keyReads':{readKeyIds:()=>new Promise((resolve,reject)=>flights.push({resolve,reject}))}};
  const keys={exports:{} as typeof import('../lib/moneyKeys'),require:(name:string)=>modules[name],AbortController};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/moneyKeys.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,keys);
  const jsx=(type:unknown,props:Node['props'])=>({type,props}),context={exports:{} as {MoneyValues:(props:unknown)=>Node},require:()=>({jsx,jsxs:jsx}),...money,currencySymbol,t,useDataFilters:()=>({current:filters}),usePref:()=>({unit:'USD'}),walletRule,matchesWallet,fundsRule,matchesSelection,Popover:'popover',CreditBalanceValue:({children}:{children:unknown})=>children,ErrorLine:'error',BudgetKeyMetrics:'key',stamp:String,day:String,ApiError};
  const src=readFileSync(new URL('../components/MoneyCard.tsx',import.meta.url),'utf8');
  runInNewContext(ts.transpileModule(src.slice(src.indexOf('export function MoneyValues('),src.indexOf('/** Subscription funds')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  let latest:ReturnType<typeof keys.exports.useShownKeys>;
  const render=()=>{cursor=0;latest=keys.exports.useShownKeys(source as any,undefined,'board');effects.splice(0).forEach(run=>run());return nodes(context.exports.MoneyValues({source,...latest,context:defaultCurrencyContext,compact}));};
  const key={id:'extra',name:'Laptop with the complete selected allowance name',disabled:false,presence:'observed'};
  return {render,flights,key,retry:()=>latest.retry(),cap:{...source.meters[0],id:'key:extra:cap',kind:'cap',amount:'3000000',limit:'10000000'}};
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
