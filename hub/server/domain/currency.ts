import {amount, amountScale} from './amount.js';

/** The initial display policy; widgets never pick a currency of their own. */
export const DEFAULT_CURRENCY='USD';
export type CurrencyDefinition={id:string;name:string;symbol:string;fractionDigits:number;kind?:'provider-credit'};
export const codexCredit:CurrencyDefinition={id:'credits:codex',name:'Codex credits',symbol:'credits',fractionDigits:2,kind:'provider-credit'};
export const codexDefault=(fetchedAt:number):ExchangeRates=>({source:'codex-default',base:codexCredit.id,date:0,fetchedAt,validUntil:null,rates:{[codexCredit.id]:'1000000',USD:'40000'}});
export const defaultCurrency:CurrencyDefinition={id:DEFAULT_CURRENCY,name:DEFAULT_CURRENCY,symbol:DEFAULT_CURRENCY,fractionDigits:2};
export type Money={amount:string;unit:string;scale?:number};
export type ExchangeRates={source:string;base:string;date:number;fetchedAt:number;rates:Record<string,string>;validUntil?:number|null};
export type RateSnapshot=ExchangeRates&{id:string};
export type RateLeg={id:string;source:string;base:string;date:number;fetchedAt:number;from:string;to:string};
export type Conversion={original:Money&{meterId:string;at:number;limit?:string|null};rate:RateLeg;steps?:RateLeg[]};
export type CurrencyBinding={from:string;at:number;anchor:string|null;steps:RateLeg[]};
export type CurrencyContext={target:CurrencyDefinition;definitions:CurrencyDefinition[];revision?:string;registryRevision?:string;sources:Record<string,CurrencyBinding[]>};
export type ManagedCurrency={definition:CurrencyDefinition;archivedAt:number|null};
export type CurrencyRateSummary={base:string;rate:string|null;direction?:'unitPerBase'|'basePerUnit';standard?:boolean};
export type CurrencyManagement={registryRevision:string;selected:string;standards:CurrencyDefinition[];personal:(ManagedCurrency&{pairs:CurrencyRateSummary[]})[];maxActive:number;builtins?:{definition:CurrencyDefinition;pairs:CurrencyRateSummary[]}[]};
export type CurrencyRateChange={sequence:number;base:string;effectiveAt:number;recordedAt:number;kind:'rate'|'stop';quote:RateSnapshot|null;nominal:boolean};
export type CurrencyRateHistory=ManagedCurrency&{pairs:CurrencyRateChange[];changes:CurrencyRateChange[];nextCursor:string|null};
export type CurrencyMutation={expectedRevision:string;requestId:string};
export const defaultCurrencyContext:CurrencyContext={target:defaultCurrency,definitions:[defaultCurrency],sources:{}};
export const isCurrency=(unit:string)=>/^(?:[A-Z]{3}|personal:[0-9a-f]{24})$/.test(unit);
export const isConvertible=(unit:string)=>isCurrency(unit)||unit===codexCredit.id;
export const conversionId=(native:string,target:string)=>`fx:${target}:${native}`;
export function conversionOrigin(id:string):{unit:string;meter:string}|null {
  const match=/^fx:([A-Z]{3}|personal:[0-9a-f]{24}):([A-Za-z0-9:_-]{1,120})$/.exec(id);
  return match?{unit:match[1],meter:match[2]}:null;
}
export function currencyDefinitionOf(input:CurrencyDefinition):CurrencyDefinition {
  if(!isCurrency(input.id)||typeof input.name!=='string'||!input.name.trim()||input.name.length>64||typeof input.symbol!=='string'||!input.symbol.trim()||input.symbol.length>12||/[\p{Cc}\p{Cf}]/u.test(input.name+input.symbol)||!Number.isInteger(input.fractionDigits)||input.fractionDigits<0||input.fractionDigits>6)throw new Error('invalid_currency');
  return {id:input.id,name:input.name.trim(),symbol:input.symbol.trim(),fractionDigits:input.fractionDigits};
}
export function exchangeRatesOf(input:ExchangeRates):ExchangeRates {
  if(typeof input.source!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(input.source)||!isConvertible(input.base)||!Number.isSafeInteger(input.date)||input.date<0||!Number.isSafeInteger(input.fetchedAt)||input.fetchedAt<input.date||input.validUntil!==undefined&&input.validUntil!==null&&(!Number.isSafeInteger(input.validUntil)||input.validUntil<=input.date))throw new Error('invalid_exchange_rates');
  const rates:Record<string,string>={};
  for(const [unit,value] of Object.entries(input.rates).sort(([a],[b])=>a.localeCompare(b))){if(!isConvertible(unit)||amount(value)<=0n)throw new Error('invalid_exchange_rates');rates[unit]=amount(value).toString();}
  if(rates[input.base]!=='1000000')throw new Error('invalid_exchange_rates');
  return {source:input.source,base:input.base,date:input.date,fetchedAt:input.fetchedAt,rates,...(input.validUntil===undefined?{}:{validUntil:input.validUntil})};
}
export const ratesCover=(rates:ExchangeRates,at:number)=>rates.date<=at&&(rates.validUntil===null||at<(rates.validUntil??rates.date+7*86_400_000));

/** Round once after the complete path, including amounts above Number precision. */
export function convertBy(amountValue:string,steps:readonly Pick<RateLeg,'from'|'to'>[],scale=6):string {
  const value=amount(amountValue);let numerator=value<0n?-value:value,denominator=1n;
  const shift=6-amountScale(scale);if(shift>=0)numerator*=10n**BigInt(shift);else denominator*=10n**BigInt(-shift);
  for(const step of steps){const from=amount(step.from),to=amount(step.to);if(from<=0n||to<=0n)throw new Error('invalid_exchange_rates');numerator*=to;denominator*=from;}
  const rounded=numerator/denominator+(numerator%denominator*2n>=denominator?1n:0n),result=(value<0n?-rounded:rounded).toString();amount(result);return result;
}
export function convertMoney(original:Money,target:string,rates:ExchangeRates):Money|null {
  amount(original.amount);if(!isConvertible(original.unit)||!isCurrency(target))return null;
  if(original.unit===target)return {amount:convertBy(original.amount,[],original.scale),unit:target};
  const from=rates.rates[original.unit],to=rates.rates[target];if(!from||!to)return null;
  return {amount:convertBy(original.amount,[{from,to}],original.scale),unit:target};
}
export function ratePath(from:string,to:string,snapshots:readonly RateSnapshot[],at:number,anchor?:string|null):RateLeg[]|null {
  if(from===to)return [];
  const usable=snapshots.filter(s=>ratesCover(s,at)).sort((a,b)=>(a.id===anchor?-1:b.id===anchor?1:0)||b.date-a.date||b.fetchedAt-a.fetchedAt);
  const leg=(s:RateSnapshot,a:string,b:string):RateLeg=>({id:s.id,source:s.source,base:s.base,date:s.date,fetchedAt:s.fetchedAt,from:s.rates[a],to:s.rates[b]});
  for(const s of usable)if(s.rates[from]&&s.rates[to])return [leg(s,from,to)];
  // Index the earliest eligible first leg for each bridge, preserving path priority.
  const bridges=new Map<string,{snapshot:RateSnapshot;rank:number;order:number}>();
  for(const [rank,snapshot] of usable.entries())if(snapshot.rates[from])for(const [order,unit] of Object.keys(snapshot.rates).entries()) {
    if(unit!==from&&unit!==to&&!bridges.has(unit))bridges.set(unit,{snapshot,rank,order});
  }
  for(const last of usable)if(last.rates[to]) {
    let selected:{unit:string;snapshot:RateSnapshot;rank:number;order:number}|null=null;
    for(const unit of Object.keys(last.rates)) {
      const first=bridges.get(unit);
      if(first&&(!selected||first.rank<selected.rank||first.rank===selected.rank&&first.order<selected.order))selected={unit,...first};
    }
    if(selected)return [leg(selected.snapshot,from,selected.unit),leg(last,selected.unit,to)];
  }
  return null;
}
export const currencySymbol=(unit:string,context:Pick<CurrencyContext,'definitions'>=defaultCurrencyContext)=>context.definitions.find(c=>c.id===unit)?.symbol??unit;
export function bindingOf(context:CurrencyContext,source:string,from:string,at:number,anchor:string|null=null):RateLeg[]|null {
  if(from===context.target.id)return [];
  return context.sources[source]?.find(b=>b.from===from&&b.at===at&&b.anchor===anchor)?.steps??null;
}
