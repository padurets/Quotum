import type {Hub} from './api.js';
import type {HistoryTiles} from './history.js';
import type {Shown, WorkRead} from './store/store.js';
import type {Stretch} from './domain/work.js';
import type {PeriodRange} from './domain/period.js';
import {packWorkPrepared,type WorkTrace} from './domain/periodWork.js';
import {drain,type Preparation} from './domain/prepare.js';
import type {Sessions} from './sessions.js';
import {workKnownFrom} from './domain/history.js';

/** A composite read extracts work once for charts and the temporal index. */
export function sharedWork(hub:Pick<Hub,'store'>,_shown:Shown,range:PeriodRange|null|(()=>PeriodRange|null),reserve:(bytes:number)=>void,release:(bytes:number)=>void,_owner:string|null=null,now=Date.now(),board:string):WorkRead {
  let kept:{from:number;to:number;rows:Stretch[]}|null=null,bytes=0;
  let access:import('./domain/workAccess.js').WorkAccess|undefined,authority:string|undefined,accessError:unknown,snapshotBytes=0;
  try{access=hub.store.workAccess(board,now,size=>{reserve(size);snapshotBytes+=size;});authority=hub.store.workKey(board,undefined,access,reserve,release);}
  catch(error){access=undefined;release(snapshotBytes);accessError=error;}
  const ensureAccess=()=>{if(accessError)throw accessError;return access!;};
  const read:WorkRead=(from,to)=>{
    if(!kept||from<kept.from||to>kept.to){
      const requested=typeof range==='function'?range():range;
      const start=Math.min(from,requested?.from??from,kept?.from??from),end=Math.max(to,requested?.to??to,kept?.to??to);
      kept=null;release(bytes);bytes=0;
      try{kept={from:start,to:end,rows:hub.store.admittedWork(ensureAccess(),start,end,size=>{reserve(size);bytes+=size;})};}
      catch(error){release(bytes);bytes=0;throw error;}
    }
    return kept.rows.flatMap(s=>s.to>from&&s.from<to?[s.from>=from&&s.to<=to?s:{...s,from:Math.max(from,s.from),to:Math.min(to,s.to)}]:[]);
  };
  read.access=access;read.authority=authority;read.ensureAccess=ensureAccess;read.reserve=reserve;read.release=release;return read;
}

export function periodWork(hub:Hub,history:HistoryTiles,board:string,shown:Shown,range:PeriodRange,work:WorkRead,now:number,reserve:(bytes:number)=>void,release?:(bytes:number)=>void):WorkTrace {
  return drain(preparePeriodWork(hub,history,board,shown,range,work,now,reserve,release));
}
export function* preparePeriodWork(hub:Hub,history:HistoryTiles,board:string,shown:Shown,range:PeriodRange,work:WorkRead,now:number,reserve:(bytes:number)=>void,release?:(bytes:number)=>void,presence:Sessions['presence']=hub.ingest.live.presence.bind(hub.ingest.live)):Preparation<WorkTrace> {
  const access=work.ensureAccess?.()??work.access??hub.store.workAccess(board,now,reserve),known=hub.store.historyKnown(shown,access.owner,access),anchor=range.from;
  const from=workKnownFrom(known);
  const trace:WorkTrace={anchor,cut:range.to,knownFrom:from??range.to,...(from===null?{available:false}:{}),refs:[],spans:[]};
  const indices=new Map<number,number>();
  for(const row of work(range.from,range.to)) {
    let index=indices.get(row.session);
    if(index===undefined) {
      index=trace.refs.length;indices.set(row.session,index);
      const saved=row.rawContext!;
      const presenceKey=hub.ingest.live.binding(row.device,saved.client,saved.source,saved.producer,row.origin,saved.project,saved.folder);
      const currentPresence=presence(row.device,saved.client,saved.source,saved.producer,row.origin,saved.project,saved.folder,now);
      const deviceName=saved.deviceName,folder=row.folder??(row.project!==saved.project?saved.project:null);
      reserve(416+2*((row.project?.length??0)+(folder?.length??0)+deviceName.length));
      trace.refs.push({ref:history.ref(board,row.session),source:row.source,...(row.sourceStatus?{sourceStatus:row.sourceStatus}:{}),clientId:saved.client,device:{id:row.device,name:deviceName},origin:row.origin,project:row.project,folder,startedAt:row.startedAt,...(presenceKey?{presenceKey}:{}),...(currentPresence?{currentPresence}:{})});
    }
    const start=row.from-anchor,end=row.to-anchor,last=trace.spans.at(-1);
    if(last&&last[0]===index&&last[2]>=start)last[2]=Math.max(last[2],end);
    else {reserve(48);trace.spans.push([index,start,end]);}
    yield;
  }
  if(trace.spans.length<128)return trace;
  const packed=yield*packWorkPrepared(trace,reserve,release);
  release?.(trace.spans.length*48);
  return packed;
}
