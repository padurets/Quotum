import {amount,isUnit} from './amount.js';

export type Money={amount:string;unit:string};
export type ExchangeRates={source:'ecb';base:string;date:number;fetchedAt:number;rates:Record<string,string>};
export type RateSnapshot=ExchangeRates&{id:string};
export type Conversion={
  original:Money&{meterId:string;at:number};
  rate:{id:string;source:ExchangeRates['source'];base:string;date:number;fetchedAt:number;from:string;to:string};
};
export const isCurrency=(unit:string)=>isUnit(unit)&&/^[A-Z]{3}$/.test(unit);
export const conversionId=(native:string,target:string)=>`fx:${target}:${native}`;
export function conversionOrigin(id:string):{unit:string;meter:string}|null {
  const match=/^fx:([A-Z]{3}):([A-Za-z0-9:_-]{1,120})$/.exec(id);
  return match?{unit:match[1],meter:match[2]}:null;
}
export function exchangeRatesOf(input:ExchangeRates):ExchangeRates {
  if(input.source!=='ecb'||!isCurrency(input.base)||!Number.isSafeInteger(input.date)||input.date<0||input.date%86_400_000!==0||!Number.isSafeInteger(input.fetchedAt)||input.fetchedAt<input.date)throw new Error('invalid_exchange_rates');
  const rates:Record<string,string>={};
  for(const [unit,value] of Object.entries(input.rates).sort(([a],[b])=>a.localeCompare(b))) {
    if(!isCurrency(unit)||amount(value)<=0n)throw new Error('invalid_exchange_rates');rates[unit]=amount(value).toString();
  }
  if(rates[input.base]!=='1000000')throw new Error('invalid_exchange_rates');
  return {source:input.source,base:input.base,date:input.date,fetchedAt:input.fetchedAt,rates};
}
export const ratesCover=(rates:ExchangeRates,at:number)=>rates.date<=at&&at-rates.date<7*86_400_000;

/** Exact money arithmetic; reference data and provider identity belong to callers. */
export function convertMoney(original:Money,target:string,rates:ExchangeRates):Money|null {
  amount(original.amount);
  if(!isCurrency(original.unit)||!isCurrency(target))return null;
  if(original.unit===target)return {amount:original.amount,unit:target};
  const from=rates.rates[original.unit],to=rates.rates[target];if(!from||!to)return null;
  const value=amount(original.amount),numerator=(value<0n?-value:value)*amount(to),denominator=amount(from);
  if(denominator<=0n||amount(to)<=0n)return null;
  const rounded=numerator/denominator+(numerator%denominator*2n>=denominator?1n:0n);
  const result=(value<0n?-rounded:rounded).toString();amount(result);return {amount:result,unit:target};
}
