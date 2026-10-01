import {useEffect,useState} from 'react';
import type {Card} from '../lib/types';
import type {KeyPart,Meter,SpendSummary} from '../../server/domain/meters';
import {useSourceAccess,useNamed,useServerView} from '../lib/board';
import {money,keyName,capLeft,capPercent} from '../lib/money';
import {moneySelection} from '../lib/moneySelection';
import {setPrefs,usePrefs} from '../lib/prefs';
import {MAX_METERS} from '../../server/domain/meterHistory';
import {stamp,countdown,countdownChangesAt,earliest} from '../lib/format';
import {useClock} from '../lib/clock';
import {t} from '../i18n';
import {ApiError,call} from '../lib/http';
import {Modal,ErrorLine} from './Kit';
import {Popover} from './Popover';

function Summary({value}:{value:SpendSummary|undefined}) {
  const detail=value?[
    value.amount===null?t('money.unknown'):'',
    !value.complete?t('money.partial'):'',
    value.knownFrom===null?'':t('money.knownFrom',{time:stamp(value.knownFrom)}),
    ...value.unlocated.map(s=>`${t('money.unlocated')}: ${money(s.amount,'USD',true)}\n${stamp(s.from)} — ${stamp(s.to)}`),
  ].filter(Boolean).join('\n'):t('money.unknown');
  return <span title={detail}>{money(value?.amount)}{value&&(!value.complete||value.uncertain)&&<small className="money-partial">*</small>}</span>;
}
function KeyStatus({part}:{part:KeyPart}) {
  const now=useClock(now=>part.expiresAt!==null&&part.expiresAt>now?part.expiresAt:null);
  return <small data-time="key-status">{part.disabled||part.expiresAt!==null&&part.expiresAt<=now?t('money.inactive'):part.presence==='missing'?t('money.missing'):''}</small>;
}
function CapReset({meter}:{meter:Meter}) {
  const now=useClock(now=>meter.resetAt===null?null:countdownChangesAt(meter.resetAt,now));
  return <small data-time="cap-reset" title={meter.resetAt===null?'':stamp(meter.resetAt)}>{meter.resetAt!==null&&meter.resetAt>now?countdown(meter.resetAt-now):meter.resetAt!==null?t('money.partial'):''}</small>;
}
export function KeyMetrics({part,meters}:{part:KeyPart;meters:readonly Meter[]}) {
  const usage=meters.find(m=>m.id===`key:${part.id}:usage`),cap=meters.find(m=>m.id===`key:${part.id}:cap`);
  const percent=cap?capPercent(cap):null;
  return <div className={`money-key${part.presence==='missing'||usage?.stale?' is-stale':''}`}>
    <div className="money-key-head"><strong>{keyName(part)}</strong><KeyStatus part={part}/></div>
    <div className="money-key-values"><span title={money(usage?.amount,'USD',true)}>{t('money.usage')}: {money(usage?.amount)}</span><span title={[t('money.day'),money(part.periods.day),t('money.week'),money(part.periods.week)].join('\n')}>{t('money.month')}: {money(part.periods.month)}</span></div>
    {cap&&<div className={`money-cap${cap.stale?' is-stale':''}`} title={part.includeByok?t('money.byok'):undefined}>
      <span title={money(capLeft(cap),cap.unit,true)}>{money(capLeft(cap),cap.unit)} / {money(cap.limit,cap.unit)}</span>
      {percent===null?<small>{t('money.exhausted')}</small>:<div className="meter" role="progressbar" aria-label={keyName(part)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={100-percent}><span className="meter-track"><i className={`fill fill-${100-percent<=10?'crit':100-percent<=30?'warn':'ok'}`} style={{width:`${100-percent}%`}}/></span></div>}
      <CapReset meter={cap}/>
    </div>}
  </div>;
}
type KeyPage={keys:KeyPart[];meters:Meter[];total:number;inventory:Card['inventory'];next:string|null};
function AllKeys({source,board,onClose}:{source:Card;board:string;onClose:()=>void}) {
  const [page,setPage]=useState<KeyPage|null>(null),[after,setAfter]=useState<string|undefined>(),[back,setBack]=useState<(string|undefined)[]>([]),[error,setError]=useState<unknown>(null),[changed,setChanged]=useState(false);
  const prefs=usePrefs(),sources=useNamed(),view=useServerView();
  const selected=moneySelection(sources,view?.hidden??[],{...prefs.money,unit:'USD'}).selection!.ids;
  useEffect(()=>{
    let live=true;
    call<KeyPage>('GET',`/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(source.id)}/keys?limit=50${after?'&after='+encodeURIComponent(after):''}`)
      .then(reply=>{if(live){setPage(reply);setError(null);}},failure=>{if(!live)return;if(failure instanceof ApiError&&failure.code==='keys_changed'){setChanged(true);setBack([]);setAfter(undefined);}else setError(failure);});
    return()=>{live=false;};
  },[board,source.id,after]);
  const toggle=(meter:string)=>{
    const has=selected.some(([id,m])=>id===source.id&&m===meter);
    const ids=has?selected.filter(([id,m])=>id!==source.id||m!==meter):[...selected,[source.id,meter] as [string,string]];
    if(ids.length>MAX_METERS)return;
    setPrefs({money:{...prefs.money,unit:'USD',removed:0,selected:{...prefs.money.selected,USD:ids}}});
  };
  return <Modal title={t('money.keys',{count:source.keysCount??0})} onClose={onClose} wide>
    {changed&&<p className="drawer-note">{t('money.changed')}</p>}
    <ErrorLine error={error}/>
    <p className="drawer-note">{page?.inventory?.complete?t('money.inventory',{count:page.inventory.observed}):t('money.inventoryPartial')}</p>
    <div className="money-key-list">{page?.keys.map(part=><div className="popover-row" key={part.id}><KeyMetrics part={part} meters={page.meters}/><div className="money-selectors">{page.meters.filter(m=>m.id.includes(part.id)).map(meter=>{
      const chosen=selected.some(([id,m])=>id===source.id&&m===meter.id);
      return <label key={meter.id}><input type="checkbox" checked={chosen} disabled={!chosen&&selected.length>=MAX_METERS} onChange={()=>toggle(meter.id)}/>{t(meter.kind==='cap'?'money.cap':'money.usage')}</label>;
    })}</div></div>)}</div>
    <p className="drawer-note">{t('money.select')}: {selected.length} / {MAX_METERS}</p>
    <div className="button-row"><button className="button" disabled={!back.length} onClick={()=>{setAfter(back.at(-1));setBack(back.slice(0,-1));}}>{t('history.back')}</button><button className="button" disabled={!page?.next} onClick={()=>{setBack([...back,after]);setAfter(page!.next!);}}>{t('money.next')}</button></div>
  </Modal>;
}
export function MoneyCard({source,board,compact=false}:{source:Card;board:string;compact?:boolean}) {
  const [all,setAll]=useState(false),balance=source.meters?.find(m=>m.id==='balance');
  return <div className="money-body">
    <div className="money-balance" title={money(balance?.amount,balance?.unit,true)}><span>{t('money.balance')}</span><strong data-money={balance?.amount}>{money(balance?.amount,balance?.unit)}</strong></div>
    {!compact&&<>
      <div className="money-summaries">{(['day','week','month'] as const).map(period=><div key={period}><small>{t(`money.${period}`)}</small><Summary value={source.spending?.[period]}/></div>)}</div>
      <div className="money-preview">{source.keys?.map(part=><KeyMetrics key={part.id} part={part} meters={source.meters??[]}/>)}</div>
      {!!source.keysCount&&<button className="link-button" type="button" onClick={()=>setAll(true)}>{t('money.keys',{count:source.keysCount})}</button>}
      {source.inventory&&!source.inventory.complete&&<small className="drawer-note">{t('money.inventoryPartial')}</small>}
    </>}
    {compact&&source.keys?.filter(k=>source.meters?.some(m=>m.id===`key:${k.id}:cap`)).slice(0,2).map(part=><KeyMetrics key={part.id} part={part} meters={source.meters??[]}/>)}
    {all&&<AllKeys source={source} board={board} onClose={()=>setAll(false)}/>}
  </div>;
}
export function AccessMark({id}:{id:string}) {
  const access=useSourceAccess(id);
  const now=useClock(now=>access?.expiresAt==null?null:earliest(access.expiresAt>now?access.expiresAt:null,access.expiresAt-7*86_400_000>now?access.expiresAt-7*86_400_000:null));
  if(!access)return null;
  const text=access.error?new ApiError(400,access.error):null;
  const expiry=access.expiresAt===null?t('sources.noExpiry'):access.expiresAt<=now?t('money.expired'):t('money.expirySoon',{time:stamp(access.expiresAt)});
  return <span data-time="access-expiry"><Popover label={expiry} trigger={<span className={access.error||access.expiresAt!==null&&access.expiresAt-now<=7*86_400_000?'v-warn':'dim'}>⌑</span>}><div className="popover-pad"><p>{expiry}</p><ErrorLine error={text}/></div></Popover></span>;
}
