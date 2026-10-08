import {isCurrency,isConvertible,bindingOf,convertBy,conversionId,type CurrencyContext} from './currency.js';
import type {Meter} from './meters.js';

/** Every money surface uses the reader's same target, with the original kept intact. */
export function displayMeter(meter:Meter,source:string,context:CurrencyContext):Meter|null {
  if(!isConvertible(meter.unit))return meter;
  if(meter.unit===context.target.id&&(!meter.conversion||isCurrency(meter.conversion.original.unit)))return meter;
  const original=meter.conversion?.original??{meterId:meter.id,amount:meter.amount,unit:meter.unit,at:meter.at,...(meter.scale===undefined?{}:{scale:meter.scale}),...(meter.kind==='cap'?{limit:meter.limit}:{})};
  const steps=bindingOf(context,source,original.unit,original.at,meter.conversion?.rate.id??null);
  if(!steps)return null;
  const convert=(value:string)=>convertBy(value,steps,original.scale),unit=context.target.id;
  const conversion=steps.length?{original,rate:steps.at(-1)!,...(steps.length>1?{steps}:{} )}:undefined;
  try {return {...meter,scale:6,id:conversionId(original.meterId,unit),unit,amount:convert(original.amount),limit:meter.kind==='cap'&&original.limit!=null?convert(original.limit):meter.limit,...(conversion?{conversion}:{conversion:undefined})};}catch{return null;}
}
export function convertedRemaining(meter:Meter):string {
  const proof=meter.conversion;
  if(proof?.original.limit!=null)return convertBy((BigInt(proof.original.limit)-BigInt(proof.original.amount)).toString(),proof.steps??[proof.rate],proof.original.scale);
  return (BigInt(meter.limit!)-BigInt(meter.amount)).toString();
}
