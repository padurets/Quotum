import {sourceKey} from './workAccess.js';
import {drain,ordered,type Preparation} from './prepare.js';
import {packWorkPrepared,WORK_BLOCK_MS,type WorkTrace} from './periodWork.js';
import type {PeriodRange} from './period.js';

const upper=(values:ArrayLike<number>,at:number)=>{let a=0,b=values.length;while(a<b){const m=(a+b)>>>1;if(values[m]<=at)a=m+1;else b=m;}return a;};

/** A pattern is a lossless sweep, shared by every hour with the same work. */
class Curve {
  readonly times:Float64Array;
  private readonly agents:Float64Array;
  private readonly active:Float64Array;
  private readonly slopes:Float64Array;
  constructor(changes:readonly [number,number][]) {
    this.times=new Float64Array(changes.length);this.agents=new Float64Array(changes.length);this.active=new Float64Array(changes.length);this.slopes=new Float64Array(changes.length);
    let previous=0,slope=0,agents=0,active=0;
    for(let i=0;i<changes.length;i++){const [at,delta]=changes[i];agents+=(at-previous)*slope;if(slope)active+=at-previous;slope+=delta;this.times[i]=at;this.agents[i]=agents;this.active[i]=active;this.slopes[i]=slope;previous=at;}
  }
  at(at:number,active=false){const i=upper(this.times,at)-1;return i<0?0:(active?this.active[i]:this.agents[i])+(at-this.times[i])*(active?Number(this.slopes[i]>0):this.slopes[i]);}
  working(at:number){return (this.slopes[upper(this.times,at)-1]??0)>0;}
  slope(at:number){return this.slopes[upper(this.times,at)-1]??0;}
  next(at:number){return this.times[upper(this.times,at)]??Infinity;}
  last(at:number){let i=upper(this.times,at)-1;if(this.times[i]===at)i--;return i<0?null:this.slopes[i]>0?at:this.times[i];}
  get bytes(){return this.times.length*32;}
}

export class WorkTimeline {
  private readonly hours:Float64Array;
  private readonly agents:Float64Array;
  private readonly active:Float64Array;
  private readonly curves:Curve[]=[];
  constructor(blocks:readonly [number,Curve][]|WorkTimeline,start=0) {
    if(blocks instanceof WorkTimeline){
      this.hours=blocks.hours.slice(start);this.agents=blocks.agents.slice(start);this.active=blocks.active.slice(start);this.curves=blocks.curves.slice(start);
      const agents=this.agents[0],active=this.active[0];
      for(let i=0;i<this.agents.length;i++){this.agents[i]-=agents;this.active[i]-=active;}
      return;
    }
    this.hours=new Float64Array(blocks.length);this.agents=new Float64Array(blocks.length+1);this.active=new Float64Array(blocks.length+1);
    for(let i=0;i<blocks.length;i++){const [hour,curve]=blocks[i];this.hours[i]=hour*WORK_BLOCK_MS;this.curves.push(curve);this.agents[i+1]=this.agents[i]+curve.at(WORK_BLOCK_MS);this.active[i+1]=this.active[i]+curve.at(WORK_BLOCK_MS,true);}
  }
  private at(at:number,active:boolean){const i=upper(this.hours,at)-1;if(i<0)return 0;return (active?this.active[i]:this.agents[i])+this.curves[i].at(Math.min(WORK_BLOCK_MS,at-this.hours[i]),active);}
  read(range:PeriodRange,active=false){return range.to>range.from?this.at(range.to,active)-this.at(range.from,active):0;}
  working(at:number){const i=upper(this.hours,at)-1;return i>=0&&at<this.hours[i]+WORK_BLOCK_MS&&this.curves[i].working(at-this.hours[i]);}
  slope(at:number){const i=upper(this.hours,at)-1;return i>=0&&at<this.hours[i]+WORK_BLOCK_MS?this.curves[i].slope(at-this.hours[i]):0;}
  next(at:number){const i=upper(this.hours,at)-1;return Math.min(i<0?Infinity:this.hours[i]+this.curves[i].next(at-this.hours[i]),this.hours[i+1]===undefined?Infinity:this.hours[i+1]+this.curves[i+1].times[0]);}
  last(at:number){let i=upper(this.hours,at)-1;if(i<0)return 0;let value=this.curves[i].last(Math.min(WORK_BLOCK_MS,at-this.hours[i]));if(value===null&&i>0){i--;value=this.curves[i].last(WORK_BLOCK_MS);}return value===null?0:this.hours[i]+value;}
  get bytes(){return this.hours.length*32+16;}
  /** Export the same exact sweep used by the integrals, without contextual refs. */
  *sourceBlocks(pattern:(values:number[])=>number,reserve:(bytes:number)=>void=()=>{}):Generator<[number,number]> {
    for(let i=0;i<this.hours.length;i++){
      reserve(64);const curve=this.curves[i],values:number[]=[];let count=0;
      for(const at of curve.times){const next=curve.slope(at);if(next!==count){reserve(32);values.push(at,next-count);}count=next;}
      const id=pattern(values);reserve(32);yield [this.hours[i]/WORK_BLOCK_MS,id];
    }
  }
  /** Whole expired hours leave owned buffers; surviving hour patterns stay shared. */
  retain(from:number,reserve:(bytes:number)=>void) {
    let start=Math.max(0,upper(this.hours,from)-1);
    if(start<this.hours.length&&this.hours[start]+this.curves[start].last(WORK_BLOCK_MS)!<=from)start++;
    if(!start)return this;
    reserve((this.hours.length-start)*32+144);
    return new WorkTimeline(this,start);
  }
  *measure(curves:Set<Curve>,reserve:(bytes:number)=>void):Preparation<number>{
    let bytes=this.bytes;
    for(const curve of this.curves){if(!curves.has(curve)){reserve(64);curves.add(curve);bytes+=curve.bytes;}yield;}
    return bytes;
  }
}

export type SourceWorkTape={version:1;from:number;cut:number;patterns:number[][];sources:{id:string;knownFrom:number|null;blocks:number[]}[];replaceFrom?:number;replaceTo?:number};
export type SourceWorkCurves={groups:{source:ReadonlyMap<string,WorkTimeline>};knownFrom:number;available?:boolean;bytes?:number};
/** Scratch is admitted before growth and released on failure or ownership transfer. */
function sourceMemory(reserve:(bytes:number)=>void,release?:((bytes:number)=>void)) {
  let bytes=0;
  const add=(size:number)=>{reserve(size);bytes+=size;};
  const drop=(size:number)=>{if(release&&size){release(size);bytes-=size;}};
  return {add,drop,get bytes(){return bytes;},retain:(size:number)=>drop(Math.max(0,bytes-size)),clear:()=>drop(bytes)};
}
const sourceTapeBytes=(tape:SourceWorkTape)=>128+tape.patterns.reduce((bytes,pattern)=>bytes+96+pattern.length*16,0)+tape.sources.reduce((bytes,row)=>bytes+256+row.id.length*2+row.blocks.length*16,0);

export function sourceWorkTape(curves:{groups:{source:ReadonlyMap<string,WorkTimeline>}},from:number,cut:number,sources:ReadonlyMap<string,number|null>,reserve:(bytes:number)=>void,release?:(bytes:number)=>void):SourceWorkTape {
  const memory=sourceMemory(reserve,release);let complete=false;
  try{
    memory.add(128);const patterns:number[][]=[],ids=new Map<string,number>();
    const pattern=(values:number[])=>{
      const valueBytes=64+values.length*16,keyBytes=64+values.length*64;memory.add(keyBytes);
      const key=values.join(',');let id=ids.get(key);
      if(id===undefined){memory.add(128);id=patterns.length;ids.set(key,id);patterns.push(values);memory.drop(keyBytes-(64+key.length*2));}
      else memory.drop(keyBytes+valueBytes);
      return id;
    };
    const rows:SourceWorkTape['sources']=[];
    for(const [id,knownFrom] of sources){
      memory.add(256+id.length*2);const blocks:number[]=[];
      for(const [hour,p] of curves.groups.source.get(id)?.sourceBlocks(pattern,memory.add)??[])blocks.push(hour,p);
      rows.push({id,knownFrom,blocks});
    }
    const tape:SourceWorkTape={version:1,from,cut,patterns,sources:rows};ids.clear();memory.retain(sourceTapeBytes(tape));complete=true;return tape;
  }finally{if(!complete)memory.clear();}
}

/** Strict source-only decoding shares Curve and WorkTimeline's millisecond arithmetic. */
export function sourceWorkCurves(tape:SourceWorkTape,reserve:(bytes:number)=>void=()=>{},retained?:{tape:SourceWorkTape;curves:SourceWorkCurves},release?:(bytes:number)=>void):SourceWorkCurves {
  if(tape.version!==1||!Number.isSafeInteger(tape.from)||!Number.isSafeInteger(tape.cut)||tape.cut<tape.from||!Array.isArray(tape.patterns)||!Array.isArray(tape.sources))throw new Error('invalid_source_work');
  const memory=sourceMemory(reserve,release);let complete=false;
  try{
    memory.add(128+tape.patterns.length*16);let bytes=0;const owned=new Set<Curve>();
    const patterns=tape.patterns.map(pattern=>{
      if(!Array.isArray(pattern)||pattern.length%2)throw new Error('invalid_source_work');
      memory.add(160+pattern.length*32);const changes:[number,number][]=[];let count=0,previous=-1;
      for(let i=0;i<pattern.length;i+=2){const at=pattern[i],delta=pattern[i+1];count+=delta;
        if(!Number.isSafeInteger(at)||at<0||at>WORK_BLOCK_MS||at<=previous||!Number.isSafeInteger(delta)||!Number.isSafeInteger(count)||count<0)throw new Error('invalid_source_work');
        changes.push([at,delta]);previous=at;
      }
      if(count!==0)throw new Error('invalid_source_work');const curve=new Curve(changes);memory.drop(changes.length*32);return curve;
    });
    const source=new Map<string,WorkTimeline>();let knownFrom=Infinity;
    for(const row of tape.sources){
      if(typeof row.id!=='string'||!row.id||source.has(row.id)||row.knownFrom!==null&&!Number.isSafeInteger(row.knownFrom)||!Array.isArray(row.blocks)||row.blocks.length%2)throw new Error('invalid_source_work');
      memory.add(288+row.id.length*2+row.blocks.length*32);const blocks:[number,Curve][]=[];let previous=-Infinity;
      for(let i=0;i<row.blocks.length;i+=2){const hour=row.blocks[i],index=row.blocks[i+1];if(!Number.isSafeInteger(hour)||hour<=previous||!Number.isSafeInteger(index)||!patterns[index])throw new Error('invalid_source_work');blocks.push([hour,patterns[index]]);previous=hour;}
      // Accounting indexes may still own an unchanged timeline. Share its buffers.
      const prior=retained?.curves.groups.source.get(row.id),timeline=prior&&sameSourceWork(retained!.tape,tape,row.id)?prior:new WorkTimeline(blocks);
      source.set(row.id,timeline);bytes+=256+row.id.length*2+drain(timeline.measure(owned,memory.add));memory.drop(blocks.length*32);
      if(row.knownFrom!==null)knownFrom=Math.min(knownFrom,row.knownFrom);
    }
    const result={groups:{source},knownFrom,available:Number.isFinite(knownFrom),bytes:bytes+owned.size*160};
    memory.retain(result.bytes);complete=true;return result;
  }finally{if(!complete)memory.clear();}
}

/** Replace the exact interval, including an empty tail and cuts inside an hour. */
export function mergeSourceWorkTape(before:SourceWorkTape,patch:SourceWorkTape,reserve:(bytes:number)=>void=()=>{},release?:(bytes:number)=>void):SourceWorkTape {
  const memory=sourceMemory(reserve,release);let complete=false;
  try{
    sourceWorkCurves(patch,memory.add,undefined,memory.drop);memory.drop(memory.bytes);
    const from=patch.from,cut=patch.cut,replaceFrom=patch.replaceFrom??from,replaceTo=patch.replaceTo??cut;
    memory.add(256);const patterns:number[][]=[],dictionary=new Map<string,number>(),sources:SourceWorkTape['sources']=[],references=new Map<readonly number[],number>();
    const pattern=(values:number[],shared:boolean)=>{
      let id=shared?references.get(values):undefined;if(id!==undefined)return id;
      const keyBytes=64+values.length*64;memory.add(keyBytes);const key=values.join(',');id=dictionary.get(key);
      if(id===undefined){memory.add(160+values.length*32);id=patterns.length;dictionary.set(key,id);patterns.push(values);memory.drop(keyBytes-(64+key.length*2));}
      else memory.drop(keyBytes);
      if(shared){memory.add(64);references.set(values,id);}return id;
    };
    const incoming=new Map<string,SourceWorkTape['sources'][number]>();
    for(const row of patch.sources){memory.add(64);incoming.set(row.id,row);}
    const rows=function*(){yield*patch.sources;for(const row of before.sources)if(!incoming.has(row.id))yield row;};
    for(const row of rows()){
      memory.add(256+row.id.length*2);const prior=before.sources.find(source=>source.id===row.id),old=prior?.blocks??[],next=incoming.get(row.id)?.blocks??[],blocks:number[]=[];let i=0,j=0;
      // Whole hours keep their shared pattern; only partial hours need a new sweep.
      while(i<old.length||j<next.length){
        const hour=Math.min(old[i]??Infinity,next[j]??Infinity),base=hour*WORK_BLOCK_MS,end=base+WORK_BLOCK_MS;
        const a=old[i]===hour?before.patterns[old[i+1]]:undefined,b=next[j]===hour?patch.patterns[next[j+1]]:undefined;
        if(old[i]===hour)i+=2;if(next[j]===hour)j+=2;
        if(end<=from||base>=cut)continue;
        let values:number[]|undefined,scratch=0;
        if(base>=from&&end<=cut&&(end<=replaceFrom||base>=replaceTo))values=a;
        else if(base>=from&&end<=cut&&base>=replaceFrom&&end<=replaceTo)values=b;
        else {
          memory.add(128);scratch+=128;const changes=new Map<number,number>();
          const add=(values:number[]|undefined,ranges:readonly [number,number][])=>{
            let count=0;
            for(let k=0;k<(values?.length??0);k+=2){count+=values![k+1];if(!count)continue;const end=values![k+2]??WORK_BLOCK_MS;
              for(const [lo,hi] of ranges){const a=Math.max(values![k],from-base,lo-base),b=Math.min(end,cut-base,hi-base);if(a>=b)continue;
                memory.add(64);scratch+=64;changes.set(a,(changes.get(a)??0)+count);changes.set(b,(changes.get(b)??0)-count);
              }
            }
          };
          add(a,[[from,replaceFrom],[replaceTo,cut]]);add(b,[[replaceFrom,replaceTo]]);
          const arrays=128+changes.size*128;memory.add(arrays);scratch+=arrays;
          values=[...changes].filter(([,delta])=>delta!==0).sort(([a],[b])=>a-b).flat();
        }
        if(values?.length){const id=pattern(values,!scratch);memory.add(32);blocks.push(hour,id);}
        memory.drop(scratch);
      }
      sources.push({id:row.id,knownFrom:row.knownFrom,blocks});
    }
    const tape:SourceWorkTape={version:1,from,cut,patterns,sources};dictionary.clear();references.clear();incoming.clear();memory.retain(sourceTapeBytes(tape));complete=true;return tape;
  }finally{if(!complete)memory.clear();}
}

/** Dictionary indices are local to each tape; compare the actual source curves. */
export function sameSourceWork(before:SourceWorkTape|null,after:SourceWorkTape|null,source:string):boolean {
  const a=before?.sources.find(row=>row.id===source),b=after?.sources.find(row=>row.id===source);
  if(!a||!b)return a===b;
  if(a.knownFrom!==b.knownFrom||a.blocks.length!==b.blocks.length)return false;
  for(let i=0;i<a.blocks.length;i+=2){
    if(a.blocks[i]!==b.blocks[i])return false;
    const x=before!.patterns[a.blocks[i+1]],y=after!.patterns[b.blocks[i+1]];
    if(x.length!==y.length||x.some((value,index)=>value!==y[index]))return false;
  }
  return true;
}

export class PeriodCurves {
  readonly contexts:WorkTimeline[]=[];
  readonly groups={source:new Map<string,WorkTimeline>(),project:new Map<string,WorkTimeline>(),device:new Map<string,WorkTimeline>()};
  all!:WorkTimeline;
  private retainedBytes=0;
  constructor(readonly trace:WorkTrace,deferred=false){if(!deferred)drain(this.build());}
  static *prepare(trace:WorkTrace):Preparation<PeriodCurves>{const value=new PeriodCurves(trace,true);yield*value.build();return value;}
  /** retainWork preserves reference objects and removes only evidence before its new anchor. */
  *retain(trace:WorkTrace,reserve:(bytes:number)=>void):Preparation<PeriodCurves>{
    reserve(256+trace.refs.length*32);
    const value=new PeriodCurves(trace,true),refs=new Map<WorkTrace['refs'][number],number>();
    for(const [id,ref] of this.trace.refs.entries()){reserve(64);refs.set(ref,id);yield;}
    const timelines=new Map<WorkTimeline,WorkTimeline>(),curves=new Set<Curve>();
    const keep=function*(timeline:WorkTimeline):Preparation<WorkTimeline>{
      const known=timelines.get(timeline);if(known)return known;
      reserve(64);const next=timeline.retain(trace.anchor,reserve);timelines.set(timeline,next);
      value.retainedBytes+=yield*next.measure(curves,reserve);return next;
    };
    value.all=yield*keep(this.all);
    for(const ref of trace.refs){const id=refs.get(ref);if(id===undefined)throw new Error('retained work changed its context');value.contexts.push(yield*keep(this.contexts[id]));yield;}
    for(const ref of trace.refs){
      const keys={source:sourceKey(ref),project:JSON.stringify(ref.project),device:ref.device.id};
      for(const dimension of ['source','project','device'] as const){const key=keys[dimension];if(!value.groups[dimension].has(key)){reserve(64+key.length*2);value.groups[dimension].set(key,yield*keep(this.groups[dimension].get(key)!));}yield;}
    }
    return value;
  }
  private *build():Preparation<void>{
    const packed=(yield*packWorkPrepared(this.trace)).packed!;
    type Hours=Map<number,Map<number,number>>;
    const byRef:number[][]=this.trace.refs.map(()=>[]);for(let i=0;i<packed.blocks.length;i+=3){byRef[packed.blocks[i]].push(i);yield;}
    const groups={source:new Map<string,Set<number>>(),project:new Map<string,Set<number>>(),device:new Map<string,Set<number>>()};
    for(let id=0;id<this.trace.refs.length;id++){const ref=this.trace.refs[id],keys={source:sourceKey(ref),project:JSON.stringify(ref.project),device:ref.device.id};for(const dimension of ['source','project','device'] as const){let ids=groups[dimension].get(keys[dimension]);if(!ids)groups[dimension].set(keys[dimension],ids=new Set());ids.add(id);}yield;}
    const curves=new Map<string,Curve>(),timelines=new Map<string,WorkTimeline>();let retained=0;
    function* timeline(ids?:ReadonlySet<number>):Preparation<WorkTimeline>{
      // Only one group's hour buckets exist at a time; overlapping dimensions
      // share the final curves without multiplying the staging ledger.
      const hours:Hours=new Map();
      for(const id of ids??byRef.keys())for(const i of byRef[id]){const hour=packed.blocks[i+1],pattern=packed.blocks[i+2];let parts=hours.get(hour);if(!parts)hours.set(hour,parts=new Map());parts.set(pattern,(parts.get(pattern)??0)+1);yield;}
      const blocks:[number,Curve][]=[],keys:string[]=[];
      for(const [hour,parts] of yield*ordered(hours,(a,b)=>a[0]-b[0])){
        const entries=[...parts].sort((a,b)=>a[0]-b[0]),key=entries.flat().join(',');let curve=curves.get(key);
        if(!curve){const changes=new Map<number,number>();for(const [id,count] of entries){const pattern=packed.patterns[id];for(let i=0;i<pattern.length;i+=2){changes.set(pattern[i],(changes.get(pattern[i])??0)+count);changes.set(pattern[i+1],(changes.get(pattern[i+1])??0)-count);yield;}}curve=new Curve(yield*ordered([...changes].filter(([,delta])=>delta!==0),(a,b)=>a[0]-b[0]));curves.set(key,curve);retained+=curve.bytes;}
        blocks.push([hour,curve]);keys.push(hour+':'+key);yield;
      }
      const key=keys.join(';');let result=timelines.get(key);if(!result){result=new WorkTimeline(blocks);timelines.set(key,result);retained+=result.bytes;}return result;
    }
    this.all=yield*timeline();
    for(let id=0;id<this.trace.refs.length;id++)this.contexts.push(yield*timeline(new Set([id])));
    for(const dimension of ['source','project','device'] as const)for(const [key,ids] of groups[dimension])this.groups[dimension].set(key,yield*timeline(ids));
    this.retainedBytes=retained;
  }
  get bytes(){return this.retainedBytes;}
}
