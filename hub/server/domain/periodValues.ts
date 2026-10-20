import {ValueChanges,applyValueChanges,type ValuePath,type ValueChange} from './valueChanges.js';
import type {CreditBalanceState} from './resources.js';
import type {Win} from './quota.js';
import type {KeyPart, Meter} from './meters.js';
import {drain,type Preparation} from './prepare.js';

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
  states?:{start?:Omit<PeriodValues,'states'>;paths:ValuePath[];pieces:[number,number,ValueChange[]][]};
  currencyUnavailable?:boolean;
};

const contains=(range:PeriodValues['validFor'],to:number)=>!!range&&range.from<=to&&to<range.to;

/** Availability lookup does not allocate a replay while the LRU is finding a candidate. */
export function hasPeriodValue(value:PeriodValues|null|undefined,to:number):boolean {
  return !!value&&(contains(value.validFor,to)||contains(value.states?.start?.validFor,to)||!!value.states?.pieces.some(([from,until])=>from<=to&&to<until));
}
export function periodValueAt(value:PeriodValues|null|undefined,to:number):PeriodValues|undefined {
  if(!value||!hasPeriodValue(value,to))return;
  if(contains(value.validFor,to))return value;
  const {states:sequence,...base}=value,start=sequence!.start??base,states=sequence!.start?sequence!:{...sequence!,start};
  if(contains(start.validFor,to))return {...start,states};
  const copy=structuredClone(start);
  for(const [from,until,changes] of states.pieces){
    applyValueChanges(copy,states.paths,changes);
    if(from<=to&&to<until)return {...copy,states};
  }
}

/** Every actual state remains recoverable; only repeated fields are omitted. */
export function withValueStates(base:PeriodValues,values:Iterable<PeriodValues>,reserve:(bytes:number)=>void):PeriodValues {
  return drain(prepareValueStates(base,values,reserve));
}
export function* prepareValueStates(base:PeriodValues,values:Iterable<PeriodValues>,reserve:(bytes:number)=>void):Preparation<PeriodValues> {
  const changes=new ValueChanges(reserve);let states:PeriodValues['states'],previous:PeriodValues=base;
  for(const value of values){
    if(!states){reserve(128);states={paths:changes.paths,pieces:[]};}
    const patch=changes.between(previous,value);
    reserve(JSON.stringify(patch).length*3+64);
    states.pieces.push([value.validFor!.from,value.validFor!.to,patch]);previous=value;yield;
  }
  return states?{...base,states}:base;
}


/** A captured value can expire with the shared clock without admitting a future observation. */
export function periodValueNow(value:PeriodValues,at:number):PeriodValues {
  const known=periodValueAt(value,at)??value;
  return {...known,windows:known.windows.map(w=>({...w,stale:at>=w.validUntil})),
    meters:known.meters.map(m=>({...m,stale:at>=(m.validUntil??m.at+m.staleAfterMs+1)})),
    keys:known.keys.map(k=>({...k,presence:k.presence==='missing'||at>=k.at+k.staleAfterMs+1?'missing':'observed'}))};
}
export function periodValueChangesAt(value:PeriodValues,now:number):number|null {
  const next=Math.min(...[...value.windows.map(w=>w.validUntil),...value.meters.map(m=>m.validUntil??m.at+m.staleAfterMs+1),...value.keys.map(k=>k.at+k.staleAfterMs+1),...(value.states?.pieces.flatMap(([from,to])=>[from,to])??[])].filter(at=>at>now));
  return next>now&&Number.isFinite(next)?next:null;
}
