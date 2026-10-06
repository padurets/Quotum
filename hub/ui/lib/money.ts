import {DEFAULT_CURRENCY,defaultCurrencyContext,currencySymbol,type CurrencyContext} from '../../server/domain/currency';
import {displayMeter,convertedRemaining} from '../../server/domain/currencyPresentation';
import {monetaryOf,providerOf} from '../../server/domain/providers';
import type {Card} from './types';
import {t} from '../i18n';
import type {Meter,KeyPart} from '../../server/domain/meters';
import type {SourceAccess} from '../../server/secrets/credentials';
import {countdownChangesAt} from './format';
import {formatLocale} from '../i18n';

/** Display rounding never feeds the ledger, including values above Number precision. */
export function money(value:string|null|undefined,unit=DEFAULT_CURRENCY,exact=false,context:CurrencyContext=defaultCurrencyContext):string {
  if(value==null)return '—';
  const raw=BigInt(value),negative=raw<0n,absolute=negative?-raw:raw;
  const precision=context.definitions.find(d=>d.id===unit)?.fractionDigits??2;
  const digits=exact||absolute>0n&&absolute<10n**BigInt(6-precision)?6:precision;
  const divisor=10n**BigInt(6-digits),rounded=(absolute+divisor/2n)/divisor,scale=10n**BigInt(digits);
  const whole=new Intl.NumberFormat(formatLocale(),{maximumFractionDigits:0}).format(rounded/scale);
  const separator=new Intl.NumberFormat(formatLocale()).formatToParts(1.1).find(p=>p.type==='decimal')?.value??'.';
  let fraction=digits?(rounded%scale).toString().padStart(digits,'0'):'';
  if(digits===6&&!exact)fraction=fraction.replace(/0+$/,'');
  return `${negative?'−':''}${whole}${fraction?separator+fraction:''} ${currencySymbol(unit,context)}`;
}
export const keyName=(key:Pick<KeyPart,'id'|'name'>)=>key.name??key.id;
export const capLeft=convertedRemaining;
export const capStale=(meter:Meter,now:number)=>meter.stale||now>meter.at+meter.staleAfterMs||meter.resetAt!==null&&meter.resetAt<=now;
export function capChangesAt(meter:Meter,now:number):number|null {
  if(capStale(meter,now))return null;
  const staleAt=meter.at+meter.staleAfterMs+1;
  return meter.resetAt===null?staleAt:Math.min(staleAt,meter.resetAt);
}
export function capPercent(meter:Meter):number|null {
  const limit=BigInt(meter.limit??'0');if(limit<=0n)return null;
  const basis=BigInt(meter.amount)*10_000n/limit;
  return Number(basis<0n?0n:basis>10_000n?10_000n:basis)/100;
}

export const ACCESS_WARNING_MS = 7 * 86_400_000;
type Access = Pick<SourceAccess,'error'|'expiresAt'>;

/** No expiry is ordinary access; only a failed access or a deadline needs attention. */
export function accessTone(access:Access,now:number):'crit'|'warn'|'neutral'|null {
  if(access.expiresAt!==null&&access.expiresAt<=now||access.error?.startsWith('credential_')||access.error?.startsWith('secret_key_'))return 'crit';
  if(access.error||access.expiresAt!==null&&access.expiresAt-now<=ACCESS_WARNING_MS)return 'warn';
  return access.expiresAt===null?null:'neutral';
}

export function accessChangesAt(access:Access|null|undefined,now:number):number|null {
  if(!access||access.expiresAt===null||access.expiresAt<=now)return null;
  const at=access.expiresAt;
  if(accessTone(access,now)==='crit')return at;
  const warning=at-ACCESS_WARNING_MS;
  return warning>now?warning:Math.min(at,countdownChangesAt(at,now)??at);
}

export function balanceGroups(source:Pick<Card,'provider'|'meters'>) {
  const descriptors=monetaryOf(source.provider)?.balances??[],meters=source.meters??[];
  return descriptors.filter(d=>d.role==='total').flatMap(d=>{
    const totals=meters.filter(m=>m.kind==='balance'&&(m.id===d.meterId&&m.unit===d.unit&&!m.conversion||m.conversion?.original.meterId===d.meterId));
    return totals.map(total=>{
      const components=descriptors.flatMap(part=>{
        if(part.unit!==d.unit||part.role==='total')return [];
        const meter=meters.find(m=>m.kind==='balance'&&(total.conversion
          ?m.unit===total.unit&&m.conversion?.original.meterId===part.meterId&&m.conversion.rate.id===total.conversion.rate.id
          :m.id===part.meterId&&m.unit===part.unit&&!m.conversion));
        return meter?[{meter,role:part.role}]:[];
      });
      return {total,components,approximate:!!total.conversion};
    });
  });
}
export function referenceBalance(source:Pick<Card,'provider'|'meters'>,foreignFallback=false) {
  const all=balanceGroups(source),groups=all.filter(g=>g.total.unit===DEFAULT_CURRENCY),foreign=all.filter(g=>!g.approximate&&g.total.unit!==DEFAULT_CURRENCY);
  return groups.find(g=>!g.approximate)??groups[0]??(foreignFallback&&foreign.length===1?foreign[0]:undefined);
}
type BudgetKey=Pick<KeyPart,'id'|'name'|'disabled'|'expiresAt'|'includeByok'|'presence'>;
export type BudgetLimit={scope:{kind:'key';id:string};part:BudgetKey;meter:Meter;native:Meter;unavailable?:boolean};
export type BudgetView={
  remaining:{kind:'funds';values:ReturnType<typeof balanceGroups>};
  limits:BudgetLimit[];
};

/** Cards show current funds and selected allowances; accounting stays in analytics. */
export function budgetView(source:Pick<Card,'id'|'provider'|'meters'>,keys:readonly KeyPart[]=[],meters:readonly Meter[]=source.meters??[],context:CurrencyContext=defaultCurrencyContext):BudgetView {
  const byId=new Map(meters.map(m=>[m.id,m]));
  const caps=providerOf(source.provider)?.meterKinds.some(kind=>kind==='cap');
  const limits=caps?keys.flatMap(part=>{
    const meter=byId.get(`key:${part.id}:cap`);
    const {id,name,disabled,expiresAt,includeByok,presence}=part;
    const shown=meter&&displayMeter(meter,source.id,context);
    return meter?.kind==='cap'&&meter.limit!==null?[{scope:{kind:'key' as const,id},part:{id,name,disabled,expiresAt,includeByok,presence},meter:shown??meter,native:meter,...(!shown?{unavailable:true}:{})}]:[];
  }):[];
  let balance=referenceBalance(source,true);
  if(balance?.approximate&&context.target.id!==DEFAULT_CURRENCY){const original=balanceGroups(source).find(g=>!g.approximate&&g.total.id===balance!.total.conversion?.original.meterId);if(original&&displayMeter(original.total,source.id,context))balance=original;}
  const shown=balance&&displayMeter(balance.total,source.id,context);
  const components=balance?.components.flatMap(part=>{const meter=displayMeter(part.meter,source.id,context);return meter?[{...part,meter}]:[];})??[];
  return {remaining:{kind:'funds',values:shown?[{total:shown,components,approximate:!!shown.conversion}]:[]},limits};
}
export const balanceRoleLabel=(role:'total'|'granted'|'toppedUp')=>t(`money.${role}`);
