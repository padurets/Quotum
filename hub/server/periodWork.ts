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
export function sharedWork(hub:Hub,shown:Shown,range:PeriodRange|null,reserve:(bytes:number)=>void,release:(bytes:number)=>void,owner:string|null=null,now=Date.now()):WorkRead {
  let kept: {from:number;to:number;rows:Stretch[]}|null=null;
  let bytes=0;
  const known=Math.max(hub.store.agentWorkSince(),hub.store.historyStart(now));
  const holders=new Map([...shown].map(([source,scope])=>[source,new Map(scope.holders.map(h=>[h.user,Math.max(h.from,scope.since,known)]))]));
  return (from,to)=>{
    if(!kept||from<kept.from||to>kept.to) {
      const start=Math.min(from,range?.from??from,kept?.from??from),end=Math.max(to,range?.to??to,kept?.to??to);
      // Consumers finish their projection before the next read. Release the old
      // extraction before replacing it; an absent session request adds no range.
      kept=null;release(bytes);bytes=0;
      const rows:Stretch[]=[],privateSources=new Map<string|null,boolean>();
      try {if(shown.size||owner)for(const s of hub.store.agentWork(start,end,[...shown.keys()],owner,size=>{reserve(size);bytes+=size;})) {
        if(owner===s.user&&!privateSources.has(s.source))privateSources.set(s.source,hub.store.displaySource(owner,s.source)===null);
        const privateWork=owner===s.user&&privateSources.get(s.source)===true;
        const cutoff=privateWork?known:s.source===null?undefined:holders.get(s.source)?.get(s.user);
        if(cutoff===undefined||s.to<=cutoff)continue;
        rows.push({...s,source:privateWork?null:s.source,from:Math.max(s.from,cutoff)});
      }}catch(error){release(bytes);bytes=0;throw error;}
      kept={from:start,to:end,rows};
    }
    return kept.rows.flatMap(s=>s.to>from&&s.from<to?[s.from>=from&&s.to<=to?s:{...s,from:Math.max(from,s.from),to:Math.min(to,s.to)}]:[]);
  };
}

export function periodWork(hub:Hub,history:HistoryTiles,board:string,shown:Shown,range:PeriodRange,work:WorkRead,now:number,reserve:(bytes:number)=>void,release?:(bytes:number)=>void):WorkTrace {
  return drain(preparePeriodWork(hub,history,board,shown,range,work,now,reserve,release));
}
export function* preparePeriodWork(hub:Hub,history:HistoryTiles,board:string,shown:Shown,range:PeriodRange,work:WorkRead,now:number,reserve:(bytes:number)=>void,release?:(bytes:number)=>void,presence:Sessions['presence']=hub.ingest.live.presence.bind(hub.ingest.live)):Preparation<WorkTrace> {
  const known=hub.store.historyKnown(shown,hub.store.privateOwner(board)),anchor=range.from;
  const trace:WorkTrace={anchor,cut:range.to,knownFrom:Math.max(workKnownFrom(known),hub.store.historyStart(now)),refs:[],spans:[]};
  const indices=new Map<number,number>();
  const device=hub.store.db.prepare('SELECT COALESCE(label,name) AS name FROM devices WHERE id=?');
  const context=hub.store.db.prepare('SELECT producer_id,client,source_id,project,folder FROM agent_sessions WHERE id=?');
  for(const row of work(range.from,range.to)) {
    let index=indices.get(row.session);
    if(index===undefined) {
      index=trace.refs.length;indices.set(row.session,index);
      const saved=context.get(row.session) as {producer_id:string|null;client:string;source_id:string|null;project:string;folder:string};
      const presenceKey=hub.ingest.live.binding(row.device,saved.client,saved.source_id,saved.producer_id,row.origin,saved.project,saved.folder);
      const currentPresence=presence(row.device,saved.client,saved.source_id,saved.producer_id,row.origin,saved.project,saved.folder,now);
      const deviceName=String(device.get(row.device)?.name??''),folder=row.folder??(row.project!==saved.project?saved.project:null);
      reserve(416+2*((row.project?.length??0)+(folder?.length??0)+deviceName.length));
      trace.refs.push({ref:history.ref(board,row.session),source:row.source,clientId:saved.client,device:{id:row.device,name:deviceName},origin:row.origin,project:row.project,folder,startedAt:row.startedAt,...(presenceKey?{presenceKey}:{}),...(currentPresence?{currentPresence}:{})});
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
