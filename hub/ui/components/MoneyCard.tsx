import type {Card,View} from '../lib/types';
import type {KeyPart,Meter} from '../../server/domain/meters';
import {useSourceAccess} from '../lib/board';
import {money,keyName,capLeft,capPercent,capStale,capChangesAt} from '../lib/money';
import {stamp,countdown,duration,countdownChangesAt,earliest} from '../lib/format';
import {useClock} from '../lib/clock';
import {t} from '../i18n';
import {ApiError,messageOf} from '../lib/http';
import {ErrorLine} from './Kit';
import {Popover} from './Popover';
import {MeterBar} from './Meter';
import {level} from '../lib/quota';
import {useShownKeys} from '../lib/moneyKeys';

function KeyStatus({part,cap}:{part:KeyPart;cap:Meter}) {
  const now=useClock(now=>earliest(part.expiresAt!==null&&part.expiresAt>now?part.expiresAt:null,capChangesAt(cap,now)));
  const stale=capStale(cap,now);
  return <small data-time="key-status" className={stale?'cap-stale':undefined}>{part.disabled||part.expiresAt!==null&&part.expiresAt<=now?t('money.inactive'):part.presence==='missing'?t('money.missing'):stale?t('money.stale'):''}</small>;
}
function CapReset({meter,short=false}:{meter:Meter;short?:boolean}) {
  const now=useClock(now=>meter.resetAt===null?null:countdownChangesAt(meter.resetAt,now));
  return <span data-time="cap-reset" title={meter.resetAt===null?'':stamp(meter.resetAt)}>{meter.resetAt!==null&&meter.resetAt>now?short?countdown(meter.resetAt-now):t('limit.resetsIn',{time:duration(meter.resetAt-now)}):meter.resetAt!==null?t('money.partial'):''}</span>;
}
export function KeyMetrics({part,meters,compact=false}:{part:KeyPart;meters:readonly Meter[];compact?:boolean}) {
  const cap=meters.find(m=>m.id===`key:${part.id}:cap`);
  if(!cap)return null;
  const percent=capPercent(cap),remaining=percent===null?null:100-percent;
  const left=money(capLeft(cap),cap.unit),value=left.slice(0,-cap.unit.length-1);
  const detail=[keyName(part),part.includeByok?t('money.byok'):''].filter(Boolean).join('\n');
  const stale=part.presence==='missing'||cap.stale;
  const bar=<MeterBar remaining={remaining} label={keyName(part)}/>;
  if(compact)return <div className={`compact-limit is-money${stale?' is-stale':''}`}>
    <div className="compact-window-name"><span title={detail}><span>{keyName(part)}</span><KeyStatus part={part} cap={cap}/></span></div>
    <small className="compact-reset"><CapReset meter={cap} short/></small>
    {bar}<strong title={money(capLeft(cap),cap.unit,true)}>{left}</strong>
  </div>;
  return <div className={`limit money-limit${stale?' is-stale':''}`}>
    <div className="limit-top"><span className="limit-name" title={detail}>{keyName(part)}<KeyStatus part={part} cap={cap}/></span>
      <span className={`limit-value v-${remaining===null?'ok':level(remaining)}`} title={money(capLeft(cap),cap.unit,true)}>{value}<small>{cap.unit}</small></span>
    </div>
    {bar}
    <div className="limit-bottom"><span title={money(cap.limit,cap.unit,true)}>{t('money.of',{amount:money(cap.limit,cap.unit)})}</span>{remaining===null?<span>{t('money.exhausted')}</span>:<CapReset meter={cap}/>}</div>
  </div>;
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
  const now=useClock(now=>access?.expiresAt==null?null:earliest(access.expiresAt>now?access.expiresAt:null,access.expiresAt-7*86_400_000>now?access.expiresAt-7*86_400_000:null,access.expiresAt>now&&access.expiresAt-now<=7*86_400_000?countdownChangesAt(access.expiresAt,now):null));
  if(!access)return null;
  const text=access.error?new ApiError(400,access.error):null;
  const expiry=access.expiresAt===null?t('sources.noExpiry'):access.expiresAt<=now?t('money.expired'):t('money.expirySoon',{time:stamp(access.expiresAt)});
  const warn=!!access.error||access.expiresAt===null||access.expiresAt-now<=7*86_400_000;
  const lead=text?messageOf(text):expiry;
  return <span data-time="access-expiry"><Popover label={lead} up align="left" triggerClass={`tray-pill access-mark${warn?' is-warn':''}`} trigger={<>
    <svg className="tray-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="4"/><path d="m11 11 9 9m-5-5 3-3m-1 5 3-3"/></svg>
    {access.expiresAt!==null&&access.expiresAt>now&&access.expiresAt-now<=7*86_400_000&&<span>{countdown(access.expiresAt-now)}</span>}
  </>}><div className="tray-panel"><div className="tray-panel-head"><p className="tray-panel-lead">{lead}</p>{text&&<p className="tray-panel-when">{expiry}</p>}</div></div></Popover></span>;
}
