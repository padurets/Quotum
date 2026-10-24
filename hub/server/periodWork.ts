import {config} from './config.js';
import {normalizeRanges} from './domain/workCalendar.js';
import {resolveLink} from './domain/links.js';
import {fundingOf} from './domain/workAccess.js';
import type {Hub} from './api.js';
import {HistoryLimit,type HistoryTiles} from './history.js';
import type {Shown, WorkRead} from './store/store.js';
import type {Stretch} from './domain/work.js';
import type {PeriodRange} from './domain/period.js';
import {packWorkPrepared,type WorkTrace} from './domain/periodWork.js';
import {drain,type Preparation} from './domain/prepare.js';
import type {Sessions} from './sessions.js';
import {workKnownFrom} from './domain/history.js';
import {prepareWorkFilter,type WorkFilter} from './domain/dataFilters.js';

/** Both scopes borrow the same bounded raw ledger and immutable access snapshot. */
export function selectedWork(sourceWide:WorkRead,filter:WorkFilter):WorkRead {
  let match:ReturnType<typeof prepareWorkFilter>|undefined,bytes=0;
  const read:WorkRead=(from,to)=>{
    try{
      // Only a consuming section prepares the matcher; siblings keep their capacity.
      match??=prepareWorkFilter(filter,size=>{sourceWide.reserve?.(size);bytes+=size;});
      return sourceWide(from,to).filter(row=>match!({...row,clientId:row.rawContext?.client??null}));
    }catch(error){sourceWide.release?.(bytes);bytes=0;match=undefined;throw error;}
  };
  read.access=sourceWide.access;read.authority=sourceWide.authority;read.ensureAccess=sourceWide.ensureAccess;read.reserve=sourceWide.reserve;read.release=sourceWide.release;
  read.filterKey=JSON.stringify(filter);return read;
}

/** A composite read extracts work once for charts and the temporal index. */
export function sharedWork(hub:Pick<Hub,'store'>,_shown:Shown,range:PeriodRange|null|(()=>PeriodRange|PeriodRange[]|null),reserve:(bytes:number)=>void,release:(bytes:number)=>void,_owner:string|null=null,now=Date.now(),board:string,onLimit?:(from:number,to:number)=>boolean,reserveValidation?:(bytes:number)=>void):WorkRead {
  let kept:{ranges:PeriodRange[];rows:Stretch[]}|null=null,bytes=0;
  let access:import('./domain/workAccess.js').WorkAccess|undefined,authority:string|undefined,accessError:unknown,captured=0,peak=0;
  const capture=(size:number)=>{reserve(size);captured+=size;peak=Math.max(peak,captured);};
  const drop=(size:number)=>{release(size);captured-=size;};
  try{
    access=hub.store.workAccess(board,now,capture);authority=hub.store.workKey(board,undefined,access,capture,drop);
    // An async reader must still validate this authority when its projection is full.
    reserveValidation?.(peak);
  }catch(error){access=undefined;authority=undefined;release(captured);accessError=error;}
  const ensureAccess=()=>{if(accessError)throw accessError;return access!;};
  const read:WorkRead=(from,to)=>{
    from=Math.max(from,now-config.retention.sampleDays*86_400_000);to=Math.min(to,now);if(to<=from)return [];
    if(!kept||!kept.ranges.some(r=>from>=r.from&&to<=r.to)){
      const requested=typeof range==='function'?range():range;
      const ranges=normalizeRanges([{from,to},...(Array.isArray(requested)?requested:requested?[requested]:[]),...(kept?.ranges??[])].map(r=>({from:Math.max(r.from,now-config.retention.sampleDays*86_400_000),to:Math.min(r.to,now)})));
      const start=ranges[0]?.from??from,end=ranges.at(-1)?.to??to;
      kept=null;release(bytes);bytes=0;
      try{kept={ranges,rows:hub.store.admittedWork(ensureAccess(),start,end,size=>{reserve(size);bytes+=size;},ranges)};}
      catch(error){release(bytes);bytes=0;if(error instanceof HistoryLimit&&onLimit?.(from,to))return read(from,to);throw error;}
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
  const trace:WorkTrace={anchor,cut:range.to,knownFrom:from===null?range.to:Math.max(from,now-config.retention.sampleDays*86_400_000),...(from===null?{available:false}:{}),refs:[],spans:[]};
  const indices=new Map<string,number>();
  for(const row of work(range.from,range.to)) {
    const fragment=JSON.stringify([row.session,row.source,row.sourceStatus]);
    let index=indices.get(fragment);
    if(index===undefined) {
      index=trace.refs.length;indices.set(fragment,index);
      const saved=row.rawContext!;
      const binding=hub.ingest.live.binding(row.device,saved.client,saved.source,saved.producer,row.origin,saved.project,saved.folder);
      const context=access.attribution?.(row.user,row.device,saved.client);
      const current=context?resolveLink({clientId:saved.client,deviceId:row.device,source:saved.source,accountBy:saved.accountBy,route:saved.route},context,now).source:saved.source;
      const funding=fundingOf(access,row.user,current);
      const presenceKey=funding.source===row.source&&funding.sourceStatus===row.sourceStatus?binding:undefined;
      const currentPresence=presenceKey?presence(row.device,saved.client,saved.source,saved.producer,row.origin,saved.project,saved.folder,now):undefined;
      const deviceName=saved.deviceName,folder=row.folder??(row.project!==saved.project?saved.project:null);
      reserve(640+2*((row.project?.length??0)+(folder?.length??0)+deviceName.length));
      trace.refs.push({ref:history.fragmentRef(board,row.session,row.source,row.sourceStatus),identityRef:history.ref(board,row.session),source:row.source,...(row.sourceStatus?{sourceStatus:row.sourceStatus}:{}),clientId:saved.client,device:{id:row.device,name:deviceName},origin:row.origin,project:row.project,folder,startedAt:row.startedAt,...(presenceKey?{presenceKey}:{}),...(currentPresence?{currentPresence}:{})});
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
