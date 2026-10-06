import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as amounts from '../lib/money';
import {t,setLocale} from '../i18n';
import type {Card} from '../lib/types';

type Node={type:unknown;props:Record<string,unknown>};
function render(source:Card,compact=false,now=100) {
  const context={exports:{} as {MoneyCard:(props:unknown)=>Node},require:(name:string)=>{
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props})};
    if(name.endsWith('/money'))return amounts;
    if(name.endsWith('/clock'))return {useClock:()=>now};
    if(name.endsWith('/i18n'))return {t};
    if(name.endsWith('/moneyKeys'))return {useShownKeys:()=>({keys:[],meters:[],error:null})};
    if(name==='./Meter')return {MeterBar:'meter-bar'};
    if(['../lib/board','../lib/format','../lib/http','../lib/quota','./Kit','./Popover'].includes(name))return {};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MoneyCard.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const expand=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(expand):value&&typeof value==='object'&&'props' in value?typeof (value as Node).type==='function'?expand(((value as Node).type as (props:unknown)=>unknown)((value as Node).props)):[value as Node,...expand((value as Node).props.children)]:[];
  const root=context.exports.MoneyCard({source,board:'b',compact});
  const text=(value:unknown):string=>Array.isArray(value)?value.map(text).join(' '):value&&typeof value==='object'&&'props' in value?typeof (value as Node).type==='function'?text(((value as Node).type as (props:unknown)=>unknown)((value as Node).props)):text((value as Node).props.children):typeof value==='string'||typeof value==='number'?String(value):'';
  return {nodes:expand(root),text:text(root)};
}
const source:Card={id:'openai_platform:fixture',provider:'openai_platform',plan:'',successAt:100,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:1000,measureIntervalMs:null,reportQuality:[],monthlyLimit:{status:'ok',observedAt:100,error:null,value:{unit:'USD',amount:'100000000',enforcement:'enforcing'},valueAt:100,staleAfterMs:1000},allowance:{unit:'USD',limit:'100000000',remaining:'70000000',overspend:'0',enforcement:'enforcing',stale:false}};

for(const locale of ['en','ru'] as const)for(const compact of [false,true])test(`${locale} ${compact?'compact':'card'} shows the configured threshold without a balance or percentage scale`,()=>{
  setLocale(locale);
  const view=render(source,compact);
  assert.ok(view.text.includes(t('money.configuredMonthlyLimit')));
  assert.ok(view.text.includes(locale==='en'?'100.00':'100,00'));
  assert.ok(!view.text.includes(locale==='en'?'70.00':'70,00'));
  assert.ok(!view.text.includes(t('money.accountBalance')));
  assert.equal(view.nodes.filter(node=>node.type==='meter-bar').length,0);
  assert.ok(view.text.includes(t('money.enforcing')));
});

test('failed and aged limit reads preserve the threshold without claiming active enforcement',()=>{
  setLocale('en');
  for(const [card,now] of [[source,1101],[{...source,monthlyLimit:{...source.monthlyLimit!,status:'unavailable' as const}},100]] as const){
    const view=render(card,false,now);
    assert.ok(view.text.includes('100.00'));
    assert.ok(view.text.includes(t('money.enforcementUnknown')));
    assert.ok(!view.text.includes(t('money.enforcing')));
  }
  const unknown=render({...source,monthlyLimit:{...source.monthlyLimit!,status:'unavailable',value:null,valueAt:null},allowance:null});
  assert.ok(unknown.text.includes('—'));
  assert.ok(!unknown.text.includes('100.00'));
});

test('an actual balance remains the current resource when cost reports are also present',()=>{
  setLocale('en');
  const view=render({...source,meters:[{id:'balance',kind:'balance',unit:'USD',amount:'13000000',at:100,staleAfterMs:1000,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null}]});
  assert.ok(view.text.includes(t('money.accountBalance')));
  assert.ok(view.text.includes('13.00'));
  assert.ok(!view.text.includes('100.00'));
});
