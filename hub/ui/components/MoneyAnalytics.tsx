import {AnalyticsPanel, AnalyticsNote, SeriesLegendItem} from './AnalyticsPanel';
import {AnalyticsTable, TableSettings, type AnalyticsRow, type AnalyticsColumn, type Cell, type TimedCell} from './AnalyticsTable';
import {providerOf,supportsBudget,type MoneyFamily} from '../../server/domain/providers';
import {memo,useCallback,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type ComponentProps,type RefObject} from 'react';
import {DEFAULT_CURRENCY,currencySymbol} from '../../server/domain/currency';
import {useBoardId,useNamed,useServerView,useCurrencyContext} from '../lib/board';
import {useBudgetFinancialHistory,useBudgetHistory,useHistoryBegins,useBudgetHistoryPlot,budgetHistory,fundsHistory} from '../lib/history';
import {usePref,setPrefs,setMuted,useChartMuted,chartSeriesMuted,chartMuteKey} from '../lib/prefs';
import {moneySelection,fundsLegacyMuted} from '../lib/moneySelection';
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
import {Chart} from './Chart';
import {usePlot} from './sizing';
import {MoneyChartSettings,MoneySettings} from './MoneySettings';
import {axisNavigation} from '../lib/axisNavigation';
import {usePrepared} from './prepared';
import {usePanning} from '../lib/pan';
import {boardPeriod} from '../lib/period';
import {composeMetersPrepared} from '../../server/domain/meterHistory';
import type {History} from '../lib/types';
import {useTableWidget,WidgetPages,TableMeasure,TableSortMenu} from './TableWidget';
import {useSeriesFocus} from './seriesFocus';

function SelectionNotice({family='budget'}:{family?:MoneyFamily}) {
  const sources=useNamed(undefined,family),view=useServerView(),settings=usePref(family==='funds'?'funds':'money'),context=useCurrencyContext();
  const result=moneySelection(sources,view?.hidden??[],settings,context,family);
  const removed=result.removed||(settings.removed??0);
  return <>{result.omitted>0&&<AnalyticsNote>{t('money.limit',{count:result.omitted})}</AnalyticsNote>}{removed>0&&<AnalyticsNote>{t('money.removed',{count:removed})}</AnalyticsNote>}</>;
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
  const subscribe=useCallback((listener:()=>void)=>clock.subscribe(watch,()=>{evaluate();listener();}),[watch,evaluate]);
  const ordered=useSyncExternalStore(subscribe,evaluate,evaluate);
  useLayoutEffect(()=>{evaluate();});
  const onSort=useCallback((column:MoneyColumn|'name'|null,cycle?:boolean)=>setPrefs({moneySort:nextMoneySort(active,column,cycle)}),[active]);
  const sorting={active,onSort,headers:[{id:'name' as const,title:t('money.key')},...columns],label:t('table.sort'),defaultLabel:t('table.defaultOrder')};
  const widget=useTableWidget(panel,columns.map(column=>column.width),240,ordered.map(row=>row.key),JSON.stringify([history?.range,unit,active]));
  return <AnalyticsPanel {...panelProps} ref={panel} history={history} controls={<>{controls}{widget.layout==='list'&&<TableSortMenu {...sorting}/>}</>}>{children}
    {ordered.length>0&&<>
      <AnalyticsTable columns={columns} rows={ordered.slice(widget.from,widget.to)} name={t('money.key')} lead="value" sorting={sorting} layout={widget.layout} body={widget.live}/>
      <WidgetPages table={widget} count={ordered.length}/>
      <TableMeasure table={widget}><AnalyticsTable columns={columns} rows={ordered.slice(widget.measureFrom,widget.measureTo)} name={t('money.key')} lead="value" sorting={sorting} layout={widget.layout} body={widget.measured} still/></TableMeasure>
    </>}
  </AnalyticsPanel>;
});

const pointAt=(series:MeterHistory,at:number,cell=60000)=>series.pointMode==='observation'?moneyPointAt(series,at):meterPointIn(series,at,cell);

/** Rolling totals still update; identical displayed amounts need no new formatting. */
const MoneyLegendAmount=memo(function MoneyLegendAmount({value,unit,context}:{value:string|null|undefined;unit:string;context:import('../../server/domain/currency').CurrencyContext}) {
  useLocale();
  return money(value,unit,false,context);
});

export function MoneyHistory({arrange,family='budget'}:{arrange:Arrange;family?:MoneyFamily}) {
  const widget=family==='funds'?SUBSCRIPTION_FUNDS:BUDGET_HISTORY;
  const context=useCurrencyContext(),board=useBoardId(),locale=useLocale(),{history,drawing,loading,error,presentation:authority}=useBudgetFinancialHistory(family,true),sources=useNamed(arrange.view.names,family);
  const range=usePref('range'),horizon=usePref('horizon'),muted=useChartMuted(widget),moneyPrefs=usePref(family==='funds'?'funds':'money');
  const prefs=useMemo(()=>({range,horizon,muted,money:moneyPrefs,funds:moneyPrefs}),[range,horizon,muted,moneyPrefs]);
  const funds=family==='funds',settings=moneyPrefs,reader=funds?fundsHistory:budgetHistory;
  const isMuted=(series:MeterHistory)=>chartSeriesMuted(muted,widget,series.sourceId,series.meterId,funds&&fundsLegacyMuted(settings,series.sourceId,series.meterId));
  const strip=useBudgetHistoryPlot(family),panning=usePanning();
  const selected=useTimeRange(),start=useHistoryBegins(),panel=useRef<HTMLElement>(null),{plot,onBase}=usePlot(panel);
  useSeriesFocus(panel);
  const now=useClock(now=>frameChangesAt(selected,history?.cellMs??60_000,now));
  const frame=frameOf(selected,{range:prefs.range,horizon:prefs.horizon},now,start),measured=measuredTo(frame,history,selected,prefs.range);
  const unit=settings.unit===DEFAULT_CURRENCY?context.target.id:settings.unit??DEFAULT_CURRENCY,symbol=currencySymbol(unit,context);
  const original=useMemo(()=>history?.meterSeries?.filter(s=>s.unit===unit&&moneyBalanceSeries(s))??[],[history?.meterSeries,unit]);
  const selection=moneySelection(sources,arrange.view.hidden,settings,context,family).selection;
  const noSelection=!(selection?.ids.length);
  const noResources=!sources.some(source=>supportsBudget(providerOf(source.provider))&&!arrange.view.hidden.includes('source:'+source.id));
  const modelContext=JSON.stringify([authority,family,board,history?.board,unit,selection?.ids]);
  const prepared=usePrepared(function* () {
    const entries:MeterHistory[]=[],visible:MeterHistory[]=[];
    let low:bigint|null=null,high:bigint|null=null;
    const plotted=strip?.meterChunks?yield* composeMetersPrepared(strip.meterChunks,strip.cell,strip.from,strip.to,strip.meterFrame):drawing?.meterSeries?.filter(s=>s.unit===unit)??[];
    for(const source of plotted) {
      if(source.unit!==unit||!moneyBalanceSeries(source))continue;
      const entry=source;
      entries.push(entry);
      if(isMuted(entry))continue;
      visible.push(entry);
      for(const point of entry.points){const value=BigInt(point.value);if(low===null||value<low)low=value;if(high===null||value>high)high=value;yield;}
    }
    const origin=low??0n,span=(high??origin)-origin||1_000_000n,pad=span/10n||1n,lines:Line[]=[];
    for(const series of visible) {
      const card=sources.find(c=>c.id===series.sourceId),scaled=(value:string)=>Number(BigInt(value)-origin)/1_000_000;
      const points:Line['points']=[];
      for(const point of series.points){points.push([point.at,scaled(point.value),point.segment,point.validUntil]);yield;}
      lines.push({sourceId:series.sourceId,windowId:series.meterId,key:moneyIdentity(series),name:nameOf(series,card?.title??series.sourceId,context,family),provider:card?.provider??'',kind:'other',label:series.semantics?.label??null,minutes:null,color:colorOf(arrange.view,series.sourceId,card?.provider??''),dash:series.kind==='cap'?'7 5':'',current:scaled(series.end??'0'),consumed:0,coveredMs:series.coveredMs,remainingAtStart:series.start===null?null:scaled(series.start),remainingAtEnd:series.end===null?null:scaled(series.end),pointMode:series.pointMode,staleAfterMs:86_400_000,points,work:null,...(series.kind==='cap'?{capCells:series.points.flatMap(p=>p.knownFrom!==undefined&&p.knownUntil!==undefined?[{at:p.at,from:p.knownFrom,to:p.knownUntil,value:scaled(p.value)}]:[])}:{})});yield;
    }
    return {entries,lines,origin,span,pad,strip};
  },[drawing,strip,prefs.muted,unit,sources,arrange.view,locale,context],modelContext);
  const model=prepared.value,entries=model?.entries??[],lines=model?.lines??[];
  const baseNavigation=axisNavigation(board,selected,prefs),navigation={...baseNavigation,context:JSON.stringify([baseNavigation.context,unit])};
  const axis=useMemo(()=>{
    const origin=model?.origin??0n,span=model?.span??1_000_000n,pad=model?.pad??1n;
    const min=-Number(pad)/1_000_000,max=Number(span+pad)/1_000_000;
    return {min,max,ticks:Array.from({length:5},(_,i)=>min+(max-min)*i/4),label:t('money.balance')+' ('+symbol+')',
      rawValue:(key:string,at:number)=>{const series=entries.find(s=>moneyIdentity(s)===key);return series&&pointAt(series,at,strip?.cell??history?.cellMs??60000)?.value;},
      observation:(key:string,at:number)=>{
        const series=entries.find(s=>moneyIdentity(s)===key),point=series&&pointAt(series,at,strip?.cell??history?.cellMs??60000);
        const observed=series?.pointMode==='observation'?point?.semantics?.conversion?.original.at:undefined;
        return Number.isSafeInteger(observed)&&point?{at:observed!,value:point.value}:undefined;
      },
      formatTick:(value:number)=>money((origin+BigInt(Math.round(value*1_000_000))).toString(),unit,false,context).slice(0,-symbol.length-1),
      formatValue:(key:string,_value:number,at:number)=>{const series=entries.find(s=>moneyIdentity(s)===key);return money(series&&pointAt(series,at,strip?.cell??history?.cellMs??60000)?.value,unit,true,context);},
      detail:(key:string,at:number)=>{
        const series=entries.find(s=>moneyIdentity(s)===key),point=series&&pointAt(series,at,strip?.cell??history?.cellMs??60000);
        return <>{point?.semantics?.limit!==null&&point?.semantics?.limit!==undefined&&<div>{t('money.limitTotal')}: {money(point.semantics.limit,unit,true,context)}{point.semantics.resetAt!==null&&<div>{stamp(point.semantics.resetAt)}</div>}</div>}{point?.steps.map(step=><div key={step.from+':'+step.to}>{t('money.unlocated')}: {money(step.amount,unit,true,context)}<div>{stamp(step.from)} — {stamp(step.to)}</div></div>)}</>;
      }};
  },[model,unit,locale,context,strip?.cell,history?.cellMs]);
  const legend=useMemo(()=><div className="legend">{original.map(s=>{const key=moneyIdentity(s),card=sources.find(c=>c.id===s.sourceId);return <SeriesLegendItem key={key} seriesKey={key} name={nameOf(s,card?.title??s.sourceId,context,family)} title={moneySeriesDetail(s,context)} color={colorOf(arrange.view,s.sourceId,card?.provider??'')} dash={s.kind==='cap'?'7 5':undefined} muted={isMuted(s)} onToggle={()=>setMuted(chartMuteKey(widget,s.sourceId,s.meterId),!isMuted(s))}><b><MoneyLegendAmount value={s.end} unit={s.unit} context={context}/></b></SeriesLegendItem>;})}</div>,[original,sources,context,family,history,arrange.view,muted,settings,widget,locale,authority,board]);
  const answered=history?.range===(selected?timeRangeKey(selected):prefs.range);
  return <AnalyticsPanel ref={panel} className={funds?'subscription-funds':'budget-history'} title={t(funds?'widgets.subscriptionFunds':'widgets.budgetHistory')} chart history={history} loading={loading} error={error} retry={reader.retry}
    settings={<MoneyChartSettings arrange={arrange} widget={widget} family={family} sources={sources} series={history?.meterSeries??[]}/>}>
    <SelectionNotice family={family}/>
    <Chart lines={lines} axis={axis} stepped from={frame.from} now={strip?now:measured} to={frame.to} cellMs={strip?.cell??history?.cellMs??60_000} strip={model?.strip??null} prepared={prepared.ready&&(panning!==null||answered||!!error)} empty={error?null:!history?t('history.loading'):noResources?t(funds?'analytics.noFunds':'analytics.noBudget'):noSelection?t('analytics.noSelection'):entries.length&&!lines.length?t('analytics.allMuted'):t('money.unknown')} plot={plot} onBase={onBase} onSelect={setTimeRange} navigation={navigation} live={frame.live} clock={now} modelContext={modelContext}/>
    {legend}
  </AnalyticsPanel>;
}
export function MoneyTable({arrange}:{arrange:Arrange}) {
  const widget=BUDGET_TABLE;
  const context=useCurrencyContext(),locale=useLocale();const {history,loading,error}=useBudgetHistory(),sources=useNamed(arrange.view.names,'budget'),settings=usePref('money');
  const unit=settings.unit===DEFAULT_CURRENCY?context.target.id:settings.unit??DEFAULT_CURRENCY;
  const entries=history?.meterSeries?.filter(s=>s.unit===unit&&moneyBalanceSeries(s))??[];
  const selection=moneySelection(sources,arrange.view.hidden,settings,context).selection;
  const empty=!sources.some(source=>supportsBudget(providerOf(source.provider))&&!arrange.view.hidden.includes('source:'+source.id))?'analytics.noBudget':!selection?.ids.length?'analytics.noSelection':'money.unknown';
  const definitions = MONEY_COLUMNS.map(({id, label, width}) => ({id, title: t(label), width, align: 'right' as const}));
  const columns = definitions.filter(column => columnShown(arrange.view, widget, column.id));
  const panel=useRef<HTMLElement>(null);
  const cellAt=(original:MeterHistory,id:MoneyColumn,now:number):{content:string;title?:string;partial?:boolean;activeMs?:number}=>{
    const s=history?.live?boardPeriod.moneyAt(original,now,history.range):original;
    const range=history?.live?boardPeriod.rangeAt('budget',now,history.range):null;
    const work=boardPeriod.moneyWorkAt(s.sourceId,now,history?.range);
    const values=moneyTableValues(s,range?.from??history!.since,range?.to??history!.to,work);
    if(id==='active'||id==='rate'||id==='remaining') {
      const eligible=moneyWorkValues(s,work);
      const proof=work?[t('money.workEstimate'),t('money.workBasis',{active:activeHours(String(work.eligibleActiveMs))}),work.partial?t('money.partial'):null].filter(Boolean).join('\n'):t('money.noWorkRate');
      if(eligible.active===null)return {content:'—',title:proof};
      if(id==='active')return {content:activeHours(eligible.active),title:proof,activeMs:work!.activeMs};
      if(id==='remaining')return {content:activeHours(eligible.remaining),title:proof};
      return {content:money(eligible.rate,s.unit,false,context),title:eligible.rate===null?t('money.workInsufficient')+'\n'+proof:proof};
    }
    if(id==='value')return {title:money(values.value,s.unit,true,context),content:money(values.value,s.unit,false,context)};
    if(s.topup===null)return {title:t('money.noSpending'),content:t('money.unavailable')};
    if(s.kind!=='balance')return {content:'—'};
    const total=moneyTotal(s,range?.from??history!.since,range?.to??history!.to,true),steps=s.topupUnlocated;
    const title=[total.unknown?t('money.unknown'):total.partial?t('money.partial'):'',...steps.map(p=>`${money(p.amount,s.unit,true,context)}\n${stamp(p.from)} — ${stamp(p.to)}`)].filter(Boolean).join('\n');
    return {title,content:money(values[id],s.unit,false,context),partial:total.partial};
  };
  const cellOf=(s:MeterHistory,id:MoneyColumn):Cell|TimedCell=>{
    const at=(now:number):Cell=>{const {partial,content,activeMs,...cell}=cellAt(s,id,now);return {...cell,content:<><span {...(activeMs===undefined?{}:{'data-work-source':s.sourceId,'data-active-ms':activeMs})}>{content}</span>{partial&&<small className="money-partial">*</small>}</>};};
    const textAt=(now:number)=>{const {activeMs:_,...visible}=cellAt(s,id,now);return JSON.stringify(visible);};
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
  return <SortedMoney rows={rows} entries={entries} columns={columns} panel={panel} unit={unit} className="budget-table" title={t('widgets.budgetTable')} history={history} loading={loading} error={error} retry={budgetHistory.retry}
    settings={<TableSettings arrange={arrange} widget={widget} columns={definitions} visible={columns.map(column=>column.id)}><MoneySettings sources={sources} hidden={arrange.view.hidden} series={history?.meterSeries??[]}/></TableSettings>}
  >
    <SelectionNotice/>
    {!history&&!error?<p className="panel-loading">{t('history.loading')}</p>:!entries.length&&!error?<p className="panel-empty">{t(empty)}</p>:null}
  </SortedMoney>;
}
