import {WORK_BLOCK_MS} from './periodWork.js';
import {sourceWorkCurves,type SourceWorkTape,type WorkTimeline} from './periodCurves.js';
import type {Preparation} from './prepare.js';
import type {PeriodRange} from './period.js';
import type {Stretch} from './work.js';
import type {CalendarCell,CalendarProof} from './workCalendar.js';

export function calendarCurve(proof:CalendarProof,range:PeriodRange,cut:number,known:number|null,reserve:(bytes:number)=>void,release?:(bytes:number)=>void){
  if(!Number.isSafeInteger(proof.retentionMs)||proof.retentionMs<=0||proof.periodMs!==undefined&&(!Number.isSafeInteger(proof.periodMs)||proof.periodMs<900_000||proof.periodMs>31*86_400_000)||proof.from!==range.from||proof.cut!==cut||!Array.isArray(proof.sources)||proof.sources.length!==1||!proof.sources[0]||proof.sources[0].id!=='work'||proof.sources[0].knownFrom!==known)throw new Error('invalid_calendar_proof');
  const curves=sourceWorkCurves(proof,reserve,undefined,release),curve=curves.groups.source.get('work');if(!curve)throw new Error('invalid_calendar_proof');return {curve,bytes:curves.bytes??0};
}

/** Anonymous hour patterns retain exact boundary changes without session identities. */
export function* calendarProof(rows:Iterable<Stretch>,range:PeriodRange,cut:number,known:number|null,retained:number,reserve:(bytes:number)=>void):Preparation<SourceWorkTape>{
  const hours=new Map<number,Map<number,number>>();
  for(const row of rows){
    const from=Math.max(row.from,range.from,retained,known??cut),to=Math.min(row.to,range.to,cut);
    if(from>=to)continue;
    for(let hour=Math.floor(from/WORK_BLOCK_MS);hour*WORK_BLOCK_MS<to;hour++){
      let changes=hours.get(hour);if(!changes){reserve(128);hours.set(hour,changes=new Map());}
      const start=Math.max(from-hour*WORK_BLOCK_MS,0),end=Math.min(to-hour*WORK_BLOCK_MS,WORK_BLOCK_MS);
      reserve(128);changes.set(start,(changes.get(start)??0)+1);changes.set(end,(changes.get(end)??0)-1);yield;
    }
    yield;
  }
  const patterns:number[][]=[],blocks:number[]=[],ids=new Map<string,number>();
  for(const [hour,changes] of [...hours].sort((a,b)=>a[0]-b[0])){
    reserve(128+changes.size*48);const values=[...changes].filter(([,delta])=>delta!==0).sort((a,b)=>a[0]-b[0]).flat(),key=values.join(',');let id=ids.get(key);
    if(id===undefined){id=patterns.length;ids.set(key,id);patterns.push(values);}blocks.push(hour,id);yield;
  }
  return {version:1,from:range.from,cut,patterns,sources:[{id:'work',knownFrom:known,blocks}]};
}

export type CalendarSegment={from:number;to:number;curve:WorkTimeline};
/** The same integral clips arbitrary selection edges, including sub-minute cache shifts. */
export function calendarProjection(edges:readonly number[],range:PeriodRange,cut:number,known:number|null,retained:number,retention:number,period:number|undefined,segments:readonly CalendarSegment[]):CalendarCell[]{
  return edges.slice(0,-1).map((edge,i)=>{
    const from=Math.max(edge,range.from,retained,known??cut),to=Math.min(edges[i+1],range.to,cut),point=Math.max(edge,Math.min(edges[i+1],range.to,cut));
    if(known===null||from>=to)return {agentMs:null,from:point,to:point,validUntil:null};
    let agentMs=0,first=Infinity;
    for(const part of segments){
      const start=Math.max(from,part.from),end=Math.min(to,part.to);if(start>=end)continue;
      const ms=part.curve.read({from:start,to:end});agentMs+=ms;
      if(ms>0)first=Math.min(first,part.curve.working(start)?start:part.curve.next(start));
    }
    if(!Number.isSafeInteger(agentMs))throw new Error('calendar_overflow');
    return {agentMs,from,to,validUntil:agentMs?first+Math.min(retention,period??Infinity)+1:null};
  });
}
