import {amount,decimal} from '../domain/amount.js';
import {usdRateOf,type MeterMeasurement,type UsdRate} from '../domain/meters.js';

const DAY=86_400_000;
const RATE_URL='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const usable=(rate:UsdRate,at:number)=>rate.date<=at&&at-rate.date<7*DAY;

/** ECB quotes both currencies against EUR; the ratio avoids floating-point amounts. */
export function parseUsdRate(xml:string,at:number):UsdRate {
  if(xml.length>65_536)throw new Error('invalid_rate');
  const dates=[...xml.matchAll(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>/g)];
  if(dates.length!==1)throw new Error('invalid_rate');
  const day=dates[0][1],date=Date.parse(day+'T00:00:00Z');
  if(!Number.isSafeInteger(date)||new Date(date).toISOString().slice(0,10)!==day)throw new Error('invalid_rate');
  const values=new Map<string,string>();
  for(const match of xml.matchAll(/<Cube\s+currency=['"](USD|CNY)['"]\s+rate=['"]([0-9]+(?:\.[0-9]+)?)['"]\s*\/>/g)) {
    if(values.has(match[1]))throw new Error('invalid_rate');
    const value=decimal(match[2]);if(value<=0n)throw new Error('invalid_rate');values.set(match[1],value.toString());
  }
  const usdPerEur=values.get('USD'),cnyPerEur=values.get('CNY');
  if(!usdPerEur||!cnyPerEur)throw new Error('invalid_rate');
  const rate={date,at,usdPerEur,cnyPerEur};if(!usable(rate,at))throw new Error('invalid_rate');
  return usdRateOf(rate);
}

/** This public read never receives a provider key; source polling supplies its cadence. */
export function deepSeekRateReader(read:typeof fetch=fetch,now=Date.now):(signal?:AbortSignal)=>Promise<UsdRate|undefined> {
  let cached:UsdRate|undefined,checkedAt=-Infinity;
  return async signal=>{
    const at=now();
    if(at-checkedAt<12*3_600_000&&cached&&usable(cached,at))return cached;
    if(at-checkedAt<300_000)return undefined;
    try {
      const response=await read(RATE_URL,{headers:{Accept:'application/xml'},redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(5_000),...(signal?[signal]:[])])});
      if(!response.ok||!response.body||!response.headers.get('content-type')?.includes('xml'))throw new Error('invalid_rate');
      const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
      try {
        for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65_536)throw new Error('invalid_rate');parts.push(part.value);}
      }finally{await reader.cancel();}
      const observed=now(),rate=parseUsdRate(Buffer.concat(parts).toString('utf8'),observed);
      if(!cached||rate.date>=cached.date)cached=rate;
      checkedAt=observed;
      return cached&&usable(cached,observed)?cached:undefined;
    }catch {
      checkedAt=now();return cached&&usable(cached,checkedAt)?cached:undefined;
    }
  };
}

export function cnyInUsd(value:string,rate:UsdRate):string {
  const original=amount(value),numerator=(original<0n?-original:original)*amount(rate.usdPerEur),denominator=amount(rate.cnyPerEur);
  if(denominator<=0n||amount(rate.usdPerEur)<=0n)throw new Error('invalid_rate');
  const rounded=numerator/denominator+(numerator%denominator*2n>=denominator?1n:0n);
  const result=(original<0n?-rounded:rounded).toString();amount(result);return result;
}

/** Native USD wins. CNY observations and their dated USD estimates remain separate. */
export function deepSeekUsd(measurement:MeterMeasurement,rate?:UsdRate):MeterMeasurement {
  if(measurement.meters.some(m=>m.id==='balance:USD'))return measurement;
  const originals=measurement.meters.filter(m=>m.unit==='CNY');
  if(!originals.length)return measurement;
  if(!rate||!usable(rate,measurement.observedAt))return {...measurement,balanceStatus:measurement.balanceStatus?{...measurement.balanceStatus,partial:true,issues:[...measurement.balanceStatus.issues,'rate_unavailable']}:undefined};
  rate=usdRateOf(rate);
  const converted=originals.map(m=>({...m,id:'converted:'+m.id.split(':')[0]+':USD',unit:'USD',amount:cnyInUsd(m.amount,rate),scope:'ecb:'+new Date(rate.date).toISOString().slice(0,10),label:'≈ CNY → USD (ECB)'}));
  return {...measurement,meters:[...measurement.meters,...converted],usdRate:rate};
}
