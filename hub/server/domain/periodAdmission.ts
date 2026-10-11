import type {MeterSpan,Reading} from './meters.js';
import {valuationAt} from './periodMoney.js';

/** Remove evidence whose observation has not reached the response's exclusive cut. */
export function admitSpan(span:MeterSpan,cut:number,reading?:Reading,binding:number|null=null):MeterSpan|undefined {
  if(span.from>=cut)return undefined;
  if(span.to<cut&&(span.interruptedAt??-Infinity)<cut&&(span.holdUntil??-Infinity)<cut)return span;
  const admitted={...span};
  if(admitted.interruptedAt!==undefined&&admitted.interruptedAt>=cut)delete admitted.interruptedAt;
  if(admitted.holdUntil!=null&&admitted.holdUntil>=cut)delete admitted.holdUntil;
  if(span.to<cut)return admitted;
  const head=span.observedFrom!==undefined&&span.observedFrom<cut?span.observedFrom:null;
  const sample=reading&&reading.at<cut&&reading.at>=(span.observedFrom??span.from)&&reading.at<=span.to?reading:undefined;
  let at=Math.max(head??-Infinity,sample?.at??-Infinity);
  if(binding!==null&&binding<cut&&valuationAt(sample??{at:head??-Infinity},span,cut,false,binding)===binding)at=Math.max(at,binding);
  // A clipped geometry boundary cannot replace a lost observation head.
  if(!Number.isFinite(at)||at<span.from)return undefined;
  admitted.to=at;
  // Compression retained the future endpoint's TTL, not the earlier heartbeat's.
  admitted.staleAfterMs=sample?.at===at?sample.staleAfterMs:0;
  if(head===null)delete admitted.observedFrom;
  return admitted;
}

export function admitAvailability<T extends {validUntil?:number}>(sample:T,cut:number):T {
  if(sample.validUntil!==undefined&&sample.validUntil>=cut)delete sample.validUntil;
  return sample;
}
