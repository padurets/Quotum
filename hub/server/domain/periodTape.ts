import type {CellSamples} from './cells.js';
import type {MeterGroup} from './meterHistory.js';
import type {RateLeg} from './currency.js';
import {drain,ordered,type Preparation} from './prepare.js';

export const SAMPLE_WIDTH=5;
export type NumberColumn={length:number;base:number;values:Uint32Array|Float64Array|null};
export type Numbers=ArrayLike<number>|NumberColumn;
export type SampleRows=readonly number[]|Float64Array|{length:number;columns:NumberColumn[]};
export const numberAt=(rows:Numbers,index:number):number|undefined=>index<0||index>=rows.length?undefined:'base' in rows?rows.base+(rows.values?.[index]??0):rows[index];
export const numberBytes=(rows:Numbers)=>'base' in rows?(rows.values?.byteLength??0)+32:rows.length*8;
export const lowerNumber=(rows:Numbers,at:number)=>{let a=0,b=rows.length;while(a<b){const m=(a+b)>>>1;if(numberAt(rows,m)!<at)a=m+1;else b=m;}return a;};
/** Integer offsets use four bytes only when the complete range is exactly representable. */
export function* numberColumn(length:number,value:(i:number,pass:number)=>number):Preparation<NumberColumn>{
  let min=Infinity,max=-Infinity,integers=true;
  for(let i=0;i<length;i++){const n=value(i,0);min=Math.min(min,n);max=Math.max(max,n);integers&&=Number.isSafeInteger(n);yield;}
  if(!length||min===max)return {length,base:length?min:0,values:null};
  const narrow=integers&&max-min<=0xffffffff,base=narrow?min:0,values=narrow?new Uint32Array(length):new Float64Array(length);
  for(let i=0;i<length;i++){values[i]=value(i,1)-base;yield;}
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

export type MoneyTape = MeterGroup & {displayUnit?:string;rates?:Record<string,RateLeg[]|null>;rateBindings?:{paths:(RateLeg[]|null)[];entries:Record<string,number>}};
export function rateAt(group:MoneyTape,key:string){const index=group.rateBindings?.entries[key];return index===undefined?group.rates?.[key]:group.rateBindings!.paths[index];}
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
  fixed?:{range:import('./period.js').PeriodRange;shift?:import('./periodShift.js').PeriodShift;cell:number;quota:import('./history.js').HistorySeries[];money:import('./meterHistory.js').MeterHistory[]};
  quota:(Omit<CellSamples,'samples'>&{samples:SampleRows;samplesEncoding?:'delta';workFrom?:number;member?:boolean;windowValue?:WindowDescriptor;descriptors?:{at:number;value:WindowDescriptor}[]})[];money:MoneyTape[];
};

function* replace<T>(before:readonly T[],after:readonly T[],keep:(row:T)=>boolean,key:(row:T)=>number):Preparation<T[]> {
  const rows=new Map<number,T>();
  for(const row of before){if(keep(row))rows.set(key(row),row);yield;}
  for(const row of after){rows.set(key(row),row);yield;}
  return yield* ordered([...rows.values()],(a,b)=>key(a)-key(b));
}

export const mergeTape=(previous:PeriodTape|undefined,next:PeriodTape)=>drain(mergeTapePrepared(previous,next));
export function* mergeTapePrepared(previous:PeriodTape|undefined,next:PeriodTape):Preparation<PeriodTape> {
  if(!previous||next.fixed||previous.fixed||next.replaceFrom<=previous.from&&(next.replaceTo??Infinity)>=previous.cut)return next;
  const quota=new Map(previous.quota.map(s=>[s.source+'\n'+s.window,s]));
  for(const series of next.quota){const key=series.source+'\n'+series.window,old=quota.get(key);const samples=yield* replaceSamples(old?.samples??[],series.samples,next.replaceFrom,next.replaceTo??Infinity);const descriptors=yield* replace(old?.descriptors??[],series.descriptors??[],s=>s.at<next.replaceFrom||s.at>=(next.replaceTo??Infinity),s=>s.at);quota.set(key,{...series,samples,...(descriptors.length?{descriptors}:{})});}
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
    const merged:MoneyTape={...series,readings,spans,...(paired?{paired}:{}),rates:undefined,rateBindings:undefined};
    const keys=new Set([old,series].flatMap(part=>[...Object.keys(part?.rates??{}),...Object.keys(part?.rateBindings?.entries??{})]));
    for(const key of keys){const path=rateAt(series,key);bindRate(merged,key,path===undefined?rateAt(old!,key)!:path);yield;}
    money.set(key,merged);
  }
  return {...next,from:Math.min(previous.from,next.from),quota:[...quota.values()],money:[...money.values()]};
}
