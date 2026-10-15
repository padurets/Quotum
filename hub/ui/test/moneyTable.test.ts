import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {defaultCurrencyContext} from '../../server/domain/currency';
import {PeriodAccounting} from '../lib/periodAccounting';
import {PageClock} from '../lib/clock';
import {moneyComparator,moneyTableValues,moneySeriesName,moneySeriesDetail,nextMoneySort,readMoneySort,visibleMoneySort,type MoneySort} from '../lib/moneyTable';
import type {MeterHistory} from '../lib/moneyView';
import {setLocale,t} from '../i18n';

const H=3_600_000;
const series=(sourceId:string,end:string|null):MeterHistory=>({sourceId,meterId:'balance',kind:'balance',unit:'USD',role:'total',start:end,end,spent:'0',topup:'0',coveredMs:H,semantics:null,unlocated:[],topupUnlocated:[],points:[]});

test('money sorting keeps integer precision, unavailable accounting last, and hidden reader choices',()=>{
  assert.deepEqual(readMoneySort({column:'limit',descending:true}),{column:'name',descending:true},'the previous name-column preference survives the shared table contract');
  const huge=9007199254740993000000n;
  const entries=[series('2',(huge+1n).toString()),series('10',huge.toString()),{...series('unknown',null),spent:null,topup:null},series('zero','0')];
  const rows=entries.map(entry=>({key:entry.sourceId,name:'Wallet '+entry.sourceId,values:moneyTableValues(entry,0,H)}));
  for(const descending of [false,true]){
    const values=[...rows].sort(moneyComparator({column:'value',descending},'en'));
    assert.equal(values.at(-1)!.key,'unknown');
    assert.deepEqual(values.slice(0,3).map(row=>row.key),descending?['2','10','zero']:['zero','10','2']);
  }
  assert.equal(moneyTableValues({...entries[0],kind:'counter'},0,H).topup,null);
  const up=nextMoneySort(null,'value'),down=nextMoneySort(up,'value');
  assert.deepEqual(readMoneySort(JSON.parse(JSON.stringify(down))),down);
  assert.equal(nextMoneySort(down,'value'),null);
  assert.equal(nextMoneySort(down,'value',false)?.descending,false,'menus reset through their default row');
  assert.equal(visibleMoneySort(down,['topup']),null);assert.equal(visibleMoneySort(down,['value']),down);
  for(const value of [{},[],{column:'spending',descending:false},{column:'forecast',descending:false},{column:'value',descending:1}])assert.equal(readMoneySort(value),null);
});

test('budget names omit repeated total words in EN/RU while distinct components and details remain',()=>{
  try {for(const locale of ['en','ru'] as const){
    setLocale(locale);const total=series('wallet','0');
    assert.equal(moneySeriesName(total,'Wallet',defaultCurrencyContext),'Wallet');
    assert.equal(moneySeriesDetail(total,defaultCurrencyContext),t('money.total'));
    assert.equal(moneySeriesName({...total,role:'granted'},'Wallet',defaultCurrencyContext),'Wallet — '+t('money.granted'));
    assert.match(moneySeriesName({...total,role:undefined,meterId:'key:k:cap',kind:'cap',semantics:{limit:'100',resetAt:null,minutes:null,scope:null,label:'Project key'}},'Wallet',defaultCurrencyContext),/Project key/);
    assert.equal(moneySeriesName(total,'Subscription',defaultCurrencyContext,'funds'),'Subscription');
  }}finally{setLocale('en');}
});

test('actual money order follows an exclusive availability boundary without replacing cells or waking unchanged order',()=>{
  let now=H,sort:MoneySort={column:'value',descending:false},index=0,dirty=false;
  const timers=new Map<object,{run:()=>void;at:number}>(),slots:any[]=[],effects:(()=>void)[]=[];
  const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:(run,ms)=>{const id={};timers.set(id,{run,at:now+ms});return id;},clearTimeout:id=>{timers.delete(id as object);}});
  const entries=[series('A','10'),series('B','20')];
  const accounting=new PeriodAccounting({from:0,cut:2*H,replaceFrom:0,cursor:'c',quota:[],money:entries.map(entry=>({source:entry.sourceId,meter:'balance',readings:[{id:'balance',kind:'balance',unit:'USD',amount:entry.end!,at:0,previousAt:null,staleAfterMs:4*H,limit:null,resetAt:null,minutes:null,scope:null,label:null}],spans:[{from:0,to:H,staleAfterMs:4*H,...(entry.sourceId==='A'?{holdUntil:H+5000}:{})}]}))},null);
  const rows=entries.map(entry=>({key:entry.sourceId,name:entry.sourceId,cells:{value:{content:'kept'}}}));
  const props={rows,entries,columns:[{id:'value'}],history:{live:true,range:'1h',since:0,to:H}};
  const slot=(make:()=>any)=>{const at=index++;return slots[at]??(slots[at]=make());};
  const context={exports:{} as {SortedMoney:(props:unknown)=>{props:{children:any[]}}},require:()=>({jsxs:(_type:unknown,props:unknown)=>({props}),jsx:(_type:unknown,props:unknown)=>({props})}),memo:(fn:unknown)=>fn,
    usePref:()=>sort,useLocale:()=> 'en',useRef:(current:unknown)=>slot(()=>({current})),useState:(make:()=>unknown)=>[slot(make)],useMemo:(make:()=>unknown)=>make(),useCallback:(fn:unknown)=>fn,
    useLayoutEffect:(run:()=>void)=>effects.push(run),useSyncExternalStore:(subscribe:(notify:()=>void)=>()=>void,read:()=>unknown)=>{const state=slot(()=>{const state={value:read(),stop:()=>{}};state.stop=subscribe(()=>{const next=read();if(next!==state.value){state.value=next;dirty=true;}});return state;});state.value=read();return state.value;},
    clock,hubNow:()=>now,moneyTableValues,moneyComparator,nextMoneySort,visibleMoneySort,
    boardPeriod:{moneyAt:(entry:MeterHistory,at:number)=>({...entry,...accounting.moneySummary(entry.sourceId,entry.meterId,entry.unit,{from:at-H,to:at})}),rangeAt:(_scope:string,at:number)=>({from:at-H,to:at}),moneyOrderAt:(at:number)=>accounting.changesAt(at,H)},
    AnalyticsPanel:()=>{},TableSortMenu:()=>{},TableMeasure:()=>{},WidgetPages:()=>{},useTableWidget:(_panel:unknown,_columns:unknown,_name:unknown,keys:string[])=>({layout:'table',from:0,to:keys.length,measureFrom:0,measureTo:0}),AnalyticsTable:()=>{},setPrefs:()=>{},t:()=> 'Account'};
  const source=readFileSync(new URL('../components/MoneyAnalytics.tsx',import.meta.url),'utf8'),start=source.indexOf('const SortedMoney=');
  runInNewContext(ts.transpileModule(`export ${source.slice(start,source.indexOf('const pointAt=',start))}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{index=0;dirty=false;const value=context.exports.SortedMoney(props).props.children[1].props.children[0].props.rows as typeof rows;effects.splice(0).forEach(run=>run());return value;};
  assert.deepEqual(Array.from(render(),row=>row.key),['A','B']);
  now=H+4999;clock.wakeDue();assert.equal(dirty,false);
  now++;clock.wakeDue();assert.equal(dirty,true);const ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['B','A']);assert.equal(ordered[1],rows[0]);assert.equal(ordered[1].cells,rows[0].cells);
  now++;clock.wakeDue();assert.equal(dirty,false);
  sort=null;assert.deepEqual(Array.from(render(),row=>row.key),['A','B']);
  for(const state of slots)state.stop?.();assert.equal(timers.size,0);
});
