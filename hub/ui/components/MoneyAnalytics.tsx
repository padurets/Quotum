import {useMemo,useRef} from 'react';
import {useNamed,useServerView} from '../lib/board';
import {useHistory,useHistoryBegins} from '../lib/history';
import {usePrefs,setPrefs,setMuted} from '../lib/prefs';
import {moneySelection} from '../lib/moneySelection';
import {money} from '../lib/money';
import {moneyIdentity,type MeterHistory} from '../lib/moneyView';
import {colorOf,columnShown,withColumn,withHidden,HISTORY,FORECAST,type Arrange} from '../lib/view';
import {frameOf,frameChangesAt,measuredTo,step} from '../lib/periods';
import {useTimeRange,setTimeRange,goTo} from '../lib/timeRange';
import {useClock,hubNow} from '../lib/clock';
import {stamp} from '../lib/format';
import type {Line} from '../lib/lines';
import {t,useLocale} from '../i18n';
import {Chart} from './Chart';
import {usePlot} from './sizing';
import {Popover,SlidersIcon,HideRow,SwitchRow} from './Popover';
import {Segmented} from './Kit';
import {MoneySettings} from './MoneySettings';

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
  const locale=useLocale(),{history,loading,error}=useHistory(),prefs=usePrefs(),sources=useNamed(arrange.view.names);
  const selected=useTimeRange(),start=useHistoryBegins(),panel=useRef<HTMLElement>(null),{plot,onBase}=usePlot(panel);
  const now=useClock(now=>frameChangesAt(selected,history?.cellMs??60_000,now));
  const frame=frameOf(selected,{range:prefs.range,horizon:prefs.horizon},now,start),measured=measuredTo(frame,history,selected,prefs.range);
  const original=history?.meterSeries?.filter(s=>s.unit===prefs.money.unit)??[];
  const entries=original.map(s=>{
    if(prefs.money.view!=='spending'||s.kind==='cap')return s;
    let cumulative=0n;return {...s,start:'0',end:s.spent,points:s.points.map(p=>{cumulative+=BigInt(p.spent);return {...p,value:cumulative.toString()};})};
  });
  const visible=entries.filter(s=>!prefs.muted[moneyIdentity(s)]);
  const values=visible.flatMap(s=>s.points.map(p=>BigInt(p.value)));
  const origin=values.reduce((min,value)=>value<min?value:min,values[0]??0n),max=values.reduce((a,b)=>a>b?a:b,origin);
  const span=max-origin||1_000_000n,pad=span/10n||1n;
  const lines=useMemo(()=>visible.map((s):Line=>{
    const card=sources.find(c=>c.id===s.sourceId),key=moneyIdentity(s),scaled=(value:string)=>Number(BigInt(value)-origin)/1_000_000;
    return {sourceId:s.sourceId,windowId:s.meterId,key,name:nameOf(s,card?.title??s.sourceId),provider:card?.provider??'',kind:'other',label:s.semantics?.label??null,minutes:null,color:colorOf(arrange.view,s.sourceId,card?.provider??''),dash:s.kind==='cap'?'7 5':'',current:scaled(s.end??'0'),consumed:0,coveredMs:s.coveredMs,remainingAtStart:s.start===null?null:scaled(s.start),remainingAtEnd:s.end===null?null:scaled(s.end),staleAfterMs:86_400_000,points:s.points.map(p=>[p.at,scaled(p.value),p.segment]),work:null};
  }),[history,prefs.muted,prefs.money.unit,prefs.money.view,sources,arrange.view,locale,origin]);
  const unit=prefs.money.unit??'USD',minY=-Number(pad)/1_000_000,maxY=Number(span+pad)/1_000_000;
  const axis={min:minY,max:maxY,ticks:Array.from({length:5},(_,i)=>minY+(maxY-minY)*i/4),label:t('money.value')+' ('+unit+')',rawValue:(key:string,at:number)=>{const series=entries.find(s=>moneyIdentity(s)===key);return series&&pointAt(series,at)?.value||'0';},formatTick:(value:number)=>money((origin+BigInt(Math.round(value*1_000_000))).toString(),unit).slice(0,-unit.length-1),formatValue:(key:string,_value:number,at:number)=>{const series=entries.find(s=>moneyIdentity(s)===key);return money(series&&pointAt(series,at)?.value,unit,true);},detail:(key:string,at:number)=>{
    const series=entries.find(s=>moneyIdentity(s)===key),point=series&&pointAt(series,at);
    return <>{point?.semantics?.limit!==null&&point?.semantics?.limit!==undefined&&<div>{t('money.limitTotal')}: {money(point.semantics.limit,unit,true)}{point.semantics.resetAt!==null&&<div>{stamp(point.semantics.resetAt)}</div>}</div>}{point?.steps.map(step=><div key={step.from+':'+step.to}>{t('money.unlocated')}: {money(step.amount,unit,true)}<div>{stamp(step.from)} — {stamp(step.to)}</div></div>)}</>;
  }};
  return <section className={`panel history${loading?' is-loading':''}`} data-widget={HISTORY} ref={panel}>
    <div className="panel-head"><h2>{t(prefs.money.view==='spending'?'money.spending':'money.balance')} ({unit})</h2><Popover label={t('history.settings')} icon={<SlidersIcon/>}>
      <div className="popover-pad"><Segmented value={prefs.money.view} onChange={view=>setPrefs({money:{...prefs.money,view}})} options={[["balance",t('money.balance')],["spending",t('money.spending')]]} label={t('money.value')}/></div>
      <MoneySettings sources={sources} hidden={arrange.view.hidden} series={original}/>
      {arrange.owner&&<HideRow onHide={()=>arrange.update(v=>({...v,hidden:[...v.hidden,HISTORY]}))}>{t('widget.hide')}</HideRow>}
    </Popover></div>
    <SelectionNotice/>
    {error&&<p className="form-error">{t('money.historyLimit')}</p>}
    <Chart lines={lines} axis={axis} stepped from={frame.from} now={measured} to={frame.to} cellMs={history?.cellMs??60_000} empty={!lines.length?t('money.unknown'):null} plot={plot} onBase={onBase} onSelect={setTimeRange} onStep={direction=>goTo(step(selected,prefs.range,direction,hubNow(),start))}/>
    <div className="legend">{entries.map(s=>{const key=moneyIdentity(s),card=sources.find(c=>c.id===s.sourceId);return <button type="button" key={key} className="legend-item" aria-pressed={!prefs.muted[key]} onClick={()=>setMuted(key,!prefs.muted[key])}><svg width="18" height="6" aria-hidden="true"><line x1="1" x2="17" y1="3" y2="3" stroke={colorOf(arrange.view,s.sourceId,card?.provider??'')} strokeWidth="2.5" strokeDasharray={s.kind==='cap'?'7 5':undefined}/></svg><span>{nameOf(s,card?.title??s.sourceId)}</span><b>{money(s.end,s.unit)}</b></button>;})}</div>
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
    <div className="money-table-wrap"><table className="money-table"><thead><tr><th>{t('money.key')}</th>{columns.map(([id,label])=><th key={id}>{t(label)}</th>)}</tr></thead><tbody>{history?.meterSeries?.filter(s=>s.unit===prefs.money.unit).map(s=><tr key={moneyIdentity(s)}><td>{nameOf(s,sources.find(c=>c.id===s.sourceId)?.title??s.sourceId)}</td>{columns.map(([id])=>id==='value'?<td key={id} title={money(s.end,s.unit,true)}>{money(s.end,s.unit)}</td>:id==='spending'?<td key={id} title={s.unlocated.map(p=>`${money(p.amount,s.unit,true)}\n${stamp(p.from)} — ${stamp(p.to)}`).join('\n')}>{s.kind==='cap'?'—':money(s.spent,s.unit)}{s.unlocated.length>0&&<small className="money-partial">*</small>}</td>:<td key={id} title={s.topupUnlocated.map(p=>`${money(p.amount,s.unit,true)}\n${stamp(p.from)} — ${stamp(p.to)}`).join('\n')}>{s.kind==='balance'?money(s.topup,s.unit):'—'}{s.topupUnlocated.length>0&&<small className="money-partial">*</small>}</td>)}</tr>)}</tbody></table></div>
  </section>;
}
