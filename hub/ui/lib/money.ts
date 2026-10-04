import {monetaryOf,balanceDescriptor} from '../../server/domain/providers';
import type {Card} from './types';
import {t} from '../i18n';
import type {Meter,KeyPart} from '../../server/domain/meters';
import type {SourceAccess} from '../../server/secrets/credentials';
import {countdownChangesAt} from './format';
import {formatLocale} from '../i18n';

/** Display rounding never feeds the ledger, including values above Number precision. */
export function money(value:string|null|undefined,unit='USD',exact=false):string {
  if(value==null)return '—';
  const raw=BigInt(value),negative=raw<0n,absolute=negative?-raw:raw;
  const digits=exact||absolute>0n&&absolute<10_000n?6:2;
  const divisor=10n**BigInt(6-digits),rounded=(absolute+divisor/2n)/divisor,scale=10n**BigInt(digits);
  const whole=new Intl.NumberFormat(formatLocale(),{maximumFractionDigits:0}).format(rounded/scale);
  const separator=new Intl.NumberFormat(formatLocale()).formatToParts(1.1).find(p=>p.type==='decimal')?.value??'.';
  let fraction=(rounded%scale).toString().padStart(digits,'0');
  if(digits===6&&!exact)fraction=fraction.replace(/0+$/,'');
  return `${negative?'−':''}${whole}${fraction?separator+fraction:''} ${unit}`;
}
export const keyName=(key:Pick<KeyPart,'id'|'name'>)=>key.name??key.id;
export const capLeft=(meter:Meter)=>(BigInt(meter.limit!)-BigInt(meter.amount)).toString();
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
  return (monetaryOf(source.provider)?.balances??[]).filter(d=>d.role==='total').flatMap(d=>{
    const total=source.meters?.find(m=>m.id===d.meterId&&m.unit===d.unit);
    if(!total)return [];
    const components=(source.meters??[]).flatMap(m=>{const role=balanceDescriptor(source.provider,m.id)?.role;return m.unit===d.unit&&role&&role!=='total'?[{meter:m,role}]:[];});
    return [{total,components}];
  });
}
export const balanceRoleLabel=(role:'total'|'granted'|'toppedUp')=>t(`money.${role}`);
