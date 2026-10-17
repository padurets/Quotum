import {edge, type Sample} from './quota.js';
import type {Meter, MeterSpan} from './meters.js';

export type UsageWork={windowId:string;from:number;to:number;growth:number;quality:'confirmed'|'partial';expiresAt:number};
export type UsageStep=Omit<UsageWork,'quality'|'expiresAt'> & {resetAt:number|null};
export type UsageSample=Pick<Sample,'at'|'used'|'resetAt'|'staleAfterMs'|'validUntil'>;
function grewOnePoint(before:number,after:number):boolean {
  const whole=Math.floor(after)-Math.floor(before);
  if(whole!==1)return whole>1;
  // Compare the native decimal endpoints, including exponent notation, without
  // rounding either one or adding a point in binary floating-point arithmetic.
  const parts=(input:number)=>{
    const [value,exponent='0']=String(input).split('e'),[integer,fraction='']=value.split('.');
    return {amount:BigInt(integer+fraction),scale:fraction.length-Number(exponent)};
  };
  const a=parts(before),b=parts(after),scale=Math.max(0,a.scale,b.scale);
  return b.amount*10n**BigInt(scale-b.scale)-a.amount*10n**BigInt(scale-a.scale)>=10n**BigInt(scale);
}
export function quotaSteps(windowId:string,samples:UsageSample[]):UsageStep[] {
  const steps:UsageStep[]=[];
  for(let i=1;i<samples.length;i++) {const a=samples[i-1],b=samples[i],step=edge(a,b);
    if(step.valid&&grewOnePoint(a.used,b.used)&&b.at-a.at<=30*60_000&&a.resetAt!==null&&b.at<a.resetAt)steps.push({windowId,from:a.at,to:b.at,growth:step.delta,resetAt:b.resetAt});
  }
  return steps;
}
export type QuotaAnchor=Meter & {generation:string|null};
export function capSteps(windowId:string,readings:QuotaAnchor[],spans:MeterSpan[]):UsageStep[] {
  const result:UsageStep[]=[];
  for(let i=1;i<readings.length;i++) {
    const a=readings[i-1],b=readings[i];
    if(a.kind!=='cap'||b.kind!=='cap'||a.limit===null||a.limit!==b.limit||BigInt(a.limit)<=0n||a.unit!==b.unit||a.generation!==b.generation||a.generation===null||a.resetAt===null||b.resetAt!==a.resetAt||b.at>=a.resetAt||b.at<=a.at||b.at-a.at>Math.min(a.staleAfterMs,30*60_000)||!spans.some(s=>s.from<=a.at&&s.to>=b.at&&b.at<(s.interruptedAt??Infinity)&&b.at<(s.holdUntil??Infinity)))continue;
    const delta=BigInt(b.amount)-BigInt(a.amount),limit=BigInt(a.limit);
    if(delta*100n<limit)continue;
    const growth=Number(delta*1000000n/limit)/10000;
    result.push({windowId,from:a.at,to:b.at,growth,resetAt:b.resetAt});
  }
  return result;
}
