import type {HistoryReply} from '../../server/domain/history';
import {PERIOD_BODY_BYTES,PERIOD_SCOPES,type PeriodScope,type HistoryQuery,type PeriodRequest,type PeriodReply} from '../../server/domain/periodRead';
import {executableWorkFilters,jsonBytes} from '../../server/domain/dataFilters';
import {ApiError} from './http';
import {expandPeriod,type PeriodWireReply} from '../../server/domain/periodWire';
import type {HistoryPool,HistoryMember} from './historyPool';

export type PeriodIntent={board:string;generation:number;resourceGeneration?:number;facetGeneration?:number;calendarGeneration?:number;revision:number;proofEpoch?:number;request:PeriodRequest};
export type PeriodReservation=((bytes:number)=>boolean)&{retain?(release:()=>void):void};
export type HistoryReadOwner={finished:Promise<void>;started?():void;role():'visible'|'ahead'|null;cancel():void};
type Demand={scope:PeriodScope;query:HistoryQuery;signal?:AbortSignal;owner?:HistoryReadOwner;activityOnly:boolean;epoch:number;delivered?:boolean;resolve(value:HistoryReply):void;reject(error:unknown):void};
type Flight={role:'visible'|'ahead';admission?:object;intent:PeriodIntent;controller:AbortController;demands:Demand[];extras:boolean;facets:boolean;started?:boolean;preparing?:boolean;releases:Set<()=>void>};
const aborted=()=>new DOMException('Aborted','AbortError');
const roleOf=(demand:Demand)=>demand.signal?.aborted?null:demand.owner?demand.owner.role():'visible';
const cursorKey=(board:string,scope:PeriodScope,query:HistoryQuery)=>JSON.stringify([board,scope,query.meters,query.unit,query.currency,query.sources]);

/** Only fixed summaries carry selected work; native evidence stays shared and immutable. */
function withoutSelectedWork<T>(value:T,charge:(bytes:number)=>void):T{
  if(!value||typeof value!=='object')return value;
  const record=value as Record<string,unknown>;let copy:Record<string,unknown>|undefined;
  for(const key in record){
    if(!Object.hasOwn(record,key))continue;
    const next=key==='selectedWork'?undefined:withoutSelectedWork(record[key],charge);
    if(key!=='selectedWork'&&next===record[key])continue;
    if(!copy){
      let bytes=64;if(Array.isArray(value))bytes+=value.length*8;else for(const field in record)if(Object.hasOwn(record,field))bytes+=32+field.length*2;
      charge(bytes);copy=(Array.isArray(value)?value.slice():{...record}) as Record<string,unknown>;
    }
    if(key==='selectedWork')delete copy[key];else copy[key]=next;
  }
  return (copy??value) as T;
}

/** One event-loop collection combines chart sections with the period's other visible consumers. */
export class PeriodTransport implements HistoryMember {
  metadataToken?: (board:string,scope:PeriodScope)=>string|undefined;
  private queue:Demand[]=[];
  private scheduled=false;
  private resetEpoch=0;
  // Coordinator changes survive an individual reader's cancellation. Delivered
  // readers authorize their baseline only until their own abort or the next reset.
  private requested=false;
  private delivered=0;
  private readonly flights=new Set<Flight>();
  private readonly facetAdmission={};
  private completed='';
  private failed='';
  private baselineKey='';
  private readonly baselineParts=new Set<string>();
  private readonly cursors=new Map<string,string>();
  private readonly metadata=new Map<PeriodScope,{board:string;sources?:string;meters?:string;unit?:string;currency?:string;work?:string;tag:string}>();
  constructor(private readonly pool:HistoryPool,private readonly intent:()=>PeriodIntent|null,private readonly receive:(reply:PeriodReply,intent:PeriodIntent,reserve?:PeriodReservation)=>void|Promise<void>,
    private readonly send:(board:string,body:PeriodRequest,signal:AbortSignal,reserve:(bytes:number)=>boolean)=>Promise<PeriodReply>,private readonly accessLost:()=>void=()=>{}) {}
  get estimatedBytes(){return 0;}
  evictionCandidates(){return [];}
  private key(intent:PeriodIntent){return `${intent.generation}:${intent.revision}`;}
  change(){this.requested=true;this.retire();this.schedule();}
  forgetEvidence(scope?:PeriodScope){if(!scope){this.cursors.clear();this.metadata.clear();}else {for(const key of this.cursors.keys())if(JSON.parse(key)[1]===scope)this.cursors.delete(key);this.metadata.delete(scope);}}
  evidence(){return new Map(this.cursors);}
  restoreEvidence(cursors:ReadonlyMap<string,string>){this.cursors.clear();for(const [key,value] of cursors)this.cursors.set(key,value);}
  reset(){this.resetEpoch++;this.requested=false;this.delivered=0;this.completed=this.failed=this.baselineKey='';this.baselineParts.clear();this.cursors.clear();this.metadata.clear();for(const flight of this.flights)this.abort(flight);for(const demand of this.queue)demand.reject(aborted());this.queue=[];}
  retry(){this.completed=this.failed='';this.change();}
  read(scope:PeriodScope,query:HistoryQuery,signal?:AbortSignal,owner?:HistoryReadOwner,activityOnly=false):Promise<HistoryReply> {
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(aborted());return;}
      const demand:Demand={scope,query,signal,owner,activityOnly,epoch:this.resetEpoch,resolve,reject};this.queue.push(demand);
      signal?.addEventListener('abort',()=>{if(demand.epoch===this.resetEpoch&&demand.delivered){demand.delivered=false;this.delivered--;}reject(aborted());this.queue=this.queue.filter(d=>d!==demand);for(const flight of this.flights)if(flight.demands.includes(demand)&&flight.demands.every(d=>d.signal?.aborted)&&!flight.extras)this.abort(flight);this.schedule();},{once:true});
      this.schedule();
    });
  }
  private schedule(){if(this.scheduled)return;this.scheduled=true;queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(()=>{this.scheduled=false;this.flush();})));}
  // An answer keeps its bytes and slot until all reader preparations settle,
  // including the cancellation of a speculative answer.
  private abort(flight:Flight){
    if(!flight.controller.signal.aborted){flight.controller.abort();for(const demand of flight.demands)if(roleOf(demand)!==null)demand.owner?.cancel();}
    for(const demand of flight.demands)demand.reject(aborted());
    if(flight.started)return;
    this.pool.release(flight);this.flights.delete(flight);
  }
  private current(intent:PeriodIntent){const current=this.intent();return current?.board===intent.board&&this.key(current)===this.key(intent);}
  private resourcesCurrent(intent:PeriodIntent){const current=this.intent();return current?.board===intent.board&&(intent.resourceGeneration===undefined?this.current(intent):current.resourceGeneration===intent.resourceGeneration);}
  private retire(){for(const flight of this.flights)if(flight.extras&&!this.current(flight.intent)&&!this.resourcesCurrent(flight.intent))this.abort(flight);}
  private async adopt(reply:PeriodReply,intent:PeriodIntent,flight:Flight,heldBytes=0){
    flight.preparing=true;
    const reservation:PeriodReservation=bytes=>this.pool.reserve(flight,heldBytes+bytes);
    // Adopted numerical roots can outlive their current view while the decoded
    // reply still belongs to this flight and its chart recipients.
    reservation.retain=release=>{flight.releases.add(release);};
    await this.receive(reply,intent,reservation);
    if(flight.controller.signal.aborted||!this.current(intent))return false;
    // Preparation can reject individual sections. Only adopted evidence can name a later delta.
    for(const scope of PERIOD_SCOPES){const part=reply[scope],query=intent.request[scope];if(query&&part?.state==='complete'){
      if(part.value.tape)this.cursors.set(cursorKey(intent.board,scope,query),part.value.tape.cursor);
      if(part.value.meta)this.metadata.set(scope,{board:intent.board,meters:query.meters,unit:query.unit,currency:query.currency,sources:query.sources,work:query.work,tag:part.value.meta});
    }}
    return true;
  }
  private flush() {
    this.retire();
    this.queue=this.queue.filter(demand=>{if(roleOf(demand)!==null)return true;demand.reject(aborted());return false;});
    const intent=this.intent();if(!intent)return;
    const key=this.key(intent);
    if(this.baselineKey!==key){this.baselineKey=key;this.baselineParts.clear();}
    const baseline=PERIOD_SCOPES.some(scope=>intent.request[scope]&&!this.cursors.has(cursorKey(intent.board,scope,intent.request[scope]!)));
    // First retain the bounded drawing cells, then its exact evidence. Their full
    // decoded bodies must not coexist while either is still waiting for preparation.
    // An open filter needs choices even while the same cohort's work reply waits.
    // A covering facet body or a different cohort still owns the ordinary barrier.
    const missingFacets=!!intent.request.facets;
    const facetBypass=missingFacets&&[...this.flights].some(f=>f.extras&&this.resourcesCurrent(f.intent)&&f.intent.generation===intent.generation&&!f.facets&&this.key(f.intent)!==key);
    const extras=(this.requested||this.delivered>0||this.queue.length>0)&&(!baseline||!this.queue.length&&!this.flights.size)&&(!!intent.request.values||!!intent.request.sessions||!!intent.request.facets||!!intent.request.sourceWork||!!intent.request.calendar||!!intent.request.quota||!!intent.request.budget||!!intent.request.funds)&&key!==this.completed&&key!==this.failed&&![...this.flights].some(f=>f.extras&&(this.key(f.intent)===key||this.resourcesCurrent(f.intent)&&(!missingFacets||f.facets||f.intent.generation!==intent.generation)));
    if(!this.queue.length&&!extras)return;
    const demands:Demand[]=[];
    const foreground=this.queue.some(demand=>roleOf(demand)==='visible');
    if(foreground)for(const scope of PERIOD_SCOPES){const index=this.queue.findIndex(d=>d.scope===scope&&roleOf(d)==='visible');if(index!==-1)demands.push(this.queue.splice(index,1)[0]);}
    else {const index=this.queue.findIndex(d=>roleOf(d)==='ahead');if(index!==-1)demands.push(this.queue.splice(index,1)[0]);}
    if(!demands.length&&!extras)return;
    const flight:Flight={get role(){return extras||demands.some(d=>roleOf(d)==='visible')?'visible':'ahead';},intent,controller:new AbortController(),demands,extras,facets:false,releases:new Set()};
    this.flights.add(flight);
    const exactQueries:Partial<Record<PeriodScope,HistoryQuery>>={};
    if(extras)for(const scope of PERIOD_SCOPES){const query=intent.request[scope];if(query)exactQueries[scope]={...query,evidence:query.evidence??this.cursors.get(cursorKey(intent.board,scope,query))};}
    // Standalone ledgers need no cells. Borrow only the drawing's captured token.
    if(extras&&!demands.length)for(const scope of PERIOD_SCOPES){
      const query=exactQueries[scope],meta=query?.cells==='skip'&&query.meta===undefined?this.metadataToken?.(intent.board,scope):undefined;
      if(query&&meta!==undefined)query.meta=meta;
    }
    const body:PeriodRequest={...intent.request,...(!extras?{values:undefined,sessions:undefined,facets:undefined,sourceWork:undefined,calendar:undefined,quota:undefined,budget:undefined,funds:undefined}:exactQueries),...Object.fromEntries(demands.map(d=>[d.scope,d.activityOnly&&d.scope==='quota'&&!intent.request.quota
      ?{cell:d.query.cell,from:d.query.from,to:d.query.to,sources:'[]',evidence:'skip',meta:''}
      :{...d.query}]))};
    const pendingBaseline=(['quota','funds','budget'] as const).filter(scope=>body[scope]&&!this.baselineParts.has(scope));
    const splitBaseline=baseline&&extras&&intent.request.selection.mode==='live';
    const deferredBaseline=splitBaseline&&pendingBaseline.length>1;
    if(splitBaseline){
      // Live ledgers remain independent by family. Compact fixed summaries and
      // changed measurements share one body and its bounded reservation.
      for(const scope of PERIOD_SCOPES)if(scope!==pendingBaseline[0])delete body[scope];
      for(const part of ['values','sessions','facets','calendar'] as const)if(this.baselineParts.has(part))delete body[part];
    }
    for(const scope of PERIOD_SCOPES){const original=body[scope];if(!original)continue;const query=body[scope]={...original};
      query.evidence??=!extras?'skip':this.cursors.get(cursorKey(intent.board,scope,query));
      // Drawing readers own their captured basis. Only our evidence-only sections borrow our token.
      if(extras&&!demands.some(demand=>demand.scope===scope)){
        const prior=this.metadata.get(scope);
        query.meta??=prior&&prior.board===intent.board&&prior.meters===query.meters&&prior.unit===query.unit&&prior.currency===query.currency&&prior.sources===query.sources&&prior.work===query.work?prior.tag:'';
      }
    }
    if(body.sourceWork&&!body.quota&&body.budget?.work!=='1')delete body.sourceWork;
    if(!body.quota&&!body.sessions&&!body.facets&&!body.calendar&&body.budget?.work!=='1')delete body.workFilter;
    flight.facets=!!body.facets;
    if(extras&&facetBypass&&flight.facets)flight.admission=this.facetAdmission;
    const resetEpoch=this.resetEpoch;
    const start=()=>{
      if(flight.controller.signal.aborted)return;
      if(extras&&!this.current(intent)&&!this.resourcesCurrent(intent)){this.abort(flight);this.schedule();return;}
      // A queued body keeps only readers that still own their captured demand.
      for(let index=demands.length-1;index>=0;index--)if(roleOf(demands[index])===null){
        const [demand]=demands.splice(index,1);demand.reject(aborted());
        const query=exactQueries[demand.scope];
        if(query&&body[demand.scope])body[demand.scope]={...query};
        else delete body[demand.scope];
      }
      if(!demands.length&&!extras){this.abort(flight);this.schedule();return;}
      for(const demand of demands)demand.owner?.started?.();
      const activityOnly=demands.some(d=>d.activityOnly&&d.scope==='quota')&&!intent.request.quota;
      // Empty-source activity has its own metadata. It cannot confirm a native baseline.
      const appliedIntent={...intent,request:activityOnly?{...body,quota:undefined}:body};
      flight.started=true;
      let decodedBytes=0;
      const response=jsonBytes(body)>PERIOD_BODY_BYTES||body.workFilter&&(body.quota||body.sessions||body.facets||body.calendar||body.budget?.work==='1')&&!executableWorkFilters(body.workFilter)?Promise.reject(new ApiError(413,'history_limit')):this.send(intent.board,body,flight.controller.signal,bytes=>{if(!this.pool.reserve(flight,bytes))return false;decodedBytes=bytes;return true;});
      response.then(async reply=>{
        if(flight.controller.signal.aborted)return;
        // A→B→A is three generations. Equal target text does not revive the first response.
        const current=this.intent();
        const evidenceReply=activityOnly?{...reply,quota:undefined}:reply;
        if(current?.generation===intent.generation&&current.revision===intent.revision) {
          const adopted=await this.adopt(evidenceReply,appliedIntent,flight);
          if(flight.controller.signal.aborted)return;
          if(adopted&&extras){if(!deferredBaseline)this.completed=key;if(baseline)for(const part of [...PERIOD_SCOPES,'values','sessions','facets','sourceWork','calendar'] as const)if(appliedIntent.request[part])this.baselineParts.add(part);}
        }
        else if(this.resourcesCurrent(intent)){
          const current=this.intent()!;
          // A work-filter edit does not revoke source-wide evidence already in flight.
          // Fixed summaries carry selected direct fields, which await their new cohort.
          let copiedBytes=0;
          const charge=(bytes:number)=>{copiedBytes+=bytes;if(!this.pool.reserve(flight,decodedBytes+copiedBytes))throw new ApiError(413,'history_limit');};
          charge(512);
          const resources={...evidenceReply,sessions:undefined,facets:undefined,calendar:undefined};
          for(const scope of PERIOD_SCOPES){const part=resources[scope];if(part?.state==='complete'){
            charge(512);
            const tape=part.value.tape,fixed=withoutSelectedWork(tape?.fixed,charge);
            resources[scope]={...part,value:{...part.value,chunks:[],...(tape?{tape:{...tape,...(fixed?{fixed}:{})}}:{})}};
          }}
          // The captured chart still needs the original body until adoption finishes.
          await this.adopt(resources,{...current,request:{...appliedIntent.request,sessions:undefined,facets:undefined,calendar:undefined}},flight,decodedBytes+copiedBytes);
          if(flight.controller.signal.aborted)return;
        }
        for(const demand of demands) {
          const part=activityOnly&&demand.scope!=='quota'?evidenceReply[demand.scope]:reply[demand.scope];
          if(part?.state==='complete'){if(demand.epoch===this.resetEpoch&&!demand.delivered&&roleOf(demand)!==null){demand.delivered=true;this.delivered++;}const {tape:_tape,...value}=part.value;demand.resolve(value);}
          else demand.reject(new ApiError(part?.state==='error'&&part.error==='history_limit'?413:400,part?.state==='error'?part.error:'history_failed'));
        }
      }).catch(error=>{
        if(flight.controller.signal.aborted)return;
        // An archived display currency can disappear before its replacement event
        // arrives. Its missing history target does not revoke access to the board.
        if(error instanceof ApiError&&[401,403,404].includes(error.status)&&!(error.status===404&&error.code==='currency_not_found')&&this.current(intent))this.accessLost();
        if(extras){if(!deferredBaseline)this.failed=key;if(baseline&&this.baselineKey===key)for(const part of [...PERIOD_SCOPES,'values','sessions','facets','sourceWork','calendar'] as const)if(appliedIntent.request[part])this.baselineParts.add(part);}
        for(const demand of demands)demand.reject(error);
        if(extras){const current=this.intent();if(current?.generation===intent.generation&&current.revision===intent.revision){const section={state:'error' as const,error:error instanceof ApiError&&error.code==='history_limit'?'history_limit' as const:'unavailable' as const};this.receive({basis:{run:'',revision:'',evaluatedAt:intent.request.evaluatedAt,evidenceCut:0,range:{from:0,to:0}},...Object.fromEntries(PERIOD_SCOPES.filter(scope=>appliedIntent.request[scope]).map(scope=>[scope,section])),...(body.values?{values:section}:{}),...(body.sessions?{sessions:section}:{}),...(body.facets?{facets:section}:{}),...(body.sourceWork?{sourceWork:section}:{}),...(body.calendar?{calendar:section}:{})},appliedIntent);}}
      })
        .finally(async()=>{try{if(flight.controller.signal.aborted)for(const demand of demands)demand.reject(aborted());if(demands.some(demand=>demand.owner))await Promise.allSettled(demands.map(demand=>demand.owner?.finished));}finally{
          for(const release of flight.releases)release();flight.releases.clear();this.pool.release(flight);this.flights.delete(flight);
          // Only demand admitted after the latest reset can wake its new baseline.
          // A different target captured before reset grants no continuing interest.
          if(resetEpoch===this.resetEpoch||this.requested||this.delivered>0||this.queue.some(demand=>roleOf(demand)!==null))this.schedule();
        }});
    };
    this.pool.request(this,flight,start,()=>this.abort(flight));
    if(this.queue.length)this.schedule();
  }
}

/** Charge transport staging before decoding; all consumers use the same retained budget. */
export async function fetchPeriod(board:string,body:PeriodRequest,signal:AbortSignal,reserve:(bytes:number)=>boolean):Promise<PeriodReply> {
  const response=await fetch(`/api/boards/${encodeURIComponent(board)}/period`,{method:'POST',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(12_000)])});
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
    return expandPeriod(parsed as PeriodWireReply,extra=>{
      const next=expanded+extra;
      if(!reserve(bytes*3+next))throw new ApiError(413,'history_limit');
      expanded=next;
    },extra=>{
      const next=expanded-extra;
      // A refused shrink retains the previous reservation and its conservative charge.
      if(reserve(bytes*3+next))expanded=next;
    });
  }finally{reader.releaseLock();}
}
