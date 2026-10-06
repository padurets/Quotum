import {QUOTA_IDS} from '../../server/domain/meters';
import type {Card,View} from '../lib/types';
import type {KeyPart,Meter} from '../../server/domain/meters';
import {currencySymbol,type CurrencyContext} from '../../server/domain/currency';
import {useSourceAccess,useCurrencyContext} from '../lib/board';
import {amountText,amountUnitLabel,capName,budgetView,balanceGroups,balanceRoleLabel,money,keyName,capLeft,capPercent,capStale,capChangesAt,accessTone,accessChangesAt,ACCESS_WARNING_MS,type BudgetLimit} from '../lib/money';
import {stamp,day,countdown,duration,countdownChangesAt,earliest} from '../lib/format';
import {useClock} from '../lib/clock';
import {t} from '../i18n';
import {ApiError,messageOf} from '../lib/http';
import {ErrorLine} from './Kit';
import {Popover} from './Popover';
import {MeterBar,PercentLimit,ResetText} from './Meter';
import {level,resetLineChangesAt} from '../lib/quota';
import {useShownKeys} from '../lib/moneyKeys';

function KeyStatus({part,cap}:{part:BudgetLimit['part'];cap:Meter}) {
  const now=useClock(now=>earliest(part.expiresAt!==null&&part.expiresAt>now?part.expiresAt:null,capChangesAt(cap,now)));
  const stale=capStale(cap,now);
  const inactive=part.disabled||part.expiresAt!==null&&part.expiresAt<=now;
  const status=inactive?t('money.inactive'):part.presence==='missing'?t('money.missing'):stale?t('money.stale'):'';
  return <small data-time="key-status" className={`key-status${stale?' cap-stale':''}${inactive?' is-inactive':''}`} role="img" title={status} aria-label={status||undefined} aria-hidden={!status}/>;
}
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
/** Monetary caps keep their amounts around the shared segmented meter. */
export function CapMetrics({cap,name,detail=name,status,compact=false}:{cap:Meter|undefined;name:string;detail?:string;status?:import('react').ReactNode;compact?:boolean}) {
  const percent=cap?capPercent(cap):null,remaining=percent===null?null:100-percent;
  const value=cap?amountText(capLeft(cap),cap.unit):'—',unit=cap?amountUnitLabel(cap.unit):'';
  const label=<span className="cap-label"><span>{name}</span>{status}</span>;
  const bar=<MeterBar remaining={cap?remaining:null} label={name}/>;
  const reset=cap?<CapReset meter={cap} short={compact}/>:<span>{t('money.stale')}</span>;
  if(compact)return <div className="compact-limit is-money">
    <div className="compact-window-name"><span title={detail}>{label}</span></div>
    <small className="compact-reset">{reset}</small>{bar}
    <strong className="limit-value" title={cap?money(capLeft(cap),cap.unit,true):undefined}>{value}<small>{unit}</small></strong>
  </div>;
  return <div className="limit money-limit">
    <div className="limit-top"><span className="limit-name" title={detail}>{label}</span>
      <span className={`limit-value v-${remaining===null?'ok':level(remaining)}`} title={cap?money(capLeft(cap),cap.unit,true):undefined}>{value}<small>{unit}</small></span>
    </div>{bar}
    <div className="limit-bottom"><span>{cap?t('money.of',{amount:money(cap.limit,cap.unit)}):t('quota.unavailable')}</span>{cap&&remaining===null?<span>{t('money.exhausted')}</span>:reset}</div>
  </div>;
}
function BudgetKeyMetrics({limit,context,compact=false}:{limit:BudgetLimit;context:CurrencyContext;compact?:boolean}) {
  const {part,meter:cap}=limit;
  const percent=capPercent(limit.native),remaining=percent===null?null:100-percent;
  const symbol=limit.unavailable?context.target.symbol:currencySymbol(cap.unit,context);
  const left=limit.unavailable?'— '+symbol:money(capLeft(cap),cap.unit,false,context),value=left.slice(0,-symbol.length-1);
  const detail=[keyName(part),part.includeByok?t('money.byok'):''].filter(Boolean).join('\n');
  const stale=part.presence==='missing'||cap.stale;
  const bar=<MeterBar remaining={remaining} label={keyName(part)}/>;
  if(compact)return <div className={`compact-limit is-money${stale?' is-stale':''}`}>
    <div className="compact-window-name"><span title={detail}><span>{keyName(part)}<KeyStatus part={part} cap={cap}/></span></span></div>
    <small className="compact-reset"><CapReset meter={cap} short/></small>
    {bar}<strong className="limit-value" title={limit.unavailable?'':money(capLeft(cap),cap.unit,true,context)}>{value}<small>{symbol}</small></strong>
  </div>;
  return <div className={`limit money-limit${stale?' is-stale':''}`}>
    <div className="limit-top"><span className="limit-name" title={detail}>{keyName(part)}<KeyStatus part={part} cap={cap}/></span>
      <span className={`limit-value v-${remaining===null?'ok':level(remaining)}`} title={limit.unavailable?'':money(capLeft(cap),cap.unit,true,context)}>{value}<small>{symbol}</small></span>
    </div>
    {bar}
    <div className="limit-bottom"><span title={limit.unavailable?'':money(cap.limit,cap.unit,true,context)}>{t('money.of',{amount:limit.unavailable?'— '+symbol:money(cap.limit,cap.unit,false,context)})}</span>{remaining===null?<span>{t('money.exhausted')}</span>:<CapReset meter={cap}/>}</div>
  </div>;
}
export function KeyMetrics({part,meters,compact=false}:{part:KeyPart;meters:readonly Meter[];compact?:boolean}) {
  const cap=meters.find(m=>m.id===`key:${part.id}:cap`);if(!cap)return null;
  return <CapMetrics cap={cap} name={keyName(part)} detail={[keyName(part),part.includeByok?t('money.byok'):''].filter(Boolean).join('\n')} status={<CapStatus part={part} cap={cap}/>} compact={compact}/>;
}
export function QuotaCard({source,ids=QUOTA_IDS,compact=false}:{source:Card;ids?:readonly string[];compact?:boolean}) {
  return <>{ids.map(id=>{
    const cap=source.meters?.find(m=>m.id===id),used=cap?capPercent(cap):null;
    const detail=cap?`${money(capLeft(cap),cap.unit,true)}\n${t('money.of',{amount:money(cap.limit,cap.unit,true)})}\n${cap.resetAt===null?t('limit.resetUnknown'):stamp(cap.resetAt)}${used===null?`\n${t('money.exhausted')}`:''}`:t('quota.unavailable');
    return <PercentLimit key={id} name={capName({id,scope:null,label:null})} remaining={used===null?null:100-used}
      valueTitle={detail} status={<CapStatus cap={cap}/>} reset={<QuotaReset resetAt={cap?.resetAt??null} short={compact}/>} compact={compact}/>;
  })}</>;
}
function QuotaReset({resetAt,short}:{resetAt:number|null;short:boolean}) {
  const now=useClock(now=>resetLineChangesAt({resetAt},now));
  return <ResetText resetAt={resetAt} now={now} short={short}/>;
}
export function QuotaMark({source}:{source:Card}) {
  if(!source.quota||source.quota.complete)return null;
  const text=messageOf(new ApiError(400,'connector_quota_'+(source.quota.generation?'partial':source.quota.issue)));
  return <Popover label={text} up align="left" triggerClass="tray-pill is-warn" trigger={<svg className="tray-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3h.01"/></svg>}><div className="tray-panel"><p className="tray-panel-lead">{text}</p><p>{t('quota.budgetOnly')}</p></div></Popover>;
}
export function MoneyCard({source,board,view,compact=false}:{source:Card;board:string;view?:View;compact?:boolean}) {
  const context=useCurrencyContext(source.id);
  const {keys,meters,error}=useShownKeys(source,view,board);
  const {remaining,limits}=budgetView(source,keys,meters,context),groups=remaining.values;
  const displayUnavailable=!groups.length&&(source.currencyUnavailable||balanceGroups(source).some(g=>!g.total.stale));
  const composition=groups.filter(group=>group.components.length||group.approximate);
  const proof=groups[0]?.total.conversion;
  const referenceRate=proof&&(proof.steps??[proof.rate]).find(r=>r.source!=='manual');
  const quoted=referenceRate&&new Date(referenceRate.date);
  const quoteDate=quoted?day(new Date(quoted.getUTCFullYear(),quoted.getUTCMonth(),quoted.getUTCDate()).getTime()):'';
  const rateSources=proof?[...new Set((proof.steps??[proof.rate]).map(r=>r.source==='manual'?t('money.personalRate'):r.source.toUpperCase()))].join(', '):'';
  const conversion=proof?t(!referenceRate?'money.fixedEstimate':'money.currencyEstimate',{amount:money(proof.original.amount,proof.original.unit,true,context),source:rateSources,date:quoteDate}):'';
  const breakdown=<div className="money-breakdown">{composition.map(({total,components,approximate})=><section key={total.id}>
    <div className={`money-breakdown-total${total.stale?' is-stale':''}`} title={[money(total.amount,total.unit,true,context),stamp(total.at),total.stale?t('money.stale'):''].filter(Boolean).join('\n')}><strong>{currencySymbol(total.unit,context)}</strong><span>{approximate?'≈ ':''}{money(total.amount,total.unit,false,context)}</span></div>
    {components.map(({meter,role})=><div key={meter.id} className={meter.stale?'is-stale':''} title={[money(meter.amount,meter.unit,true,context),stamp(meter.at),meter.stale?t('money.stale'):''].filter(Boolean).join('\n')}><span>{balanceRoleLabel(role)}</span><span>{approximate?'≈ ':''}{money(meter.amount,meter.unit,false,context)}</span></div>)}
    {approximate&&conversion&&<p className="popover-note">{conversion}</p>}
  </section>)}</div>;
  return <div className="money-body">
    <div className="money-balance">
      <span>{t('money.accountBalance')}</span>
      <div className="money-balance-values">{!groups.length?<span className="limit-value" title={displayUnavailable?t('money.noDisplayBalance',{currency:context.target.symbol}):t('money.noBalance')}>—<small>{context.target.symbol}</small></span>:groups.map(({total,approximate})=>{
        const formatted=money(total.amount,total.unit,false,context),symbol=currencySymbol(total.unit,context),amount=formatted.slice(0,-symbol.length-1);
        const value=<span key={total.id} className={`limit-value${total.stale?' is-stale':''}`} data-money={total.amount} title={[money(total.amount,total.unit,true,context),stamp(total.at),approximate?conversion:'',total.stale?t('money.stale'):''].filter(Boolean).join('\n')}>{approximate?'≈ ':''}{amount}<small>{symbol}</small></span>;
        return composition.length?<Popover key={total.id} label={t('money.breakdown')} trigger={value} triggerClass="money-balance-trigger" up>{breakdown}</Popover>:value;
      })}</div>
    </div>
    <div className="limits money-limits">{limits.map(limit=><BudgetKeyMetrics key={limit.scope.id} limit={limit} context={context} compact={compact}/>)}</div>
    <ErrorLine error={error}/>
  </div>;
}
/** Safe supplier facts use the existing news mark, with their own freshness. */
export function BalanceMark({source}:{source:Card}) {
  const context=useCurrencyContext(source.id),unavailable=!budgetView(source,[],source.meters??[],context).remaining.values.length&&(source.currencyUnavailable||balanceGroups(source).some(g=>!g.total.stale));
  const status=source.balanceStatus;
  const now=useClock(now=>status&&now<=status.at+status.staleAfterMs?status.at+status.staleAfterMs+1:null);
  if(!unavailable&&(!status||status.isAvailable&&!status.partial))return null;
  const lines=[...(unavailable?[t('money.noDisplayBalance',{currency:context.target.symbol})]:[]),...(status&&!status.isAvailable?[t('money.balanceUnavailable')]:[]),...(status?.issues.includes('empty_balances')?[t('money.noBalance')]:status?.partial?[t('money.balancePartial')]:[]),...(status?[stamp(status.at),...(now>status.at+status.staleAfterMs?[t('money.stale')]:[])]:[])];
  return <span data-time="balance-status"><Popover label={lines.join('\n')} up align="left" triggerClass="tray-pill" trigger={<span aria-hidden="true">!</span>}><div className="tray-panel"><div className="tray-panel-head">{lines.map((line,i)=><p key={i} className={i?'tray-panel-when':'tray-panel-lead'}>{line}</p>)}</div></div></Popover></span>;
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
