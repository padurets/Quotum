import {QUOTA_IDS} from '../../server/domain/meters';
import type {Card,View} from '../lib/types';
import type {KeyPart,Meter} from '../../server/domain/meters';
import {useSourceAccess} from '../lib/board';
import {money,amountText,amountUnitLabel,capName,keyName,capLeft,capPercent,capStale,capChangesAt,accessTone,accessChangesAt,ACCESS_WARNING_MS} from '../lib/money';
import {stamp,countdown,duration,countdownChangesAt,earliest} from '../lib/format';
import {useClock} from '../lib/clock';
import {t} from '../i18n';
import {ApiError,messageOf} from '../lib/http';
import {ErrorLine} from './Kit';
import {Popover} from './Popover';
import {MeterBar} from './Meter';
import {level} from '../lib/quota';
import {useShownKeys} from '../lib/moneyKeys';

function CapStatus({part,cap}:{part?:KeyPart;cap?:Meter}) {
  const now=useClock(now=>earliest(part?.expiresAt!=null&&part.expiresAt>now?part.expiresAt:null,cap?capChangesAt(cap,now):null));
  const inactive=!!part&&(part.disabled||part.expiresAt!==null&&part.expiresAt<=now);
  const status=inactive?t('money.inactive'):part?.presence==='missing'?t('money.missing'):!cap?t('quota.unavailable'):capStale(cap,now)?t('money.stale'):'';
  const detail=status&&cap?`${status}\n${stamp(cap.at)}`:status;
  return <small data-time="key-status" className={`key-status${inactive?' is-inactive':''}`} role="img" title={detail} aria-label={detail||undefined} aria-hidden={!status}/>;
}
export function CapReset({meter,short=false}:{meter:Meter;short?:boolean}) {
  const now=useClock(now=>meter.resetAt===null?null:countdownChangesAt(meter.resetAt,now));
  const unknown=meter.resetAt===null&&meter.scope!=='lifetime';
  const text=meter.resetAt===null?unknown?short?'—':t('limit.resetUnknown'):'' :meter.resetAt>now?short?countdown(meter.resetAt-now):t('limit.resetsIn',{time:duration(meter.resetAt-now)}):t('limit.resetPassed');
  return <span data-time="cap-reset" title={unknown?t('limit.resetUnknown'):meter.resetAt!==null?stamp(meter.resetAt):''}>{text}</span>;
}
/** Independent caps share the subscription scale, regardless of how they are measured. */
export function CapMetrics({cap,name,detail=name,status,compact=false,showPercent=false}:{cap:Meter|undefined;name:string;detail?:string;status?:import('react').ReactNode;compact?:boolean;showPercent?:boolean}) {
  const percent=cap?capPercent(cap):null,remaining=percent===null?null:100-percent;
  const value=cap?amountText(capLeft(cap),cap.unit):'—',unit=cap?amountUnitLabel(cap.unit):'';
  const percentText=showPercent&&remaining!==null?<small className="limit-share">{Math.round(remaining)}%</small>:null;
  const bar=<MeterBar remaining={cap?remaining:null} label={name}/>;
  const reset=cap?<CapReset meter={cap} short={compact}/>:<span>{t('money.stale')}</span>;
  if(compact)return <div className="compact-limit is-money">
    <div className="compact-window-name"><span title={detail}>{name}{percentText}{status}</span></div>
    <small className="compact-reset">{reset}</small>{bar}
    <strong className="limit-value" title={cap?money(capLeft(cap),cap.unit,true):undefined}>{value}<small>{unit}</small></strong>
  </div>;
  return <div className="limit money-limit">
    <div className="limit-top"><span className="limit-name" title={detail}>{name}{percentText}{status}</span>
      <span className={`limit-value v-${remaining===null?'ok':level(remaining)}`} title={cap?money(capLeft(cap),cap.unit,true):undefined}>{value}<small>{unit}</small></span>
    </div>{bar}
    <div className="limit-bottom"><span>{cap?t('money.of',{amount:money(cap.limit,cap.unit)}):t('quota.unavailable')}</span>{cap&&remaining===null?<span>{t('money.exhausted')}</span>:reset}</div>
  </div>;
}
export function KeyMetrics({part,meters,compact=false}:{part:KeyPart;meters:readonly Meter[];compact?:boolean}) {
  const cap=meters.find(m=>m.id===`key:${part.id}:cap`);if(!cap)return null;
  return <CapMetrics cap={cap} name={keyName(part)} detail={[keyName(part),part.includeByok?t('money.byok'):''].filter(Boolean).join('\n')} status={<CapStatus part={part} cap={cap}/>} compact={compact}/>;
}
export function QuotaCard({source,compact=false}:{source:Card;compact?:boolean}) {
  return <>{QUOTA_IDS.map(id=>{const cap=source.meters?.find(m=>m.id===id);return <CapMetrics key={id} cap={cap} name={capName({id,scope:null,label:null})} status={<CapStatus cap={cap}/>} showPercent compact={compact}/>;})}</>;
}
export function QuotaMark({source}:{source:Card}) {
  if(!source.quota||source.quota.complete)return null;
  const text=messageOf(new ApiError(400,'connector_quota_'+(source.quota.generation?'partial':source.quota.issue)));
  return <Popover label={text} up align="left" triggerClass="tray-pill is-warn" trigger={<svg className="tray-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3h.01"/></svg>}><div className="tray-panel"><p className="tray-panel-lead">{text}</p><p>{t('quota.budgetOnly')}</p></div></Popover>;
}
export function MoneyCard({source,board,view,compact=false}:{source:Card;board:string;view?:View;compact?:boolean}) {
  const balance=source.meters?.find(m=>m.id==='balance'),{keys,meters,error}=useShownKeys(source,view,board);
  const unit=balance?.unit??'USD',formatted=money(balance?.amount,unit),amount=balance?.amount==null?formatted:formatted.slice(0,-unit.length-1);
  return <div className="money-body">
    <div className="money-balance" title={money(balance?.amount,unit,true)}><span>{t('money.accountBalance')}</span><span className="limit-value" data-money={balance?.amount}>{amount}{balance?.amount!=null&&<small>{unit}</small>}</span></div>
    <div className="limits money-limits">{keys.map(part=><KeyMetrics key={part.id} part={part} meters={meters} compact={compact}/>)}</div>
    <ErrorLine error={error}/>
  </div>;
}
export function AccessMark({id}:{id:string}) {
  const access=useSourceAccess(id);
  const now=useClock(now=>accessChangesAt(access,now));
  if(!access)return null;
  const tone=accessTone(access,now);
  if(tone===null)return null;
  const text=access.error?new ApiError(400,access.error):null;
  const expiry=access.expiryKind==='unknown'?t('sources.unknownExpiry'):access.expiresAt===null?t('sources.noExpiry'):access.expiresAt<=now?t('money.expired'):t('money.expirySoon',{time:stamp(access.expiresAt)});
  const lead=text?messageOf(text):expiry;
  return <span data-time="access-expiry"><Popover label={lead} up align="left" triggerClass={`tray-pill access-mark${tone==='neutral'?'':` is-${tone}`}`} trigger={<>
    <svg className="tray-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="4"/><path d="m11 11 9 9m-5-5 3-3m-1 5 3-3"/></svg>
    {tone!=='crit'&&access.expiresAt!==null&&access.expiresAt>now&&access.expiresAt-now<=ACCESS_WARNING_MS&&<span>{countdown(access.expiresAt-now)}</span>}
  </>}><div className="tray-panel"><div className="tray-panel-head"><p className="tray-panel-lead">{lead}</p>{text&&<p className="tray-panel-when">{expiry}</p>}</div></div></Popover></span>;
}
