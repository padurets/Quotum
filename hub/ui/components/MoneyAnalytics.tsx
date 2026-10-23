import {AnalyticsPanel, SeriesLegendItem} from './AnalyticsPanel';
import {AnalyticsTable, TableSettings, type AnalyticsRow, type AnalyticsColumn, type Cell, type TimedCell} from './AnalyticsTable';
import {providerOf,supportsBudget,type MoneyFamily} from '../../server/domain/providers';
import {memo,useCallback,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type ComponentProps,type RefObject} from 'react';
import {DEFAULT_CURRENCY,currencySymbol} from '../../server/domain/currency';
import {useBoardId,useNamed,useServerView,useCurrencyContext} from '../lib/board';
import {useBudgetFinancialHistory,useBudgetHistory,useHistoryBegins,useBudgetHistoryPlot,budgetHistory,fundsHistory} from '../lib/history';
import {usePref,setPrefs} from '../lib/prefs';
import {moneySelection} from '../lib/moneySelection';
import {money,activeHours} from '../lib/money';
import {moneySeriesName as nameOf,moneySeriesDetail,moneyTableValues,moneyWorkValues,moneyBalanceSeries,moneyComparator,nextMoneySort,visibleMoneySort,type MoneyColumn} from '../lib/moneyTable';
import {moneyIdentity,moneyPointAt,meterPointIn,moneyTotal,type MeterHistory} from '../lib/moneyView';
import {colorOf,columnShown,SUBSCRIPTION_FUNDS,BUDGET_HISTORY,BUDGET_TABLE,type Arrange} from '../lib/view';
import {frameOf,frameChangesAt,measuredTo} from '../lib/periods';
import {useTimeRange,setTimeRange,timeRangeKey} from '../lib/timeRange';
import {clock,hubNow,useClock} from '../lib/clock';
import {stamp} from '../lib/format';
import type {Line} from '../lib/lines';
import {t,useLocale} from '../i18n';
import {Chart,type ValueAxis} from './Chart';
import {usePlot} from './sizing';
import {MoneyChartSettings} from './MoneySettings';
import {axisNavigation} from '../lib/axisNavigation';
import {usePrepared} from './prepared';
import {pan,usePanning} from '../lib/pan';
import {boardPeriod} from '../lib/period';
import {composeMetersPrepared} from '../../server/domain/meterHistory';
import type {History} from '../lib/types';
import {TableSurface,useTableWidget,WidgetPages,TableMeasure,TableSortMenu} from './TableWidget';
import {useSeriesFocus} from './seriesFocus';
import {SeriesDetails} from './SeriesDetails';

function useSelectionNotice(family:MoneyFamily='budget') {
  const sources=useNamed(undefined,family),view=useServerView(),settings=usePref(family==='funds'?'funds':'money'),context=useCurrencyContext();
  const result=moneySelection(sources,view?.hidden??[],settings,context,family);
  const removed=result.removed||(settings.removed??0);
  return [result.limited?t('api.filters_limit'):result.omitted>0?t('money.limit',{count:result.omitted}):null,removed>0?t('money.removed',{count:removed}):null].filter(Boolean).join('\n')||null;
}
const MONEY_COLUMNS = [
  {id: 'value', label: 'money.value', width: 140},
  {id: 'topup', label: 'money.topup', width: 140},
  {id: 'active', label: 'money.activeTime', width: 140},
  {id: 'rate', label: 'money.activeRate', width: 180},
  {id: 'remaining', label: 'money.remainingActiveHours', width: 180},
] as const;

/** Values and order share the period index; clock changes retain every cell. */
const SortedMoney=memo(function SortedMoney({rows,entries,columns,history,panel,unit,children,controls,...panelProps}:{rows:AnalyticsRow<MoneyColumn>[];entries:MeterHistory[];columns:AnalyticsColumn<MoneyColumn>[];history:History|null;panel:RefObject<HTMLElement|null>;unit:string} & Omit<ComponentProps<typeof AnalyticsPanel>,'ref'>) {
  const saved=usePref('moneySort'),locale=useLocale();
  const active=useMemo(()=>visibleMoneySort(saved,columns.map(column=>column.id)),[saved,columns]);
  const current=useRef({rows,entries,active,history,locale});current.current={rows,entries,active,history,locale};
  const [watch]=useState(()=>clock.watch()),cached=useRef<AnalyticsRow<MoneyColumn>[]>([]);
  const evaluate=useCallback(()=>{
    const {rows,entries,active,history,locale}=current.current,now=hubNow();
    const orderAt=(at:number)=>{
      if(!active||!history)return rows;
      const range=history.live?boardPeriod.rangeAt('budget',at,history.range):null;
      const values=entries.map((series,i)=>({key:rows[i].key,name:rows[i].name,values:moneyTableValues(history.live?boardPeriod.moneyAt(series,at,history.range):series,range?.from??history.since,range?.to??history.to,boardPeriod.moneyWorkAt(series.sourceId,at,history.range))})).sort(moneyComparator(active,locale));
      const byKey=new Map(rows.map(row=>[row.key,row]));return values.map(value=>byKey.get(value.key)!);
    };
    const ordered=orderAt(now);
    clock.due(watch,history?.live&&active&&active.column!=='name'?boardPeriod.moneyOrderAt(now,history.range,active.column==='active'?at=>JSON.stringify(orderAt(at).map(row=>row.key)):undefined):null,now);
    if(ordered.length!==cached.current.length||ordered.some((row,i)=>row!==cached.current[i]))cached.current=ordered;
    return cached.current;
  },[watch]);
  const subscribe=useCallback((listener:()=>void)=>clock.subscribe(watch,listener),[watch]);
  const ordered=useSyncExternalStore(subscribe,evaluate,evaluate);
  useLayoutEffect(()=>{evaluate();});
  const onSort=useCallback((column:MoneyColumn|'name'|null,cycle?:boolean)=>setPrefs({moneySort:nextMoneySort(active,column,cycle)}),[active]);
  const sorting={active,onSort,headers:[{id:'name' as const,title:t('money.key')},...columns],label:t('table.sort'),defaultLabel:t('table.defaultOrder')};
  const widget=useTableWidget(panel,columns.map(column=>column.width),240,ordered.map(row=>row.key),JSON.stringify([history?.range,unit,active]));
  return <AnalyticsPanel {...panelProps} ref={panel} history={history} controls={<>{controls}{widget.layout==='list'&&<TableSortMenu {...sorting}/>}</>}>
    <TableSurface table={widget}>{children}<AnalyticsTable columns={columns} rows={ordered.slice(widget.from,widget.to)} name={t('money.key')} lead="value" sorting={sorting} layout={widget.layout} body={widget.live}/>
      </TableSurface><WidgetPages table={widget} count={ordered.length}/>
      <TableMeasure table={widget}><AnalyticsTable columns={columns} rows={ordered.slice(widget.measureFrom,widget.measureTo)} name={t('money.key')} lead="value" sorting={sorting} layout={widget.layout} body={widget.measured} still/></TableMeasure>
  </AnalyticsPanel>;
});

const pointAt=(series:MeterHistory,at:number,cell=60000)=>series.pointMode==='observation'?moneyPointAt(series,at):meterPointIn(series,at,cell);

/** Rolling totals still update; identical displayed amounts need no new formatting. */
const MoneyLegendAmount=memo(function MoneyLegendAmount({value,unit,context}:{value:string|null|undefined;unit:string;context:import('../../server/domain/currency').CurrencyContext}) {
  useLocale();
  return money(value,unit,false,context);
});

export function MoneyHistory({arrange,family='budget'}:{arrange:Arrange;family?:MoneyFamily}) {
  const details=useSelectionNotice(family);
  const widget=family==='funds'?SUBSCRIPTION_FUNDS:BUDGET_HISTORY;
  const context=useCurrencyContext(),board=useBoardId(),locale=useLocale(),{history,drawing,loading,error,presentation:authority}=useBudgetFinancialHistory(family,true),sources=useNamed(arrange.view.names,family);
  const range=usePref('range'),horizon=usePref('horizon'),moneyPrefs=usePref(family==='funds'?'funds':'money');
  const prefs=useMemo(()=>({range,horizon,money:moneyPrefs,funds:moneyPrefs}),[range,horizon,moneyPrefs]);
  const funds=family==='funds',settings=moneyPrefs,reader=funds?fundsHistory:budgetHistory;
  const strip=useBudgetHistoryPlot(family),panning=usePanning();
  const selected=useTimeRange(),start=useHistoryBegins(),panel=useRef<HTMLElement>(null),{plot,onBase}=usePlot(panel);

  const now=useClock(now=>frameChangesAt(selected,history?.cellMs??60_000,now));
  const frame=frameOf(selected,{range:prefs.range,horizon:prefs.horizon},now,start),measured=measuredTo(frame,history,selected,prefs.range);
  const unit=settings.unit===DEFAULT_CURRENCY?context.target.id:settings.unit??DEFAULT_CURRENCY,symbol=currencySymbol(unit,context);
  const selection=moneySelection(sources,arrange.view.hidden,settings,context,family).selection;
  const selectionKey=JSON.stringify(selection?.ids??[]);
  const original=useMemo(()=>history?.meterSeries?.filter(s=>s.unit===unit&&moneyBalanceSeries(s)&&selection?.ids.some(([source,meter])=>source===s.sourceId&&meter===s.meterId))??[],[history?.meterSeries,unit,selectionKey]);
  // Rolling accounting can replace series without changing the legend's facts.
  const legendValues=JSON.stringify(original.map(s=>[
    s.sourceId,s.meterId,s.kind,s.unit,s.end,s.role,s.semantics?.label,s.semantics?.scope,
    s.semantics?.conversion?.original.unit,s.semantics?.conversion?.rate.source,
  ]));
  const focus=useSeriesFocus(panel,JSON.stringify([board,family]),{kind:family,unit:settings.unit??DEFAULT_CURRENCY},JSON.stringify([authority,history?.range,unit]));
  const amounts=useRef(new Map<string,{value:string|null;unit:string;context:typeof context;locale:typeof locale;text:string}>());
  const descriptions=useMemo(()=>{
    const next:typeof amounts.current=new Map();
    const entries=original.map(s=>{
      const key=moneyIdentity(s),card=sources.find(c=>c.id===s.sourceId),detail=moneySeriesDetail(s,context),old=amounts.current.get(key);
      const amount=old&&old.value===s.end&&old.unit===s.unit&&old.context===context&&old.locale===locale?old:{value:s.end,unit:s.unit,context,locale,text:money(s.end,s.unit,true,context)};
      next.set(key,amount);
      return {key,name:nameOf(s,card?.title??s.sourceId,context,family),detail:[amount.text,detail].filter(Boolean).join('\n')};
    });
    amounts.current=next;return entries;
  },[legendValues,sources,context,family,settings,widget,locale,authority,board]);
  const noSelection=!(selection?.ids.length);
  const noResources=!sources.some(source=>supportsBudget(providerOf(source.provider)));
  const modelContext=JSON.stringify([authority,family,board,history?.board,unit,selection?.ids]);
  const baseNavigation=axisNavigation(board,selected,prefs),navigation={...baseNavigation,context:JSON.stringify([baseNavigation.context,unit,authority])};
  type Domain={low:bigint;high:bigint};
  const pose=useRef<{context:string;range:string;domain:Domain|null;held:Domain|null;axes:WeakMap<ValueAxis,Domain|null>}|null>(null);
  const poseContext=JSON.stringify([modelContext,navigation.context]);
  if(pose.current?.context!==poseContext)pose.current={context:poseContext,range:navigation.range,domain:null,held:null,axes:new WeakMap()};
  const previous=pose.current;
  if(previous.range!==navigation.range)previous.held=null;
  previous.range=navigation.range;
  const held=previous.held;
  const incomingCellMs=strip?.cell??drawing?.cellMs??history?.cellMs??60_000;
  const prepared=usePrepared(function* () {
    const entries:MeterHistory[]=[],visible:MeterHistory[]=[];
    let low:bigint|null=null,high:bigint|null=null;
    const plotted=strip?.meterChunks?yield* composeMetersPrepared(strip.meterChunks,strip.cell,strip.from,strip.to,strip.meterFrame):drawing?.meterSeries?.filter(s=>s.unit===unit)??[];
    for(const source of plotted) {
      if(source.unit!==unit||!moneyBalanceSeries(source)||!selection?.ids.some(([id,meter])=>id===source.sourceId&&meter===source.meterId))continue;
      const entry=source;
      entries.push(entry);
      visible.push(entry);
      for(const point of entry.points){const value=BigInt(point.value);if(low===null||value<low)low=value;if(high===null||value>high)high=value;yield;}
    }
    // Exact composition must preserve the value pose painted at release. New
    // evidence can expand it; an explicit range or display context releases it.
    if(held){low=low===null||held.low<low?held.low:low;high=high===null||held.high>high?held.high:high;}
    const origin=low??0n,span=(high??origin)-origin||1_000_000n,pad=span/10n||1n,lines:Line[]=[];
    for(const series of visible) {
      const card=sources.find(c=>c.id===series.sourceId),scaled=(value:string)=>Number(BigInt(value)-origin)/1_000_000;
      const points:Line['points']=[];
      for(const point of series.points){points.push([point.at,scaled(point.value),point.segment,point.validUntil]);yield;}
      lines.push({sourceId:series.sourceId,windowId:series.meterId,key:moneyIdentity(series),name:nameOf(series,card?.title??series.sourceId,context,family),provider:card?.provider??'',kind:'other',label:series.semantics?.label??null,minutes:null,color:colorOf(arrange.view,series.sourceId,card?.provider??''),dash:series.kind==='cap'?'7 5':'',current:scaled(series.end??'0'),consumed:0,coveredMs:series.coveredMs,remainingAtStart:series.start===null?null:scaled(series.start),remainingAtEnd:series.end===null?null:scaled(series.end),pointMode:series.pointMode,staleAfterMs:86_400_000,points,work:null,...(series.kind==='cap'?{capCells:series.points.flatMap(p=>p.knownFrom!==undefined&&p.knownUntil!==undefined?[{at:p.at,from:p.knownFrom,to:p.knownUntil,value:scaled(p.value)}]:[])}:{})});yield;
    }
    return {entries,lines,origin,span,pad,strip,cellMs:incomingCellMs,domain:low===null||high===null?null:{low,high}};
  },[drawing,strip,unit,sources,arrange.view,locale,context,held,incomingCellMs],modelContext);
  const model=prepared.value,entries=model?.entries??[],lines=model?.lines??[],cellMs=model?.cellMs??incomingCellMs;
  const axis=useMemo(()=>{
    const origin=model?.origin??0n,span=model?.span??1_000_000n,pad=model?.pad??1n;
    const min=-Number(pad)/1_000_000,max=Number(span+pad)/1_000_000;
    return {min,max,ticks:Array.from({length:5},(_,i)=>min+(max-min)*i/4),label:t('money.balance')+' ('+symbol+')',
      rawValue:(key:string,at:number)=>{const series=entries.find(s=>moneyIdentity(s)===key);return series&&pointAt(series,at,cellMs)?.value;},
      observation:(key:string,at:number)=>{
        const series=entries.find(s=>moneyIdentity(s)===key),point=series&&pointAt(series,at,cellMs);
        const observed=series?.pointMode==='observation'?point?.semantics?.conversion?.original.at:undefined;
        return Number.isSafeInteger(observed)&&point?{at:observed!,value:point.value}:undefined;
      },
      formatTick:(value:number)=>money((origin+BigInt(Math.round(value*1_000_000))).toString(),unit,false,context).slice(0,-symbol.length-1),
      formatValue:(key:string,_value:number,at:number)=>{const series=entries.find(s=>moneyIdentity(s)===key);return money(series&&pointAt(series,at,cellMs)?.value,unit,true,context);},
      detail:(key:string,at:number)=>{
        const series=entries.find(s=>moneyIdentity(s)===key),point=series&&pointAt(series,at,cellMs);
        return <>{point?.semantics?.limit!==null&&point?.semantics?.limit!==undefined&&<div>{t('money.limitTotal')}: {money(point.semantics.limit,unit,true,context)}{point.semantics.resetAt!==null&&<div>{stamp(point.semantics.resetAt)}</div>}</div>}{point?.steps.map(step=><div key={step.from+':'+step.to}>{t('money.unlocated')}: {money(step.amount,unit,true,context)}<div>{stamp(step.from)} — {stamp(step.to)}</div></div>)}</>;
      }};
  },[model,unit,locale,context,cellMs]);
  previous.axes.set(axis,model?.domain??null);
  const onDrawing=useMemo(()=>(valueAxis:ValueAxis|undefined)=>{
    if(pose.current===previous)previous.domain=valueAxis?previous.axes.get(valueAxis)??null:null;
  },[previous]);
  useLayoutEffect(()=>pan.onStop(stop=>{
    if(pose.current!==previous||!stop.changed)return;
    // A stop owns the painted domain even if React skipped its active phase.
    previous.range=stop.range?timeRangeKey(stop.range):'live';
    previous.held=stop.range?previous.domain:null;
  }),[previous]);
  const legend=useMemo(()=><div className="legend">{original.map(s=>{const key=moneyIdentity(s),card=sources.find(c=>c.id===s.sourceId);return <SeriesLegendItem key={key} seriesKey={key} name={nameOf(s,card?.title??s.sourceId,context,family)} description={descriptions.find(entry=>entry.key===key)?.detail} color={colorOf(arrange.view,s.sourceId,card?.provider??'')} dash={s.kind==='cap'?'7 5':undefined}><b><MoneyLegendAmount value={s.end} unit={s.unit} context={context}/></b></SeriesLegendItem>;})}</div>,[legendValues,sources,context,family,arrange.view,settings,widget,locale,authority,board,descriptions]);
  const answered=history?.range===(selected?timeRangeKey(selected):prefs.range);
  const emptySelection=noResources||noSelection,settledEmpty=emptySelection&&!loading&&!error;
  return <AnalyticsPanel ref={panel} className={funds?'subscription-funds':'budget-history'} title={t(funds?'widgets.subscriptionFunds':'widgets.budgetHistory')} chart history={settledEmpty?null:history} loading={loading} error={error} retry={reader.retry} details={details}
    settings={<MoneyChartSettings arrange={arrange} widget={widget} family={family} sources={sources} series={history?.meterSeries??[]}/>}>

    <SeriesDetails focus={focus} entries={descriptions} panel={panel}/>
    <Chart lines={lines} axis={axis} onDrawing={onDrawing} stepped from={frame.from} now={strip?now:measured} to={frame.to} cellMs={cellMs} strip={model?.strip??null} prepared={prepared.ready&&(panning!==null||answered||!!error||settledEmpty)} empty={error?null:noResources?t(funds?'analytics.noFunds':'analytics.noBudget'):noSelection?t('analytics.noSelection'):!history?null:t('money.unknown')} plot={plot} onBase={onBase} onSelect={setTimeRange} navigation={navigation} live={frame.live} clock={now} modelContext={modelContext}/>
    {legend}
  </AnalyticsPanel>;
}
export function MoneyTable({arrange}:{arrange:Arrange}) {
  const details=useSelectionNotice();
  const widget=BUDGET_TABLE;
  const context=useCurrencyContext(),locale=useLocale();const {history,loading,error}=useBudgetHistory(),sources=useNamed(arrange.view.names,'budget'),settings=usePref('money');
  const unit=settings.unit===DEFAULT_CURRENCY?context.target.id:settings.unit??DEFAULT_CURRENCY;
  const entries=history?.meterSeries?.filter(s=>s.unit===unit&&moneyBalanceSeries(s))??[];
  const selection=moneySelection(sources,arrange.view.hidden,settings,context).selection;
  const empty=!sources.some(source=>supportsBudget(providerOf(source.provider)))?'analytics.noBudget':!selection?.ids.length?'analytics.noSelection':'money.unknown';
  const definitions = MONEY_COLUMNS.map(({id, label, width}) => ({id, title: t(label), width, align: 'right' as const}));
  const columns = definitions.filter(column => columnShown(arrange.view, widget, column.id));
  const panel=useRef<HTMLElement>(null);
  const cellAt=(original:MeterHistory,id:MoneyColumn,now:number):{content:string;title?:string;details?:string;partial?:boolean;activeMs?:number}=>{
    const s=history?.live?boardPeriod.moneyAt(original,now,history.range):original;
    const range=history?.live?boardPeriod.rangeAt('budget',now,history.range):null;
    const work=boardPeriod.moneyWorkAt(s.sourceId,now,history?.range);
    const values=moneyTableValues(s,range?.from??history!.since,range?.to??history!.to,work);
    if(id==='active'||id==='rate'||id==='remaining') {
      if(s.kind!=='balance'||s.role&&s.role!=='total')return {content:'—',title:t('money.sourceWorkOnly')};
      const eligible=moneyWorkValues(s,work);
      if(id==='active'){
        const from=work?.selectedWork?.from??work?.knownFrom;
        const title=eligible.active===null?t('agents.activityUnknown'):from!==undefined&&from!==null&&from>(range?.from??history!.since)?t('work.since',{time:stamp(from)}):undefined;
        return {content:activeHours(eligible.active),title,activeMs:work?.selectedWork?.activeMs??undefined};
      }
      const proof=work?[t('money.workEstimate'),t('filters.sourceWide'),t('money.workBasis',{active:activeHours(String(work.eligibleActiveMs))}),work.partial?t('money.partial'):null].filter(Boolean).join('\n'):t('money.noWorkRate');
      if(id==='remaining')return {content:activeHours(eligible.remaining),title:proof};
      const title=eligible.rate===null?t('money.workInsufficient')+'\n'+proof:proof;
      return {content:money(eligible.rate,s.unit,false,context),title,details:[money(eligible.rate,s.unit,true,context),title].join('\n')};
    }
    if(id==='value')return {title:money(values.value,s.unit,true,context),details:money(values.value,s.unit,true,context),content:money(values.value,s.unit,false,context)};
    if(s.topup===null)return {title:t('money.noSpending'),content:t('money.unavailable')};
    if(s.kind!=='balance')return {content:'—'};
    const total=moneyTotal(s,range?.from??history!.since,range?.to??history!.to,true),steps=s.topupUnlocated;
    const title=[total.unknown?t('money.unknown'):total.partial?t('money.partial'):'',...steps.map(p=>`${money(p.amount,s.unit,true,context)}\n${stamp(p.from)} — ${stamp(p.to)}`)].filter(Boolean).join('\n');
    return {title,details:[money(values[id],s.unit,true,context),title].filter(Boolean).join('\n'),content:money(values[id],s.unit,false,context),partial:total.partial};
  };
  const cellOf=(s:MeterHistory,id:MoneyColumn):Cell|TimedCell=>{
    const detailAt=(now:number)=>cellAt(s,id,now).details??'';
    const details=history?.live?{at:detailAt,changesAt:(now:number)=>boardPeriod.cellChangesAt('budget',now,detailAt,undefined,s.sourceId,history.range)}:undefined;
    const at=(now:number):Cell=>{const {partial,content,activeMs,...cell}=cellAt(s,id,now);return {...cell,...(cell.details===undefined?{}:{details:details??cell.details}),content:<><span {...(activeMs===undefined?{}:{'data-work-source':s.sourceId,'data-active-ms':activeMs})}>{content}</span>{partial&&<small className="money-partial">*</small>}</>};};
    const textAt=(now:number)=>{const {activeMs:_,details:_detail,...visible}=cellAt(s,id,now);return JSON.stringify(visible);};
    return history?.live?{time:'money-'+id,changesAt:now=>boardPeriod.cellChangesAt('budget',now,textAt,undefined,s.sourceId,history.range),at}:at(hubNow());
  };
  // Retained rows stay mounted through pan-only panel updates; their cells own
  // the clock and replan only when the table's data or display settings change.
  const rows=useMemo(()=>entries.map(series=>{
      const source=sources.find(card=>card.id===series.sourceId);
      return {key:moneyIdentity(series),name:nameOf(series,source?.title??series.sourceId,context),hint:moneySeriesDetail(series,context),
        color:colorOf(arrange.view,series.sourceId,source?.provider??''),
        cells:{value:cellOf(series,'value'),topup:cellOf(series,'topup'),active:cellOf(series,'active'),rate:cellOf(series,'rate'),remaining:cellOf(series,'remaining')}};
    }),[history,unit,sources,context,arrange.view,locale]);
  return <SortedMoney rows={rows} entries={entries} columns={columns} panel={panel} unit={unit} className="budget-table" title={t('widgets.budgetTable')} history={history} loading={loading} error={error} retry={budgetHistory.retry} details={details}
    settings={<TableSettings arrange={arrange} widget={widget} columns={definitions} visible={columns.map(column=>column.id)}></TableSettings>}
  >
    {history&&!entries.length&&!error?<p className="panel-empty">{t(empty)}</p>:null}
  </SortedMoney>;
}
