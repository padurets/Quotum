import {drain,ordered,type Preparation} from './prepare.js';
import type {Origin} from './ingest.js';
import type {PeriodRange} from './period.js';

export type WorkRef = {
  ref:string;source:string;device:{id:string;name:string};origin:Origin;
  project:string|null;folder:string|null;startedAt:number;
  currentPresence?:{working:boolean;through:number;workingThrough?:number;startedAt:number};
};
/** Offsets are exact milliseconds, with one shared origin and no repeated context metadata. */
export type WorkTrace = {anchor:number;cut?:number;knownFrom:number;refs:WorkRef[];spans:[number,number,number][]};
export type WorkDelta = WorkTrace & {replaceFrom:number;replaceTo?:number};
export type WorkedSession = WorkRef & {workedMs:number;lastWorkedAt:number;working:boolean};

export function workedSessions(trace:WorkTrace, range:PeriodRange, now:number):WorkedSession[] {
  const sums=new Map<number,{workedMs:number;lastWorkedAt:number}>();
  for(const [index,start,end] of trace.spans) {
    const from=Math.max(range.from,trace.anchor+start),to=Math.min(range.to,trace.anchor+end);
    if(to<=from)continue;
    const previous=sums.get(index);
    sums.set(index,{workedMs:(previous?.workedMs??0)+to-from,lastWorkedAt:Math.max(previous?.lastWorkedAt??0,to)});
  }
  return [...sums].map(([index,worked])=>{
    const ref=trace.refs[index],presence=ref.currentPresence;
    return {...ref,...worked,working:!!presence&&Math.min(presence.through,presence.workingThrough??Infinity)>now&&presence.working};
  });
}

/** Replacement, never addition: a retry or an extended interval cannot count work twice. */
export const mergeWork=(trace:WorkTrace,delta:WorkDelta)=>drain(mergeWorkPrepared(trace,delta));
export function* mergeWorkPrepared(trace:WorkTrace, delta:WorkDelta):Preparation<WorkTrace> {
  const refs=[...trace.refs],indices=new Map(refs.map((ref,i)=>[ref.ref,i]));
  const mapped:number[]=[];
  for(const ref of delta.refs){let index=indices.get(ref.ref);if(index===undefined){index=refs.length;refs.push(ref);indices.set(ref.ref,index);}else refs[index]=ref;mapped.push(index);yield;}
  const anchor=Math.min(trace.anchor,delta.anchor),stop=delta.replaceTo??Infinity;
  const spans:WorkTrace['spans']=[];
  for(const [id,a,b] of trace.spans){const from=Math.max(delta.knownFrom,a+trace.anchor),to=b+trace.anchor;if(to<=from){yield;continue;}
    if(from<delta.replaceFrom)spans.push([id,from-anchor,Math.min(to,delta.replaceFrom)-anchor]);
    if(to>stop)spans.push([id,Math.max(from,stop)-anchor,to-anchor]);yield;
  }
  for(const [id,a,b] of delta.spans){const from=Math.max(delta.knownFrom,a+delta.anchor),to=b+delta.anchor;if(to>from)spans.push([mapped[id],from-anchor,to-anchor]);yield;}
  const sorted=yield* ordered(spans,(a,b)=>a[0]-b[0]||a[1]-b[1]);
  const compact:WorkTrace['spans']=[];
  for(const row of sorted){const last=compact.at(-1);if(last&&last[0]===row[0]&&last[2]>=row[1])last[2]=Math.max(last[2],row[2]);else compact.push(row);yield;}
  const retained:WorkRef[]=[],remap=new Map<number,number>();
  for(const row of compact){let id=remap.get(row[0]);if(id===undefined){id=retained.length;retained.push(refs[row[0]]);remap.set(row[0],id);}row[0]=id;yield;}
  return {anchor,...(delta.cut!==undefined?{cut:delta.cut}:{}),knownFrom:delta.knownFrom,refs:retained,spans:compact};
}
