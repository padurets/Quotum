import {ValueChanges,applyValueChanges,type ValuePath,type ValueChange} from './valueChanges.js';
import type {CreditBalanceState} from './resources.js';
import type {Win} from './quota.js';
import type {KeyPart, Meter} from './meters.js';

export type WindowValue = Win & {observedAt:number; validUntil:number; stale:boolean};
/** Measurements only. Operational status, account names and actions come from the live board. */
export type PeriodValues = {
  id:string;
  provider:string;
  windows:WindowValue[];
  meters:Meter[];
  keys:KeyPart[];
  creditBalance?:CreditBalanceState;
  validFor?:{from:number;to:number};
  states?:{start:Omit<PeriodValues,'states'>;paths:ValuePath[];pieces:[number,number,ValueChange[]][]};
  currencyUnavailable?:boolean;
};

/** Availability lookup does not allocate a replay while the LRU is finding a candidate. */
export function hasPeriodValue(value:PeriodValues|null|undefined,to:number):boolean {
  return !!value&&(!!value.validFor&&value.validFor.from<=to&&to<value.validFor.to||!!value.states?.pieces.some(([from,until])=>from<=to&&to<until));
}
export function periodValueAt(value:PeriodValues|null|undefined,to:number):PeriodValues|undefined {
  if(!value||!hasPeriodValue(value,to))return;
  if(value.validFor&&value.validFor.from<=to&&to<value.validFor.to)return value;
  const states=value.states!,copy=structuredClone(states.start);
  for(const [from,until,changes] of states.pieces){
    applyValueChanges(copy,states.paths,changes);
    if(from<=to&&to<until)return {...copy,states};
  }
}

/** Every actual state remains recoverable; only repeated fields are omitted. */
export function withValueStates(base:PeriodValues,values:Iterable<PeriodValues>,reserve:(bytes:number)=>void):PeriodValues {
  const changes=new ValueChanges(reserve);let states:PeriodValues['states'],previous:PeriodValues|undefined;
  for(const value of values){
    if(!states){reserve(JSON.stringify(value).length*3+128);states={start:value,paths:changes.paths,pieces:[]};}
    const patch=previous?changes.between(previous,value):[];
    reserve(JSON.stringify(patch).length*3+64);
    states.pieces.push([value.validFor!.from,value.validFor!.to,patch]);previous=value;
  }
  return states?{...base,states}:base;
}
