import type {Card,View} from '../lib/types';
import type {KeyPart,Meter} from '../../server/domain/meters';
import {useSourceAccess} from '../lib/board';
import {money,keyName,capLeft,capPercent,capStale,capChangesAt,accessTone,accessChangesAt,ACCESS_WARNING_MS} from '../lib/money';
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
  const inactive=part.disabled||part.expiresAt!==null&&part.expiresAt<=now;
  const status=inactive?t('money.inactive'):part.presence==='missing'?t('money.missing'):stale?t('money.stale'):'';
  return <small data-time="key-status" className={`key-status${stale?' cap-stale':''}${inactive?' is-inactive':''}`} role="img" title={status} aria-label={status||undefined} aria-hidden={!status}/>;
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
    <div className="compact-window-name"><span title={detail}><span>{keyName(part)}<KeyStatus part={part} cap={cap}/></span></span></div>
    <small className="compact-reset"><CapReset meter={cap} short/></small>
    {bar}<strong className="limit-value" title={money(capLeft(cap),cap.unit,true)}>{value}<small>{cap.unit}</small></strong>
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
  if(source.reportQuality!==undefined)return <BudgetCard source={source} compact={compact}/>;
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
  const expiry=access.expiryKnown===false?t('sources.unknownExpiry'):access.expiresAt===null?t('sources.noExpiry'):access.expiresAt<=now?t('money.expired'):t('money.expirySoon',{time:stamp(access.expiresAt)});
  const lead=text?messageOf(text):expiry;
  return <span data-time="access-expiry"><Popover label={lead} up align="left" triggerClass={`tray-pill access-mark${tone==='neutral'?'':` is-${tone}`}`} trigger={<>
    <svg className="tray-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="4"/><path d="m11 11 9 9m-5-5 3-3m-1 5 3-3"/></svg>
    {tone!=='crit'&&access.expiresAt!==null&&access.expiresAt>now&&access.expiresAt-now<=ACCESS_WARNING_MS&&<span>{countdown(access.expiresAt-now)}</span>}
  </>}><div className="tray-panel"><div className="tray-panel-head"><p className="tray-panel-lead">{lead}</p>{text&&<p className="tray-panel-when">{expiry}</p>}</div></div></Popover></span>;
}

function BudgetCard({source,compact}:{source:Card;compact:boolean}) {
  const allowance=source.allowance,unit=allowance?.unit??'USD';
  const remaining=allowance?.remaining??null,limit=allowance?.limit??null;
  const percent=limit!==null&&BigInt(limit)>0n&&remaining!==null&&BigInt(remaining)<=BigInt(limit)?Number(BigInt(remaining)*10000n/BigInt(limit))/100:null;
  const text=money(remaining,unit),value=remaining===null?text:text.slice(0,-unit.length-1);
  const enforcement=allowance?.enforcement==='enforcing'?t('money.enforcing'):allowance?.enforcement==='inactive'?t('money.inactive'):t('money.enforcementUnknown');
  const calendar=source.reportedSpending??[],month=calendar.find(c=>c.unit===unit)?.month;
  const reason=calendar.some(c=>c.unit!==unit&&c.month.amount!==null)?t('money.currencyMismatch'):allowance?.stale?t('money.stale'):allowance&&remaining===null&&!month?.confirmed?t('money.lastKnown'):'';
  const trouble=source.monthlyLimit?.status==='unavailable'||allowance?.stale;
  const mark=trouble?<small className="key-status cap-stale" role="img" aria-label={t('money.limitUnknown')} title={t('money.limitUnknown')}/>:null;
  const detail=[t('money.monthlyLimit'),money(limit,unit,true),enforcement,allowance?.overspend&&BigInt(allowance.overspend)>0n?t('money.overspend')+': '+money(allowance.overspend,unit,true):'',reason].filter(Boolean).join('\n');
  if(compact)return <div className="money-body"><div className="limits money-limits"><div className="compact-limit is-money">
    <div className="compact-window-name"><span title={detail}>{t('money.monthlyLimit')}{mark}</span></div>
    <small className="compact-reset" title={detail}>{enforcement}</small>
    <MeterBar remaining={percent} label={t('money.monthlyLimit')}/>
    <strong className="limit-value" title={detail}>{value}{remaining!==null&&<small>{unit}</small>}</strong>
  </div></div></div>;
  return <div className="money-body"><div className="limits money-limits"><div className="limit money-limit">
    <div className="limit-top"><span className="limit-name" title={detail}>{t('money.allowance')}{mark}</span><span className="limit-value" title={detail}>{value}{remaining!==null&&<small>{unit}</small>}</span></div>
    <MeterBar remaining={percent} label={t('money.monthlyLimit')}/>
    <div className="limit-bottom"><span title={detail}>{limit===null?t('money.limitUnknown'):t('money.of',{amount:money(limit,unit)})}</span><span title={detail}>{enforcement}</span></div>
  </div></div></div>;
}
