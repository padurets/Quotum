import type {Meter,KeyPart} from '../../server/domain/meters';
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
export function capPercent(meter:Meter):number|null {
  const limit=BigInt(meter.limit??'0');if(limit<=0n)return null;
  const basis=BigInt(meter.amount)*10_000n/limit;
  return Number(basis<0n?0n:basis>10_000n?10_000n:basis)/100;
}
