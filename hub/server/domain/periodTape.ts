import type {CellSamples} from './cells.js';
import type {MeterGroup} from './meterHistory.js';
import type {RateLeg} from './currency.js';
import {drain,ordered,type Preparation} from './prepare.js';

export const SAMPLE_WIDTH=5;
export type NumberColumn={length:number;base:number;values:Uint32Array|Float64Array|null;runs?:{ends:Uint32Array;bases:Float64Array;steps:Float64Array}};
export type Numbers=ArrayLike<number>|NumberColumn;
export type SampleRows=readonly number[]|Float64Array|{length:number;columns:NumberColumn[]};
export function numberAt(rows:Numbers,index:number):number|undefined {
  if(index<0||index>=rows.length)return undefined;
  if(!('base' in rows))return rows[index];
  if(!rows.runs)return rows.base+(rows.values?.[index]??0);
  const {ends,bases,steps}=rows.runs;let a=0,b=ends.length;
  while(a<b){const middle=(a+b)>>>1;if(ends[middle]<=index)a=middle+1;else b=middle;}
  return bases[a]+(index-(a?ends[a-1]:0))*steps[a];
}
export const numberBytes=(rows:Numbers)=>'base' in rows?(rows.runs?rows.runs.ends.byteLength+rows.runs.bases.byteLength+rows.runs.steps.byteLength+128:(rows.values?.byteLength??0)+32):rows.length*8;
export const lowerNumber=(rows:Numbers,at:number)=>{let a=0,b=rows.length;while(a<b){const m=(a+b)>>>1;if(numberAt(rows,m)!<at)a=m+1;else b=m;}return a;};
/** Integer offsets use four bytes only when the complete range is exactly representable. */
export function* numberColumn(length:number,value:(i:number,pass:number)=>number):Preparation<NumberColumn>{
  let min=Infinity,max=-Infinity,integers=true,count=0,start=0,base=0,step:number|undefined,previous=0;
  for(let i=0;i<length;i++){
    const n=value(i,0);min=Math.min(min,n);max=Math.max(max,n);integers&&=Number.isSafeInteger(n);
    if(!i){base=n;count++;}else if(step===undefined){const delta=n-previous;if(Number.isSafeInteger(delta)&&previous+delta===n)step=delta;else{count++;base=n;start=i;}}
    else if(!Number.isSafeInteger(step)||n!==base+(i-start)*step){count++;base=n;start=i;step=undefined;}
    previous=n;if((i&63)===63)yield;
  }
  if(!length||min===max)return {length,base:length?min:0,values:null};
  const narrow=integers&&max-min<=0xffffffff;
  // Long regular cadences and prefixes retain every integer, including breaks.
  // Incompressible and fractional columns keep their original exact buffer.
  if(integers&&count*20+128<length*(narrow?4:8)+32){
    const ends=new Uint32Array(count),bases=new Float64Array(count),steps=new Float64Array(count);let run=0;
    step=undefined;start=0;previous=0;
    for(let i=0;i<length;i++){
      const n=value(i,1);
      if(!i)bases[0]=n;
      else if(step===undefined){const delta=n-previous;if(Number.isSafeInteger(delta)&&previous+delta===n){step=delta;steps[run]=step;}else{ends[run++]=i;bases[run]=n;start=i;}}
      else if(!Number.isSafeInteger(step)||n!==bases[run]+(i-start)*step){ends[run++]=i;bases[run]=n;start=i;step=undefined;}
      previous=n;if((i&63)===63)yield;
    }
    ends[run]=length;return {length,base:0,values:null,runs:{ends,bases,steps}};
  }
  base=narrow?min:0;const values=narrow?new Uint32Array(length):new Float64Array(length);
  for(let i=0;i<length;i++){values[i]=value(i,1)-base;if((i&63)===63)yield;}
  return {length,base,values};
}
type Sample=CellSamples['samples'][number];
/** Flat numeric rows avoid repeating property names and per-observation objects. */
export const packSamples=(rows:readonly Sample[]):number[]=>rows.flatMap(s=>[s.at,s.used,s.resetAt??-1,s.staleAfterMs,s.validUntil??-1]);
/** Repeated deadlines and cadence use exact integer differences on the wire. */
export function encodeSamples(rows:readonly Sample[]):number[] {
  let at=0,reset=-1,stale=0,valid=-1;const result:number[]=[];
  for(const row of rows){const r=row.resetAt??-1,v=row.validUntil??-1;result.push(row.at-at,row.used,r-reset,row.staleAfterMs-stale,v-valid);at=row.at;reset=r;stale=row.staleAfterMs;valid=v;}
  return result;
}
export const decodeSamples=(rows:SampleRows)=>drain(retainSamplesPrepared(rows,true));
export function* retainSamplesPrepared(rows:SampleRows,delta=false):Preparation<SampleRows>{
  if('columns' in rows)return rows;
  const columns:NumberColumn[]=[];
  for(let field=0;field<SAMPLE_WIDTH;field++){let previous=0;const initial=field===2||field===4?-1:0;
    columns.push(yield*numberColumn(sampleCount(rows),(i)=>{if(i===0)previous=initial;const value=rows[i*SAMPLE_WIDTH+field];return delta&&field!==1?previous+=value:value;}));
  }
  return {length:rows.length,columns};
}
export function sampleBytes(rows:SampleRows,delta=false):number {
  if('columns' in rows)return rows.columns.reduce((n,c)=>n+numberBytes(c),0);
  let bytes=160;
  for(let field=0;field<SAMPLE_WIDTH;field++){let min=Infinity,max=-Infinity,integers=true,previous=field===2||field===4?-1:0;
    for(let i=field;i<rows.length;i+=SAMPLE_WIDTH){const value=delta&&field!==1?previous+=rows[i]:rows[i];min=Math.min(min,value);max=Math.max(max,value);integers&&=Number.isSafeInteger(value);}
    if(min!==max)bytes+=sampleCount(rows)*(integers&&max-min<=0xffffffff?4:8);
  }
  return bytes;
}
export const sampleCount=(rows:SampleRows)=>rows.length/SAMPLE_WIDTH;
export function sampleAt(rows:SampleRows,index:number):Sample|undefined {
  const at=index*SAMPLE_WIDTH;if(at<0||at>=rows.length)return undefined;
  const get=(field:number)=>'columns' in rows?numberAt(rows.columns[field],index)!:rows[at+field];
  return {at:get(0),used:get(1),resetAt:get(2)===-1?null:get(2),staleAfterMs:get(3),...(get(4)===-1?{}:{validUntil:get(4)})};
}
function* replaceSamples(before:SampleRows,after:SampleRows,from:number,to:number):Preparation<SampleRows> {
  let result=new Float64Array(0),length=0;
  // Count first so the published buffer has no spare copy of replaced rows.
  for(let pass=0;pass<2;pass++) {
    let a=0,b=0,position=0;
    while(a<before.length||b<after.length) {
      const read=(rows:SampleRows,at:number)=>'columns' in rows?numberAt(rows.columns[at%SAMPLE_WIDTH],Math.floor(at/SAMPLE_WIDTH))!:rows[at];
      if(a<before.length&&read(before,a)>=from&&read(before,a)<to){a+=SAMPLE_WIDTH;yield;continue;}
      const next=b<after.length&&(a>=before.length||read(after,b)<=read(before,a));
      if(pass)for(let j=0;j<SAMPLE_WIDTH;j++)result[position+j]=next?read(after,b+j):read(before,a+j);
      position+=SAMPLE_WIDTH;
      if(next){if(a<before.length&&read(after,b)===read(before,a))a+=SAMPLE_WIDTH;b+=SAMPLE_WIDTH;}else a+=SAMPLE_WIDTH;
      yield;
    }
    if(!pass){length=position;result=new Float64Array(length);}
  }
  return yield*retainSamplesPrepared(result);
}

export type MoneyTape = MeterGroup & {workCounter?:import('./periodMoneyWork.js').WorkCounter;displayUnit?:string;rates?:Record<string,RateLeg[]|null>;rateBindings?:{paths:(RateLeg[]|null)[];entries:Record<string,number>}};
export function rateAt(group:MoneyTape,key:string){const index=group.rateBindings?.entries[key];return index===undefined?group.rates?.[key]:group.rateBindings!.paths[index];}
export function* rateObservations(group:MoneyTape):Generator<[string,number]> {
  for(const key of new Set([...Object.keys(group.rates??{}),...Object.keys(group.rateBindings?.entries??{})])) {
    const split=key.lastIndexOf('\n');yield [key.slice(0,split),Number(key.slice(split+1))];
  }
}
/** Observation anchors keep their identity while repeated complete rate paths share storage. */
export function bindRate(group:MoneyTape,key:string,path:RateLeg[]|null):number {
  const bindings=group.rateBindings??={paths:[],entries:{}},text=JSON.stringify(path);
  let index=bindings.paths.findIndex(value=>JSON.stringify(value)===text),bytes=key in bindings.entries?0:128+key.length*2;
  if(index<0){index=bindings.paths.length;bindings.paths.push(path);bytes+=128+text.length*2;}
  bindings.entries[key]=index;return bytes;
}
type WindowDescriptor=Pick<import('./quota.js').Win,'id'|'kind'|'label'|'minutes'>;
/** A complete initial tape covers every future position of a live left edge without IO. */
export type PeriodTape = {
  from:number;cut:number;replaceFrom:number;replaceTo?:number;cursor:string;
  fixed?:{range:import('./period.js').PeriodRange;shift?:import('./periodShift.js').PeriodShift;cell:number;moneyWork?:import('./moneyWork.js').MoneyWork[];quota:import('./history.js').HistorySeries[];money:import('./meterHistory.js').MeterHistory[]};
  quota:(Omit<CellSamples,'samples'>&{samples:SampleRows;samplesEncoding?:'delta';workFrom?:number|null;member?:boolean;windowValue?:WindowDescriptor;descriptors?:{at:number;value:WindowDescriptor}[]})[];money:MoneyTape[];
};

const sameRow=(a:unknown,b:unknown)=>a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>(a as Record<string,unknown>)[key]===(b as Record<string,unknown>)[key]);

/** Work counters do not change the financial series that shares their source. */
export function sameMoneyTape(a:MoneyTape,b:MoneyTape):boolean {
  const {workCounter:_aw,retainedFrom:af=0,readings:ar,spans:as,paired:ap,rates:ratesA,rateBindings:bindingsA,...am}=a;
  const {workCounter:_bw,retainedFrom:bf=0,readings:br,spans:bs,paired:bp,rates:ratesB,rateBindings:bindingsB,...bm}=b;
  if(ar!==br||as!==bs||ap?.readings!==bp?.readings||ap?.spans!==bp?.spans||ratesA!==ratesB||bindingsA!==bindingsB||JSON.stringify(am)!==JSON.stringify(bm))return false;
  // A moving cutoff matters only when it changes confirmed financial coverage.
  // Keep interruption and hold bounds identical to the accounting index.
  return af===bf||as.every(span=>{
    const to=Math.min(span.to,span.holdUntil??Infinity,span.interruptedAt??Infinity);
    return Math.min(to,Math.max(span.from,af))===Math.min(to,Math.max(span.from,bf));
  });
}

function* replace<T>(before:readonly T[],after:readonly T[],keep:(row:T)=>boolean,key:(row:T)=>number):Preparation<T[]> {
  const rows=new Map<number,T>();
  for(const row of before){if(keep(row))rows.set(key(row),row);yield;}
  for(const row of after){
    const at=key(row);let a=0,b=before.length;while(a<b){const m=(a+b)>>>1;if(key(before[m])<at)a=m+1;else b=m;}
    const old=before[a];rows.set(at,old&&key(old)===at&&sameRow(old,row)?old:row);yield;
  }
  const sorted=yield*ordered([...rows.values()],(a,b)=>key(a)-key(b));
  return sorted.length===before.length&&sorted.every((row,i)=>row===before[i])?before as T[]:sorted;
}

export const mergeTape=(previous:PeriodTape|undefined,next:PeriodTape)=>drain(mergeTapePrepared(previous,next));
export function* mergeTapePrepared(previous:PeriodTape|undefined,next:PeriodTape,reserve:(bytes:number)=>void=()=>{},release:(bytes:number)=>void=()=>{}):Preparation<PeriodTape> {
  if(!previous||next.fixed||previous.fixed)return next;
  const complete=next.replaceFrom<=previous.from&&(next.replaceTo??Infinity)>=previous.cut;
  const from=complete?-Infinity:next.replaceFrom,to=complete?Infinity:next.replaceTo??Infinity;
  reserve(256+(previous.quota.length+next.quota.length+previous.money.length+next.money.length)*128);
  const previousQuota=new Map(previous.quota.map(s=>[s.source+'\n'+s.window,s])),quota=complete?new Map<string,PeriodTape['quota'][number]>():previousQuota;
  for(const series of next.quota){const key=series.source+'\n'+series.window,old=previousQuota.get(key);const samples=yield* replaceSamples(old?.samples??[],series.samples,from,to);const descriptors=yield* replace(old?.descriptors??[],series.descriptors??[],s=>s.at<from||s.at>=to,s=>s.at);quota.set(key,{...series,samples,...(descriptors.length?{descriptors}:{})});}
  const previousMoney=new Map(previous.money.map(s=>[s.source+'\n'+s.meter,s])),money=complete?new Map<string,MoneyTape>():previousMoney;
  for(const series of next.money) {
    const key=series.source+'\n'+series.meter,old=previousMoney.get(key);
    reserve([old,series,old?.paired,series.paired].reduce((bytes,part)=>bytes+(part?(part.readings.length+part.spans.length)*128:0),0));
    const readings=yield* replace(old?.readings??[],series.readings,r=>r.at<from||r.at>=to,r=>r.at);
    const spans=yield* replace(old?.spans??[],series.spans,s=>s.to<from||s.from>=to,s=>s.from);
    let paired=series.paired;
    if(paired&&old?.paired) {
      const readings=yield* replace(old.paired.readings,paired.readings,r=>r.at<from||r.at>=to,r=>r.at);
      const spans=yield* replace(old.paired.spans,paired.spans,s=>s.to<from||s.from>=to,s=>s.from);
      paired={readings,spans};
    }
    let workCounter=series.workCounter;
    if(workCounter&&old?.workCounter) {
      reserve((old.workCounter.readings.length+workCounter.readings.length+old.workCounter.spans.length+workCounter.spans.length)*128);
      const readings=yield*replace(old.workCounter.readings,workCounter.readings,r=>r.at<from||r.at>=to,r=>r.at);
      const spans=yield*replace(old.workCounter.spans,workCounter.spans,s=>s.to<from||s.from>=to,s=>s.from);
      workCounter={...workCounter,readings,spans};
    }
    const merged:MoneyTape={...series,readings,spans,...(paired?{paired}:{}),...(workCounter?{workCounter}:{}),rates:undefined,rateBindings:undefined};
    const keys=new Set<string>(),anchors=new Set<number>(),superseded=new Set<number>();
    for(const part of complete?[series]:[old,series])if(part)for(const dictionary of [part.rates,part.rateBindings?.entries])for(const key in dictionary){
      if(!keys.has(key)){reserve(128+key.length*2);keys.add(key);}yield;
    }
    const anchor=(at:number)=>{if(!anchors.has(at)){reserve(64);anchors.add(at);}};
    for(const part of [merged,...(merged.paired?[merged.paired]:[])]){
      for(const reading of part.readings){anchor(reading.at);yield;}
      for(const span of part.spans){anchor(span.to);if(span.observedFrom!==undefined)anchor(span.observedFrom);yield;}
    }
    for(const [before,after] of [[old,series],[old?.paired,series.paired]])if(before&&after){
      const tails=new Map<number,number>();
      for(const span of after.spans){reserve(64);tails.set(span.from,span.to);yield;}
      for(const span of before.spans){if((tails.get(span.from)??-Infinity)>span.to&&!superseded.has(span.to)){reserve(64);superseded.add(span.to);}yield;}
      tails.clear();
    }
    function* entries(){for(const key of keys){reserve(128+key.length*2);const split=key.lastIndexOf('\n');yield {key,unit:key.slice(0,split),at:Number(key.slice(split+1))};}}
    let previousUnit:string|undefined,previousPath:string|undefined,previousProofBytes=0;
    for(const {key,unit,at} of yield*ordered(entries(),(a,b)=>a.unit.localeCompare(b.unit)||a.at-b.at)){
      const incoming=rateAt(series,key),path=incoming===undefined?rateAt(old!,key)!:incoming;
      const pathBytes=128+(path??[]).reduce((bytes,leg)=>bytes+256+2*(leg.id.length+leg.source.length+leg.base.length+leg.from.length+leg.to.length),0);
      reserve(pathBytes*2);const proof=JSON.stringify(path);
      const redundant=incoming===undefined&&superseded.has(at)&&!anchors.has(at)&&previousUnit===unit&&previousPath===proof;
      previousUnit=unit;previousPath=proof;release(previousProofBytes);previousProofBytes=pathBytes;
      if(redundant){release(pathBytes);yield;continue;}
      // Explicit bindings remain authoritative. Only a superseded span tail
      // carrying the same complete rate proof can be removed.
      const bound=256+key.length*2+pathBytes;reserve(bound);
      const owned=bindRate(merged,key,path);release(bound-owned+pathBytes);yield;
    }
    release(previousProofBytes);
    if(old?.rateBindings&&merged.rateBindings&&sameRow(old.rateBindings.entries,merged.rateBindings.entries)&&JSON.stringify(old.rateBindings.paths)===JSON.stringify(merged.rateBindings.paths))merged.rateBindings=old.rateBindings;
    if(old?.rates&&merged.rates&&JSON.stringify(old.rates)===JSON.stringify(merged.rates))merged.rates=old.rates;
    money.set(key,old?.retainedFrom===merged.retainedFrom&&sameMoneyTape(old??merged,merged)&&old?.workCounter===merged.workCounter?old??merged:merged);
  }
  return {...next,from:complete?next.from:Math.min(previous.from,next.from),quota:[...quota.values()],money:[...money.values()]};
}
