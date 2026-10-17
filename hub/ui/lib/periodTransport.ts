import type {HistoryBasis,HistoryReply} from '../../server/domain/history';
import type {HistoryBases} from '../../server/domain/periodSourceWire';
import {PERIOD_SCOPES,type PeriodScope,type HistoryQuery,type PeriodRequest,type PeriodReply} from '../../server/domain/periodRead';
import {ApiError} from './http';
import {expandPeriod,type PeriodWireReply} from '../../server/domain/periodWire';
import type {HistoryPool,HistoryMember} from './historyPool';

export type PeriodIntent={board:string;generation:number;revision:number;proofEpoch?:number;request:PeriodRequest};
export type HistoryReadOwner={finished:Promise<void>;started?():void;role():'visible'|'ahead'|null;cancel():void};
type Demand={scope:PeriodScope;query:HistoryQuery;signal?:AbortSignal;owner?:HistoryReadOwner;basis?:HistoryBasis;resolve(value:HistoryReply):void;reject(error:unknown):void};
type Flight={role:'visible'|'ahead';intent:PeriodIntent;controller:AbortController;demands:Demand[];extras:boolean;preparing?:boolean};
const aborted=()=>new DOMException('Aborted','AbortError');
const roleOf=(demand:Demand)=>demand.signal?.aborted?null:demand.owner?demand.owner.role():'visible';

/** One event-loop collection combines chart sections with the period's other visible consumers. */
export class PeriodTransport implements HistoryMember {
  metadataToken?: (board:string,scope:PeriodScope)=>string|undefined;
  private queue:Demand[]=[];
  private scheduled=false;
  private resetEpoch=0;
  private readonly flights=new Set<Flight>();
  private completed='';
  private failed='';
  private baselineKey='';
  private readonly baselineParts=new Set<string>();
  private readonly cursors=new Map<string,string>();
  private readonly metadata=new Map<PeriodScope,{board:string;meters?:string;unit?:string;currency?:string;work?:string;tag:string}>();
  constructor(private readonly pool:HistoryPool,private readonly intent:()=>PeriodIntent|null,private readonly receive:(reply:PeriodReply,intent:PeriodIntent,reserve?:(bytes:number)=>boolean)=>void|Promise<void>,
    private readonly send:(board:string,body:PeriodRequest,signal:AbortSignal,reserve:(bytes:number)=>boolean,bases?:HistoryBases)=>Promise<PeriodReply>,private readonly accessLost:()=>void=()=>{}) {}
  get estimatedBytes(){return 0;}
  evictionCandidates(){return [];}
  private key(intent:PeriodIntent){return `${intent.generation}:${intent.revision}`;}
  change(){this.retire();this.schedule();}
  forgetEvidence(scope?:PeriodScope){if(!scope){this.cursors.clear();this.metadata.clear();}else {for(const key of this.cursors.keys())if(JSON.parse(key)[1]===scope)this.cursors.delete(key);this.metadata.delete(scope);}}
  evidence(){return new Map(this.cursors);}
  restoreEvidence(cursors:ReadonlyMap<string,string>){this.cursors.clear();for(const [key,value] of cursors)this.cursors.set(key,value);}
  reset(){this.resetEpoch++;this.completed=this.failed=this.baselineKey='';this.baselineParts.clear();this.cursors.clear();this.metadata.clear();for(const flight of this.flights)this.abort(flight);for(const demand of this.queue)demand.reject(aborted());this.queue=[];}
  retry(){this.failed='';this.change();}
  read(scope:PeriodScope,query:HistoryQuery,signal?:AbortSignal,owner?:HistoryReadOwner,basis?:HistoryBasis):Promise<HistoryReply> {
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(aborted());return;}
      const demand={scope,query,signal,owner,basis,resolve,reject};this.queue.push(demand);
      signal?.addEventListener('abort',()=>{reject(aborted());this.queue=this.queue.filter(d=>d!==demand);for(const flight of this.flights)if(flight.demands.includes(demand)&&flight.demands.every(d=>d.signal?.aborted)&&!flight.extras)this.abort(flight);this.schedule();},{once:true});
      this.schedule();
    });
  }
  private schedule(){if(this.scheduled)return;this.scheduled=true;queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(()=>{this.scheduled=false;this.flush();})));}
  // An answer keeps its bytes and slot until all reader preparations settle,
  // including the cancellation of a speculative answer.
  private abort(flight:Flight){if(!flight.controller.signal.aborted){flight.controller.abort();for(const demand of flight.demands)if(roleOf(demand)!==null)demand.owner?.cancel();}if(flight.preparing)return;for(const demand of flight.demands)demand.reject(aborted());this.pool.release(flight);this.flights.delete(flight);}
  private current(intent:PeriodIntent){const current=this.intent();return current?.board===intent.board&&this.key(current)===this.key(intent);}
  private retire(){for(const flight of this.flights)if(flight.extras&&!this.current(flight.intent))this.abort(flight);}
  private flush() {
    this.retire();
    this.queue=this.queue.filter(demand=>{if(roleOf(demand)!==null)return true;demand.reject(aborted());return false;});
    const intent=this.intent();if(!intent)return;
    const key=this.key(intent);
    if(this.baselineKey!==key){this.baselineKey=key;this.baselineParts.clear();}
    const cursorKey=(scope:PeriodScope,query:HistoryQuery)=>JSON.stringify([intent.board,scope,query.meters,query.unit,query.currency]);
    const baseline=PERIOD_SCOPES.some(scope=>intent.request[scope]&&!this.cursors.has(cursorKey(scope,intent.request[scope]!)));
    // First retain the bounded drawing cells, then its exact evidence. Their full
    // decoded bodies must not coexist while either is still waiting for preparation.
    const extras=(!baseline||!this.queue.length&&!this.flights.size)&&(!!intent.request.values||!!intent.request.sessions||!!intent.request.quota||!!intent.request.budget||!!intent.request.funds)&&key!==this.completed&&key!==this.failed&&![...this.flights].some(f=>f.extras&&this.key(f.intent)===key);
    if(!this.queue.length&&!extras)return;
    const demands:Demand[]=[];
    const foreground=this.queue.some(demand=>roleOf(demand)==='visible');
    if(foreground)for(const scope of PERIOD_SCOPES){const index=this.queue.findIndex(d=>d.scope===scope&&roleOf(d)==='visible');if(index!==-1)demands.push(this.queue.splice(index,1)[0]);}
    else {const index=this.queue.findIndex(d=>roleOf(d)==='ahead');if(index!==-1)demands.push(this.queue.splice(index,1)[0]);}
    if(!demands.length&&!extras)return;
    const flight:Flight={get role(){return extras||demands.some(d=>roleOf(d)==='visible')?'visible':'ahead';},intent,controller:new AbortController(),demands,extras};
    this.flights.add(flight);
    const exactQueries:Partial<Record<PeriodScope,HistoryQuery>>={};
    if(extras)for(const scope of PERIOD_SCOPES){const query=intent.request[scope];if(query)exactQueries[scope]={...query,evidence:query.evidence??this.cursors.get(cursorKey(scope,query))};}
    // Standalone ledgers need no cells or source decoding. Borrow only the
    // drawing's captured token; a mixed body keeps its own demand bases.
    if(extras&&!demands.length)for(const scope of PERIOD_SCOPES){
      const query=exactQueries[scope],meta=query?.cells==='skip'&&query.meta===undefined?this.metadataToken?.(intent.board,scope):undefined;
      if(query&&meta!==undefined)query.meta=meta;
    }
    const body:PeriodRequest={...intent.request,...(!extras?{values:undefined,sessions:undefined,quota:undefined,budget:undefined,funds:undefined}:exactQueries),...Object.fromEntries(demands.map(d=>[d.scope,{...d.query}]))};
    const pendingBaseline=(['quota','funds','budget'] as const).filter(scope=>body[scope]&&!this.baselineParts.has(scope));
    const splitBaseline=baseline&&extras&&intent.request.selection.mode==='live';
    const deferredBaseline=splitBaseline&&pendingBaseline.length>1;
    if(splitBaseline){
      // Live ledgers remain independent by family. Compact fixed summaries and
      // changed measurements share one body and its bounded reservation.
      for(const scope of PERIOD_SCOPES)if(scope!==pendingBaseline[0])delete body[scope];
      for(const part of ['values','sessions'] as const)if(this.baselineParts.has(part))delete body[part];
    }
    const drawingSources=demands.some(demand=>!!demand.basis?.meta&&demand.query.meta===demand.basis.meta);
    for(const scope of PERIOD_SCOPES){const original=body[scope];if(!original)continue;const query=body[scope]={...original};
      query.evidence??=!extras?'skip':this.cursors.get(cursorKey(scope,query));
      // A sibling token has no captured source dictionary. Standalone ledgers can
      // reuse it without disabling a drawing reader's source encoding.
      if(extras&&!demands.some(demand=>demand.scope===scope)){
        const prior=this.metadata.get(scope);
        query.meta??=!drawingSources&&prior&&prior.board===intent.board&&prior.meters===query.meters&&prior.unit===query.unit&&prior.currency===query.currency&&prior.work===query.work?prior.tag:'';
      }
    }
    const appliedIntent={...intent,request:body};
    const resetEpoch=this.resetEpoch;
    const start=()=>{
      if(flight.controller.signal.aborted)return;
      if(extras&&!this.current(intent)){this.abort(flight);this.schedule();return;}
      // A queued body keeps only readers that still own their captured demand.
      for(let index=demands.length-1;index>=0;index--)if(roleOf(demands[index])===null){
        const [demand]=demands.splice(index,1);demand.reject(aborted());
        const query=exactQueries[demand.scope];
        if(query&&body[demand.scope])body[demand.scope]={...query};
        else delete body[demand.scope];
      }
      if(!demands.length&&!extras){this.abort(flight);this.schedule();return;}
      for(const demand of demands)demand.owner?.started?.();
      const bases:HistoryBases={};for(const demand of demands)if(demand.basis&&body[demand.scope]?.meta===demand.basis.meta)bases[demand.scope]=demand.basis;
      this.send(intent.board,body,flight.controller.signal,bytes=>this.pool.reserve(flight,bytes),bases).then(async reply=>{
        if(flight.controller.signal.aborted)return;
        // A→B→A is three generations. Equal target text does not revive the first response.
        const current=this.intent();
        if(current?.generation===intent.generation&&current.revision===intent.revision) {
          flight.preparing=true;
          await this.receive(reply,appliedIntent,bytes=>this.pool.reserve(flight,bytes));
          if(flight.controller.signal.aborted)return;
          const latest=this.intent();
          if(latest?.generation===intent.generation&&latest.revision===intent.revision){if(extras){if(!deferredBaseline)this.completed=key;if(baseline)for(const part of [...PERIOD_SCOPES,'values','sessions'] as const)if(body[part])this.baselineParts.add(part);}
          for(const scope of PERIOD_SCOPES){const part=reply[scope],query=body[scope];if(query&&part?.state==='complete'){
            if(part.value.tape)this.cursors.set(cursorKey(scope,query),part.value.tape.cursor);
            if(part.value.meta)this.metadata.set(scope,{board:intent.board,meters:query.meters,unit:query.unit,currency:query.currency,work:query.work,tag:part.value.meta});
          }}}
        }
        for(const demand of demands) {
          const part=reply[demand.scope];
          if(part?.state==='complete'){const {tape:_tape,...value}=part.value;demand.resolve(value);}
          else demand.reject(new ApiError(part?.state==='error'&&part.error==='history_limit'?413:400,part?.state==='error'?part.error:'history_failed'));
        }
      }).catch(error=>{
        if(flight.controller.signal.aborted)return;
        if(error instanceof ApiError&&[401,403,404].includes(error.status))this.accessLost();
        if(extras){if(!deferredBaseline)this.failed=key;if(baseline&&this.baselineKey===key)for(const part of [...PERIOD_SCOPES,'values','sessions'] as const)if(body[part])this.baselineParts.add(part);}
        for(const demand of demands)demand.reject(error);
        if(extras){const current=this.intent();if(current?.generation===intent.generation&&current.revision===intent.revision){const section={state:'error' as const,error:error instanceof ApiError&&error.code==='history_limit'?'history_limit' as const:'unavailable' as const};this.receive({basis:{run:'',revision:'',evaluatedAt:intent.request.evaluatedAt,evidenceCut:0,range:{from:0,to:0}},...Object.fromEntries(PERIOD_SCOPES.filter(scope=>body[scope]).map(scope=>[scope,section])),...(body.values?{values:section}:{}),...(body.sessions?{sessions:section}:{})},appliedIntent);}}
      })
        .finally(async()=>{if(flight.controller.signal.aborted)for(const demand of demands)demand.reject(aborted());if(demands.some(demand=>demand.owner))await Promise.allSettled(demands.map(demand=>demand.owner?.finished));this.pool.release(flight);this.flights.delete(flight);if(resetEpoch===this.resetEpoch)this.schedule();});
    };
    this.pool.request(this,flight,start,()=>this.abort(flight));
    if(this.queue.length)this.schedule();
  }
}

/** Charge transport staging before decoding; all consumers use the same retained budget. */
export async function fetchPeriod(board:string,body:PeriodRequest,signal:AbortSignal,reserve:(bytes:number)=>boolean,bases:HistoryBases={}):Promise<PeriodReply> {
  const sources=PERIOD_SCOPES.some(scope=>!!bases[scope]?.meta)&&PERIOD_SCOPES.every(scope=>!body[scope]?.meta||body[scope]!.meta===bases[scope]?.meta);
  const response=await fetch(`/api/boards/${encodeURIComponent(board)}/period`,{method:'POST',cache:'no-store',headers:{'content-type':'application/json',...(sources?{'x-quotum-history-sources':'basis'}:{})},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(12_000)])});
  if(!response.body)throw new Error('empty_period_reply');
  // The native response consumer finishes Chromium's network record. A bounded
  // clone drains first, while the original branch retains the bytes for parsing.
  const reader=response.clone().body!.getReader();let bytes=0;
  try {
    for(;;){
      const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;
      if(bytes>7*1024*1024||!reserve(bytes*3)){
        await Promise.all([reader.cancel(),response.body.cancel()]);throw new ApiError(413,'history_limit');
      }
    }
    const parsed=await response.json();
    if(!response.ok)throw new ApiError(response.status,parsed.error??'history_failed');
    if(signal.aborted)throw aborted();
    let expanded=0;
    return expandPeriod(parsed as PeriodWireReply,extra=>{expanded+=extra;if(!reserve(bytes*3+expanded))throw new ApiError(413,'history_limit');},sources?bases:{});
  }finally{reader.releaseLock();}
}
