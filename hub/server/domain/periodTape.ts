import type {CellSamples} from './cells.js';
import type {MeterGroup} from './meterHistory.js';
import type {RateLeg} from './currency.js';
import {drain,ordered,type Preparation} from './prepare.js';

export type MoneyTape = MeterGroup & {displayUnit?:string;rates?:Record<string,RateLeg[]|null>};
type WindowDescriptor=Pick<import('./quota.js').Win,'id'|'kind'|'label'|'minutes'>;
/** A complete initial tape covers every future position of a live left edge without IO. */
export type PeriodTape = {
  from:number;cut:number;replaceFrom:number;replaceTo?:number;cursor:string;
  quota:(CellSamples&{workFrom?:number;member?:boolean;windowValue?:WindowDescriptor;descriptors?:{at:number;value:WindowDescriptor}[]})[];money:MoneyTape[];
};

function* replace<T>(before:readonly T[],after:readonly T[],keep:(row:T)=>boolean,key:(row:T)=>number):Preparation<T[]> {
  const rows=new Map<number,T>();
  for(const row of before){if(keep(row))rows.set(key(row),row);yield;}
  for(const row of after){rows.set(key(row),row);yield;}
  return yield* ordered([...rows.values()],(a,b)=>key(a)-key(b));
}

export const mergeTape=(previous:PeriodTape|undefined,next:PeriodTape)=>drain(mergeTapePrepared(previous,next));
export function* mergeTapePrepared(previous:PeriodTape|undefined,next:PeriodTape):Preparation<PeriodTape> {
  if(!previous||next.replaceFrom<=previous.from&&(next.replaceTo??Infinity)>=previous.cut)return next;
  const quota=new Map(previous.quota.map(s=>[s.source+'\n'+s.window,s]));
  for(const series of next.quota){const key=series.source+'\n'+series.window,old=quota.get(key);const samples=yield* replace(old?.samples??[],series.samples,s=>s.at<next.replaceFrom||s.at>=(next.replaceTo??Infinity),s=>s.at);const descriptors=yield* replace(old?.descriptors??[],series.descriptors??[],s=>s.at<next.replaceFrom||s.at>=(next.replaceTo??Infinity),s=>s.at);quota.set(key,{...series,samples,...(descriptors.length?{descriptors}:{})});}
  const money=new Map(previous.money.map(s=>[s.source+'\n'+s.meter,s]));
  for(const series of next.money) {
    const key=series.source+'\n'+series.meter,old=money.get(key);
    const readings=yield* replace(old?.readings??[],series.readings,r=>r.at<next.replaceFrom||r.at>=(next.replaceTo??Infinity),r=>r.at);
    const spans=yield* replace(old?.spans??[],series.spans,s=>s.to<next.replaceFrom||s.from>=(next.replaceTo??Infinity),s=>s.from);
    let paired=series.paired;
    if(paired&&old?.paired) {
      const readings=yield* replace(old.paired.readings,paired.readings,r=>r.at<next.replaceFrom||r.at>=(next.replaceTo??Infinity),r=>r.at);
      const spans=yield* replace(old.paired.spans,paired.spans,s=>s.to<next.replaceFrom||s.from>=(next.replaceTo??Infinity),s=>s.from);
      paired={readings,spans};
    }
    money.set(key,{...series,readings,spans,...(paired?{paired}:{}),rates:{...old?.rates,...series.rates}});
  }
  return {...next,from:Math.min(previous.from,next.from),quota:[...quota.values()],money:[...money.values()]};
}
