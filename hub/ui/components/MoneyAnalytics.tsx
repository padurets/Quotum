import {useMemo,useRef} from 'react';
import {useBoardId,useNamed,useServerView} from '../lib/board';
import {useHistory,useHistoryBegins,useHistoryPlot} from '../lib/history';
import {usePrefs,setPrefs,setMuted} from '../lib/prefs';
import {moneySelection} from '../lib/moneySelection';
import {money} from '../lib/money';
import {moneyIdentity,moneyTotal,type MeterHistory} from '../lib/moneyView';
import {colorOf,columnShown,withColumn,withHidden,HISTORY,FORECAST,type Arrange} from '../lib/view';
import {frameOf,frameChangesAt,measuredTo} from '../lib/periods';
import {useTimeRange,setTimeRange,timeRangeKey} from '../lib/timeRange';
import {useClock} from '../lib/clock';
import {stamp} from '../lib/format';
import type {Line} from '../lib/lines';
import {t,useLocale} from '../i18n';
import {Chart} from './Chart';
import {usePlot} from './sizing';
import {Popover,SlidersIcon,HideRow,SwitchRow} from './Popover';
import {Segmented} from './Kit';
import {MoneySettings} from './MoneySettings';
import {axisNavigation} from '../lib/axisNavigation';
import {usePrepared} from './prepared';
import {usePanning} from '../lib/pan';

function nameOf(series:MeterHistory,title:string) {
  const detail=series.meterId==='balance'?'':series.semantics?.label??series.meterId;
  return [title,detail,series.kind==='cap'?t('money.cap'):series.meterId==='balance'?'':t('money.usage')].filter(Boolean).join(' — ');
}
function SelectionNotice() {
  const sources=useNamed(),view=useServerView(),prefs=usePrefs();
  const result=moneySelection(sources,view?.hidden??[],prefs.money);
  const removed=result.removed||(prefs.money.removed??0);
  return <>{result.omitted>0&&<p className="drawer-note">{t('money.limit',{count:result.omitted})}</p>}{removed>0&&<p className="drawer-note">{t('money.removed',{count:removed})}</p>}</>;
}
const pointAt=(series:MeterHistory,at:number)=>series.points.filter(p=>p.at<=at).at(-1);

export function MoneyHistory({arrange}:{arrange:Arrange}) {
  const board=useBoardId(),locale=useLocale(),{history,loading,error}=useHistory(),prefs=usePrefs(),sources=useNamed(arrange.view.names);
  const strip=useHistoryPlot(),panning=usePanning();
  const selected=useTimeRange(),start=useHistoryBegins(),panel=useRef<HTMLElement>(null),{plot,onBase}=usePlot(panel);
  const now=useClock(now=>frameChangesAt(selected,history?.cellMs??60_000,now));
  const frame=frameOf(selected,{range:prefs.range,horizon:prefs.horizon},now,start),measured=measuredTo(frame,history,selected,prefs.range);
  const original=history?.meterSeries?.filter(s=>s.unit===prefs.money.unit)??[];
  const unit=prefs.money.unit??'USD';
  const prepared=usePrepared(function* () {
    const entries:MeterHistory[]=[],visible:MeterHistory[]=[];
    let low:bigint|null=null,high:bigint|null=null;
    for(const source of strip?.meterSeries??original) {
      if(source.unit!==unit)continue;
      let entry=source;
      if(prefs.money.view==='spending'&&source.kind!=='cap') {
        let cumulative=0n;const points:MeterHistory['points']=[];
        for(const point of source.points){cumulative+=BigInt(point.spent);points.push({...point,value:cumulative.toString()});yield;}
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
      for(const point of series.points){points.push([point.at,scaled(point.value),point.segment]);yield;}
      lines.push({sourceId:series.sourceId,windowId:series.meterId,key:moneyIdentity(series),name:nameOf(series,card?.title??series.sourceId),provider:card?.provider??'',kind:'other',label:series.semantics?.label??null,minutes:null,color:colorOf(arrange.view,series.sourceId,card?.provider??''),dash:series.kind==='cap'?'7 5':'',current:scaled(series.end??'0'),consumed:0,coveredMs:series.coveredMs,remainingAtStart:series.start===null?null:scaled(series.start),remainingAtEnd:series.end===null?null:scaled(series.end),staleAfterMs:86_400_000,points,work:null});yield;
    }
    return {entries,lines,origin,span,pad,strip};
  },[history,strip,prefs.muted,unit,prefs.money.view,sources,arrange.view,locale],`${board}:${unit}`);
  const model=prepared.value,entries=model?.entries??[],lines=model?.lines??[];
  const baseNavigation=axisNavigation(board,selected,prefs),navigation={...baseNavigation,context:JSON.stringify([baseNavigation.context,unit,prefs.money.view])};
  const axis=useMemo(()=>{
    const origin=model?.origin??0n,span=model?.span??1_000_000n,pad=model?.pad??1n;
    const min=-Number(pad)/1_000_000,max=Number(span+pad)/1_000_000;
    return {min,max,ticks:Array.from({length:5},(_,i)=>min+(max-min)*i/4),label:t('money.value')+' ('+unit+')',
      rawValue:(key:string,at:number)=>{const series=entries.find(s=>moneyIdentity(s)===key);return series&&pointAt(series,at)?.value||'0';},
      formatTick:(value:number)=>money((origin+BigInt(Math.round(value*1_000_000))).toString(),unit).slice(0,-unit.length-1),
      formatValue:(key:string,_value:number,at:number)=>{const series=entries.find(s=>moneyIdentity(s)===key);return money(series&&pointAt(series,at)?.value,unit,true);},
      detail:(key:string,at:number)=>{
        const series=entries.find(s=>moneyIdentity(s)===key),point=series&&pointAt(series,at);
        return <>{point?.semantics?.limit!==null&&point?.semantics?.limit!==undefined&&<div>{t('money.limitTotal')}: {money(point.semantics.limit,unit,true)}{point.semantics.resetAt!==null&&<div>{stamp(point.semantics.resetAt)}</div>}</div>}{point?.steps.map(step=><div key={step.from+':'+step.to}>{t('money.unlocated')}: {money(step.amount,unit,true)}<div>{stamp(step.from)} — {stamp(step.to)}</div></div>)}</>;
      }};
  },[model,unit,locale]);
  const answered=history?.range===(selected?timeRangeKey(selected):prefs.range);
  return <section className={`panel history${loading?' is-loading':''}`} data-widget={HISTORY} ref={panel}>
    <div className="panel-head"><h2>{t(prefs.money.view==='spending'?'money.spending':'money.balance')} ({unit})</h2><Popover label={t('history.settings')} icon={<SlidersIcon/>}>
      <div className="popover-pad"><Segmented value={prefs.money.view} onChange={view=>setPrefs({money:{...prefs.money,view}})} options={[["balance",t('money.balance')],["spending",t('money.spending')]]} label={t('money.value')}/></div>
      <MoneySettings sources={sources} hidden={arrange.view.hidden} series={original}/>
      {arrange.owner&&<HideRow onHide={()=>arrange.update(v=>({...v,hidden:[...v.hidden,HISTORY]}))}>{t('widget.hide')}</HideRow>}
    </Popover></div>
    <SelectionNotice/>
    {error&&<p className="form-error">{t('money.historyLimit')}</p>}
    <Chart lines={lines} axis={axis} stepped from={frame.from} now={strip?now:measured} to={frame.to} cellMs={strip?.cell??history?.cellMs??60_000} strip={model?.strip??null} prepared={prepared.ready&&(panning!==null||answered)} empty={!lines.length?t('money.unknown'):null} plot={plot} onBase={onBase} onSelect={setTimeRange} navigation={navigation} live={frame.live} clock={now} modelContext={JSON.stringify([board,unit])}/>
    <div className="legend">{original.map(s=>{const key=moneyIdentity(s),card=sources.find(c=>c.id===s.sourceId),total=prefs.money.view==='spending'&&s.kind!=='cap'&&history?moneyTotal(s,history.since,history.to):null,value=total?total.amount:s.end;return <button type="button" key={key} className="legend-item" aria-pressed={!prefs.muted[key]} onClick={()=>setMuted(key,!prefs.muted[key])}><svg width="18" height="6" aria-hidden="true"><line x1="1" x2="17" y1="3" y2="3" stroke={colorOf(arrange.view,s.sourceId,card?.provider??'')} strokeWidth="2.5" strokeDasharray={s.kind==='cap'?'7 5':undefined}/></svg><span>{nameOf(s,card?.title??s.sourceId)}</span><b title={total?.unknown?t('money.unknown'):total?.partial?t('money.partial'):undefined}>{money(value,s.unit)}{total?.partial&&<small className="money-partial">*</small>}</b></button>;})}</div>
  </section>;
}
export function MoneyTable({arrange}:{arrange:Arrange}) {
  useLocale();const {history,error}=useHistory(),sources=useNamed(arrange.view.names),prefs=usePrefs();
  const columns=([['value','money.value'],['spending','money.spending'],['topup','money.topup']] as const).filter(([id])=>columnShown(arrange.view,FORECAST,id));
  return <section className="panel forecast" data-widget={FORECAST}>
    <div className="panel-head"><h2>{t('money.spending')} ({prefs.money.unit})</h2>{arrange.owner&&<Popover label={t('forecast.settings')} icon={<SlidersIcon/>}>
      {([['value','money.value'],['spending','money.spending'],['topup','money.topup']] as const).map(([id,label])=><SwitchRow key={id} on={columnShown(arrange.view,FORECAST,id)} onChange={on=>arrange.update(view=>withColumn(view,FORECAST,id,on))}>{t(label)}</SwitchRow>)}
      <HideRow onHide={()=>arrange.update(view=>withHidden(view,FORECAST,true))}>{t('widget.hide')}</HideRow>
    </Popover>}</div><SelectionNotice/>
    {history&&<p className="drawer-note">{t('money.interval',{from:stamp(history.since),to:stamp(history.to)})}</p>}
    {error&&<p className="form-error">{t('money.historyLimit')}</p>}
    <div className="table-wrap"><table className="monetary-table"><thead><tr><th>{t('money.key')}</th>{columns.map(([id,label])=><th key={id}>{t(label)}</th>)}</tr></thead><tbody>{history?.meterSeries?.filter(s=>s.unit===prefs.money.unit).map(s=><tr key={moneyIdentity(s)}><td>{nameOf(s,sources.find(c=>c.id===s.sourceId)?.title??s.sourceId)}</td>{columns.map(([id])=>{
      if(id==='value')return <td key={id} title={money(s.end,s.unit,true)}>{money(s.end,s.unit)}</td>;
      if(id==='spending'&&s.kind==='cap'||id==='topup'&&s.kind!=='balance')return <td key={id}>—</td>;
      const topup=id==='topup',total=moneyTotal(s,history.since,history.to,topup),steps=topup?s.topupUnlocated:s.unlocated;
      const title=[total.unknown?t('money.unknown'):total.partial?t('money.partial'):'',...steps.map(p=>`${money(p.amount,s.unit,true)}\n${stamp(p.from)} — ${stamp(p.to)}`)].filter(Boolean).join('\n');
      return <td key={id} title={title}>{money(total.amount,s.unit)}{total.partial&&<small className="money-partial">*</small>}</td>;
    })}</tr>)}</tbody></table></div>
  </section>;
}
