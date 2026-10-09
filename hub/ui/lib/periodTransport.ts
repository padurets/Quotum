import type {HistoryReply} from '../../server/domain/history';
import {PERIOD_SCOPES,type PeriodScope,type HistoryQuery,type PeriodRequest,type PeriodReply} from '../../server/domain/periodRead';
import {ApiError} from './http';
import type {HistoryPool,HistoryMember} from './historyPool';

export type PeriodIntent={board:string;generation:number;revision:number;request:PeriodRequest};
type Demand={scope:PeriodScope;query:HistoryQuery;signal?:AbortSignal;resolve(value:HistoryReply):void;reject(error:unknown):void};
type Flight={role:'visible';intent:PeriodIntent;controller:AbortController;demands:Demand[];ownSlot:boolean;extras:boolean};
const aborted=()=>new DOMException('Aborted','AbortError');

/** One event-loop collection combines chart sections with the period's other visible consumers. */
export class PeriodTransport implements HistoryMember {
  private queue:Demand[]=[];
  private scheduled=false;
  private readonly flights=new Set<Flight>();
  private completed='';
  private failed='';
  private readonly cursors=new Map<string,string>();
  constructor(private readonly pool:HistoryPool,private readonly intent:()=>PeriodIntent|null,private readonly receive:(reply:PeriodReply,intent:PeriodIntent)=>void|Promise<void>,
    private readonly send:(board:string,body:PeriodRequest,signal:AbortSignal,reserve:(bytes:number)=>boolean)=>Promise<PeriodReply>,private readonly accessLost:()=>void=()=>{}) {}
  get estimatedBytes(){return 0;}
  evictionCandidates(){return [];}
  private key(intent:PeriodIntent){return `${intent.generation}:${intent.revision}`;}
  change(){this.schedule();}
  reset(){this.completed=this.failed='';this.cursors.clear();for(const flight of this.flights)this.abort(flight);for(const demand of this.queue)demand.reject(aborted());this.queue=[];}
  retry(){this.failed='';this.schedule();}
  read(scope:PeriodScope,query:HistoryQuery,signal?:AbortSignal):Promise<HistoryReply> {
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(aborted());return;}
      const demand={scope,query,signal,resolve,reject};this.queue.push(demand);
      signal?.addEventListener('abort',()=>{reject(aborted());this.queue=this.queue.filter(d=>d!==demand);for(const flight of this.flights)if(flight.demands.includes(demand)&&flight.demands.every(d=>d.signal?.aborted)&&!flight.extras)this.abort(flight);},{once:true});
      this.schedule();
    });
  }
  private schedule(){if(this.scheduled)return;this.scheduled=true;queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(()=>{this.scheduled=false;this.flush();})));}
  private abort(flight:Flight){flight.controller.abort();for(const demand of flight.demands)demand.reject(aborted());this.pool.release(flight);this.flights.delete(flight);}
  private flush() {
    const intent=this.intent();if(!intent)return;
    const key=this.key(intent);
    const extras=(!!intent.request.values||!!intent.request.sessions||!!intent.request.quota||!!intent.request.budget||!!intent.request.funds)&&key!==this.completed&&key!==this.failed&&![...this.flights].some(f=>f.extras&&this.key(f.intent)===key);
    if(!this.queue.length&&!extras)return;
    const demands:Demand[]=[];
    for(const scope of PERIOD_SCOPES){const index=this.queue.findIndex(d=>d.scope===scope&&!d.signal?.aborted);if(index!==-1)demands.push(this.queue.splice(index,1)[0]);}
    const flight:Flight={role:'visible',intent,controller:new AbortController(),demands,ownSlot:!demands.length,extras};
    this.flights.add(flight);
    const cursorKey=(scope:PeriodScope,query:HistoryQuery)=>JSON.stringify([intent.board,scope,query.meters,query.unit,query.currency]);
    const body:PeriodRequest={...intent.request,...(!extras?{values:undefined,sessions:undefined,quota:undefined,budget:undefined,funds:undefined}:{}),...Object.fromEntries(demands.map(d=>[d.scope,{...d.query}]))};
    for(const scope of PERIOD_SCOPES){const query=body[scope];if(query)query.evidence??=this.cursors.get(cursorKey(scope,query));}
    const appliedIntent={...intent,request:body};
    const start=()=>{
      if(flight.controller.signal.aborted)return;
      this.send(intent.board,body,flight.controller.signal,bytes=>this.pool.reserve(flight,bytes)).then(async reply=>{
        if(flight.controller.signal.aborted)return;
        // A→B→A is three generations. Equal target text does not revive the first response.
        const current=this.intent();
        if(current?.generation===intent.generation&&current.revision===intent.revision) {
          await this.receive(reply,appliedIntent);
          const latest=this.intent();
          if(latest?.generation===intent.generation&&latest.revision===intent.revision){if(extras)this.completed=key;
          for(const scope of PERIOD_SCOPES){const part=reply[scope],query=body[scope];if(query&&part?.state==='complete'&&part.value.tape)this.cursors.set(cursorKey(scope,query),part.value.tape.cursor);}}
        }
        for(const demand of demands) {
          const part=reply[demand.scope];
          if(part?.state==='complete'){const {tape:_tape,...value}=part.value;demand.resolve(value);}
          else demand.reject(new ApiError(part?.state==='error'&&part.error==='history_limit'?413:400,part?.state==='error'?part.error:'history_failed'));
        }
      }).catch(error=>{if(error instanceof ApiError&&[401,403,404].includes(error.status))this.accessLost();if(extras)this.failed=key;for(const demand of demands)demand.reject(error);if(extras){const current=this.intent();if(current?.generation===intent.generation&&current.revision===intent.revision)this.receive({basis:{run:'',revision:'',evaluatedAt:intent.request.evaluatedAt,evidenceCut:0,range:{from:0,to:0}},...(body.values?{values:{state:'error',error:error instanceof ApiError&&error.code==='history_limit'?'history_limit':'unavailable'}}:{}),...(body.sessions?{sessions:{state:'error',error:error instanceof ApiError&&error.code==='history_limit'?'history_limit':'unavailable'}}:{})},intent);}})
        .finally(()=>{this.pool.release(flight);this.flights.delete(flight);const next=this.intent();if(this.queue.length||next&&this.key(next)!==key)this.schedule();});
    };
    if(flight.ownSlot)this.pool.request(this,flight,start,()=>this.abort(flight));else start();
    if(this.queue.length)this.schedule();
  }
}

/** Charge transport staging before decoding; all consumers use the same retained budget. */
export async function fetchPeriod(board:string,body:PeriodRequest,signal:AbortSignal,reserve:(bytes:number)=>boolean):Promise<PeriodReply> {
  const response=await fetch(`/api/boards/${encodeURIComponent(board)}/period`,{method:'POST',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(12_000)])});
  const reader=response.body?.getReader();if(!reader)throw new Error('empty_period_reply');
  const parts:Uint8Array[]=[];let bytes=0;
  try {
    for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>7*1024*1024||!reserve(bytes*3)){await reader.cancel();throw new ApiError(413,'history_limit');}parts.push(item.value);}
    const buffer=new Uint8Array(bytes);let at=0;for(const part of parts){buffer.set(part,at);at+=part.byteLength;}
    const parsed=JSON.parse(new TextDecoder().decode(buffer));
    if(!response.ok)throw new ApiError(response.status,parsed.error??'history_failed');
    return parsed as PeriodReply;
  }finally{reader.releaseLock();}
}
