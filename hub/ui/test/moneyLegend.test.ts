import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import {memo as reactMemo,type ReactElement,type ComponentProps} from 'react';
import * as providers from '../../server/domain/providers';
import * as currency from '../../server/domain/currency';
import * as moneyView from '../lib/moneyView';
import * as money from '../lib/money';
import * as moneyTable from '../lib/moneyTable';
import * as periods from '../lib/periods';
import * as i18n from '../i18n';
import {DEFAULT_MONEY,moneySelection,fundsLegacyMuted} from '../lib/moneySelection';
import {PeriodAccounting} from '../../server/domain/periodAccounting';
import * as meterHistory from '../../server/domain/meterHistory';
import * as widgets from '../../server/domain/widgets';
import {chartMuteKey,chartSeriesMuted} from '../lib/prefs';
import * as views from '../../server/domain/view';
import * as preparation from './preparationFixture';
import type {Card,History} from '../lib/types';
import type {Reading} from '../../server/domain/meters';
import type {PeriodTape} from '../../server/domain/periodTape';
import type {MeterHistory} from '../lib/moneyView';
import type {Prefs} from '../lib/prefs';
import type {Chart as ChartComponent} from '../components/Chart';

type ChartProps=ComponentProps<typeof ChartComponent>;
type FixtureNode={type:unknown;key:string|null;props:Record<string,unknown>};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object';
function nodeOf(value:unknown):FixtureNode|null {
  if(!record(value)||!record(value.props))return null;
  return {type:value.type,key:typeof value.key==='string'?value.key:null,props:value.props};
}
function memoOf(value:unknown):value is {$$typeof:symbol;type:(props:Record<string,unknown>)=>unknown} {
  return record(value)&&value.$$typeof===Symbol.for('react.memo')&&typeof value.type==='function';
}
type Leaf={props:Record<string,unknown>;locale:i18n.Locale;subscribesLocale:boolean;value:unknown};

// The actual module and production rolling accounting are read unchanged.
// Reconciliation models React.memo's shallow props and locale subscription;
// it controls formatter calls, not browser CPU or canonical benchmark timing.
test('money legend reuses unchanged amounts through rolling clocks and preserves fresh presentation',t=>{
  t.after(()=>i18n.setLocale('en',false));
  const source=readFileSync(new URL('../components/MoneyAnalytics.tsx',import.meta.url),'utf8');
  const M=60000,H=60*M,NOW=4*H,N=12;
  const cards:Card[]=Array.from({length:N},(_,i)=>({id:'wallet'+i,title:'Wallet '+i,provider:'openrouter',plan:'',successAt:NOW-M,resets:null,staleAfterMs:H,measureIntervalMs:null,windows:[],error:null,stale:false,owners:[],meters:[{id:'balance',kind:'balance',amount:'10000000',unit:'USD',at:NOW-M,limit:null,stale:false,staleAfterMs:H,resetAt:null,minutes:null,scope:null,label:null}]}));
  const reading=(at:number,amount='10000000'):Reading=>({id:'balance',kind:'balance',unit:'USD',amount,scale:6,limit:null,at,previousAt:null,staleAfterMs:4*H,resetAt:null,minutes:null,scope:null,label:null});
  const tape=(next:boolean):PeriodTape=>({from:0,cut:NOW+10*M,replaceFrom:0,cursor:'same',quota:[],money:cards.map((c,i)=>({source:c.id,meter:'balance',accounting:{spending:'counter',topups:'counter'},readings:[reading(0),reading(NOW-30*M),...(next&&!i?[reading(NOW+2*M,'9000000')]:[])],spans:[{from:0,to:NOW+10*M,staleAfterMs:4*H}]}))});
  const base:History={board:'b',range:'1h',live:true,since:NOW-H,to:NOW,cellMs:M,historyStart:0,events:[],series:[],activity:{since:0,known:null,barMs:M,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}},meterSeries:cards.map(c=>({sourceId:c.id,meterId:'balance',kind:'balance',unit:'USD',start:'10000000',end:'10000000',spent:'0',topup:'0',unlocated:[],topupUnlocated:[],coveredMs:H,semantics:null,points:[{at:NOW-M,value:'10000000',segment:0,validUntil:NOW+2*H,spent:'0',steps:[],semantics:null}]}))};
  function harness() {
    const hooks=preparation.preparationFixture(),leaves=new Map<string,Leaf>();
    let now=NOW,index=new PeriodAccounting(tape(false),null);
    let history:History|null=index.project(base,{from:NOW-H,to:NOW}),drawing:History|null=history;
    let sources=cards,context=currency.defaultCurrencyContext,locale:i18n.Locale='en',authority=0;
    let prefs:Pick<Prefs,'money'|'funds'|'muted'|'range'|'horizon'>={money:{...DEFAULT_MONEY,unit:'USD'},funds:{...DEFAULT_MONEY},muted:{},range:'1h',horizon:'auto'};
    let view=views.EMPTY_VIEW,calls=0,activeLeaf:Leaf|null=null;
    const toggles:{key:string;value:boolean}[]=[];
    const Chart=()=>null,SeriesLegendItem=()=>null,MoneyChartSettings=()=>null;
    const useMemo=(f:()=>unknown,deps:unknown[])=>{const r=hooks.useRef(null) as {current:{deps:unknown[];value:unknown}|null};if(!r.current||deps.length!==r.current.deps.length||deps.some((v,i)=>!Object.is(v,r.current!.deps[i])))r.current={deps,value:f()};return r.current.value;};
    const useLocale=()=>{if(activeLeaf)activeLeaf.subscribesLocale=true;return locale;};
    const modules:Record<string,unknown>={
      'react/jsx-runtime':jsx,react:{useRef:hooks.useRef,useMemo,memo:reactMemo},
      '../../server/domain/providers':providers,'../../server/domain/currency':currency,'../../server/domain/meterHistory':{composeMetersPrepared:meterHistory.composeMetersPrepared},
      '../lib/board':{useBoardId:()=> 'b',useCurrencyContext:()=>context,useNamed:()=>sources},
      '../lib/history':{useBudgetHistory:()=>({history,drawing,loading:!history,presentation:authority}),useBudgetHistoryPlot:()=>null,useHistoryBegins:()=>0,budgetHistory:{retry(){}},fundsHistory:{retry(){}}},
      '../lib/prefs':{useChartMuted:()=>prefs.muted,chartMuteKey,chartSeriesMuted,usePref:(key:keyof typeof prefs)=>prefs[key],setMuted:(key:string,value:boolean)=>toggles.push({key,value})},
      '../lib/moneyTable':moneyTable,'./seriesFocus':{useSeriesFocus:()=>{}},
      './MoneySettings':{MoneyChartSettings},
      '../lib/moneySelection':{moneySelection,fundsLegacyMuted},'../lib/moneyView':moneyView,'../lib/money':{...money,money:(...args:Parameters<typeof money.money>)=>{calls++;return money.money(...args);}},
      '../lib/view':{...widgets,colorOf:()=> '#fff'},'../lib/periods':periods,'../lib/timeRange':{useTimeRange:()=>null},'../lib/clock':{useClock:()=>now},'../lib/pan':{usePanning:()=>null},
      '../lib/axisNavigation':{axisNavigation:()=>({context:'b'})},'../i18n':{t:i18n.t,useLocale},'./prepared':{usePrepared:hooks.usePrepared},'./sizing':{usePlot:()=>({plot:160,onBase(){}})},'./Chart':{Chart},'./AnalyticsPanel':{SeriesLegendItem},
    };
    const vm={exports:{} as {MoneyHistory:(props:unknown)=>ReactElement<{children:unknown[]}>},require:(n:string)=>modules[n]??{}};
    runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,vm);
    // Actual React.memo object; shallow Object.is props and locale-subscription
    // invalidation are modeled, not a browser reconciliation or timing measurement.
    function resolve(value:unknown,key:string,seen:Set<string>):unknown {
      if(Array.isArray(value))return value.map((child,i)=>resolve(child,key+'/'+i,seen));
      const node=nodeOf(value);
      if(!node)return value;
      if(memoOf(node.type)) {
        seen.add(key);const old=leaves.get(key),props=node.props,keys=Object.keys(props);
        if(old&&(!old.subscribesLocale||old.locale===locale)&&keys.length===Object.keys(old.props).length&&keys.every(k=>Object.is(props[k],old.props[k])))return old.value;
        const next:Leaf={props,locale,subscribesLocale:false,value:null};
        activeLeaf=next;next.value=node.type.type(props);activeLeaf=null;leaves.set(key,next);return next.value;
      }
      return {type:node.type===SeriesLegendItem?'series':typeof node.type==='string'?node.type:'other',key:node.key,props:Object.fromEntries(Object.entries(node.props).filter(([k])=>k!=='children'&&k!=='onToggle')),children:resolve(node.props.children,node.key?key+'/'+node.key:key,seen)};
    }
    function render() {
      i18n.setLocale(locale,false);calls=0;hooks.begin();
      const tree=vm.exports.MoneyHistory({arrange:{view,owner:false}});
      const panel=nodeOf(tree)!;
      assert.equal(panel.props.controls,undefined,'data selection is inside settings, without a duplicate header control');
      const settings=nodeOf(panel.props.settings)!;
      assert.equal(settings.type,MoneyChartSettings);assert.equal(settings.props.sources,sources);
      const chart=tree.props.children.find((child):child is ReactElement<ChartProps>=>nodeOf(child)?.type===Chart);
      const legend=tree.props.children.find((child):child is ReactElement<{className:string;children:unknown[]}>=>{const node=nodeOf(child);return node?.type==='div'&&node.props.className==='legend';});
      assert.ok(chart);assert.ok(legend);
      const seen=new Set<string>(),display=JSON.stringify(resolve(legend,'',seen));
      for(const key of leaves.keys())if(!seen.has(key))leaves.delete(key);
      hooks.commit();return {calls,chart,legend,display};
    }
    function settle(){for(let i=0;i<4;i++){render();hooks.finish();}return render();}
    function replaceFirst(fields:Partial<MeterHistory>) {history={...history!,meterSeries:history!.meterSeries!.map((s,i)=>i?s:{...s,...fields})};drawing=history;}
    function update(phase:string) {
      if(phase==='frame')now+=250;
      if(phase==='clock'){now+=M;history=index.project(base,{from:now-H,to:now});}
      if(phase==='data'){index=new PeriodAccounting(tape(true),null);history=index.project(base,{from:now-H,to:now});drawing=history;}
      if(phase==='nonrolling'){history={...history!,live:false};drawing=history;}
      if(phase==='nonrollingAmount')replaceFirst({end:'12345678'});
      if(phase==='rename')sources=sources.map((s,i)=>i?s:{...s,title:'Renamed'});
      if(phase==='currency')context={...context,definitions:context.definitions.map(d=>d.id==='USD'?{...d,symbol:'USDx'}:d)};
      if(phase==='locale')locale='ru';
      if(phase==='mute')prefs={...prefs,muted:{[chartMuteKey(widgets.BUDGET_HISTORY,'wallet0','balance')]:true}};
      if(phase==='zero')replaceFirst({end:'0',spent:'0',coveredMs:history!.to-history!.since,unlocated:[]});
      if(phase==='unknown')replaceFirst({end:null,spent:null,coveredMs:0});
      if(phase==='unavailable')replaceFirst({end:'0',spent:null,coveredMs:history!.to-history!.since});
      if(phase==='partial')replaceFirst({spent:'1234',coveredMs:1,unlocated:[]});
      if(phase==='cap')replaceFirst({kind:'cap',meterId:'key:cap',semantics:{limit:'10000000',resetAt:null,minutes:60,scope:'scope',label:'Cap'},end:'0',spent:null});
      if(phase==='hide'){view={...view,hidden:['source:wallet0']};history=null;drawing=null;authority++;}
      if(phase==='restore'){view=views.EMPTY_VIEW;history=index.project(base,{from:now-H,to:now});drawing=history;authority++;}
      if(phase==='unit')prefs={...prefs,money:{...prefs.money,unit:'EUR'}};
      if(phase==='resetunit')prefs={...prefs,money:{...prefs.money,unit:'USD'}};
      if(phase==='revoke'){history=null;drawing=null;authority++;}
      return render();
    }
    return {render,settle,update,toggle:(r:ReturnType<typeof render>)=>{
      const callback=nodeOf(r.legend.props.children[0])?.props.onToggle;
      assert.equal(typeof callback,'function');
      if(typeof callback==='function')callback();
      return toggles.at(-1);
    }};
  }
  const h=harness(),rows:{phase:string;moneyCalls:number;prepared:ChartProps['prepared'];lines:number}[]=[];
  const first=h.settle();
  let retained=first.chart.props.lines;
  for(let n=0;n<50;n++)assert.equal(h.update('frame').legend,first.legend,'frame-only renders retain the actual legend JSX');
  for(const phase of['stable','clock','clock','clock','data','nonrolling','nonrollingAmount','rename','currency','locale','mute','zero','unknown','unavailable','partial','cap','zero','unknown','hide','restore','unit','resetunit','revoke']) {
    const r=phase==='stable'?h.render():h.update(phase);
    if(['stable','clock','rename','mute'].includes(phase))assert.equal(r.calls,0,phase+' reuses identical formatted amounts');
    if(phase==='clock'){assert.equal(r.chart.props.prepared,true);assert.strictEqual(r.chart.props.lines,retained,'clock keeps the exact prepared drawing');}
    if(['data','nonrollingAmount'].includes(phase)){assert.equal(r.calls,1,phase+' reformats only revised amount');assert.equal(r.chart.props.prepared,false,'pending numerical preparation remains pending');}
    if(phase==='data')assert.strictEqual(r.chart.props.lines,retained,'pending new data retains the prior authorized drawing');
    if(['currency','locale','restore','resetunit'].includes(phase))assert.equal(r.calls,N,phase+' invalidates formatting or remounts fresh leaves');
    if(phase==='rename')assert.match(r.display,/Renamed/);
    if(phase==='currency')assert.match(r.display,/USDx/);
    if(phase==='locale')assert.match(r.display,/12,35 USDx/);
    if(phase==='mute')assert.equal(h.toggle(r)!.value,false,'callback uses current muted state');
    if(['hide','unit','revoke'].includes(phase)){assert.equal(r.chart.props.lines.length,0);assert.equal(r.legend.props.children.length,0,'no stale amount survives cleared history/unit/authority');}
    if(phase==='zero')assert.match(r.display,/0,00 USDx/);
    if(phase==='unknown')assert.match(r.display,/—/);
    if(phase==='unavailable'){assert.match(r.display,/0,00 USDx/);assert.ok(!r.display.includes(i18n.t('money.unavailable')),'unsupported spending never masks a known balance');}
    if(phase==='partial'){assert.match(r.display,/0,00 USDx/);assert.doesNotMatch(r.display,/money-partial/,'partial spending is not partial balance');}
    if(phase==='cap')assert.match(r.display,/Cap/,'balance retains the scoped allowance');
    rows.push({phase,moneyCalls:r.calls,prepared:r.chart.props.prepared,lines:r.chart.props.lines.length});
    retained=h.settle().chart.props.lines;
  }
});
