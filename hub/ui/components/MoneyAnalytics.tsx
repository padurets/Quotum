import {AnalyticsPanel, AnalyticsNote, SeriesLegendItem} from './AnalyticsPanel';
import {AnalyticsTable, TableSettings, type Cell} from './AnalyticsTable';
import {providerOf,supportsBudget} from '../../server/domain/providers';
import {useMemo,useRef} from 'react';
import {DEFAULT_CURRENCY,currencySymbol} from '../../server/domain/currency';
import {useBoardId,useNamed,useServerView,useCurrencyContext} from '../lib/board';
import {useBudgetHistory,useHistoryBegins,useBudgetHistoryPlot,budgetHistory} from '../lib/history';
import {usePrefs,setPrefs,setMuted} from '../lib/prefs';
import {moneySelection} from '../lib/moneySelection';
import {money,capName} from '../lib/money';
import {moneyIdentity,moneyPointAt,meterPointIn,moneyTotal,type MeterHistory} from '../lib/moneyView';
import {colorOf,columnShown,withHidden,BUDGET_HISTORY,BUDGET_TABLE,type Arrange} from '../lib/view';
import {frameOf,frameChangesAt,measuredTo} from '../lib/periods';
import {useTimeRange,setTimeRange,timeRangeKey} from '../lib/timeRange';
import {useClock} from '../lib/clock';
import {stamp} from '../lib/format';
import type {Line} from '../lib/lines';
import {t,useLocale} from '../i18n';
import {Chart} from './Chart';
import {usePlot} from './sizing';
import {Popover,SlidersIcon,HideRow} from './Popover';
import {Segmented} from './Kit';
import {MoneySettings} from './MoneySettings';
import {axisNavigation} from '../lib/axisNavigation';
import {usePrepared} from './prepared';
import {usePanning} from '../lib/pan';
import {composeMetersPrepared} from '../../server/domain/meterHistory';

function nameOf(series:MeterHistory,title:string,context:import('../../server/domain/currency').CurrencyContext) {
  if(series.role)return [title,t(`money.${series.role}`),series.semantics?.conversion?`≈ ${series.semantics.conversion.original.unit} → ${currencySymbol(series.unit,context)} (${series.semantics.conversion.rate.source==='manual'?t('money.personalRate'):series.semantics.conversion.rate.source.toUpperCase()})`:series.semantics?.label].filter(Boolean).join(' — ');
  const detail=series.meterId==='balance'?'':series.kind==='cap'?capName({id:series.meterId,scope:series.semantics?.scope??null,label:series.semantics?.label??null}):series.semantics?.label??series.meterId;
  return [title,detail,series.kind==='cap'?t('money.cap'):series.meterId==='balance'?'':t('money.usage')].filter(Boolean).join(' — ');
}
function SelectionNotice() {
  const sources=useNamed(undefined,'budget'),view=useServerView(),prefs=usePrefs(),context=useCurrencyContext();
  const result=moneySelection(sources,view?.hidden??[],prefs.money,context);
  const removed=result.removed||(prefs.money.removed??0);
  return <>{result.omitted>0&&<AnalyticsNote>{t('money.limit',{count:result.omitted})}</AnalyticsNote>}{removed>0&&<AnalyticsNote>{t('money.removed',{count:removed})}</AnalyticsNote>}</>;
}
const MONEY_COLUMNS = [
  {id: 'value', label: 'money.value', width: 140},
  {id: 'spending', label: 'money.spending', width: 140},
  {id: 'topup', label: 'money.topup', width: 140},
] as const;
type MoneyColumn = typeof MONEY_COLUMNS[number]['id'];

const pointAt=(series:MeterHistory,at:number,cell=60000)=>series.pointMode==='observation'?moneyPointAt(series,at):meterPointIn(series,at,cell);

export function MoneyHistory({arrange}:{arrange:Arrange}) {
  const context=useCurrencyContext(),board=useBoardId(),locale=useLocale(),{history,loading,error}=useBudgetHistory(),prefs=usePrefs(),sources=useNamed(arrange.view.names,'budget');
  const strip=useBudgetHistoryPlot(),panning=usePanning();
  const selected=useTimeRange(),start=useHistoryBegins(),panel=useRef<HTMLElement>(null),{plot,onBase}=usePlot(panel);
  const now=useClock(now=>frameChangesAt(selected,history?.cellMs??60_000,now));
  const frame=frameOf(selected,{range:prefs.range,horizon:prefs.horizon},now,start),measured=measuredTo(frame,history,selected,prefs.range);
  const unit=prefs.money.unit===DEFAULT_CURRENCY?context.target.id:prefs.money.unit??DEFAULT_CURRENCY,symbol=currencySymbol(unit,context);
  const original=history?.meterSeries?.filter(s=>s.unit===unit)??[];
  const selection=moneySelection(sources,arrange.view.hidden,prefs.money,context).selection;
  const noSelection=!(selection?.ids.length);
  const noResources=!sources.some(source=>supportsBudget(providerOf(source.provider))&&!arrange.view.hidden.includes('source:'+source.id));
  const modelContext=JSON.stringify([board,history?.board,unit,selection?.ids]);
  const prepared=usePrepared(function* () {
    const entries:MeterHistory[]=[],visible:MeterHistory[]=[];
    let low:bigint|null=null,high:bigint|null=null;
    const plotted=strip?.meterChunks?yield* composeMetersPrepared(strip.meterChunks,strip.cell,strip.from,strip.to,strip.meterFrame):original;
    for(const source of plotted) {
      if(source.unit!==unit)continue;
      let entry=source;
      if(prefs.money.view==='spending'&&source.spent===null)continue;
      if(prefs.money.view==='spending'&&source.kind!=='cap') {
        let cumulative=0n;const points:MeterHistory['points']=[];
        for(const point of source.points){cumulative+=BigInt(point.spent!);points.push({...point,value:cumulative.toString()});yield;}
        entry={...source,start:'0',end:source.spent,points};
      }
      entries.push(entry);
      if(prefs.muted[moneyIdentity(entry)])continue;
      visible.push(entry);
      for(const point of entry.points){const value=BigInt(point.value);if(low===null||value<low)low=value;if(high===null||value>high)high=value;yield;}
    }
    const origin=low??0n,span=(high??origin)-origin||1_000_000n,pad=span/10n||1n,lines:Line[]=[];
    for(const series of visible) {
      const card=sources.find(c=>c.id===series.sourceId),scaled=(value:string)=>Number(BigInt(value)-origin)/1_000_000;
      const points:Line['points']=[];
      for(const point of series.points){points.push([point.at,scaled(point.value),point.segment,point.validUntil]);yield;}
      lines.push({sourceId:series.sourceId,windowId:series.meterId,key:moneyIdentity(series),name:nameOf(series,card?.title??series.sourceId,context),provider:card?.provider??'',kind:'other',label:series.semantics?.label??null,minutes:null,color:colorOf(arrange.view,series.sourceId,card?.provider??''),dash:series.kind==='cap'?'7 5':'',current:scaled(series.end??'0'),consumed:0,coveredMs:series.coveredMs,remainingAtStart:series.start===null?null:scaled(series.start),remainingAtEnd:series.end===null?null:scaled(series.end),pointMode:series.pointMode,staleAfterMs:86_400_000,points,work:null,...(series.kind==='cap'?{capCells:series.points.flatMap(p=>p.knownFrom!==undefined&&p.knownUntil!==undefined?[{at:p.at,from:p.knownFrom,to:p.knownUntil,value:scaled(p.value)}]:[])}:{})});yield;
    }
    return {entries,lines,origin,span,pad,strip};
  },[history,strip,prefs.muted,unit,prefs.money.view,sources,arrange.view,locale,context],modelContext);
  const model=prepared.value,entries=model?.entries??[],lines=model?.lines??[];
  const baseNavigation=axisNavigation(board,selected,prefs),navigation={...baseNavigation,context:JSON.stringify([baseNavigation.context,unit,prefs.money.view])};
  const axis=useMemo(()=>{
    const origin=model?.origin??0n,span=model?.span??1_000_000n,pad=model?.pad??1n;
    const min=-Number(pad)/1_000_000,max=Number(span+pad)/1_000_000;
    return {min,max,ticks:Array.from({length:5},(_,i)=>min+(max-min)*i/4),label:t('money.value')+' ('+symbol+')',
      rawValue:(key:string,at:number)=>{const series=entries.find(s=>moneyIdentity(s)===key);return series&&pointAt(series,at,strip?.cell??history?.cellMs??60000)?.value;},
      formatTick:(value:number)=>money((origin+BigInt(Math.round(value*1_000_000))).toString(),unit,false,context).slice(0,-symbol.length-1),
      formatValue:(key:string,_value:number,at:number)=>{const series=entries.find(s=>moneyIdentity(s)===key);return money(series&&pointAt(series,at,strip?.cell??history?.cellMs??60000)?.value,unit,true,context);},
      detail:(key:string,at:number)=>{
        const series=entries.find(s=>moneyIdentity(s)===key),point=series&&pointAt(series,at,strip?.cell??history?.cellMs??60000);
        return <>{point?.semantics?.limit!==null&&point?.semantics?.limit!==undefined&&<div>{t('money.limitTotal')}: {money(point.semantics.limit,unit,true,context)}{point.semantics.resetAt!==null&&<div>{stamp(point.semantics.resetAt)}</div>}</div>}{point?.steps.map(step=><div key={step.from+':'+step.to}>{t('money.unlocated')}: {money(step.amount,unit,true,context)}<div>{stamp(step.from)} — {stamp(step.to)}</div></div>)}</>;
      }};
  },[model,unit,locale,context,strip?.cell,history?.cellMs]);
  const answered=history?.range===(selected?timeRangeKey(selected):prefs.range);
  return <AnalyticsPanel ref={panel} className="budget-history" title={t('widgets.budgetHistory')} chart history={history} loading={loading} error={error} retry={budgetHistory.retry}
    settings={<Popover label={t('history.settings')} icon={<SlidersIcon/>}>
      <div className="popover-pad"><Segmented value={prefs.money.view} onChange={view=>setPrefs({money:{...prefs.money,view}})} options={[["balance",t('money.balance')],["spending",t('money.spending')]]} label={t('money.value')}/></div>
      <MoneySettings sources={sources} hidden={arrange.view.hidden} series={original}/>
      {arrange.owner&&<HideRow onHide={()=>arrange.update(v=>withHidden(v,BUDGET_HISTORY,true))}>{t('widget.hide')}</HideRow>}
    </Popover>}>
    <SelectionNotice/>
    {prefs.money.view==='spending'&&original.some(s=>s.spent===null)&&<AnalyticsNote title={t('money.noSpending')}>{t('money.unsupportedSpending',{count:new Set(original.filter(s=>s.spent===null).map(s=>s.sourceId)).size})}</AnalyticsNote>}
    <Chart lines={lines} axis={axis} stepped from={frame.from} now={strip?now:measured} to={frame.to} cellMs={strip?.cell??history?.cellMs??60_000} strip={model?.strip??null} prepared={prepared.ready&&(panning!==null||answered||!!error)} empty={error?null:!history?t('history.loading'):noResources?t('analytics.noBudget'):noSelection?t('analytics.noSelection'):entries.length&&!lines.length?t('analytics.allMuted'):prefs.money.view==='spending'&&original.some(s=>s.spent===null)?t('money.noSpending'):t('money.unknown')} plot={plot} onBase={onBase} onSelect={setTimeRange} navigation={navigation} live={frame.live} clock={now} modelContext={modelContext}/>
    <div className="legend">{original.map(s=>{const key=moneyIdentity(s),card=sources.find(c=>c.id===s.sourceId),total=prefs.money.view==='spending'&&s.kind!=='cap'&&history?moneyTotal(s,history.since,history.to):null,value=total?total.amount:s.end;return <SeriesLegendItem key={key} name={nameOf(s,card?.title??s.sourceId,context)} color={colorOf(arrange.view,s.sourceId,card?.provider??'')} dash={s.kind==='cap'?'7 5':undefined} muted={!!prefs.muted[key]} onToggle={()=>setMuted(key,!prefs.muted[key])}><b title={total?.unknown?t('money.unknown'):total?.partial?t('money.partial'):undefined}>{s.spent===null&&prefs.money.view==='spending'?t('money.unavailable'):money(value,s.unit,false,context)}{total?.partial&&s.spent!==null&&<small className="money-partial">*</small>}</b></SeriesLegendItem>;})}</div>
  </AnalyticsPanel>;
}
export function MoneyTable({arrange}:{arrange:Arrange}) {
  const context=useCurrencyContext();useLocale();const {history,loading,error}=useBudgetHistory(),sources=useNamed(arrange.view.names,'budget'),prefs=usePrefs();
  const unit=prefs.money.unit===DEFAULT_CURRENCY?context.target.id:prefs.money.unit??DEFAULT_CURRENCY;
  const entries=history?.meterSeries?.filter(s=>s.unit===unit)??[];
  const selection=moneySelection(sources,arrange.view.hidden,prefs.money,context).selection;
  const empty=!sources.some(source=>supportsBudget(providerOf(source.provider))&&!arrange.view.hidden.includes('source:'+source.id))?'analytics.noBudget':!selection?.ids.length?'analytics.noSelection':'money.unknown';
  const definitions = MONEY_COLUMNS.map(({id, label, width}) => ({id, title: t(label), width, align: 'right' as const}));
  const columns = definitions.filter(column => columnShown(arrange.view, BUDGET_TABLE, column.id));
  const panel=useRef<HTMLElement>(null);
  const cellOf=(s:MeterHistory,id:MoneyColumn):Cell=>{
    if(id==='value')return {title:money(s.end,s.unit,true,context),content:money(s.end,s.unit,false,context)};
    if(id==='spending'&&s.spent===null||id==='topup'&&s.topup===null)return {title:t('money.noSpending'),content:t('money.unavailable')};
    if(id==='spending'&&s.kind==='cap'||id==='topup'&&s.kind!=='balance')return {content:'—'};
    const topup=id==='topup',total=moneyTotal(s,history!.since,history!.to,topup),steps=topup?s.topupUnlocated:s.unlocated;
    const title=[total.unknown?t('money.unknown'):total.partial?t('money.partial'):'',...steps.map(p=>`${money(p.amount,s.unit,true,context)}\n${stamp(p.from)} — ${stamp(p.to)}`)].filter(Boolean).join('\n');
    return {title,content:<>{money(total.amount,s.unit,false,context)}{total.partial&&<small className="money-partial">*</small>}</>};
  };
  return <AnalyticsPanel ref={panel} className="budget-table" title={t('widgets.budgetTable')} history={history} loading={loading} error={error} retry={budgetHistory.retry}
    settings={<TableSettings arrange={arrange} widget={BUDGET_TABLE} columns={definitions} visible={columns.map(column=>column.id)}/>}
  >
    <SelectionNotice/>
    {!history&&!error?<p className="panel-loading">{t('history.loading')}</p>:!entries.length&&!error?<p className="panel-empty">{t(empty)}</p>:null}
    {entries.length>0&&<AnalyticsTable columns={columns}
      rows={entries.map(series => {
        const source = sources.find(card => card.id === series.sourceId);
        return {key: moneyIdentity(series), name: nameOf(series, source?.title ?? series.sourceId, context),
          color: colorOf(arrange.view, series.sourceId, source?.provider ?? ''),
          cells: {value: cellOf(series, 'value'), spending: cellOf(series, 'spending'), topup: cellOf(series, 'topup')}};
      })}
      name={t('money.key')} nameWidth={240} lead="value"/>}
  </AnalyticsPanel>;
}
