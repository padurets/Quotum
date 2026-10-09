import type {Hub} from './api.js';
import type {HistoryTiles} from './history.js';
import type {Shown, WorkRead} from './store/store.js';
import type {Stretch} from './domain/work.js';
import type {PeriodRange} from './domain/period.js';
import {packWork,type WorkTrace} from './domain/periodWork.js';

/** A composite read extracts work once for charts and the temporal index. */
export function sharedWork(hub:Hub,shown:Shown,range:PeriodRange|null,reserve:(bytes:number)=>void,release:(bytes:number)=>void):WorkRead {
  let kept: {from:number;to:number;rows:Stretch[]}|null=null;
  let bytes=0;
  const known=Math.max(hub.store.agentWorkSince(),hub.store.historyStart(Date.now()));
  const holders=new Map([...shown].map(([source,scope])=>[source,new Map(scope.holders.map(h=>[h.user,Math.max(h.from,scope.since,known)]))]));
  return (from,to)=>{
    if(!kept||from<kept.from||to>kept.to) {
      const start=Math.min(from,range?.from??from,kept?.from??from),end=Math.max(to,range?.to??to,kept?.to??to);
      // Consumers finish their projection before the next read. Release the old
      // extraction before replacing it; an absent session request adds no range.
      kept=null;release(bytes);bytes=0;
      const rows:Stretch[]=[];
      try {if(shown.size)for(const s of hub.store.agentWork(start,end,[...shown.keys()],size=>{reserve(size);bytes+=size;})) {
        const cutoff=holders.get(s.source)?.get(s.user);
        if(cutoff===undefined||s.to<=cutoff)continue;
        rows.push(s.from<cutoff?{...s,from:cutoff}:s);
      }}catch(error){release(bytes);bytes=0;throw error;}
      kept={from:start,to:end,rows};
    }
    return kept.rows.flatMap(s=>s.to>from&&s.from<to?[s.from>=from&&s.to<=to?s:{...s,from:Math.max(from,s.from),to:Math.min(to,s.to)}]:[]);
  };
}

export function periodWork(hub:Hub,history:HistoryTiles,board:string,shown:Shown,range:PeriodRange,work:WorkRead,now:number,reserve:(bytes:number)=>void):WorkTrace {
  const known=hub.store.historyKnown(shown),anchor=range.from;
  const trace:WorkTrace={anchor,cut:range.to,knownFrom:Math.max(known.work,hub.store.historyStart(now)),refs:[],spans:[]};
  const indices=new Map<number,number>();
  const device=hub.store.db.prepare('SELECT COALESCE(label,name) AS name FROM devices WHERE id=?');
  const context=hub.store.db.prepare('SELECT producer_id,project,folder FROM agent_sessions WHERE id=?');
  for(const row of work(range.from,range.to)) {
    let index=indices.get(row.session);
    if(index===undefined) {
      index=trace.refs.length;indices.set(row.session,index);
      const saved=context.get(row.session) as {producer_id:string|null;project:string;folder:string};
      const currentPresence=hub.ingest.live.presence(row.device,row.source,saved.producer_id,row.origin,saved.project,saved.folder,now);
      const deviceName=String(device.get(row.device)?.name??''),folder=row.folder??(row.project!==saved.project?saved.project:null);
      reserve(384+2*((row.project?.length??0)+(folder?.length??0)+deviceName.length));
      trace.refs.push({ref:history.ref(board,row.session),source:row.source,device:{id:row.device,name:deviceName},origin:row.origin,project:row.project,folder,startedAt:row.startedAt,...(currentPresence?{currentPresence}:{})});
    }
    const start=row.from-anchor,end=row.to-anchor,last=trace.spans.at(-1);
    if(last&&last[0]===index&&last[2]>=start)last[2]=Math.max(last[2],end);
    else {reserve(48);trace.spans.push([index,start,end]);}
  }
  if(trace.spans.length<128)return trace;
  const packed=packWork(trace);reserve(packed.packed!.blocks.length*16+packed.packed!.patterns.reduce((n,p)=>n+p.length*16,0));return packed;
}
