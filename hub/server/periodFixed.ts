import type {PeriodRange} from './domain/period.js';
import {decodeSamples,sampleCount,type PeriodTape} from './domain/periodTape.js';
import {drain} from './domain/prepare.js';
import {PeriodCurves} from './domain/periodCurves.js';
import {PeriodAccounting} from './domain/periodAccounting.js';
import {PeriodIndex} from './domain/periodIndex.js';
import {PeriodActivity} from './domain/periodActivity.js';
import type {WorkTrace} from './domain/periodWork.js';
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
  return {...tape,quota:[],money:[],fixed:accounting.fixed(range,cell)};
}

export function fixedWork(trace:WorkTrace,range:PeriodRange,cell:number,now:number,reserve:(bytes:number)=>void):WorkTrace {
  reserve(trace.spans.length*640+(trace.packed?trace.packed.blocks.length*64+trace.packed.patterns.reduce((n,p)=>n+p.length*128,0):0));
  const index=new PeriodIndex(trace),rows=index.advance(range,now).rows,projection=new PeriodActivity(trace,index.curves);
  projection.update(rows);
  const barMs=barOf(cell,range.to-range.from);
  const blank:History['activity']={since:range.from,known:null,barMs,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}};
  const activity=projection.project(blank,range);
  for(const at of new Set([Math.floor(range.from/barMs)*barMs,Math.floor((range.to-1)/barMs)*barMs])){
    const part={from:Math.max(range.from,at),to:Math.min(range.to,at+barMs)};
    activity.cells.push([at,index.curves.all.read(part,true),index.curves.all.read(part),index.curves.contexts.filter(curve=>curve.read(part)>0).length]);
    for(const by of ['source','project','device'] as const)for(const group of activity.by[by])group.cells.push([at,index.curves.groups[by].get(group.key)!.read(part)]);
  }
  const ids=new Map(trace.refs.map((ref,i)=>[ref.ref,i]));
  return {...trace,spans:[],packed:undefined,fixed:{range,totals:rows.map(row=>[ids.get(row.ref)!,row.workedMs,row.lastWorkedAt]),activity}};
}
