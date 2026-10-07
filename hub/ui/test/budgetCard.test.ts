import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as amounts from '../lib/money';
import * as currency from '../../server/domain/currency';
import * as formats from '../lib/format';
import {t,setLocale} from '../i18n';
import type {Card} from '../lib/types';

type Node={type:unknown;props:Record<string,unknown>};
function render(source:Card,compact=false) {
  const context={exports:{} as {MoneyCard:(props:unknown)=>Node},require:(name:string)=>{
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props}),Fragment:'fragment'};
    if(name.endsWith('/money'))return amounts;
    if(name.endsWith('/currency'))return currency;
    if(name.endsWith('/format'))return formats;
    if(name.endsWith('/clock'))return {useClock:()=>100};
    if(name.endsWith('/i18n'))return {t};
    if(name.endsWith('/board'))return {useCurrencyContext:()=>currency.defaultCurrencyContext};
    if(name.endsWith('/moneyKeys'))return {useShownKeys:()=>({keys:[],meters:source.meters??[],error:null})};
    if(name==='./Kit')return {ErrorLine:()=>null};
    if(name==='./Popover')return {Popover:(props:Node['props'])=>({type:'popover',props:{children:[props.trigger,props.children]}})};
    if(['../../server/domain/meters','../lib/format','../lib/http','../lib/quota','./Meter','./StatusMark'].includes(name))return {};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MoneyCard.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const expand=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(expand):value&&typeof value==='object'&&'props' in value?typeof (value as Node).type==='function'?expand(((value as Node).type as (props:unknown)=>unknown)((value as Node).props)):[value as Node,...expand((value as Node).props.children)]:[];
  const root=context.exports.MoneyCard({source,board:'b',compact});
  const nodes=expand(root);
  const text=(value:unknown):string=>Array.isArray(value)?value.map(text).join(' '):value&&typeof value==='object'&&'props' in value?typeof (value as Node).type==='function'?text(((value as Node).type as (props:unknown)=>unknown)((value as Node).props)):text((value as Node).props.children):typeof value==='string'||typeof value==='number'?String(value):'';
  return {nodes,text:text(root)};
}
const source:Card={id:'openai_platform:fixture',provider:'openai_platform',plan:'',successAt:100,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:1000,measureIntervalMs:null,reportQuality:[],meters:[{id:'monthly',kind:'cap',unit:'USD',amount:'30000000',at:100,staleAfterMs:1000,stale:false,limit:'100000000',resetAt:null,minutes:null,scope:'monthly',label:null}],monthlyLimit:{status:'ok',observedAt:100,error:null,value:{unit:'USD',amount:'100000000',enforcement:'enforcing'},valueAt:100,staleAfterMs:1000},allowance:{unit:'USD',limit:'100000000',remaining:'70000000',overspend:'0',enforcement:'enforcing',stale:false}};

for(const locale of ['en','ru'] as const)for(const compact of [false,true])test(`${locale} ${compact?'compact':'card'} keeps unavailable funds distinct from the reported spending threshold and allowance`,()=>{
  setLocale(locale);
  const view=render(source,compact);
  assert.ok(view.text.includes(t('money.accountBalance')));
  assert.ok(view.text.includes('—'));
  assert.ok(!view.text.includes(locale==='en'?'100.00':'100,00'));
  assert.ok(!view.text.includes(locale==='en'?'70.00':'70,00'));
  assert.equal(view.nodes.filter(node=>node.props['data-money']!==undefined).length,0);
});

for(const amount of ['13000000','0'])test(`the common balance renderer preserves ${amount==='0'?'confirmed zero':'real funds'} alongside report metadata`,()=>{
  setLocale('en');
  const balance={...source.meters![0],id:'balance',kind:'balance' as const,amount,limit:null,scope:null};
  const view=render({...source,provider:'openrouter',meters:[balance]});
  assert.ok(view.text.includes(t('money.accountBalance')));
  assert.ok(view.nodes.some(node=>node.props['data-money']===amount));
  assert.ok(!view.text.includes('100.00'));
});
