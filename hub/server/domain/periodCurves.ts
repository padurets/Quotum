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
