import {quotaSteps,capSteps,type UsageWork,type UsageStep,type QuotaAnchor,type UsageSample} from './domain/usageWork.js';
import {edge,type SourceState} from './domain/quota.js';
import type {Store} from './store/store.js';
import {quotaMeter,providerOf} from './domain/providers.js';

const DAY=86_400_000;
/** Source evidence is shared; holder identities and configured scopes stay private. */
export class UsageWithoutWork {
  private cache=new Map<string,{key:string;value:UsageWork[];changesAt:number|null}>();
  constructor(private readonly store:Store) {}
  of(source:string,state:SourceState,now:number):{value:UsageWork[];changesAt:number|null} {
    if(!state.windows.length&&!state.meters?.some(m=>quotaMeter(providerOf(state.provider),m.id)))return {value:[],changesAt:null};
    const {db}=this.store;
    const topology=db.prepare("SELECT h.user_id,h.since,coalesce(v.version,0) AS version,coalesce(l.version,0) AS links,coalesce((SELECT value FROM meta WHERE key='workEvidence:'||h.user_id),'0') AS evidence FROM holders h LEFT JOIN owner_coverage_versions v ON v.user_id=h.user_id LEFT JOIN link_versions l ON l.user_id=h.user_id WHERE h.source_id=? ORDER BY h.user_id").all(source);
    const key=JSON.stringify([state.successAt,state.resources?.windows,state.quota,state.windows,state.meters?.filter(m=>m.kind==='cap'),topology,this.store.coverage.revision(),this.store.workRevision()]);
    const cached=this.cache.get(source);
    if(cached?.key===key&&(cached.changesAt===null||now<cached.changesAt))return cached;
    const from=now-DAY,steps:UsageStep[]=[];
    const rows=db.prepare('SELECT window_id,at,used,reset_at,stale_after_ms FROM samples WHERE source_id=? AND at>=? AND at<=? ORDER BY window_id,at').all(source,from-30*60_000,now) as {window_id:string;at:number;used:number;reset_at:number|null;stale_after_ms:number}[];
    const barriers=(db.prepare("SELECT at FROM events WHERE source_id=? AND kind='quota_unavailable' AND at>? AND at<=? ORDER BY at").all(source,from-30*60_000,now) as {at:number}[]).map(b=>b.at);
    const groups=new Map<string,UsageSample[]>();
    for(const r of rows){const list=groups.get(r.window_id)??[];list.push({at:r.at,used:r.used,resetAt:r.reset_at,staleAfterMs:r.stale_after_ms});groups.set(r.window_id,list);}
    for(const [id,samples] of groups){
      let next=0;
      const bounded=samples.map(s=>{while(next<barriers.length&&barriers[next]<=s.at)next++;return next<barriers.length?{...s,validUntil:barriers[next]}:s;});
      const current=state.windows.find(w=>w.id===id);
      if(current)steps.push(...quotaSteps(id,bounded).filter(s=>s.to>=from&&s.resetAt!==null&&current.resetAt!==null&&current.resetAt>=s.resetAt-60_000&&current.resetAt-s.resetAt<=Math.max(60_000,(state.successAt??s.to)-s.to+60_000)&&current.used>=samples.find(a=>a.at===s.to)!.used-0.05&&!bounded.some((b,i)=>i>0&&b.at>s.to&&['reset','correction'].includes(edge(bounded[i-1],b).reason))));
    }
    const anchors=db.prepare('SELECT window_id,payload FROM quota_anchors WHERE source_id=? AND at>=? AND at<=? ORDER BY window_id,at').all(source,from-30*60_000,now) as {window_id:string;payload:string}[];
    const caps=new Map<string,QuotaAnchor[]>();for(const row of anchors){const list=caps.get(row.window_id)??[];list.push(JSON.parse(row.payload));caps.set(row.window_id,list);}
    for(const [id,readings] of caps){const current=state.meters?.find(m=>m.id===id);if(!current||current.resetAt!==readings.at(-1)?.resetAt||state.quota?.generation!==readings.at(-1)?.generation)continue;steps.push(...capSteps(id,readings,this.store.meters.spans(source,id,Math.min(from,readings[0].at),now)).filter(s=>s.to>=from));}
    // Newer ordinary work does not erase a historical finding. Reattribution does.
    const alive=steps.filter(s=>s.to<=now&&Math.min(s.to+DAY,s.resetAt!==null?s.resetAt:Infinity)>now);
    const holdings=new Map(topology.map(h=>[String(h.user_id),Number(h.since)]));
    const start=alive.length?Math.min(...alive.map(s=>s.from)):now,end=alive.length?Math.max(...alive.map(s=>s.to)):now;
    const work=alive.length?this.store.agentWork(start,end,[source]).flatMap(w=>w.to<=holdings.get(w.user)!?[]:[{...w,from:Math.max(w.from,holdings.get(w.user)!)}]):[];
    const full=alive.length?this.store.coverage.reader(source,start,end):()=>false;
    const latest=new Map<string,UsageWork>();
    for(const step of alive){if(work.some(w=>w.from<step.to&&w.to>step.from))continue;latest.set(step.windowId,{windowId:step.windowId,from:step.from,to:step.to,growth:step.growth,quality:full(step.from,step.to)?'confirmed':'partial',expiresAt:Math.min(step.to+DAY,step.resetAt??Infinity)});}
    const value=[...latest.values()],changesAt=value.length?Math.min(...value.map(v=>v.expiresAt)):null;
    const result={key,value,changesAt};this.cache.set(source,result);return result;
  }
}
