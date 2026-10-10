import {PERIOD_SCOPES,type PeriodReply} from './periodRead.js';
import type {MeterSemantics} from './meters.js';
import type {Conversion,RateLeg} from './currency.js';
import {packPeriodSequences,expandPeriodSequences} from './periodSequenceWire.js';

/** The dictionary applies only to monetary cell semantics, never to native evidence. */
type WireSemantics=Omit<MeterSemantics,'conversion'>&{conversion?:Omit<Conversion,'rate'>&{rate:RateLeg|number}};
export type PeriodWireReply = {basis:PeriodReply['basis'];moneySemantics?:WireSemantics[];rateLegs?:RateLeg[]} & Partial<Record<keyof Omit<PeriodReply,'basis'>,unknown>>;
type Slot={semantics?:WireSemantics|number|null;openSemantics?:WireSemantics|number};
function* slots(reply:PeriodWireReply):Generator<Slot>{
  for(const scope of PERIOD_SCOPES){
    const part=reply[scope] as PeriodReply[typeof scope];
    if(part?.state!=='complete')continue;
    for(const chunk of part.value.chunks)for(const series of chunk.meterSeries??[]){
      yield series;
      for(const cell of series.cells)if(cell[5]){yield cell[5];for(const observation of cell[5].observations??[])yield observation;}
    }
  }
}

/** Share complete repeated semantics; their amounts, observation times and provenance stay exact. */
export function periodDictionary(reply:PeriodReply,reserve:(bytes:number)=>void){
  const sequences=packPeriodSequences(reply,reserve);
  type Entry={value:WireSemantics;count:number;index?:number};
  const entries=new Map<string,Entry>();
  const keys=new WeakMap<object,Partial<Record<'semantics'|'openSemantics',Entry>>>();
  const rates=new Map<string,number>(),rateLegs:RateLeg[]=[];
  for(const slot of slots(reply))for(const key of ['semantics','openSemantics'] as const){
    const value=slot[key];if(!value||typeof value==='number')continue;
    const text=JSON.stringify(value);let entry=entries.get(text);
    reserve(128+(entry?0:text.length*2+96));
    if(entry)entry.count++;else {
      let packed=value;
      if(value.conversion&&typeof value.conversion.rate!=='number'){
        const rate=value.conversion.rate,rateKey=JSON.stringify(rate);let index=rates.get(rateKey);
        if(index===undefined){reserve(128+rateKey.length*2);index=rateLegs.length;rates.set(rateKey,index);rateLegs.push(rate);}
        packed={...value,conversion:{...value.conversion,rate:index}};
      }
      entry={value:packed,count:1};entries.set(text,entry);
    }
    let fields=keys.get(slot);if(!fields)keys.set(slot,fields={});fields[key]=entry;
  }
  const moneySemantics:WireSemantics[]=[];
  for(const entry of entries.values())if(entry.count>1){entry.index=moneySemantics.length;moneySemantics.push(entry.value);}
  return {moneySemantics,rateLegs,replacer:function(this:unknown,key:string,value:unknown){
    if(value&&typeof value==='object'&&sequences.has(value))return sequences.get(value);
    if(!this||typeof this!=='object'||key!=='semantics'&&key!=='openSemantics')return value;
    const entry=keys.get(this)?.[key];
    return entry?.index??entry?.value??value;
  }};
}

/** Restore aliases in the already charged native JSON body without copying its cells. */
export function expandPeriod(reply:PeriodWireReply,reserve:(bytes:number)=>void=()=>{}):PeriodReply{
  expandPeriodSequences(reply as PeriodReply,reserve);
  const dictionary=reply.moneySemantics;
  if(dictionary||reply.rateLegs){
    for(const slot of slots(reply))for(const key of ['semantics','openSemantics'] as const){
      let value=slot[key];
      if(typeof value==='number'){
        if(!Number.isSafeInteger(value)||value<0||!dictionary?.[value])throw new Error('invalid_period_semantics');
        slot[key]=value=dictionary[value];
      }
      const rate=value?.conversion?.rate;
      if(typeof rate==='number'){
        if(!Number.isSafeInteger(rate)||rate<0||!reply.rateLegs?.[rate])throw new Error('invalid_period_rate');
        value!.conversion!.rate=reply.rateLegs[rate];
      }
    }
    delete reply.moneySemantics;
    delete reply.rateLegs;
  }
  return reply as PeriodReply;
}
