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
/** Geometry may be clipped; only certified endpoints can date an observation. */
export function spanObservedAt(span:Pick<MeterSpan,'to'|'observedFrom'>,at:number,inclusive=false):number|null {
  if(span.to<at||inclusive&&span.to===at)return span.to;
  return span.observedFrom!==undefined&&(span.observedFrom<at||inclusive&&span.observedFrom===at)?span.observedFrom:null;
}
export const observedAt=(reading:Pick<Reading,'at'>,span:MeterSpan|undefined,at:number,inclusive=false)=>
  Math.max(reading.at,span?spanObservedAt(span,at,inclusive)??reading.at:reading.at);
/** A legacy clipped head is not proof, even if an older reader bound a rate there. */
export function valuationAt(reading:Pick<Reading,'at'>,span:MeterSpan|undefined,at:number,inclusive=false,binding:number|null=null) {
  const observed=observedAt(reading,span,at,inclusive);
  const head=span?.observedFrom;
  const proven=span&&binding!==null&&(binding===reading.at||binding===span.to||
    (head!==undefined?binding>=head:binding>span.from));
  return proven&&binding!==null&&binding<=span.to&&(binding<at||inclusive&&binding===at)?Math.max(observed,binding):observed;
}
