import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement,type ReactNode} from 'react';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as money from '../lib/money';
import * as format from '../lib/format';
import {budgetView} from '../lib/money';
import {setLocale,t} from '../i18n';
import type {Card} from '../lib/types';
import type {KeyPart,Meter} from '../../server/domain/meters';
import * as meterDomain from '../../server/domain/meters';
import {deepSeekMeasurement} from '../../server/connectors/deepseek';
import * as currency from '../../server/domain/currency';
import {defaultCurrencyContext} from '../../server/domain/currency';
import {Store} from '../../server/store/store';
import * as statusMarks from '../components/StatusMark';
import * as currencySettings from '../lib/currencySettings';

Object.assign(globalThis,{React});

const meter=(id:string,amount='0',unit:Meter['unit']='USD'):Meter=>({id,amount,unit,kind:'balance',limit:null,at:1,staleAfterMs:1000,stale:false,resetAt:null,minutes:null,scope:null,label:null});
const key=(id:string):KeyPart=>({id,name:id,disabled:false,expiresAt:null,includeByok:false,at:1,staleAfterMs:1000,presence:'observed',missCount:0,periods:{day:'999000000',week:null,month:null},byokUsage:{total:'888000000',day:null,week:null,month:null}});
const card=(provider:string,meters:Meter[]):Card=>({id:'s',provider,meters,plan:'',successAt:1,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:1000,measureIntervalMs:null});
const dual=()=>card('deepseek',[
  meter('topped_up:USD','30000000'),meter('balance:USD','37000000'),meter('granted:CNY','10000000','CNY'),
  meter('balance:CNY','110000000','CNY'),meter('granted:USD','7000000'),meter('topped_up:CNY','100000000','CNY'),
]);

// Exercise the production card with a closed disclosure and no network or page clock.
let shownCurrency=defaultCurrencyContext;
const fixture={exports:{} as {MoneyCard:(props:{source:Card;board:string;compact?:boolean;tray?:boolean})=>ReturnType<typeof createElement>;BalanceMark:(props:{source:Card})=>ReturnType<typeof createElement>|null},require:(name:string)=>{
  if(name==='react/jsx-runtime')return jsx;
  if(name==='../../server/domain/currency')return currency;
  if(name==='../../server/domain/meters')return meterDomain;
  if(name==='../lib/money')return money;
  if(name==='../lib/currencySettings')return currencySettings;
  if(name==='../lib/format')return format;
  if(name==='../i18n')return {t};
  if(name==='../lib/moneyKeys')return {useShownKeys:(source:Card)=>({keys:source.keys??[],meters:source.meters??[],error:null})};
  if(name==='./Popover')return {Popover:({trigger,triggerClass,label}:{trigger:ReactNode;triggerClass?:string;label:string})=>createElement('button',{'aria-expanded':false,className:triggerClass,'aria-label':label},trigger)};
  if(name==='./StatusMark')return statusMarks;
  if(name==='./Kit')return {ErrorLine:()=>null};
  if(name==='../lib/board')return {useCurrencyContext:()=>shownCurrency};
  if(name==='../lib/clock')return {useClock:()=>1};
  if(['../lib/board','../lib/clock','../lib/http','../lib/quota','./Meter'].includes(name))return {};
  throw new Error(name);
}};
runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MoneyCard.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,fixture);
const {MoneyCard}=fixture.exports;

test('subscription footer keeps the last known balance in its warning tone, like free resets',()=>{
  const source={...card('codex',[{...meter('balance:credits','0','credits:codex'),scale:0}]),creditBalance:{id:'balance:credits' as const,unit:'credits:codex' as const,status:'finite' as const,at:1,staleAfterMs:1000}};
  shownCurrency={...defaultCurrencyContext,sources:{s:[{from:'credits:codex',at:1,anchor:null,steps:[{id:'default',source:'codex-default',base:'credits:codex',date:0,fetchedAt:1,from:'1000000',to:'40000'}]}]}};
  try {
    for(const locale of ['en','ru'] as const) {
      setLocale(locale);
      const draw=(value:Card)=>renderToStaticMarkup(createElement(MoneyCard,{source:value,board:'',tray:true}));
      assert.match(draw(source),/data-money="0"/,'a reported zero is a value');
      assert.ok(!draw(source).includes('data-time='),'live amounts remain data mutations in the performance probe');
      assert.ok(draw({...source,creditBalance:{...source.creditBalance,status:'unlimited'}}).includes('∞'));
      for(const status of ['missing','invalid','unsupported'] as const) {
        const html=draw({...source,creditBalance:{...source.creditBalance,status}});
        assert.match(html,/tray-pill is-warn/);
        assert.match(html,/data-money="0"/,'the last known zero remains visible');
        assert.ok(!html.includes('—')&&!html.includes('m12 3 10 18H2Z'),'no placeholder or warning icon replaces the balance');
        const positive=draw({...source,meters:[{...source.meters![0],amount:'2500',stale:true}],creditBalance:{...source.creditBalance,status}});
        assert.match(positive,/data-money="100000000"/,'the last known positive balance stays visible without opening details');
      }
      assert.equal(money.subscriptionFundsVisible({...source,meters:[],creditBalance:undefined}),false);
      assert.equal(money.subscriptionFundsVisible({...source,meters:[],creditBalance:{...source.creditBalance,status:'missing'}}),false);
      assert.equal(money.subscriptionFundsVisible({...source,budget:{enabled:false,since:null,anchor:null,revision:''}}),false);
    }
  } finally {shownCurrency=defaultCurrencyContext;setLocale('en');}
});

test('balance news uses the shared warning icon and status tones rather than a text badge',()=>{
  for(const locale of ['en','ru'] as const) {
    setLocale(locale);
    const available=card('deepseek',[meter('balance:USD','37000000')]);
    available.balanceStatus={at:1,staleAfterMs:1000,isAvailable:true,partial:false,issues:[]};
    assert.equal(renderToStaticMarkup(createElement(fixture.exports.BalanceMark,{source:available})), '');
    const cases:[Card,'warn'|'crit'][] = [
      [{...available,balanceStatus:{...available.balanceStatus,partial:true,issues:['currency_missing' as const]}},'warn'],
      [{...available,balanceStatus:{...available.balanceStatus,isAvailable:false}},'crit'],
      [{...card('openrouter',[]),currencyUnavailable:true},'warn'],
    ];
    for(const [source,tone] of cases) {
      const markup=renderToStaticMarkup(createElement(fixture.exports.BalanceMark,{source}));
      assert.match(markup,new RegExp(`class="[^"]*tray-pill is-${tone}(?: |")`));
      assert.match(markup,/<svg class="tray-icon"[^>]*width="13"[^>]*height="13"/);
      assert.ok(markup.includes('m12 3 10 18H2Z'));
      assert.ok(!markup.includes('>!</span>'));
    }
  }
  setLocale('en');
});

test('budget cards select native USD and its own composition without accounting or phantom caps',()=>{
  const source=dual(),extra={...meter('key:k:cap','1000000'),kind:'cap' as const,limit:'9000000'};
  source.meters!.push(extra,{...meter('usage','999000000'),kind:'counter'},meter('extra','888000000'));
  const view=budgetView(source,[key('k')]);
  assert.equal(view.remaining.kind,'funds');assert.deepEqual(view.limits,[]);
  assert.deepEqual(view.remaining.values.map(({total,components})=>({amount:total.amount,unit:total.unit,parts:components.map(c=>c.meter.unit)})),[
    {amount:'37000000',unit:'USD',parts:['USD','USD']},
  ]);
  const reordered=budgetView({...source,meters:[...source.meters!].reverse()});
  assert.deepEqual(reordered.remaining,view.remaining);
  assert.deepEqual(view.remaining.values.map(g=>g.components.map(c=>c.role)),[['granted','toppedUp']]);
});

test('selected key allowances stay separate from wallet funds and exclude key accounting totals',()=>{
  const wallet=meter('balance','37000000'),cap={...meter('key:k:cap','3000000'),kind:'cap' as const,limit:'10000000',scope:'monthly',resetAt:5000};
  const zero={...cap,id:'key:zero:cap',limit:'0',amount:'1000000'};
  const source=card('openrouter',[wallet,cap,zero,{...meter('credits','50000000'),kind:'counter'}]);
  const view=budgetView(source,[key('k'),key('zero'),key('uncapped')]);
  assert.equal(view.remaining.values[0].total,wallet);assert.deepEqual(view.remaining.values[0].components,[]);
  assert.deepEqual(view.limits.map(l=>[l.scope,l.meter.amount,l.meter.limit,l.meter.scope]),[
    [{kind:'key',id:'k'},'3000000','10000000','monthly'],[{kind:'key',id:'zero'},'1000000','0','monthly'],
  ]);
  assert.equal(Object.hasOwn(view.limits[0].part,'periods'),false);assert.equal(Object.hasOwn(view.limits[0].part,'byokUsage'),false);
  assert.deepEqual(budgetView(source,[]).limits,[]);
  assert.deepEqual(budgetView(source,[key('k')],[{...cap,kind:'counter'}]).limits,[]);
});

test('unknown or mismatched observations cannot invent funds or a currency',()=>{
  assert.deepEqual(budgetView(card('unknown',[meter('balance','1')])).remaining.values,[]);
  assert.deepEqual(budgetView(card('deepseek',[meter('granted:USD','1')])).remaining.values,[]);
  assert.deepEqual(budgetView(card('deepseek',[meter('balance:CNY','1','USD')])).remaining.values,[]);
  assert.deepEqual(budgetView(card('openrouter',[{...meter('balance','1'),kind:'counter'}])).remaining.values,[]);
});

test('both card surfaces render one native USD value without CNY or permanent composition',()=>{
  try {
    for(const locale of ['en','ru'] as const)for(const compact of [false,true]) {
      setLocale(locale);const source=dual();source.meters!.find(m=>m.id==='balance:USD')!.stale=true;
      const markup=renderToStaticMarkup(createElement(MoneyCard,{source,board:'',compact}));
      assert.equal(markup.split(t('money.accountBalance')).length-1,1);
      assert.equal((markup.match(/data-money=/g)??[]).length,1);
      assert.match(markup,/class="limit-value is-stale" data-money="37000000"/);
      assert.ok(!markup.includes('CNY'));
      assert.equal((markup.match(/aria-expanded="false"/g)??[]).length,1);
      assert.ok(markup.includes(`<div class="money-balance"><span>${t('money.accountBalance')}</span>`));
      assert.match(markup,/<button[^>]*><span[^>]*data-money="37000000"/);
      assert.ok(!markup.includes(t('money.granted')));assert.ok(!markup.includes(t('money.toppedUp')));
      assert.ok(!markup.includes('class="meter"'));
    }
  } finally {setLocale('en');}
});

test('CNY-only cards use a dated USD estimate with the same renderer',()=>{
  const at=Date.UTC(2026,9,5),store=new Store(':memory:',at);
  const measured=deepSeekMeasurement({is_available:true,balance_infos:[{currency:'CNY',total_balance:'110',granted_balance:'10',topped_up_balance:'100'}]},at);
  const id=store.source('deepseek','1'.repeat(24),at);store.record(id,measured);
  const quote=store.currencies.save({source:'ecb',base:'EUR',date:at,fetchedAt:at,rates:{EUR:'1000000',USD:'1000000',CNY:'7000000'}});
  for(const native of measured.meters)store.currencies.record(id,native,'USD',quote);
  const source=card('deepseek',[...measured.meters,...measured.meters.flatMap(m=>store.currencies.project(id,m,'USD',at)??[])]);store.close();
  for(const compact of [false,true]){
    const markup=renderToStaticMarkup(createElement(MoneyCard,{source,board:'',compact}));
    assert.equal((markup.match(/data-money=/g)??[]).length,1);assert.match(markup,/data-money="15714286"/);assert.ok(markup.includes('≈ '));assert.ok(markup.includes('ECB'));
  }
  const totalOnly={...source,meters:source.meters!.filter(m=>m.id==='balance:CNY'||m.conversion?.original.meterId==='balance:CNY')};
  const disclosure=renderToStaticMarkup(createElement(MoneyCard,{source:totalOnly,board:''}));
  assert.equal((disclosure.match(/aria-expanded="false"/g)??[]).length,1);assert.ok(disclosure.includes('ECB'));
  const later={...source,meters:source.meters!.map(m=>m.id==='balance:CNY'?{...m,amount:'142000000',at:at+1000}:m.conversion?{...m,stale:true}:m)};
  const stale=renderToStaticMarkup(createElement(MoneyCard,{source:later,board:''}));
  assert.ok(!stale.includes('142.000000 CNY'));assert.match(stale,/is-stale" data-money="15714286"/);
});

test('funds absence, a confirmed zero and a signed balance keep different card values',()=>{
  for(const provider of ['deepseek','openrouter']) {
    const id=provider==='deepseek'?'balance:USD':'balance';
    const draw=(meters:Meter[])=>renderToStaticMarkup(createElement(MoneyCard,{source:card(provider,meters),board:''}));
    const unknown=draw([]);assert.ok(unknown.includes('—'));assert.ok(!unknown.includes('data-money='));
    assert.match(draw([meter(id)]),/data-money="0"/);
    assert.match(draw([meter(id,'-1')]),/data-money="-1"/);
  }
});
