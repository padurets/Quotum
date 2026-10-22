import {activityGroupKey,activityScope,selectActivityWork} from '../../server/domain/activityScope';
import {executableWorkFilters,jsonBytes,type WorkFilter} from '../../server/domain/dataFilters';
import {cellOf,cellStart,composePrepared,expandHistory,targetOf,tileOf,tileStart,type Chunk,type History} from '../../server/domain/history';
import {evaluatedRange,type PeriodSelection} from '../../server/domain/period';
import type {PeriodRequest,PeriodReply} from '../../server/domain/periodRead';
import {workPreparationBytes,type WorkTrace} from '../../server/domain/periodWork';
import {PeriodActivity} from './periodActivity';
import {PeriodCurves} from './periodCurves';
import {HistoryTile} from './historyTiles';
import type {HistoryMember,HistoryPool} from './historyPool';
import {prepareAsync,preparations,type Preparation,type Preparations} from './prepare';
import {periodTextChangesAt} from './periodClock';
import type {ActivityDimension} from './types';

export type ActivityScope = {board:string;authority:string;workAuthority?:string;run?:string;by:ActivityDimension;muted:readonly string[];filters:WorkFilter;selection:PeriodSelection;rangeKey:string;barMs:number};
type Reading={trace:WorkTrace|null;ready:boolean;error:string|null;evidence?:number};
type Model={projector:PeriodActivity;activity:History['activity'];selection:PeriodSelection;rangeKey:string;by:ActivityDimension;muted:readonly string[];lifetime:object;bytes:number;evidence?:number};
export type ActivitySelectionState={model:Model|null;loading:boolean;error:string|null;errorOwner?:'upstream-work'|'local-preparation'|'subset-read'};
type Flight={role:'visible';controller:AbortController;generation:number};
export type ActivitySelectionEnv={pool:HistoryPool;now():number;read():Reading;send(board:string,request:PeriodRequest,signal:AbortSignal,reserve:(bytes:number)=>boolean):Promise<PeriodReply>;scheduler?:()=>Preparations|null;accessLost?():void;retryWork?():void};

/** One local numerical consumer. Board evidence and supplier accounting remain untouched. */
export class ActivitySelection implements HistoryMember {
  private scope:ActivityScope|null=null;
  private paused=false;
  private identity='';
  private lifetime={};
  private generation=0;
  private news=0;
  private dirty=Infinity;
  private scheduled=false;
  private flight:Flight|null=null;
  private readonly owner={};
  private source:WorkTrace|null=null;
  private awaiting:WorkTrace|null=null;
  private waitingForBoard=false;
  private tiles=new Map<number,HistoryTile>();
  private bytes=0;
  private readonly retained=new Map<Model,number>();
  private readonly compatibility=new WeakMap<Model,WeakMap<WorkTrace,boolean>>();
  private state:ActivitySelectionState={model:null,loading:false,error:null};
  private readonly listeners=new Set<()=>void>();
  constructor(private readonly env:ActivitySelectionEnv){}
  get estimatedBytes(){return this.bytes+[...this.retained.keys()].reduce((bytes,model)=>bytes+(model===this.state.model?0:model.bytes),0);}
  /** A prepared drawing keeps its numerical basis until its replacement commits. */
  retain(model:Model|null){
    if(!model)return()=>{};
    this.retained.set(model,(this.retained.get(model)??0)+1);this.env.pool.register(this);
    let released=false;
    return()=>{if(released)return;released=true;const count=this.retained.get(model)??0;if(count>1)this.retained.set(model,count-1);else this.retained.delete(model);if(!this.scope&&!this.retained.size)this.env.pool.unregister(this);};
  }
  sameScope(model=this.state.model):model is Model{return !!model&&model.lifetime===this.lifetime;}
  /** Exact subset HTTP and shared work may finish in either order. Compare their
   * admitted contexts, not the hub revision which also includes unrelated meters. */
  compatible(model=this.state.model){
    if(!this.sameScope(model)||!this.scope)return false;
    const reading=this.env.read(),trace=reading.trace;
    if(!reading.ready||!trace)return false;
    if(model.selection.mode==='live')return model.evidence===reading.evidence;
    const selected=model.projector.trace;
    if(!trace.fixed||!selected.fixed)return false;
    const cached=this.compatibility.get(model),previous=cached?.get(trace);if(previous!==undefined)return previous;
    const muted=new Set(this.scope.muted),key=(value:WorkTrace,subset:boolean)=>JSON.stringify([
      value.fixed!.range,value.knownFrom,value.available,
      value.fixed!.totals.filter(([id])=>!subset||!muted.has(activityGroupKey(value.refs[id],model.by))).map(([id,ms,last])=>[value.refs[id].ref,ms,last]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),
    ]);
    const value=key(trace,true)===key(selected,false),values=cached??new WeakMap<WorkTrace,boolean>();values.set(trace,value);this.compatibility.set(model,values);return value;
  }
  evictionCandidates(){return [];}
  get=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(state:ActivitySelectionState){this.state=state;for(const listener of this.listeners)listener();}
  configure(scope:ActivityScope|null,paused=false){
    if(scope)try{
      if(!executableWorkFilters(activityScope(scope.filters,scope.by,scope.muted)))throw new Error('history_limit');
    }catch{this.reset();this.publish({model:null,loading:false,error:'history_limit'});return;}
    const identity=scope?JSON.stringify([scope.board,scope.authority,scope.workAuthority,scope.run,scope.by,[...scope.muted].sort(),scope.filters,scope.selection,scope.rangeKey,scope.barMs]):'';
    if(identity===this.identity){this.paused=paused;if(!paused){this.refresh();if(this.dirty!==Infinity)this.schedule();}return;}
    this.reset();this.identity=identity;this.scope=scope;this.paused=paused;
    if(scope){this.env.pool.register(this);this.dirty=-Infinity;this.publish({model:null,loading:!paused,error:null});if(!paused)this.schedule();}
  }
  private scheduler(){return this.env.scheduler?this.env.scheduler():preparations();}
  reset(){
    this.generation++;this.identity='';this.lifetime={};this.scope=null;this.source=this.awaiting=null;this.waitingForBoard=false;this.tiles.clear();this.bytes=0;this.dirty=Infinity;
    if(!this.retained.size)this.env.pool.unregister(this);
    this.flight?.controller.abort();this.scheduler()?.cancel(this.owner);
    // A cancelled response/preparation owns its reservation until its finally block.
    this.publish({model:null,loading:false,error:null});
  }
  refresh=()=>{
    if(!this.scope||this.scope.selection.mode!=='live')return;
    const reading=this.env.read();
    if(!reading.ready){
      if(!this.waitingForBoard){this.waitingForBoard=true;this.generation++;this.flight?.controller.abort();this.scheduler()?.cancel(this.owner);}
      this.publish({model:this.state.model,loading:!reading.error,error:reading.error,errorOwner:reading.error?'upstream-work':undefined});return;
    }
    if(reading.trace!==this.source||this.waitingForBoard){this.waitingForBoard=false;this.source=reading.trace;this.awaiting=null;this.news++;this.dirty=-Infinity;this.publish({model:this.state.model,loading:true,error:null});this.schedule();}
  };
  /** A baseline can replace every fixed cell without withdrawing compatible evidence. */
  baseline(){
    if(this.scope?.selection.mode==='range')this.changed(-Infinity);
    else this.refresh();
  }
  invalidate(){
    const scope=this.scope,paused=this.paused;
    this.reset();
    if(scope)this.configure(scope,paused);
  }
  changed(since:number,workAuthority?:string){
    if(!this.scope)return;
    if(workAuthority!==undefined&&workAuthority!==this.scope.workAuthority){this.reset();return;}
    if(since===Infinity)return;
    if(this.scope.selection.mode==='range'&&since>=this.scope.selection.to)return;
    if(this.scope.selection.mode==='live')this.awaiting=this.env.read().trace;
    this.news++;this.dirty=Math.min(this.dirty,since);this.publish({model:this.state.model,loading:true,error:null});this.schedule();
  }
  retry=()=>{
    if(!this.scope)return;
    if(this.state.errorOwner==='upstream-work'){this.env.retryWork?.();this.refresh();return;}
    if(this.scope.selection.mode==='live'||this.dirty===Infinity)this.dirty=-Infinity;
    this.publish({model:this.state.model,loading:true,error:null});this.schedule();
  };
  private schedule(){if(this.scheduled)return;this.scheduled=true;queueMicrotask(()=>queueMicrotask(()=>{this.scheduled=false;this.flush();}));}
  private flush(){
    const scope=this.scope;if(!scope||this.paused||this.flight||this.dirty===Infinity)return;
    if(scope.selection.mode==='live'&&this.awaiting&&this.env.read().trace===this.awaiting)return;
    try{if(!executableWorkFilters(activityScope(scope.filters,scope.by,scope.muted)))throw new Error('history_limit');}
    catch{this.dirty=Infinity;this.publish({model:null,loading:false,error:'history_limit'});return;}
    const flight:Flight={role:'visible',controller:new AbortController(),generation:this.generation};this.flight=flight;
    this.env.pool.request(this,flight,()=>{void this.run(scope,flight);},()=>flight.controller.abort());
  }
  private async run(scope:ActivityScope,flight:Flight){
    const {pool}=this.env,generation=flight.generation,news=this.news,since=this.dirty,lifetime=this.lifetime;
    const valid=()=>!flight.controller.signal.aborted&&generation===this.generation&&this.scope===scope;
    let transport=0,scratch=0;
    const reserve=(bytes:number)=>{if(!pool.reserve(flight,transport+bytes))throw new Error('history_limit');scratch=bytes;};
    try{
      if(!valid())return;
      let build:Preparation<{model:Model;tiles:Map<number,HistoryTile>;bytes:number}>;
      if(scope.selection.mode==='live'){
        const reading=this.env.read(),trace=reading.trace;
        if(!reading.ready||!trace||trace.fixed){this.publish({model:this.state.model,loading:!reading.error,error:reading.error,errorOwner:reading.error?'upstream-work':undefined});return;}
        this.source=trace;
        const self=this;
        build=(function*(){
          reserve(workPreparationBytes(trace)+jsonBytes({...trace,spans:[],packed:undefined})*4+trace.refs.length*1024+1024);
          const selected=yield*selectActivityWork(trace,scope.by,new Set(scope.muted));
          const curves=yield*PeriodCurves.prepare(selected),projector=yield*PeriodActivity.prepare(selected,curves);
          const activity={...projector.summary(evaluatedRange(scope.selection,self.env.now()),scope.by),barMs:scope.barMs};
          // Shared pattern/reference objects remain charged by their board owner too.
          const bytes=curves.bytes+jsonBytes({...selected,spans:[],packed:undefined})*4+selected.refs.length*1024+(selected.packed?.blocks.length??0)*16+
            (selected.packed?.patterns.reduce((bytes,pattern)=>bytes+64+pattern.length*16,0)??0)+selected.spans.length*64+1024;
          reserve(bytes);
          return {model:{projector,activity,selection:scope.selection,rangeKey:scope.rangeKey,by:scope.by,muted:scope.muted,lifetime,bytes,evidence:reading.evidence},tiles:new Map<number,HistoryTile>(),bytes};
        })();
      }else{
        const range=scope.selection,cell=cellOf(range.to-range.from),from=cellStart(Math.max(range.from,since),cell),to=Math.ceil(range.to/cell)*cell;
        const request:PeriodRequest={version:1,selection:range,evaluatedAt:this.env.now(),workFilter:activityScope(scope.filters,scope.by,scope.muted),sessions:{},quota:{cell:String(cell),from:String(from),to:String(to),sources:'[]',meters:'[]',unit:'USD',evidence:'skip'}};
        if(jsonBytes(request)>76*1024)throw new Error('history_limit');
        const reply=await this.env.send(scope.board,request,flight.controller.signal,bytes=>{if(!pool.reserve(flight,bytes+scratch))return false;transport=bytes;return true;});
        if(!valid())return;
        // HTTP can reach a restarted hub before its stream announces the new run.
        if(scope.run!==undefined&&reply.basis.run!==scope.run)return;
        if(reply.quota?.state!=='complete'||reply.sessions?.state!=='complete')throw new Error([reply.quota,reply.sessions].some(part=>part?.state==='error'&&part.error==='history_limit')?'history_limit':'history_failed');
        const answer=expandHistory(reply.quota.value),trace=reply.sessions.value,previous=this.tiles;
        build=(function*(){
          reserve(1024+jsonBytes(trace)*4);
          const tiles=new Map(previous);let tileBytes=[...tiles.values()].reduce((n,tile)=>n+tile.bytes,0);
          for(const chunk of answer.chunks){
            const id=tileOf(chunk.from,cell),old=tiles.get(id)??new HistoryTile(tileStart(id,cell),cell);
            const tile=yield*old.staged(chunk,answer.known,bytes=>{reserve(1024+jsonBytes(trace)*4+tileBytes+bytes);return true;},answer.now,'activity');
            if(!tile)throw new Error('history_limit');
            const covered=old.readTo>old.readFrom;
            tile.readFrom=covered?Math.min(old.readFrom,chunk.from):chunk.from;
            tile.readTo=covered?Math.max(old.readTo,chunk.to):chunk.to;
            tile.validTo=Math.min(tile.readTo,answer.now);tile.writeSeq=old.writeSeq+1;
            tileBytes+=tile.bytes-(tiles.get(id)?.bytes??0);tiles.set(id,tile);yield;
          }
          const chunks:Chunk[]=[];reserve(1024+jsonBytes(trace)*4+tileBytes*4);
          for(const tile of tiles.values()){chunks.push(yield*tile.chunkPrepared(answer.known,false,answer.now,'activity'));yield;}
          const history=yield*composePrepared(chunks,answer,targetOf(range.to-range.from,answer.now,scope.rangeKey,range),new Set());
          const projector=yield*PeriodActivity.prepare(trace),activity=projector.project(history.activity,range);
          const bytes=tileBytes+jsonBytes(activity)*4+jsonBytes(trace)*4+1024;reserve(bytes);
          return {model:{projector,activity,selection:scope.selection,rangeKey:scope.rangeKey,by:scope.by,muted:scope.muted,lifetime,bytes},tiles,bytes};
        })();
      }
      const result=await prepareAsync(this.owner,build,valid,this.scheduler());
      if(!result||!valid())return;
      if(news!==this.news){this.schedule();return;}
      pool.reserve(flight,transport);
      this.tiles=result.tiles;this.bytes=result.bytes;this.dirty=Infinity;
      this.publish({model:result.model,loading:false,error:null});
    }catch(error){
      if(valid()){
        if(error&&typeof error==='object'&&'status' in error&&[401,403,404].includes(Number(error.status))){this.reset();this.env.accessLost?.();return;}
        this.publish({model:this.state.model,loading:false,error:error instanceof Error&&error.message==='history_limit'?'history_limit':'history_failed',errorOwner:scope.selection.mode==='live'?'local-preparation':'subset-read'});
        // Failed cells remain dirty. A later event cannot confirm the failed prefix.
      }
    }finally{
      pool.release(flight);if(this.flight===flight)this.flight=null;
      if(generation!==this.generation||news!==this.news)this.schedule();
    }
  }
  numbers(now:number,bar?:number,model=this.state.model,key?:string){
    if(!this.sameScope(model))return null;
    const range=evaluatedRange(model.selection,now);
    if(bar!==undefined){range.from=Math.max(range.from,bar);range.to=Math.min(range.to,bar+model.activity.barMs);}
    if(model.selection.mode==='live')return model.projector.numbers(model.activity,range,model.by,key);
    if(bar===undefined){
      if(key===undefined)return model.activity;
      const group=model.activity.by[model.by].find(group=>group.key===key);
      return {...model.activity,agentMs:group?.agentMs??0,activeMs:group?.activeMs??0,agents:group?.agents??0,by:{...model.activity.by,[model.by]:group?[group]:[]}};
    }
    const cell=model.activity.cells.find(([at])=>at===bar);
    const by=model.by;
    return {...model.activity,agentMs:cell?.[2]??0,activeMs:cell?.[1]??0,agents:cell?.[3]??0,by:{...model.activity.by,[by]:model.activity.by[by].map(group=>({...group,agentMs:group.cells.find(([at])=>at===bar)?.[1]??0}))}};
  }
  changesAt(now:number,read:(at:number)=>string,model=this.state.model,key?:string){
    if(!this.sameScope(model)||model.selection.mode!=='live')return null;
    const period=model.selection.periodMs;
    return periodTextChangesAt(now,at=>{
      const next=Math.min(model.projector.changesAt(at,period,model.by,key)??Infinity,
        ...[model.projector.trace.knownFrom+period,(model.projector.trace.cut??Infinity)+period].filter(value=>value>at));
      return Number.isFinite(next)?next:null;
    },read);
  }
}
