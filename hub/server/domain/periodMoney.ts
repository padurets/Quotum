import type {MeterSpan,Reading} from './meters.js';

export const spanDeadline=(span:MeterSpan)=>Math.min(span.to+span.staleAfterMs+1,span.holdUntil??Infinity,span.interruptedAt??Infinity);
/** A recovery at the exclusive right edge cannot validate the preceding value. */
export function spanBefore(spans:readonly MeterSpan[],at:number,inclusive=false) {
  let lo=0,hi=spans.length;
  while(lo<hi){const i=(lo+hi)>>>1;if(inclusive?spans[i].from<=at:spans[i].from<at)lo=i+1;else hi=i;}
  return spans[lo-1];
}
export function readingBefore(readings:readonly Reading[],at:number) {
  let lo=0,hi=readings.length;
  while(lo<hi){const i=(lo+hi)>>>1;if(readings[i].at<=at)lo=i+1;else hi=i;}
  return readings[lo-1];
}
/** Only the two retained heartbeat endpoints are known inside a compressed span. */
export const observedAt=(reading:Pick<Reading,'at'>,span:MeterSpan|undefined,at:number,inclusive=false)=>span
  ?Math.max(reading.at,span.to<at||inclusive&&span.to===at?span.to:span.from):reading.at;
/** A recorded valuation is also an observation, but cannot bridge a resource's missing span. */
export function valuationAt(reading:Pick<Reading,'at'>,span:MeterSpan|undefined,at:number,inclusive=false,binding:number|null=null) {
  const observed=observedAt(reading,span,at,inclusive);
  return span&&binding!==null&&binding>=span.from&&binding<=span.to&&(binding<at||inclusive&&binding===at)?Math.max(observed,binding):observed;
}
