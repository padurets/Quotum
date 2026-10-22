import type {Preparation} from './prepare.js';
import {WORK_BLOCK_MS,type WorkTrace} from './periodWork.js';
import {numberColumn,numberTail,rateAt,bindRate,sampleAt,sampleCount,sampleBytes,type SampleRows,type PeriodTape,type MoneyTape} from './periodTape.js';
import type {MeterSpan,Reading} from './meters.js';

const lower=<T>(rows:readonly T[],at:number,time:(row:T)=>number)=>{let a=0,b=rows.length;while(a<b){const m=(a+b)>>>1;if(time(rows[m])<at)a=m+1;else b=m;}return a;};
const before=<T>(rows:readonly T[],at:number,time:(row:T)=>number)=>Math.max(0,lower(rows,at,time)-1);

/** Keep intersecting hour blocks without expanding their shared interval patterns. */
export function* retainWork(trace:WorkTrace,from:number,reserve:(bytes:number)=>void=()=>{}):Preparation<WorkTrace> {
  if(trace.fixed||from<=trace.anchor)return trace;
  let expired=false;
  if(trace.packed){const {blocks,patterns}=trace.packed;for(let i=0;i<blocks.length;i+=3){if(blocks[i+1]*WORK_BLOCK_MS+patterns[blocks[i+2]].at(-1)!<=from)expired=true;yield;}}
  else for(const [,,b] of trace.spans){if(trace.anchor+b<=from)expired=true;yield;}
  if(!expired)return trace;
  const refs:WorkTrace['refs']=[],ids=new Map<number,number>();
  const ref=(id:number)=>{let mapped=ids.get(id);if(mapped===undefined){reserve(128);mapped=refs.length;ids.set(id,mapped);refs.push(trace.refs[id]);}return mapped;};
  if(trace.packed){
    const blocks:number[]=[],patterns:number[][]=[],indices=new Map<number,number>();
    for(let i=0;i<trace.packed.blocks.length;i+=3){
      const id=trace.packed.blocks[i],hour=trace.packed.blocks[i+1],patternId=trace.packed.blocks[i+2],pattern=trace.packed.patterns[patternId];
      if(hour*WORK_BLOCK_MS+pattern.at(-1)!>from){let mapped=indices.get(patternId);if(mapped===undefined){reserve(96);mapped=patterns.length;indices.set(patternId,mapped);patterns.push(pattern);}reserve(48);blocks.push(ref(id),hour,mapped);}yield;
    }
    return {...trace,anchor:from,refs,spans:[],packed:{blocks,patterns}};
  }
  const spans:WorkTrace['spans']=[];
  for(const [id,a,b] of trace.spans){if(trace.anchor+b>from){reserve(64);spans.push([ref(id),Math.max(from,trace.anchor+a)-from,trace.anchor+b-from]);}yield;}
  return {...trace,anchor:from,refs,spans};
}

function* samplesAfter(rows:SampleRows,from:number,reserve:(bytes:number)=>void,release:(bytes:number)=>void):Preparation<SampleRows>{
  let a=0,b=sampleCount(rows);while(a<b){const m=(a+b)>>>1;if(sampleAt(rows,m)!.at<from)a=m+1;else b=m;}
  const start=Math.max(0,a-1),count=sampleCount(rows)-start;if(!start)return rows;
  // Copies release expired buffers without expanding a compressed ledger.
  const compressed='columns' in rows;let reserved=0;
  const stage=(bytes:number)=>{reserve(bytes);reserved+=bytes;};
  stage(compressed?256:count*40+512);
  const columns=[];
  for(let field=0;field<5;field++)columns.push('columns' in rows?yield*numberTail(rows.columns[field],start,stage):yield*numberColumn(count,i=>rows[(i+start)*5+field]));
  const kept={length:count*5,columns};
  release(reserved-(compressed?256:0)-sampleBytes(kept));return kept;
}

function* tail<T>(rows:readonly T[],start:number,reserve:(bytes:number)=>void):Preparation<T[]> {
  if(!start)return rows as T[];
  reserve((rows.length-start)*16+32);const kept:T[]=[];for(let i=start;i<rows.length;i++){kept.push(rows[i]);yield;}return kept;
}
function* partAfter<T extends {readings:Reading[];spans:MeterSpan[]}>(part:T,from:number,reserve:(bytes:number)=>void,retainedReadings?:Reading[]):Preparation<T>{
  const readings=retainedReadings??(yield*tail(part.readings,before(part.readings,from,r=>r.at),reserve));
  // The predecessor span retains its real head, endpoint and availability bounds.
  // Clipping its head would change gap classification and invent an observation.
  const spans=yield*tail(part.spans,before(part.spans,from,s=>s.from),reserve);
  return readings===part.readings&&spans===part.spans?part:{...part,readings,spans};
}
function* moneyAfter(group:MoneyTape,from:number,reserve:(bytes:number)=>void,release:(bytes:number)=>void):Preparation<MoneyTape>{
  const raw=yield*partAfter(group,from,reserve),paired=group.paired?yield*partAfter(group.paired,from,reserve):undefined,workCounter=group.workCounter?yield*partAfter(group.workCounter,from,reserve,group.workCounter.readings===group.readings?raw.readings:undefined):undefined;
  const own=workCounter!==group.workCounter?{...raw,workCounter}:raw;
  if(!group.rates&&!group.rateBindings)return own===group&&paired===group.paired?group:{...own,...(paired?{paired}:{})};
  if(raw===group&&paired===group.paired){
    // With no expired financial rows, future bindings and one predecessor per
    // unit already form the complete retained dictionary. Avoid copying it.
    const previous=new Set<string>();let reusable=true,temporary=0;
    for(const key of rateKeys(group)){
      const split=key.lastIndexOf('\n'),unit=key.slice(0,split),at=Number(key.slice(split+1));
      if(at<from){if(previous.has(unit)){reusable=false;break;}const bytes=64+unit.length*2;reserve(bytes);temporary+=bytes;previous.add(unit);}yield;
    }
    release(temporary);
    if(reusable)return own;
  }
  const keys=new Set<string>(),previous=new Map<string,{at:number;key:string}>();let count=0,temporary=0;
  const stage=(bytes:number)=>{reserve(bytes);temporary+=bytes;};
  const addKey=(key:string)=>{if(!keys.has(key)){stage(64+key.length*2);keys.add(key);}};
  const add=(unit:string,at:number)=>addKey(unit+'\n'+at);
  for(const [part,original] of [[own,group],...(paired&&group.paired?[[paired,group.paired]]:[])]){
    for(const reading of part.readings){add(reading.unit,reading.at);yield;}
    for(const span of part.spans)for(const at of [span.observedFrom,span.to])if(at!==undefined){
      const i=lower(original.readings,at+1,r=>r.at)-1;if(i>=0)add(original.readings[i].unit,at);yield;
    }
  }
  for(const key of rateKeys(group)){
    count++;const split=key.lastIndexOf('\n'),unit=key.slice(0,split),at=Number(key.slice(split+1));
    if(at>=from)addKey(key);else if(at>(previous.get(unit)?.at??-Infinity)){
      if(!previous.has(unit))stage(128+unit.length*2);previous.set(unit,{at,key});
    }yield;
  }
  for(const {key} of previous.values()){addKey(key);yield;}
  let retained=0;for(const key of keys){if(rateAt(group,key)!==undefined)retained++;yield;}
  if(own===group&&paired===group.paired&&workCounter===group.workCounter&&retained===count){release(temporary);return group;}
  const result:MoneyTape={...own,...(paired?{paired}:{}),rates:undefined,rateBindings:undefined};
  for(const key of keys){
    const path=rateAt(group,key);if(path===undefined)continue;
    // Reserve dictionary entries, path comparison strings and any new path before
    // bindRate allocates them. Only its owned entries and paths survive the yield.
    const pathBytes=128+(path??[]).reduce((n,leg)=>n+256+2*(leg.id.length+leg.source.length+leg.base.length+leg.from.length+leg.to.length),0);
    const bound=256+key.length*2+pathBytes*2;
    reserve(bound);const owned=bindRate(result,key,path);release(bound-owned);yield;
  }
  release(temporary);
  return result;
}

/** Retention is independent of capture/authority and preserves exact boundary evidence. */
export function* retainTape(tape:PeriodTape,from:number,reserve:(bytes:number)=>void=()=>{},release:(bytes:number)=>void=()=>{}):Preparation<PeriodTape>{
  if(tape.fixed||from<=tape.from)return tape;
  const containers=256+(tape.quota.length+tape.money.length*3)*128;reserve(containers);
  const quota:PeriodTape['quota']=[],money:MoneyTape[]=[];let changed=false;
  for(const series of tape.quota){
    const samples=yield*samplesAfter(series.samples,from,reserve,release);
    const descriptors=series.descriptors?yield*tail(series.descriptors,before(series.descriptors,from,d=>d.at),reserve):undefined;
    const next=samples===series.samples&&descriptors===series.descriptors?series:{...series,samples,...(descriptors?{descriptors}:{})};quota.push(next);changed ||= next!==series;yield;
  }
  for(const group of tape.money){const next=yield*moneyAfter(group,from,reserve,release);money.push(next);changed ||= next!==group;yield;}
  if(!changed){release(containers);return tape;}
  return {...tape,from,quota,money};
}

function* rateKeys(group:MoneyTape):Generator<string>{
  for(const key in group.rates)if(!(key in (group.rateBindings?.entries??{})))yield key;
  for(const key in group.rateBindings?.entries)yield key;
}

/** Next future boundary, including after a capacity refusal or a no-op trim. */
export function* retirementEdge(work:WorkTrace|null,tapes:Iterable<PeriodTape>,from:number):Preparation<number>{
  let at=Infinity;
  const consider=(value:number)=>{if(value>from)at=Math.min(at,value);};
  if(work&&!work.fixed){
    if(work.packed){const {blocks,patterns}=work.packed;for(let i=0;i<blocks.length;i+=3){consider(blocks[i+1]*WORK_BLOCK_MS+patterns[blocks[i+2]].at(-1)!);yield;}}
    else for(const [,,b] of work.spans){consider(work.anchor+b);yield;}
  }
  for(const tape of tapes)if(!tape.fixed){
    for(const series of tape.quota){
      let a=1,b=sampleCount(series.samples);while(a<b){const m=(a+b)>>>1;if(sampleAt(series.samples,m)!.at+1<=from)a=m+1;else b=m;}
      consider((sampleAt(series.samples,a)?.at??Infinity)+1);
      if(series.descriptors){const i=Math.max(1,lower(series.descriptors,from,d=>d.at));consider((series.descriptors[i]?.at??Infinity)+1);}yield;
    }
    for(const group of tape.money){
      for(const part of [group,...(group.paired?[group.paired]:[]),...(group.workCounter?[group.workCounter]:[])]){
        consider((part.readings[Math.max(1,lower(part.readings,from,r=>r.at))]?.at??Infinity)+1);
        consider((part.spans[Math.max(1,lower(part.spans,from,s=>s.from))]?.from??Infinity)+1);yield;
      }
      for(const key of rateKeys(group)){consider(Number(key.slice(key.lastIndexOf('\n')+1))+1);yield;}
    }
  }
  return at;
}

export type QuotaTail={readonly before:PeriodTape['quota'][number];readonly after:PeriodTape['quota'][number];readonly removed:1};
/** Mint retirement evidence only from the original producer's actual returned rows. */
export function* retainTapeWithTails(tape:PeriodTape,from:number,reserve:(bytes:number)=>void,retained:(before:PeriodTape['quota'][number],after:PeriodTape['quota'][number])=>void,release:(bytes:number)=>void=()=>{}):Preparation<PeriodTape>{
  const value=yield*retainTape(tape,from,reserve,release);
  if(value===tape||value.quota.length!==tape.quota.length)return value;
  for(let i=0;i<value.quota.length;i++){
    const before=tape.quota[i],after=value.quota[i];
    if(before.source===after.source&&before.window===after.window&&sampleCount(before.samples)===sampleCount(after.samples)+1)retained(before,after);
    yield;
  }
  return value;
}
