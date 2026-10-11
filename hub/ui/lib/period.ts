import {moneySelection} from './moneySelection';
import {subscriptionSelection} from './subscription';
import {cellOf} from '../../server/domain/history';
import {PERIOD_SCOPES,type PeriodScope,type HistoryQuery} from '../../server/domain/periodRead';
import {prepareAsync,preparations,type Preparation} from './prepare';
import {useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {evaluatedRange,periodKey,type PeriodBasis,type PeriodSelection} from '../../server/domain/period';
import {hasPeriodValue,periodValueAt,type PeriodValues} from '../../server/domain/periodValues';
import {mergeWorkPrepared,packWorkPrepared,workPreparationBytes,type WorkedSession as RecordedSession,type WorkTrace} from '../../server/domain/periodWork';
import type {LiveSession} from './types';
import type {PeriodReply} from '../../server/domain/periodRead';
import {AGENTS,ACTIVITY,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,widgetVisible} from '../../server/domain/widgets';
import {PeriodTransport,fetchPeriod,type PeriodIntent} from './periodTransport';
import {PeriodIndex} from './periodIndex';
import type {WorkOrder} from '../../server/domain/periodIndex';
import {historyPool} from './historyPool';
import {page,type PageEvent,type PageState} from './board';
import {clock,hubNow} from './clock';
import {onPrefs,prefs} from './prefs';
import {periodOf} from './periods';
import {onTimeRange,timeRange} from './timeRange';
import {pan} from './pan';
import {sameJson,selector} from './store';
import {periodTextChangesAt} from './periodClock';
import type {Line} from './lines';
import type {MeterHistory} from './moneyView';
import {UNAUTHORIZED} from './http';
import {retainSamplesPrepared,sampleBytes,mergeTapePrepared,type PeriodTape} from '../../server/domain/periodTape';
import {PeriodAccounting} from './periodAccounting';
import {PeriodActivity} from './periodActivity';
import type {History} from '../../server/domain/history';
import {canShift,shifted} from '../../server/domain/periodShift';
import * as retention from '../../server/domain/periodRetention';

type Reading<T>={value:T|null;basis:PeriodBasis|null;loading:boolean;error:string|null};
type WorkedSession=Omit<RecordedSession,'currentPresence'>&Pick<LiveSession,'currentPresence'>;
const empty=<T>():Reading<T>=>({value:null,basis:null,loading:false,error:null});
const noValue=empty<PeriodValues>(),noSessions:WorkedSession[]=[];

export type SessionOrder={key:unknown;worked?:readonly WorkOrder[]};
class BoardPeriod {
  private readonly workOrders=new Set<(rows:WorkedSession[])=>SessionOrder|null>();
  private active=false;
  private readonly preparationOwner={};
  private receiving=Promise.resolve();
  private retirementAt=Infinity;
  private retiring=false;
  private retirementPreparing=false;
  private workEvidence=0;
  private generation=0;
  private revision=0;
  private proofEpoch=0;
  private workProofEpoch=-1;
  private valuesProofEpoch=-1;
  private readonly dirtyScopes=new Set<PeriodScope>();
  private scopeKeys:Partial<Record<PeriodScope,string>>={};
  private evaluatedAt=hubNow();
  private identity='';
  private selection:PeriodSelection={mode:'live',periodMs:86_400_000};
  private sourceIds:string[]=[];
  private wantsWork=false;
  private workNeeded=false;
  private liveEvidence=false;
  private valuesNeeded=false;
  private authority='';
  private workAuthority:string|undefined;
  private readonly valueCache=new Map<string,{values:Map<string,Reading<PeriodValues>>;bytes:number;at:number}>();
  private readonly values=new Map<string,Reading<PeriodValues>>();
  private readonly valueListeners=new Map<string,Set<()=>void>>();
  private work:Reading<WorkTrace>=empty();
  private cursor:string|undefined;
  private index:PeriodIndex|null=null;
  private workSelection:PeriodSelection=this.selection;
  private workRangeKey='24h';
  private activity:PeriodActivity|null=null;
  private readonly tapes=new Map<PeriodScope,{tape:PeriodTape;accounting:PeriodAccounting;generation:number;proofEpoch:number;selection:PeriodSelection;rangeKey:string;queryKey:string}>();
  private readonly projectionRevision={quota:0,budget:0,funds:0};
  private readonly projectionErrors:Partial<Record<PeriodScope,'history_limit'|'history_failed'>>={};
  private readonly projectionListeners={quota:new Set<()=>void>(),budget:new Set<()=>void>(),funds:new Set<()=>void>()};
  private workRows:WorkedSession[]=[];
  private rowsBySource=new Map<string,WorkedSession[]>();
  private listeners=new Set<()=>void>();
  private sourceListeners=new Map<string,Set<()=>void>>();
  private workState={...this.work,rows:this.workRows,evidence:this.workEvidence};
  private readonly watch=clock.watch();
  private bytes=0;
  private cacheKey='';
  private readonly retained=new Map<string,{bytes:number;copyBytes:number;at:number;fits:(selection:PeriodSelection)=>boolean;restore:(selection:PeriodSelection)=>void}>();
  readonly transport=new PeriodTransport(historyPool,()=>this.intent(),(reply,intent,reserve)=>this.receive(reply,intent,reserve),fetchPeriod,()=>{page.dispatch({type:'board-close'});if(typeof window!=='undefined')window.dispatchEvent(new Event(UNAUTHORIZED));});
  constructor(){historyPool.register(this);clock.subscribe(this.watch,()=>this.tick());}
  get estimatedBytes(){return this.bytes+[...this.valueCache.values(),...this.retained.values()].reduce((sum,c)=>sum+c.bytes,0);}
  evictionCandidates(){return [...this.valueCache].map(([key,c])=>({bytes:c.bytes,shownAt:c.at,drop:()=>{this.valueCache.delete(key);}})).concat([...this.retained].map(([key,c])=>({bytes:c.bytes,shownAt:c.at,drop:()=>{this.retained.delete(key);}})));}
  private retainCurrent(){
    if(!this.cacheKey)return;
    if(!this.valuesNeeded&&this.valuesProofEpoch===this.proofEpoch&&this.selection.mode==='range'&&[...this.values.values()].every(v=>v.value&&!v.loading&&!v.error)){
      const values=new Map(this.values);this.valueCache.set(periodKey(this.selection),{values,bytes:JSON.stringify([...values]).length*3,at:hubNow()});
    }
    const range=evaluatedRange(this.selection,hubNow());
    if(!this.active||!page.get().board||this.workNeeded||this.work.loading||this.work.error||this.valuesNeeded||[...this.values.values()].some(value=>value.loading||value.error)||PERIOD_SCOPES.some(scope=>this.projectionErrors[scope]||this.scopeKeys[scope]&&this.needsTape(scope,this.scopeKeys[scope]!,range)))return;
    const tapes=new Map([...this.tapes].map(([scope,tape])=>[scope,{...tape}])),work=this.work,index=this.index,activity=this.activity,workSelection=this.workSelection,workRangeKey=this.workRangeKey,cursor=this.cursor,liveEvidence=this.liveEvidence,values=new Map(this.values),cursors=this.transport.evidence(),bytes=this.bytes;
    const context=JSON.stringify([this.authority,this.scopeKeys]);
    const workProofEpoch=this.workProofEpoch,valuesProofEpoch=this.valuesProofEpoch,reusable=workProofEpoch===this.proofEpoch&&(!values.size||valuesProofEpoch===this.proofEpoch)&&[...tapes.values()].every(t=>t.proofEpoch===this.proofEpoch);
    // Proofs and alternative states are immutable and shared by shifted summaries.
    // Summaries exclude shared shift proofs; a whole value sequence bounds its largest replay.
    const copyBytes=workSelection.mode==='live'?0:JSON.stringify({...work.value,fixed:work.value?.fixed?{...work.value.fixed,shift:undefined}:undefined}).length*6
      +[...tapes.values()].reduce((sum,{tape})=>sum+JSON.stringify({...tape,fixed:tape.fixed?{...tape.fixed,shift:undefined}:undefined}).length*6,0)
      +JSON.stringify([...values.values()]).length*3;
    this.valueCache.delete(periodKey(this.selection));
    this.retained.set(this.cacheKey,{bytes:bytes+this.cacheKey.length*2+context.length*2+256,copyBytes,at:hubNow(),fits:selection=>reusable&&selection.mode==='range'&&work.value?.fixed!==undefined&&canShift(work.value.fixed,selection)&&context===JSON.stringify([this.authority,this.scopeKeys])&&[...tapes.values()].every(({tape})=>tape.fixed&&canShift(tape.fixed,selection))&&[...values.values()].every(v=>hasPeriodValue(v.value,selection.to)),restore:selection=>{
      this.workEvidence++;
      this.tapes.clear();for(const [scope,tape] of tapes)this.tapes.set(scope,tape);
      this.work=work;this.index=index;this.activity=activity;this.workSelection=workSelection;this.workRangeKey=workRangeKey;this.cursor=cursor;this.liveEvidence=liveEvidence;this.bytes=bytes;
      for(const id of new Set([...this.values.keys(),...values.keys()]))this.setValue(id,values.get(id)??noValue);
      if(selection.mode==='range'&&workSelection.mode==='range'&&periodKey(selection)!==periodKey(workSelection)){
        const value={...work.value!,fixed:shifted(work.value!.fixed!,selection)!};
        this.work={...work,value,basis:work.basis?{...work.basis,range:selection}:null};this.index=new PeriodIndex(value);this.activity=new PeriodActivity(value,this.index.curves);
        this.workSelection=selection;this.workRangeKey=periodKey(selection);
        for(const [scope,entry] of tapes){const tape={...entry.tape,fixed:shifted(entry.tape.fixed!,selection)!};this.tapes.set(scope,{...entry,tape,accounting:new PeriodAccounting(tape,value),selection,rangeKey:periodKey(selection)});}
        for(const [id,reading] of values)this.setValue(id,{...reading,value:periodValueAt(reading.value,selection.to)!,basis:reading.basis?{...reading.basis,range:selection}:null});
      }
      this.measureBytes();
      this.transport.restoreEvidence(cursors);this.workNeeded=false;this.valuesNeeded=false;
      this.workProofEpoch=workProofEpoch;
      this.valuesProofEpoch=valuesProofEpoch;
      // A cached live ledger may have crossed all of its old deadlines while hidden.
      this.retirementAt=selection.mode==='live'?hubNow():Infinity;
    }});
  }
  get=()=>this.workState;
  getProjectionRevision=(scope:PeriodScope)=>this.projectionRevision[scope];
  subscribeProjection=(scope:PeriodScope,listener:()=>void)=>{this.projectionListeners[scope].add(listener);return()=>{this.projectionListeners[scope].delete(listener);};};
  private publishProjection(scopes:readonly PeriodScope[]=PERIOD_SCOPES){for(const scope of scopes){this.projectionRevision[scope]++;for(const listener of this.projectionListeners[scope])listener();}}
  project(history:History,scope:PeriodScope,now=this.evaluatedAt) {
    const tape=this.tapes.get(scope);
    let result=history;
    if(tape?.rangeKey===history.range){const range=evaluatedRange(tape.selection,now),values=new Map<string,PeriodValues>();if(tape.selection.mode==='range')for(const [id,reading] of this.values)if(reading.value&&reading.basis?.range.to===range.to)values.set(id,reading.value);result=tape.accounting.project(history,range,values);}
    if(scope==='quota'&&this.activity&&this.workRangeKey===history.range&&this.work.basis){const range=evaluatedRange(this.workSelection,now);result={...result,since:range.from,to:range.to,activity:this.activity.project(history.activity,range)};}
    return result;
  }
  activityAt(history:History,by:import('./types').ActivityDimension,now:number,bar?:number,key?:string) {
    let fallback=history.activity;
    if(bar!==undefined){const cell=fallback.cells.find(([at])=>at===bar);fallback={...fallback,activeMs:cell?.[1]??0,agentMs:cell?.[2]??0,agents:cell?.[3]??0,by:{...fallback.by,[by]:fallback.by[by].map(group=>({...group,agentMs:group.cells.find(([at])=>at===bar)?.[1]??0}))}};}
    if(!this.activity||this.workRangeKey!==history.range||!this.work.basis||this.workSelection.mode==='range')return fallback;
    const range=evaluatedRange(this.workSelection,now);
    if(bar!==undefined){range.from=Math.max(range.from,bar);range.to=Math.min(range.to,bar+history.activity.barMs);}
    return this.activity.numbers(fallback,range,by,key);
  }
  activityChangesAt(history:History,by:import('./types').ActivityDimension,now:number,read:(at:number)=>string,key?:string) {
    if(this.workSelection.mode!=='live'||this.workRangeKey!==history.range||!this.work.basis)return null;
    const period=this.workSelection.periodMs;
    return periodTextChangesAt(now,at=>this.activity?.changesAt(at,period,by,key)??null,read);
  }
  quotaAt(line:Line,now:number,rangeKey?:string):Line {
    const tape=this.tapes.get('quota');if(!tape||tape.selection.mode!=='live'||rangeKey!==undefined&&tape.rangeKey!==rangeKey)return line;
    const summary=tape.accounting.quotaSummary(line.sourceId,line.windowId,evaluatedRange(tape.selection,now));
    return summary?{...line,...summary}:line;
  }
  moneyAt(series:MeterHistory,now:number,rangeKey?:string):MeterHistory {
    const tape=this.tapes.get('budget');if(!tape||tape.selection.mode!=='live'||rangeKey!==undefined&&tape.rangeKey!==rangeKey)return series;
    const summary=tape.accounting.moneySummary(series.sourceId,series.meterId,series.unit,evaluatedRange(tape.selection,now));
    return summary?{...series,...summary}:series;
  }
  rangeAt(scope:PeriodScope,now:number,rangeKey?:string){const tape=this.tapes.get(scope);return tape&&(rangeKey===undefined||tape.rangeKey===rangeKey)?evaluatedRange(tape.selection,now):null;}
  private workBoundary(now:number,refs?:readonly string[],source?:string) {
    if(!this.index||this.workSelection.mode!=='live')return null;
    let next=Infinity;const period=this.workSelection.periodMs;
    for(const [i,curve] of this.index.curves.contexts.entries())if((!refs||refs.includes(this.index.trace.refs[i].ref))&&(!source||this.index.trace.refs[i].source===source))next=Math.min(next,curve.next(now-period)+period,curve.next(now));
    return Number.isFinite(next)?next:null;
  }
  workedAt(refs:readonly string[],fallback:number|null,now:number) {
    if(!refs.length||!this.index||this.workSelection.mode!=='live')return fallback;
    const range=evaluatedRange(this.workSelection,now);
    return this.index.trace.refs.reduce((sum,ref,i)=>sum+(refs.includes(ref.ref)?this.index!.curves.contexts[i].read(range):0),0);
  }
  workedChangesAt(refs:readonly string[],now:number,read:(now:number)=>string){return refs.length?periodTextChangesAt(now,at=>this.workBoundary(at,refs),read):null;}
  cellChangesAt(scope:PeriodScope,now:number,read:(now:number)=>string,extra?:(now:number)=>number|null,source?:string,rangeKey?:string){
    const tape=this.tapes.get(scope);if(!tape||tape.selection.mode!=='live'||rangeKey!==undefined&&tape.rangeKey!==rangeKey)return extra?.(now)??null;
    const period=tape.selection.periodMs;
    return periodTextChangesAt(now,at=>{const next=Math.min(tape.accounting.changesAt(at,period,source)??Infinity,scope==='quota'?this.workBoundary(at,undefined,source)??Infinity:Infinity,extra?.(at)??Infinity);return Number.isFinite(next)?next:null;},read);
  }
  projectionState(history:History,scope:PeriodScope){const tape=this.tapes.get(scope),range=evaluatedRange(this.selection,this.evaluatedAt);return {ready:!!tape&&tape.queryKey===this.scopeKeys[scope]&&tape.rangeKey===history.range&&this.tapeCovers(tape.tape,range),error:this.projectionErrors[scope]};}
  getSource=(id:string)=>this.rowsBySource.get(id)??noSessions;
  getWorkEvidence=()=>this.workEvidence;
  getValue=(id:string)=>this.values.get(id)??noValue;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  subscribeWorkOrder=(read:(rows:WorkedSession[])=>SessionOrder|null)=>{this.workOrders.add(read);this.scheduleClock();return()=>{this.workOrders.delete(read);this.scheduleClock();};};
  refreshWorkClock=()=>{if(this.evaluatedAt!==hubNow())this.tick();else{this.retireExpired(hubNow());this.scheduleClock();}};
  subscribeSource=(id:string,listener:()=>void)=>{let set=this.sourceListeners.get(id);if(!set)this.sourceListeners.set(id,set=new Set());set.add(listener);return()=>{set!.delete(listener);};};
  subscribeValue=(id:string,listener:()=>void)=>{let set=this.valueListeners.get(id);if(!set)this.valueListeners.set(id,set=new Set());set.add(listener);return()=>{set!.delete(listener);};};
  private queryKey(query:HistoryQuery){return JSON.stringify([query.meters,query.unit,query.currency]);}
  private tapeCovers(tape:PeriodTape,range:{from:number;to:number}) {
    // A complete fixed summary covers its requested endpoints, even when minute
    // rounding puts the right edge beyond the separate observation cut.
    if(tape.fixed)return this.selection.mode==='range'&&range.from===tape.fixed.range.from&&range.to===tape.fixed.range.to;
    return range.from>=tape.from&&(range.to<=tape.cut||this.selection.mode==='live'&&this.liveEvidence);
  }
  private needsTape(scope:PeriodScope,key:string,range:{from:number;to:number}){const tape=this.tapes.get(scope);return this.dirtyScopes.has(scope)||!tape||tape.queryKey!==key||!this.tapeCovers(tape.tape,range);}
  private queries(board:NonNullable<PageState['board']>,range:{from:number;to:number}) {
    const cell=cellOf(range.to-range.from),cards=board.lineup.flatMap(id=>board.cards[id]??[]);
    const queries:Partial<Record<PeriodScope,HistoryQuery>>={};
    for(const scope of PERIOD_SCOPES) {
      const visible=(scope==='quota'?[ACTIVITY,...QUOTA_WIDGETS]:scope==='funds'?[SUBSCRIPTION_FUNDS]:BUDGET_WIDGETS).some(id=>widgetVisible(board.view,id,board.lineup.length));if(!visible)continue;
      const meters=scope==='quota'?subscriptionSelection(cards,board.view):moneySelection(cards,board.view.hidden,scope==='funds'?prefs().funds:prefs().money,board.currencies,scope==='funds'?'funds':'budget').selection;
      const query:HistoryQuery={cell:String(cell),from:String(Math.floor(range.from/cell)*cell),to:String(Math.ceil(range.to/cell)*cell),cells:'skip',...(meters?{unit:meters.unit,meters:JSON.stringify(meters.ids),...(meters.displayCurrency?{currency:meters.displayCurrency}:{})}:{})};
      queries[scope]=query;
    }
    return queries;
  }
  private intent():PeriodIntent|null {
    const board=page.get().board;if(!board||!this.active)return null;
    const pending=!pan.get(),range=evaluatedRange(this.selection,hubNow()),queries=pending?this.queries(board,range):{};
    for(const scope of PERIOD_SCOPES)if(queries[scope]&&(this.projectionErrors[scope]&&!this.dirtyScopes.has(scope)||!this.needsTape(scope,this.queryKey(queries[scope]!),range)))delete queries[scope];
    return {board:board.id,generation:this.generation,revision:this.revision,proofEpoch:this.proofEpoch,request:{version:1,selection:this.selection,evaluatedAt:hubNow(),...queries,...(pending&&this.valuesNeeded&&this.selection.mode==='range'&&this.sourceIds.length?{values:this.sourceIds}:{}),...(pending&&this.wantsWork&&this.workNeeded?{sessions:{...(this.cursor?{cursor:this.cursor}:{})}}:{})}};
  }
  private setValue(id:string,value:Reading<PeriodValues>){this.values.set(id,value);for(const listener of this.valueListeners.get(id)??[])listener();}
  private publishWork() {this.workState={...this.work,rows:this.workRows,evidence:this.workEvidence};for(const listener of this.listeners)listener();}
  private retireWork() {
    this.workEvidence++;this.retirementAt=Infinity;
    this.work=empty();this.cursor=undefined;this.index=null;this.activity=null;this.workProofEpoch=-1;
    this.tapes.delete('quota');delete this.projectionErrors.quota;this.transport.forgetEvidence('quota');
    this.workRows=[];
    const previous=this.rowsBySource;this.rowsBySource=new Map();for(const id of previous.keys())for(const listener of this.sourceListeners.get(id)??[])listener();
    this.work={...this.work,loading:this.wantsWork};this.publishWork();this.publishProjection(['quota']);
    this.measureBytes();clock.due(this.watch,null,hubNow());
  }
  private clear() {
    this.workEvidence++;this.retirementAt=Infinity;
    this.proofEpoch++;this.workProofEpoch=-1;this.valuesProofEpoch=-1;this.dirtyScopes.clear();
    this.retained.clear();this.cacheKey='';
    preparations()?.cancel(this.preparationOwner);this.transport.reset();this.work=empty();this.cursor=undefined;this.index=null;this.activity=null;this.tapes.clear();delete this.projectionErrors.quota;delete this.projectionErrors.budget;delete this.projectionErrors.funds;this.valueCache.clear();this.liveEvidence=false;this.bytes=0;this.workRows=[];this.publishProjection();
    for(const id of this.values.keys())this.setValue(id,noValue);this.values.clear();
    const previous=this.rowsBySource;this.rowsBySource=new Map();for(const id of previous.keys())for(const listener of this.sourceListeners.get(id)??[])listener();
    this.publishWork();clock.due(this.watch,null,hubNow());
  }
  activate(active:boolean){if(this.active===active)return;this.active=active;if(!active){this.clear();this.identity='';}else this.changed();}
  changed(event?:PageEvent,state:PageState=page.get()) {
    const board=state.board;
    if(!board||event?.type==='board-close'){this.identity='';this.generation++;this.clear();return;}
    if(!this.active)return;
    const snapshot=event?.type==='hub'&&event.event.type==='snapshot';
    const changedWork=snapshot&&(!board.workAuthority||board.workAuthority!==this.workAuthority);
    if(snapshot||!this.identity||event?.type==='hub'&&event.event.type==='history'&&event.event.data.workAuthority)this.workAuthority=board.workAuthority;
    const selected=timeRange(),selection:PeriodSelection=selected?{mode:'range',...selected}:{mode:'live',periodMs:periodOf(prefs().range).ms};
    const sources=board.lineup.filter(id=>!board.view.hidden.includes('source:'+id));
    const wantsWork=sources.length>0||[AGENTS,ACTIVITY].some(id=>widgetVisible(board.view,id,board.lineup.length));
    const scopeKeys=Object.fromEntries(Object.entries(this.queries(board,evaluatedRange(selection,hubNow()))).map(([scope,query])=>[scope,this.queryKey(query)]));
    const changedScopes=PERIOD_SCOPES.filter(scope=>scopeKeys[scope]!==this.scopeKeys[scope]);
    const identity=JSON.stringify([board.id,periodKey(selection),sources,wantsWork,board.currencies?.target.id,board.currencies?.revision,board.currencies?.registryRevision,sources.map(id=>[id,board.cards[id]?.budget])]);
    const authority=JSON.stringify([board.id,sources,wantsWork,board.currencies?.target.id,board.currencies?.revision,board.currencies?.registryRevision,sources.map(id=>[id,board.cards[id]?.budget])]);
    if(authority!==this.authority){this.clear();this.authority=authority;}
    if(event?.type==='hub'&&['history','hello','snapshot','mine','lineup'].includes(event.event.type))this.retained.clear();
    const cacheKey=JSON.stringify([identity,scopeKeys]);
    if(cacheKey!==this.cacheKey){this.retainCurrent();this.cacheKey=cacheKey;}
    this.selection=selection;this.sourceIds=sources;this.wantsWork=wantsWork;this.scopeKeys=scopeKeys;
    if(changedWork)this.retireWork();
    if(identity!==this.identity) {
      const oldBoard=this.identity?JSON.parse(this.identity)[0]:null;
      this.identity=identity;this.generation++;this.revision++;
      this.workEvidence++;this.retirementAt=Infinity;
      this.dirtyScopes.clear();
      for(const scope of PERIOD_SCOPES)delete this.projectionErrors[scope];
      if(oldBoard!==board.id||event?.type==='hub'&&['mine','lineup'].includes(event.event.type))this.clear();
      this.cacheKey=cacheKey;
      let cached=this.valueCache.get(periodKey(selection));
      if(!cached&&selection.mode==='range')cached=[...this.valueCache.values()].find(c=>sources.every(id=>hasPeriodValue(c.values.get(id)?.value,selection.to)));
      const valueStaging={role:'visible' as const};
      if(cached&&!historyPool.reserve(valueStaging,cached.bytes))cached=undefined;
      this.valuesNeeded=selection.mode==='range'&&!cached;
      if(selection.mode==='range')for(const id of sources){const saved=cached?.values.get(id),value=periodValueAt(saved?.value,selection.to);this.setValue(id,saved?{...saved,...(value?{value}:{}),basis:saved.basis?{...saved.basis,range:{from:selection.from,to:selection.to}}:null}:{...this.getValue(id),loading:true,error:null});}
      else {for(const id of this.values.keys())this.setValue(id,noValue);this.values.clear();}
      const range=evaluatedRange(selection,hubNow());
      if(this.tapes.size||this.work.value) {
        // Complete evidence belongs either to this target or to the shared LRU.
        // A fixed target replaces its raw ledger with exact summaries and edges.
        preparations()?.cancel(this.preparationOwner);this.tapes.clear();this.cursor=undefined;this.index=null;this.activity=null;this.work={...this.work,value:null};this.liveEvidence=false;this.transport.forgetEvidence();
        clock.due(this.watch,null,hubNow());
      }
      this.bytes=JSON.stringify([...this.values.values()]).length*3+JSON.stringify(this.workRows).length*3;
      historyPool.release(valueStaging);
      this.workNeeded=wantsWork&&(!this.work.value||range.from<this.work.value.anchor||range.to>(this.work.value.cut??0)&&!this.liveEvidence);
      const saved=this.retained.has(cacheKey)?[cacheKey,this.retained.get(cacheKey)!] as const:[...this.retained].find(([,entry])=>entry.fits(selection));
      if(saved){
        const staging={role:'visible' as const},before=this.bytes;
        this.retained.delete(saved[0]);this.bytes+=saved[1].bytes;
        // The removed cache entry remains owned until its exact shifted copy is ready.
        if(saved[0]===cacheKey||historyPool.reserve(staging,saved[1].copyBytes)){saved[1].restore(selection);this.tick(false);}
        else this.bytes=before;
        historyPool.release(staging);
      }
      if(!this.workNeeded&&this.work.basis){this.workSelection=selection;this.workRangeKey=selection.mode==='range'?periodKey(selection):prefs().range;this.tick(false);}
      for(const tape of this.tapes.values())if(range.from>=tape.tape.from&&(range.to<=tape.tape.cut||this.liveEvidence)){tape.selection=selection;tape.rangeKey=selection.mode==='range'?periodKey(selection):prefs().range;}
      this.work={...this.work,loading:this.workNeeded,error:null};this.publishWork();this.publishProjection();
      this.transport.change();return;
    }
    if(!this.active)return;
    if(changedScopes.length){
      // A resource choice changes only its evidence. Other families and the
      // complete session index remain available under their existing proofs.
      this.generation++;this.revision++;preparations()?.cancel(this.preparationOwner);
      for(const scope of changedScopes){this.tapes.delete(scope);this.dirtyScopes.delete(scope);delete this.projectionErrors[scope];this.transport.forgetEvidence(scope);}
      this.measureBytes();this.publishProjection(changedScopes);this.transport.change();
    }
    if(event?.type==='connection'){this.tick();return;}
    if(event?.type==='hub') {
      const hub=event.event;
      if(hub.type==='hello'||hub.type==='snapshot'||hub.type==='mine'||hub.type==='lineup') {
        this.generation++;this.revision++;this.cursor=undefined;this.workNeeded=wantsWork;this.valuesNeeded=selection.mode==='range';
        if(hub.type==='mine'||hub.type==='lineup')this.clear();
        if(hub.type==='snapshot'||hub.type==='hello')this.tick();
        this.transport.change();
      }else if(hub.type==='sessions'||hub.type==='ownSessions') {
        this.tick();
      }else if(hub.type==='history') {
        const included=hub.data.sources.some(id=>sources.includes(id));
        if(included){this.proofEpoch++;this.valueCache.clear();}
        const own=board.meta.personal&&hub.data.ownSince!==undefined&&(selection.mode==='live'||hub.data.ownSince<selection.to);
        const relevant=included&&(selection.mode==='live'||hub.data.since<selection.to)||own;
        if(relevant){
          const retired=own&&hub.data.ownSince===0||included&&(hub.data.changes?hub.data.changes.some(c=>sources.includes(c.source)&&c.scope==='quota'&&(c.since===0||c.workSince===0)):hub.data.since===0);
          if(retired)this.retireWork();
          if(included&&selection.mode==='range')this.valuesNeeded=true;
          for(const scope of PERIOD_SCOPES){
            const visible=(scope==='quota'?[ACTIVITY,...QUOTA_WIDGETS]:scope==='funds'?[SUBSCRIPTION_FUNDS]:BUDGET_WIDGETS).some(id=>widgetVisible(board.view,id,board.lineup.length));
            if(!visible)continue;
            const selected=scope==='quota'?new Set(sources):new Set(moneySelection(board.lineup.flatMap(id=>board.cards[id]??[]),board.view.hidden,scope==='funds'?prefs().funds:prefs().money,board.currencies,scope==='funds'?'funds':'budget').selection?.ids.map(([id])=>id));
            if(scope==='quota'&&own||(hub.data.changes?hub.data.changes.some(c=>selected.has(c.source)&&c.scope===(scope==='funds'?'budget':scope)&&(selection.mode==='live'||c.since<selection.to)):hub.data.sources.some(id=>selected.has(id))))this.dirtyScopes.add(scope);
          }
          const work=hub.data.changes?.some(c=>sources.includes(c.source)&&c.scope==='quota'&&c.workSince!==undefined)??true;if(retired||work||own)this.workNeeded=wantsWork;this.revision++;this.transport.change();
        }
      }
    }
  }
  private receive(reply:PeriodReply,intent:PeriodIntent,reserve?:(bytes:number)=>boolean) {
    // Sibling resource replies share one retained projection. Let each commit before
    // taking the next snapshot, so a later chart cannot cancel values or sessions.
    if(this.retirementPreparing)preparations()?.cancel(this.preparationOwner);
    const next=this.receiving.then(()=>this.applyReply(reply,intent,reserve));
    this.receiving=next.catch(()=>{});return next;
  }
  private async applyReply(reply:PeriodReply,intent:PeriodIntent,transferred?:(bytes:number)=>boolean) {
    if(intent.generation!==this.generation||intent.revision!==this.revision)return;
    const proofEpoch=intent.proofEpoch??this.proofEpoch;
    if(!reply.values&&!reply.sessions&&!PERIOD_SCOPES.some(scope=>reply[scope]?.state==='complete'?reply[scope].value.tape:reply[scope]?.state==='error'&&intent.request[scope]?.evidence!=='skip'))return;
    const changed=new Set<PeriodScope>();
    const staging={role:'visible' as const};
    // Decoding has released its byte buffers. Reuse its reservation for the
    // same reply's retained evidence and prefixes, instead of charging it twice.
    const reserve=transferred??((bytes:number)=>historyPool.reserve(staging,bytes));
    const release=()=>{if(transferred)transferred(cellsBytes);else historyPool.release(staging);};
    // Keep the previous complete presentation if the new evidence cannot fit.
    // Charge decoded dictionaries and all derived prefixes before building them.
    const cellsBytes=PERIOD_SCOPES.reduce((bytes,scope)=>{const part=reply[scope];if(part?.state!=='complete')return bytes;const {tape:_,...cells}=part.value;return bytes+JSON.stringify(cells).length*3;},0);
    const staged=new Map<string,number>(),limited=new Error('history_limit');
    const charge=(key:string,bytes:number)=>{const prior=staged.get(key)??0;staged.set(key,bytes);if(!reserve(cellsBytes+[...staged.values()].reduce((a,b)=>a+b,0))){staged.set(key,prior);throw limited;}};
    const discard=(key:string)=>{staged.delete(key);reserve(cellsBytes+[...staged.values()].reduce((a,b)=>a+b,0));};
    const ownTape=(tape:PeriodTape,prior?:PeriodTape)=>({...tape,quota:tape.quota.filter(row=>!prior?.quota.includes(row)),money:tape.money.filter(row=>!prior?.money.includes(row))});
    const failScope=(scope:PeriodScope)=>{reply[scope]={state:'error',error:'history_limit'};discard(scope);};
    for(const scope of PERIOD_SCOPES){const part=reply[scope];if(part?.state==='complete'&&part.value.tape)try{charge(scope,tapeBytes(part.value.tape,true));}catch(error){if(error!==limited)throw error;failScope(scope);}}
    if(reply.sessions&&reply.sessions.state!=='error')try{charge('work',workBytes(reply.sessions.value,0));}catch(error){if(error!==limited)throw error;reply.sessions={state:'error',error:'history_limit'};}
    // Card states are adopted unchanged; only their reading wrappers are new.
    if(reply.values?.state==='complete')try{charge('values',JSON.stringify(reply.values.value).length*3+reply.values.value.length*768);}catch(error){if(error!==limited)throw error;reply.values={state:'error',error:'history_limit'};}
    const priorWork=this.work.value,priorIndex=this.index,priorTapes=new Map(this.tapes);
    const retainedFrom=intent.request.selection.mode==='live'?evaluatedRange(intent.request.selection,hubNow()).from:null;
    function* build():Preparation<{work:WorkTrace|null;index:PeriodIndex|null;activity:PeriodActivity|null;tapes:typeof priorTapes;edge:number}> {
      const incomingTapes=new Map<PeriodScope,PeriodTape>();
      // Compact each decoded column before allocating work or accounting indexes.
      // Progress replaces reservations as scratch buffers become unreachable.
      for(const scope of PERIOD_SCOPES){const part=reply[scope],incoming=part?.state==='complete'?part.value.tape:undefined;if(!incoming)continue;
        const old=priorTapes.get(scope),queryKey=JSON.stringify([intent.request[scope]?.meters,intent.request[scope]?.unit,intent.request[scope]?.currency]),previous=old?.queryKey===queryKey?old.tape:undefined;
        try{
          // Only this column changes ownership. Recounting every other series
          // after each column makes a dense ledger's admission quadratic.
          let incomingBytes=tapeBytes(incoming,true);
          for(const series of incoming.quota){
            const before=quotaTapeBytes(series,true);
            charge(scope,incomingBytes+series.samples.length/5*40);
            series.samples=yield*retainSamplesPrepared(series.samples,series.samplesEncoding==='delta');delete series.samplesEncoding;
            incomingBytes+=quotaTapeBytes(series,true)-before;charge(scope,incomingBytes);yield;
          }
          const replacement=previous?.quota.filter(s=>incoming.quota.some(row=>row.source===s.source&&row.window===s.window)).reduce((n,s)=>n+s.samples.length/5*88,0)??0;
          const mergeBase=tapeBytes(incoming)+replacement;let mergeScratch=0;
          charge(scope,mergeBase);
          const merging=(bytes:number)=>{mergeScratch+=bytes;charge(scope,mergeBase+mergeScratch);};
          let tape=yield*mergeTapePrepared(previous,incoming,merging,bytes=>merging(-bytes));
          if(retainedFrom!==null){let scratch=0;const before=tapeBytes(ownTape(tape,previous));tape=yield*retention.retainTape(tape,retainedFrom,bytes=>{scratch+=bytes;charge(scope,before+scratch);});}
          incomingTapes.set(scope,tape);if(part?.state==='complete')part.value.tape=tape;charge(scope,tapeBytes(ownTape(tape,previous)));
        }catch(error){if(error!==limited)throw error;incomingTapes.delete(scope);failScope(scope);}
      }
      let work=priorWork,index:PeriodIndex|null=null,activity:PeriodActivity|null=null,retired=false;
      const part=reply.sessions;
      if(part&&part.state!=='error')try{
        charge('work',workBytes(part.value)+(part.state==='delta'?workBytes(priorWork):0));
        work=part.state==='delta'&&priorWork?yield*mergeWorkPrepared(priorWork,part.value):part.value;
        if(retainedFrom!==null){let scratch=0;const before=workBytes(work),previous=work;work=yield*retention.retainWork(work,retainedFrom,bytes=>{scratch+=bytes;charge('work',before+scratch);});retired=work!==previous;}
        // Current presence belongs to the stream. A delayed analytical response
        // contributes credited work, never another lease or presence deadline.
        work={...work,refs:work.refs.map(({currentPresence:_,...ref})=>ref)};
        charge('work',workBytes(work,0)+workPreparationBytes(work));
        if(!work.packed&&!work.fixed)work=yield*packWorkPrepared(work);
        charge('work',workBytes(work,0)+workPreparationBytes(work));index=yield*PeriodIndex.prepare(work);activity=yield*PeriodActivity.prepare(work,index.curves);charge('work',workBytes(work,index.curves.bytes));
      }catch(error){if(error!==limited)throw error;reply.sessions={state:'error',error:'history_limit'};work=priorWork;index=null;activity=null;discard('work');}
      const workPart=reply.sessions,changedWork=new Set<string>();let changedBytes=0;
      try{if(workPart&&workPart.state!=='error')for(const refs of [workPart.value.refs,...(workPart.state==='complete'||retired?[priorWork?.refs??[]]:[])])for(const ref of refs){if(ref.source&&!changedWork.has(ref.source)){changedBytes+=64+ref.source.length*2;charge('changedWork',changedBytes);changedWork.add(ref.source);}yield;}}
      catch(error){if(error!==limited)throw error;reply.sessions={state:'error',error:'history_limit'};work=priorWork;index=null;activity=null;changedWork.clear();discard('changedWork');discard('work');}
      const tapes=new Map(priorTapes);
      for(const scope of PERIOD_SCOPES){
        const old=tapes.get(scope),incoming=incomingTapes.get(scope);
        if(!incoming&&!(scope==='quota'&&old&&index))continue;
        const queryKey=JSON.stringify([intent.request[scope]?.meters,intent.request[scope]?.unit,intent.request[scope]?.currency]),tape=incoming??old!.tape;
        const base=staged.get(scope)??0;
        try{
          const accounting=yield*PeriodAccounting.prepare(tape,work,index?.curves??priorIndex?.curves,old?.accounting,changedWork,bytes=>charge(scope,base+bytes));
          if(incoming){changed.add(scope);tapes.set(scope,{tape,accounting,generation:intent.generation,proofEpoch,selection:intent.request.selection,rangeKey:intent.request.selection.mode==='range'?periodKey(intent.request.selection):prefs().range,queryKey});}
          else tapes.set(scope,{...old!,accounting});
        }catch(error){if(error!==limited)throw error;incomingTapes.delete(scope);failScope(scope);}
      }
      const edge=retainedFrom===null?Infinity:yield*retention.retirementEdge(work,[...tapes.values()].map(entry=>entry.tape),retainedFrom);
      return {work,index,activity,tapes,edge};
    }
    const valid=()=>intent.generation===this.generation&&intent.revision===this.revision;
    const prepared=await prepareAsync(this.preparationOwner,build(),valid).catch(error=>{release();throw error;});
    if(!prepared||!valid()){release();return;}
    for(const scope of PERIOD_SCOPES){const part=reply[scope];if(part){if(part.state==='error'){this.projectionErrors[scope]=part.error==='history_limit'?'history_limit':'history_failed';this.dirtyScopes.delete(scope);}else delete this.projectionErrors[scope];changed.add(scope);}}
    this.evaluatedAt=hubNow();this.tapes.clear();for(const [scope,tape] of prepared.tapes)this.tapes.set(scope,tape);
    for(const scope of PERIOD_SCOPES){const section=reply[scope];if(section?.state==='complete'&&section.value.tape)this.dirtyScopes.delete(scope);}
    if(reply.values) {
      if(reply.values.state==='complete'){
        changed.add('quota');this.valuesNeeded=false;this.valuesProofEpoch=proofEpoch;for(const value of reply.values.value)this.setValue(value.id,{value,basis:reply.values.basis,loading:false,error:null});
      }
      else {this.valuesNeeded=false;for(const id of this.sourceIds)this.setValue(id,{...this.getValue(id),loading:false,error:reply.values.error});}
    }
    if(reply.sessions) {
      const section=reply.sessions;
      if(section.state==='error'){this.workNeeded=false;this.work={...this.work,loading:false,error:section.error};this.publishWork();}
      else {
        const value=prepared.work!;
        this.workEvidence++;
        this.cursor=section.value.cursor;this.workNeeded=false;this.liveEvidence ||= intent.request.selection.mode==='live';
        this.workProofEpoch=proofEpoch;
        this.workSelection=intent.request.selection;this.workRangeKey=this.workSelection.mode==='range'?periodKey(this.workSelection):prefs().range;
        this.work={value,basis:section.basis,loading:false,error:null};this.index=prepared.index;this.activity=prepared.activity;
        this.tick(false);
      }
    }
    this.measureBytes();
    release();
    this.publishProjection([...changed]);
    this.retirementAt=intent.request.selection.mode==='live'?prepared.edge+intent.request.selection.periodMs:Infinity;
    this.scheduleClock();
  }
  private async planRetirement(){
    if(this.selection.mode!=='live'){this.retirementAt=Infinity;return;}
    const generation=this.generation,revision=this.revision,from=evaluatedRange(this.selection,hubNow()).from,period=this.selection.periodMs;
    const edge=await prepareAsync(this.preparationOwner,retention.retirementEdge(this.work.value,[...this.tapes.values()].map(entry=>entry.tape),from),()=>this.active&&generation===this.generation&&revision===this.revision);
    if(edge!==null)this.retirementAt=edge+period;
  }
  private retireExpired(now:number){
    if(this.retiring||now<this.retirementAt||this.selection.mode!=='live'||pan.get())return;
    this.retiring=true;
    const generation=this.generation,revision=this.revision,from=evaluatedRange(this.selection,now).from,period=this.selection.periodMs;
    const valid=()=>this.active&&generation===this.generation&&revision===this.revision&&!pan.get();
    const run=async()=>{
      if(!valid())return;
      const previousWork=this.work.value,previousIndex=this.index,previousTapes=new Map(this.tapes),staging={role:'visible' as const};
      const limited=new Error('history_limit'),sizes=new Map<string,number>();
      const charge=(key:string,bytes:number)=>{sizes.set(key,bytes);if(!historyPool.reserve(staging,[...sizes.values()].reduce((a,b)=>a+b,0)))throw limited;};
      const build=function*():Preparation<{work:WorkTrace|null;index:PeriodIndex|null;activity:PeriodActivity|null;tapes:typeof previousTapes;edge:number}> {
        let work=previousWork,index=previousIndex,activity:PeriodActivity|null=null,scratch=0;
        if(work){
          work=yield*retention.retainWork(work,from,bytes=>{scratch+=bytes;charge('work',scratch);});
          if(work!==previousWork){
            const base=workBytes(work,0)+work.refs.length*512;let scratch=0;
            charge('work',base);
            if(index)index=yield*index.retain(work,bytes=>{scratch+=bytes;charge('work',base+scratch);});
            else {charge('work',workBytes(work,0)+workPreparationBytes(work));index=yield*PeriodIndex.prepare(work);}
            activity=yield*PeriodActivity.prepare(work,index.curves);charge('work',workBytes(work,index.curves.bytes));
          }else sizes.delete('work');
        }
        const changedWork=new Set<string>(),tapes=new Map(previousTapes);let changedBytes=0;
        if(work!==previousWork)for(const refs of [work?.refs??[],previousWork?.refs??[]])for(const ref of refs){if(ref.source&&!changedWork.has(ref.source)&&previousIndex?.curves.groups.source.get(ref.source)!==index?.curves.groups.source.get(ref.source)){changedBytes+=64+ref.source.length*2;charge('changedWork',changedBytes);changedWork.add(ref.source);}yield;}
        for(const [scope,entry] of previousTapes){
          let scratch=0;const tape=yield*retention.retainTape(entry.tape,from,bytes=>{scratch+=bytes;charge(scope,scratch);});
          if(tape!==entry.tape||scope==='quota'&&work!==previousWork){
            const owned={...tape,quota:tape.quota.filter(row=>!entry.tape.quota.includes(row)),money:tape.money.filter(row=>!entry.tape.money.includes(row))},base=tapeBytes(owned);
            charge(scope,base);const accounting=yield*PeriodAccounting.prepare(tape,work,index?.curves,entry.accounting,changedWork,bytes=>charge(scope,base+bytes));tapes.set(scope,{...entry,tape,accounting});
          }else sizes.delete(scope);
          yield;
        }
        const edge=yield*retention.retirementEdge(work,[...tapes.values()].map(entry=>entry.tape),from);
        return {work,index,activity,tapes,edge};
      };
      try{
        this.retirementPreparing=true;
        const result=await prepareAsync(this.preparationOwner,build(),valid);if(!result||!valid())return;
        this.work={...this.work,value:result.work};this.index=result.index;if(result.activity)this.activity=result.activity;
        this.tapes.clear();for(const [scope,entry] of result.tapes)this.tapes.set(scope,entry);
        // Compaction changes storage, not evidence or a chart's drawing revision.
        this.retirementAt=result.edge+period;
        this.workState={...this.workState,value:result.work};this.tick();this.measureBytes();
      }catch(error){if(error!==limited)throw error;historyPool.release(staging);await this.planRetirement();}
      finally{this.retirementPreparing=false;historyPool.release(staging);}
    };
    const next=this.receiving.then(run).finally(()=>{this.retiring=false;this.scheduleClock();});this.receiving=next.catch(()=>{});
  }
  private measureBytes(){
    this.bytes=JSON.stringify([...this.values.values()]).length*3+workBytes(this.work.value,this.index?.curves.bytes)+[...this.tapes.values()].reduce((sum,t)=>sum+tapeBytes(t.tape)+t.accounting.bytes,0);
  }
  /** The current stream is authoritative even while an older analytical reply is being prepared. */
  private present(rows:WorkedSession[]) {
    const board=page.get().board,live=new Map<string,{source:string|null;device:string;presence:NonNullable<WorkedSession['currentPresence']>}>();
    if(board?.presenceConfirmed){
      for(const source of this.sourceIds)for(const session of board.sessions?.[source]??[])if(session.presenceKey&&session.currentPresence)live.set(session.presenceKey,{source,device:session.device.id,presence:session.currentPresence});
      if(board.meta.personal)for(const session of board.ownSessions??[])if(session.presenceKey&&session.currentPresence)live.set(session.presenceKey,{source:null,device:session.device.id,presence:session.currentPresence});
    }
    return rows.map(row=>{
      const current=row.presenceKey?live.get(row.presenceKey):undefined;
      const presence=current&&current.source===row.source&&current.device===row.device.id?current.presence:undefined;
      const working=!!presence&&presence.working;
      if(working===row.working&&sameJson(presence,row.currentPresence))return row;
      const {currentPresence:_previous,...rest}=row;return {...rest,working,...(presence?{currentPresence:presence}:{})};
    });
  }
  private tick(fromClock=true) {
    if(!this.active)return;
    const now=hubNow();
    if(this.selection.mode==='live'){
      const range=evaluatedRange(this.selection,now),workGap=!!this.index&&range.from<this.index.trace.anchor;
      const gaps=PERIOD_SCOPES.filter(scope=>{const entry=this.tapes.get(scope);return entry?.selection.mode==='live'&&range.from<entry.tape.from;});
      const work=workGap&&!this.workNeeded&&!this.work.loading&&!this.work.error,scopes=gaps.filter(scope=>!this.dirtyScopes.has(scope)&&!this.projectionErrors[scope]);
      if(work||scopes.length){
        this.revision++;this.retirementAt=Infinity;preparations()?.cancel(this.preparationOwner);
        if(work){this.cursor=undefined;this.workNeeded=true;this.work={...this.work,loading:true,error:null};this.publishWork();}
        for(const scope of scopes){this.dirtyScopes.add(scope);this.transport.forgetEvidence(scope);}this.publishProjection(scopes);
        this.transport.change();
      }
      // A corrected hub clock can widen the window behind discarded evidence.
      // Keep the previous honest basis until its bounded replacement arrives.
      if(workGap){clock.due(this.watch,null,now);return;}
    }
    this.evaluatedAt=now;
    const projected=this.index&&this.work.basis?this.index.advance(evaluatedRange(this.workSelection,now),now):{rows:this.workRows,changed:false,limited:false};
    if(projected.limited){this.work={...this.work,error:'history_range_invalid'};this.publishWork();clock.due(this.watch,null,now);return;}
    const rows=this.present(projected.rows);
    const changed=projected.changed||this.workState.value!==this.work.value||rows.length!==this.workRows.length||rows.some((row,i)=>row.ref!==this.workRows[i]?.ref||row.working!==this.workRows[i]?.working||!sameJson(row.currentPresence,this.workRows[i]?.currentPresence));
    if(changed) {
      this.workRows=rows;
      this.activity?.update(this.workRows);
      const next=new Map<string,WorkedSession[]>();
      for(const row of this.workRows){if(row.source===null)continue;let list=next.get(row.source);if(!list)next.set(row.source,list=[]);list.push(row);}
      const old=this.rowsBySource;this.rowsBySource=next;
      for(const id of new Set([...old.keys(),...next.keys()])) {
        if(sameJson(old.get(id)??[],next.get(id)??[])){if(old.has(id))next.set(id,old.get(id)!);continue;}
        for(const listener of this.sourceListeners.get(id)??[])listener();
      }
    }
    if(this.work.basis)this.work={...this.work,basis:{...this.work.basis,evaluatedAt:now,range:evaluatedRange(this.workSelection,now)}};
    if(changed||this.workState.loading!==this.work.loading||this.workState.error!==this.work.error||this.workSelection.mode==='range'&&!sameJson(this.workState.basis?.range,this.work.basis?.range))this.publishWork();
    if(!fromClock)this.publishProjection(['quota']);
    this.retireExpired(now);
    this.scheduleClock();
  }
  private scheduleClock(){
    const now=hubNow();
    const orders=this.active&&this.index&&this.workSelection.mode==='live'?[...this.workOrders].flatMap(read=>read(this.workRows)?.worked??[]):[];
    const due=this.workSelection.mode==='live'?this.index?.changesAt(now,this.workSelection.periodMs,orders)??null:null;
    const next=Math.min(due??Infinity,this.retiring||pan.get()?Infinity:this.retirementAt);
    clock.due(this.watch,Number.isFinite(next)?next:null,now);
  }
  retryHistory(scope:PeriodScope){
    if(!this.projectionErrors[scope])return;
    delete this.projectionErrors[scope];this.dirtyScopes.add(scope);this.revision++;
    this.publishProjection([scope]);this.transport.retry();
  }
  retry=()=>{
    let needed=false;
    if(this.work.error&&this.wantsWork){needed=this.workNeeded=true;this.work={...this.work,loading:true,error:null};this.publishWork();}
    if(this.selection.mode==='range'&&[...this.values.values()].some(value=>value.error)){
      needed=this.valuesNeeded=true;for(const id of this.sourceIds)this.setValue(id,{...this.getValue(id),loading:true,error:null});
    }
    if(needed){this.revision++;this.transport.retry();}
  };
}

// Each context also belongs to three numerical group indexes (arrays of shared curve references).
const workBytes=(trace:WorkTrace|null,curves?:number)=>trace?JSON.stringify({...trace,spans:[],packed:undefined}).length*2+(trace.packed?trace.packed.blocks.length*8+trace.packed.patterns.reduce((n,p)=>n+p.length*8+32,0)+(curves??trace.packed.blocks.length/3*144+trace.packed.patterns.reduce((n,p)=>n+p.length*128,0)):trace.spans.length*640)+trace.refs.length*864:0;
const quotaTapeBytes=(series:PeriodTape['quota'][number],wire:boolean)=>JSON.stringify({...series,samples:[]}).length*2+(wire&&!('columns' in series.samples)?series.samples.length*8:sampleBytes(series.samples,series.samplesEncoding==='delta'));
const tapeBytes=(tape:PeriodTape,wire=false)=>JSON.stringify({...tape,quota:tape.quota.map(s=>({...s,samples:[]})),money:tape.money.map(s=>({...s,readings:[],spans:[],...(s.paired?{paired:{readings:[],spans:[]}}:{})}))}).length*2+tape.quota.reduce((n,s)=>n+(wire&&!('columns' in s.samples)?s.samples.length*8:sampleBytes(s.samples,s.samplesEncoding==='delta')),0)+tape.money.reduce((n,s)=>n+[...s.readings,...s.paired?.readings??[]].reduce((bytes,r)=>bytes+256+2*((r.amount?.length??0)+(r.unit?.length??0)+(r.label?.length??0)+(r.scope?.length??0)+(r.limit?.length??0)),0)+(s.spans.length+(s.paired?.spans.length??0))*192,0);

export const boardPeriod=new BoardPeriod();
export function followPeriod(){const stop=page.listen((event,state)=>boardPeriod.changed(event,state));const choose=()=>boardPeriod.changed();const stops=[stop,onPrefs(choose),onTimeRange(choose),pan.onPhase(()=>boardPeriod.refreshWorkClock())];choose();return()=>stops.forEach(stop=>stop());}
export function usePeriodValues(id:string){return useSyncExternalStore(listener=>boardPeriod.subscribeValue(id,listener),()=>boardPeriod.getValue(id));}
const roster=(rows:readonly WorkedSession[])=>rows.map(({workedMs:_,...row})=>row);
const panelRoster=roster;
export function usePeriodSessions(order:(rows:WorkedSession[])=>SessionOrder|null=()=>null){
  const latest=useRef(order);latest.current=order;
  const [watch]=useState(()=>(rows:WorkedSession[])=>latest.current(rows));
  useLayoutEffect(()=>boardPeriod.subscribeWorkOrder(watch),[watch]);
  useLayoutEffect(()=>boardPeriod.refreshWorkClock());
  const [read]=useState(()=>selector(boardPeriod,()=>({select:({value:_value,...state})=>state,equal:(a,b)=>a.evidence===b.evidence&&a.loading===b.loading&&a.error===b.error&&sameJson(panelRoster(a.rows),panelRoster(b.rows))&&sameJson(latest.current(a.rows)?.key,latest.current(b.rows)?.key)})));
  return useSyncExternalStore(boardPeriod.subscribe,read);
}
export type SessionPeriod=Pick<Reading<WorkTrace>,'basis'|'loading'|'error'>;
export function useSourcePeriodSessions(id:string){
  const current=useRef(id);current.current=id;
  const [read]=useState(()=>selector({get:()=>({rows:boardPeriod.getSource(current.current),value:boardPeriod.getWorkEvidence()})},()=>({select:state=>state,equal:(a,b)=>a.value===b.value&&sameJson(roster(a.rows),roster(b.rows))})));
  const rows=useSyncExternalStore(listener=>boardPeriod.subscribeSource(id,listener),read).rows;
  // Global work events carry loading and failure even when a source has no rows.
  // Successful clock/evidence updates still notify only that source's data reader.
  const [status]=useState(()=>selector(boardPeriod,()=>({
    select:({basis,loading,error}):SessionPeriod=>({basis:loading||error?basis:null,loading,error}),
    equal:(a,b)=>a.loading===b.loading&&a.error===b.error&&sameJson(a.basis?.range,b.basis?.range),
  })));
  return {rows,...useSyncExternalStore(boardPeriod.subscribe,status)};
}
