import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PageClock} from '../lib/clock';
import {PeriodAccounting} from '../lib/periodAccounting';
import {PeriodCurves,sourceWorkCurves,sourceWorkTape} from '../../server/domain/periodCurves';
import {drain} from '../lib/prepare';
import {periodTextChangesAt} from '../lib/periodClock';
import {evaluatedRange} from '../../server/domain/period';
import {moneyTableValues,moneyWorkValues,moneyComparator,nextMoneySort,visibleMoneySort} from '../lib/moneyTable';
import {activeHours,money} from '../lib/money';
import {stamp} from '../lib/format';
import {defaultCurrencyContext} from '../../server/domain/currency';
import {t} from '../i18n';
import type {PeriodTape} from '../../server/domain/periodTape';
import type {WorkTrace} from '../../server/domain/periodWork';
import type {MeterHistory} from '../lib/moneyView';

const M=60_000,H=60*M;
const coordinator=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
const ui=readFileSync(new URL('../components/MoneyAnalytics.tsx',import.meta.url),'utf8');
const jsx=(_type:unknown,props:unknown)=>({props});
const compile=(code:string,context:Record<string,unknown>)=>runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);

function fixture(stale=false){
  const selected:WorkTrace={anchor:0,knownFrom:0,cut:H,refs:['A','B'].map(source=>({ref:source,source,device:{id:source,name:source},origin:'terminal',project:'Selected',folder:null,startedAt:0})),spans:[[0,0,15*M],[0,30*M,45*M],[1,5*M,35*M]]};
  const full:WorkTrace={...selected,spans:[[0,0,H],[1,0,H]]};
  const source=stale?{groups:{source:new Map()},knownFrom:Infinity,available:false}:sourceWorkCurves(sourceWorkTape(new PeriodCurves(full),0,H,new Map([['A',0],['B',0]]),()=>{}));
  const readings=(stale?[0]:[0,H-1]).map((at,i)=>({id:'usage',at,previousAt:i?0:null,kind:'counter' as const,unit:'USD',amount:String(i*1000000),limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:stale?M:4*H}));
  const spans=[{from:0,to:stale?M:H,observedFrom:0,staleAfterMs:stale?M:4*H}];
  const tape:PeriodTape={from:0,cut:H,replaceFrom:0,cursor:'x',quota:[],money:['A','B'].map(source=>({source,meter:'balance',role:'total',readings:readings.map(row=>({...row,id:'balance',kind:'balance',amount:'100000000'})),spans,workCounter:{source,unit:'USD',knownFrom:0,workFrom:0,readings,spans}}))};
  const accounting=drain(PeriodAccounting.prepare(tape,selected,undefined,undefined,undefined,undefined,source));
  const context={exports:{} as any,evaluatedRange,periodTextChangesAt};
  compile('class Model {'+coordinator.slice(coordinator.indexOf('  moneyOrderAt('),coordinator.indexOf('  private workBoundary('))+coordinator.slice(coordinator.indexOf('  cellChangesAt('),coordinator.indexOf('  projectionState('))+'}\nexports.Model=Model;',context);
  const model=new context.exports.Model();model.tapes=new Map([['budget',{tape,accounting,rangeKey:'1h',selection:{mode:'live',periodMs:H}}]]);
  const boardPeriod={moneyWorkAt:(source:string,at:number)=>accounting.moneyWorkSummary(source,{from:at-H,to:at}),moneyAt:(entry:MeterHistory)=>entry,rangeAt:(_scope:string,at:number)=>({from:at-H,to:at}),moneyOrderAt:model.moneyOrderAt.bind(model),cellChangesAt:model.cellChangesAt.bind(model)};
  const entries=['A','B'].map(sourceId=>({sourceId,meterId:'balance',kind:'balance',role:'total',unit:'USD',end:'100000000',topup:null} as MeterHistory));
  return {accounting,boardPeriod,entries};
}

test('actual budget Active sort wakes at selected-curve crossings inside a continuous supplier interval',()=>{
  const {boardPeriod,entries}=fixture();let now=H+1,index=0,dirty=false;
  const timers=new Map<object,{run:()=>void;at:number}>(),slots:any[]=[],effects:(()=>void)[]=[];
  const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:(run,ms)=>{const token={};timers.set(token,{run,at:now+ms});return token;},clearTimeout:token=>{timers.delete(token as object);}});
  const slot=(make:()=>any)=>{const at=index++;return slots[at]??(slots[at]=make());};
  const rows=entries.map(entry=>({key:entry.sourceId,name:entry.sourceId,cells:{active:{content:'retained'}}}));
  const context={exports:{} as any,require:()=>({jsx,jsxs:jsx}),memo:(fn:unknown)=>fn,
    usePref:()=>({column:'active',descending:false}),useLocale:()=> 'en',useRef:(current:unknown)=>slot(()=>({current})),useState:(make:()=>unknown)=>[slot(make)],useMemo:(make:()=>unknown)=>make(),useCallback:(fn:unknown)=>fn,
    useLayoutEffect:(run:()=>void)=>effects.push(run),useSyncExternalStore:(subscribe:(notify:()=>void)=>()=>void,read:()=>unknown)=>{const state=slot(()=>{const state={value:read(),stop:()=>{}};state.stop=subscribe(()=>{const next=read();if(next!==state.value){state.value=next;dirty=true;}});return state;});state.value=read();return state.value;},
    clock,hubNow:()=>now,moneyTableValues,moneyComparator,nextMoneySort,visibleMoneySort,boardPeriod,
    AnalyticsPanel:()=>{},TableSortMenu:()=>{},TableMeasure:()=>{},WidgetPages:()=>{},TableSurface:'surface',useTableWidget:(_panel:unknown,_columns:unknown,_name:unknown,keys:string[])=>({layout:'table',from:0,to:keys.length,measureFrom:0,measureTo:0}),AnalyticsTable:()=>{},setPrefs:()=>{},t:()=> 'Account'};
  const start=ui.indexOf('const SortedMoney=');compile('export '+ui.slice(start,ui.indexOf('const pointAt=',start)),context);
  const render=()=>{index=0;dirty=false;const result=context.exports.SortedMoney({rows,entries,history:{live:true,range:'1h',since:0,to:H},unit:'USD',columns:[{id:'active',title:'Active'}]}).props.children[0].props.children[1].props.rows;effects.splice(0).forEach(run=>run());return result as typeof rows;};
  assert.deepEqual(Array.from(render(),row=>row.key),['A','B']);
  now=H+25*M;clock.wakeDue();assert.equal(dirty,true);const ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['B','A']);assert.equal(ordered[0],rows[1]);
  now=H+26*M;clock.wakeDue();assert.equal(dirty,false,'unchanged order keeps the existing rows');
  for(const state of slots)state.stop?.();assert.equal(timers.size,0);
});

test('actual budget Active cell keeps its selected clock when supplier work is unavailable',()=>{
  const {boardPeriod,entries}=fixture(true);
  const context={exports:{} as any,require:()=>({jsx,jsxs:jsx}),history:{live:true,range:'1h',since:0,to:H},boardPeriod,moneyTableValues,moneyWorkValues,activeHours,money,t,stamp,context:defaultCurrencyContext};
  compile(ui.slice(ui.indexOf('  const cellAt='),ui.indexOf('  // Retained rows stay mounted'))+'\nexports.create=cellOf;exports.raw=cellAt;',context);
  const cell=context.exports.create(entries[0],'active'),read=(at:number)=>context.exports.raw(entries[0],'active',at).content;
  const now=H+1,due=cell.changesAt(now);assert.notEqual(read(now),read(H+10*M));assert.ok(due!==null&&due<=H+10*M);
  assert.equal(read(due-1),read(now));assert.notEqual(read(due),read(now));
  assert.equal(cell.changesAt(2*H+1),null,'expired selected evidence leaves no idle wake');
});
