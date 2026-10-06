import {decimal} from '../domain/amount.js';
import {exchangeRatesOf,ratesCover,type ExchangeRates} from '../domain/currency.js';

const URL='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export function parseEcb(xml:string,at:number):ExchangeRates {
  if(xml.length>65_536)throw new Error('invalid_exchange_rates');
  const dates=[...xml.matchAll(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>/g)];
  if(dates.length!==1)throw new Error('invalid_exchange_rates');
  const day=dates[0][1],date=Date.parse(day+'T00:00:00Z');
  if(!Number.isSafeInteger(date)||new Date(date).toISOString().slice(0,10)!==day)throw new Error('invalid_exchange_rates');
  const rates:Record<string,string>={EUR:'1000000'};
  for(const match of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9]+(?:\.[0-9]+)?)['"]\s*\/>/g)) {
    if(Object.hasOwn(rates,match[1]))throw new Error('invalid_exchange_rates');
    rates[match[1]]=decimal(match[2]).toString();
  }
  const result=exchangeRatesOf({source:'ecb',base:'EUR',date,fetchedAt:at,rates});
  if(!rates.USD||!ratesCover(result,at))throw new Error('invalid_exchange_rates');return result;
}
export type RatesReader=(signal:AbortSignal)=>Promise<ExchangeRates>;
/** A public data-source adapter: fixed destination, no credentials or account inputs. */
export function ecbReader(read:typeof fetch=fetch,now=Date.now):RatesReader {
  return async signal=>{
    const response=await read(URL,{headers:{Accept:'application/xml'},redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(5_000)])});
    if(!response.ok||!response.body||!response.headers.get('content-type')?.includes('xml'))throw new Error('exchange_rates_unavailable');
    const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
    try {
      for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65_536)throw new Error('invalid_exchange_rates');parts.push(part.value);}
    }finally{await reader.cancel();}
    return parseEcb(Buffer.concat(parts).toString('utf8'),now());
  };
}
/** Tests and demos replace a source adapter; consumers still use the common service. */
export const rateSources:ReadonlyMap<'ecb',RatesReader>=new Map([['ecb',ecbReader()]]);
