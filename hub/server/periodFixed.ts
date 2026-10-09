import type {PeriodRange} from './domain/period.js';
import {decodeSamples,sampleCount,sampleAt,type PeriodTape} from './domain/periodTape.js';
import {drain} from './domain/prepare.js';
import {PeriodCurves} from './domain/periodCurves.js';
import {PeriodAccounting} from './domain/periodAccounting.js';
import {PeriodIndex} from './domain/periodIndex.js';
import {PeriodActivity} from './domain/periodActivity.js';
import {workSpans,type WorkTrace} from './domain/periodWork.js';
import {shiftBoundaries,withShift,withShiftWindow} from './domain/periodShift.js';
import {HistoryLimit} from './history.js';
import {barOf} from './domain/work.js';
import type {History} from './domain/history.js';

/** A fixed interval needs exact totals and boundary geometry, not a rolling ledger. */
export function fixedTape(tape:PeriodTape,work:WorkTrace|null,range:PeriodRange,cell:number,reserve:(bytes:number)=>void,release:(bytes:number)=>void=()=>{}):PeriodTape {
  reserve(JSON.stringify(tape.money).length*3);
  for(const series of tape.quota){reserve(sampleCount(series.samples)*40);if(series.samplesEncoding==='delta')series.samples=decodeSamples(series.samples);delete series.samplesEncoding;}
  if(work)reserve(work.spans.length*640+(work.packed?work.packed.blocks.length*64+work.packed.patterns.reduce((n,p)=>n+p.length*128,0):0));
  const curves=work?new PeriodCurves(work):undefined;
  let scratch=0;
  const accounting=drain(PeriodAccounting.prepare(tape,work,curves,undefined,undefined,bytes=>{if(bytes>scratch)reserve(bytes-scratch);else release(scratch-bytes);scratch=bytes;}));
  const base=accounting.fixed(range,cell);
  reserve(JSON.stringify(base).length*6);
  function* anchors(){
    for(const series of tape.quota){
      yield series.workFrom??0;
      for(const descriptor of series.descriptors??[])yield descriptor.at;
      for(let i=0;i<sampleCount(series.samples);i++){const s=sampleAt(series.samples,i)!;yield s.at;yield s.at+s.staleAfterMs+1;yield s.resetAt??Infinity;yield s.validUntil??Infinity;}
    }
    for(const group of tape.money)for(const part of [group,...(group.paired?[group.paired]:[])]){
      for(const r of part.readings){yield r.at;yield r.previousAt??Infinity;yield r.resetAt??Infinity;yield r.at+r.staleAfterMs+1;}
      for(const s of part.spans){yield s.from;yield s.to;yield s.to+s.staleAfterMs+1;yield s.holdUntil??Infinity;yield s.interruptedAt??Infinity;}
    }
    if(work)yield*workAnchors(work);
  }
  const fixed=reusable(base,offset=>accounting.fixed({from:range.from+offset,to:range.to+offset},cell),cell,tape.from,tape.cut,[cell],anchors(),reserve,release);
  return {...tape,quota:[],money:[],fixed};
}

function* workAnchors(trace:WorkTrace){yield trace.knownFrom;for(const [,from,to] of workSpans(trace)){yield trace.anchor+from;yield trace.anchor+to;}}

export function fixedWork(trace:WorkTrace,range:PeriodRange,cell:number,now:number,reserve:(bytes:number)=>void,release:(bytes:number)=>void=()=>{}):WorkTrace {
  reserve(trace.spans.length*640+(trace.packed?trace.packed.blocks.length*64+trace.packed.patterns.reduce((n,p)=>n+p.length*128,0):0));
  const index=new PeriodIndex(trace),projection=new PeriodActivity(trace,index.curves);
  const barMs=barOf(cell,range.to-range.from);
  const project=(range:PeriodRange):NonNullable<WorkTrace['fixed']>=>{
    const rows=index.advance(range,now).rows;projection.update(rows);
    const blank:History['activity']={since:range.from,known:null,barMs,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}};
    const activity=projection.project(blank,range);
    for(const at of new Set([Math.floor(range.from/barMs)*barMs,Math.floor((range.to-1)/barMs)*barMs])){
      const part={from:Math.max(range.from,at),to:Math.min(range.to,at+barMs)};
      activity.cells.push([at,index.curves.all.read(part,true),index.curves.all.read(part),index.curves.contexts.filter(curve=>curve.read(part)>0).length]);
      for(const by of ['source','project','device'] as const)for(const group of activity.by[by])group.cells.push([at,index.curves.groups[by].get(group.key)!.read(part)]);
    }
    const ids=new Map(trace.refs.map((ref,i)=>[ref.ref,i]));
    return {range,totals:rows.map(row=>[ids.get(row.ref)!,row.workedMs,row.lastWorkedAt]),activity};
  };
  const base=project(range);reserve(JSON.stringify(base).length*6);
  const fixed=reusable(base,offset=>project({from:range.from+offset,to:range.to+offset}),cell,trace.anchor,trace.cut??range.to,[cell,barMs],workAnchors(trace),reserve,release);
  return {...trace,spans:[],packed:undefined,fixed};
}

function reusable<T extends {range:PeriodRange}>(base:T,read:(offset:number)=>T,cell:number,from:number,to:number,cells:readonly number[],anchors:Iterable<number>,reserve:(bytes:number)=>void,release:(bytes:number)=>void):T {
  let bytes=0,boundaries:number[]=[];const charge=(size:number)=>{reserve(size);bytes+=size;};
  try{
    boundaries=shiftBoundaries(base.range,Math.max(-cell,from-base.range.from),Math.min(cell+1,to-base.range.to+1),cells,anchors,charge);
    return withShiftWindow(base,read,boundaries,charge);
  }
  catch(error){release(bytes);if(!(error instanceof HistoryLimit))throw error;return withShift(base,read,boundaries.find(offset=>offset>0)??1);}
}
