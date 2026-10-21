import {WorkCalendar} from './workCalendar';
import {workChange} from './workChanges';
import {AGENT_HOURS_HEATMAP} from '../../server/domain/widgets';
import {effectiveFilters,filtersReady,onDataFilters} from './filterSelection';
import {executableWorkFilters,matchesSource,workFilter} from '../../server/domain/dataFilters';
import {mergeSourceWorkTape,sameSourceWork,sourceWorkCurves,type SourceWorkTape,type SourceWorkCurves} from '../../server/domain/periodCurves';
import {moneyReadSelection} from './moneySelection';
import {subscriptionSelection} from './subscription';
import {cellOf} from '../../server/domain/history';
import {PERIOD_SCOPES,type PeriodScope,type HistoryQuery,type WorkFacets} from '../../server/domain/periodRead';
import {prepareAsync,preparations,type Preparation} from './prepare';
import {useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {evaluatedRange,periodKey,type PeriodBasis,type PeriodSelection} from '../../server/domain/period';
import {hasPeriodValue,periodValueAt,periodValueNow,periodValueChangesAt,type PeriodValues} from '../../server/domain/periodValues';
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
import type {ActivityOrder} from '../../server/domain/periodActivity';
import type {History} from '../../server/domain/history';
import {canShift,shifted} from '../../server/domain/periodShift';
import * as retention from '../../server/domain/periodRetention';

type Reading<T>={value:T|null;basis:PeriodBasis|null;loading:boolean;error:string|null};
type WorkedSession=Omit<RecordedSession,'currentPresence'>&Pick<LiveSession,'currentPresence'>;
const empty=<T>():Reading<T>=>({value:null,basis:null,loading:false,error:null});
const noValue=empty<PeriodValues>(),noSessions:WorkedSession[]=[];

export type SessionOrder={key:unknown;worked?:readonly WorkOrder[];activity?:ActivityOrder};
class BoardPeriod {
  readonly calendar=new WorkCalendar();
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
  private nativeDue=Infinity;
  private identity='';
  private selection:PeriodSelection={mode:'live',periodMs:86_400_000};
  private sourceIds:string[]=[];
  private filterKey='';
  private resourceIdentity='';
  private resourceGeneration=0;
  private workLimit=false;
  private sourceTape:SourceWorkTape|null=null;
  private sourceCurves:SourceWorkCurves|undefined;
  private sourceCursor:string|undefined;
  private sourceEpoch=0;
  private facetsNeeded=false;
  private facetsDemand=0;
  private facetGeneration=0;
  private facetAt:number|null=null;
  private facetState:{value:WorkFacets|null;loading:boolean;error:string|null}={value:null,loading:false,error:null};
  private readonly facetListeners=new Set<()=>void>();
  getFacets=()=>this.facetState;
  subscribeFacets=(listener:()=>void)=>{this.facetListeners.add(listener);return()=>{this.facetListeners.delete(listener);};};
  // Facts can change while closed; a live range can also move without a new event.
  demandFacets=()=>{const first=this.facetsDemand++===0;if(!this.facetState.value||this.facetsNeeded||first&&this.selection.mode==='live'&&this.facetAt!==hubNow()){this.facetsNeeded=true;this.facetState={...this.facetState,loading:true};for(const listener of this.facetListeners)listener();this.revision++;this.transport.change();}return()=>{this.facetsDemand--;};};
  private invalidateFacets(){this.facetGeneration++;this.facetsNeeded=true;}
  private resetFacets(){this.invalidateFacets();this.facetAt=null;this.facetState={value:null,loading:this.facetsDemand>0,error:null};for(const listener of this.facetListeners)listener();}
  private facetBytes(value=this.facetState.value){if(!value)return 0;const choices=[value,...(value.retained?[value.retained]:[])];return 256+JSON.stringify(value).length*3+choices.reduce((bytes,value)=>bytes+value.projects.length*32+value.devices.length*96+value.clients.length*32+value.funding.length*32,0);}
  private wantsWork=false;
  private workNeeded=false;
  private liveEvidence=false;
  private valuesNeeded=false;
  private authority='';
  private financialIdentity='';
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
  private activityRetained:History['activity']|null=null;
  private readonly tapes=new Map<PeriodScope,{tape:PeriodTape;accounting:PeriodAccounting;generation:number;proofEpoch:number;sourceEpoch?:number;selection:PeriodSelection;rangeKey:string;queryKey:string;basisRange?:PeriodBasis['range']}>();
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
  private configureCalendar(visible:boolean,context:string,now:number,limited:boolean,selection:PeriodSelection){
    const staging={role:'visible' as const};
    try{return this.calendar.configure(visible,context,now,limited,selection,bytes=>historyPool.reserve(staging,bytes));}
    finally{historyPool.release(staging);}
  }
  get estimatedBytes(){return this.bytes+this.calendar.bytes+[...this.valueCache.values(),...this.retained.values()].reduce((sum,c)=>sum+c.bytes,0);}
  evictionCandidates(){return [...this.valueCache].map(([key,c])=>({bytes:c.bytes,shownAt:c.at,drop:()=>{this.valueCache.delete(key);}})).concat([...this.retained].map(([key,c])=>({bytes:c.bytes,shownAt:c.at,drop:()=>{this.retained.delete(key);}})),this.calendar.evictionCandidates());}
  private retainCurrent(){
    if(!this.cacheKey)return;
    if(!this.valuesNeeded&&this.valuesProofEpoch===this.proofEpoch&&this.selection.mode==='range'&&[...this.values.values()].every(v=>v.value&&!v.loading&&!v.error)){
      const values=new Map(this.values);this.valueCache.set(periodKey(this.selection),{values,bytes:JSON.stringify([...values]).length*3,at:hubNow()});
    }
    const range=evaluatedRange(this.selection,hubNow());
    if(!this.active||!page.get().board||this.workNeeded||this.work.loading||this.work.error||this.valuesNeeded||[...this.values.values()].some(value=>value.loading||value.error)||PERIOD_SCOPES.some(scope=>this.projectionErrors[scope]||this.scopeKeys[scope]&&this.needsTape(scope,this.scopeKeys[scope]!,range)))return;
    const tapes=new Map([...this.tapes].map(([scope,tape])=>[scope,{...tape}])),work=this.work,index=this.index,activity=this.activity,workSelection=this.workSelection,workRangeKey=this.workRangeKey,cursor=this.cursor,liveEvidence=this.liveEvidence,values=new Map(this.values),cursors=this.transport.evidence(),bytes=this.bytes-this.facetBytes();
    const sourceTape=this.sourceTape,sourceCurves=this.sourceCurves,sourceCursor=this.sourceCursor;
    const context=JSON.stringify([this.authority,this.scopeKeys,this.filterKey,this.financialIdentity]);
    const workProofEpoch=this.workProofEpoch,valuesProofEpoch=this.valuesProofEpoch,reusable=workProofEpoch===this.proofEpoch&&(!values.size||valuesProofEpoch===this.proofEpoch)&&[...tapes.values()].every(t=>t.proofEpoch===this.proofEpoch);
    // Proofs and alternative states are immutable and shared by shifted summaries.
    // Summaries exclude shared shift proofs; a whole value sequence bounds its largest replay.
    const copyBytes=workSelection.mode==='live'?0:JSON.stringify({...work.value,fixed:work.value?.fixed?{...work.value.fixed,shift:undefined}:undefined}).length*6
      +[...tapes.values()].reduce((sum,{tape})=>sum+JSON.stringify({...tape,fixed:tape.fixed?{...tape.fixed,shift:undefined}:undefined}).length*6,0)
      +JSON.stringify([...values.values()]).length*3;
    this.valueCache.delete(periodKey(this.selection));
    this.retained.set(this.cacheKey,{bytes:bytes+this.cacheKey.length*2+context.length*2+256,copyBytes,at:hubNow(),fits:selection=>reusable&&selection.mode==='range'&&work.value?.fixed!==undefined&&canShift(work.value.fixed,selection)&&context===JSON.stringify([this.authority,this.scopeKeys,this.filterKey,this.financialIdentity])&&[...tapes.values()].every(({tape})=>tape.fixed&&canShift(tape.fixed,selection))&&[...values.values()].every(v=>hasPeriodValue(v.value,Math.min(selection.to,hubNow()))),restore:selection=>{
      this.workEvidence++;
      this.tapes.clear();for(const [scope,tape] of tapes)this.tapes.set(scope,tape);
      this.work=work;this.index=index;this.activity=activity;this.activityRetained=null;this.workSelection=workSelection;this.workRangeKey=workRangeKey;this.cursor=cursor;this.liveEvidence=liveEvidence;this.bytes=bytes;
      this.sourceTape=sourceTape;this.sourceCurves=sourceCurves;this.sourceCursor=sourceCursor;
      for(const id of new Set([...this.values.keys(),...values.keys()]))this.setValue(id,values.get(id)??noValue);
      if(selection.mode==='range'&&workSelection.mode==='range'&&periodKey(selection)!==periodKey(workSelection)){
        const value={...work.value!,fixed:shifted(work.value!.fixed!,selection)!};
        this.work={...work,value,basis:work.basis?{...work.basis,range:selection}:null};this.index=new PeriodIndex(value);this.activity=new PeriodActivity(value,this.index.curves);
        this.workSelection=selection;this.workRangeKey=periodKey(selection);
        for(const [scope,entry] of tapes){const tape={...entry.tape,fixed:shifted(entry.tape.fixed!,selection)!};this.tapes.set(scope,{...entry,tape,accounting:new PeriodAccounting(tape,value),selection,rangeKey:periodKey(selection)});}
        for(const [id,reading] of values)this.setValue(id,{...reading,value:periodValueAt(reading.value,Math.min(selection.to,hubNow()))!,basis:reading.basis?{...reading.basis,range:selection}:null});
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
  getFinancialProjectionRevision=(scope:PeriodScope)=>this.tapes.get(scope)?.accounting.financialAuthority??null;
  getProjectionRevision=(scope:PeriodScope)=>this.projectionRevision[scope];
  projectionChangesAt=(scope:PeriodScope,now:number)=>this.selection.mode==='range'?this.tapes.get(scope)?.accounting.changesAt(now,0)??null:null;
  subscribeProjection=(scope:PeriodScope,listener:()=>void)=>{this.projectionListeners[scope].add(listener);return()=>{this.projectionListeners[scope].delete(listener);};};
  private publishProjection(scopes:readonly PeriodScope[]=PERIOD_SCOPES){for(const scope of scopes){this.projectionRevision[scope]++;for(const listener of this.projectionListeners[scope])listener();}}
  /** A discarded prefix cannot supply a new analytical range while replacement waits. */
  private workRange(now:number):PeriodBasis['range']|null {
    if(!this.work.basis)return null;
    const range=evaluatedRange(this.workSelection,now);
    return this.index&&range.from>=this.index.trace.anchor?range:{...this.work.basis.range};
  }
  private workAdvances(now:number) {return this.workSelection.mode==='live'&&!!this.index&&!!this.work.basis&&evaluatedRange(this.workSelection,now).from>=this.index.trace.anchor;}
  private tapeRange(tape:{tape:PeriodTape;selection:PeriodSelection;basisRange?:PeriodBasis['range']},now:number) {
    const range=evaluatedRange(tape.selection,now);
    return range.from>=tape.tape.from?range:tape.basisRange??evaluatedRange(tape.selection,this.evaluatedAt);
  }
  project(history:History,scope:PeriodScope,now=this.evaluatedAt) {
    const tape=this.tapes.get(scope);
    let result=history;
    if(tape?.rangeKey===history.range){const range=this.tapeRange(tape,now),values=new Map<string,PeriodValues>();if(tape.selection.mode==='range')for(const [id,reading] of this.values)if(reading.value&&reading.basis?.range.to===range.to)values.set(id,reading.value);result=tape.accounting.project(history,range,values,false,Math.min(range.to,now));}
    if(scope==='quota'&&this.activity&&this.workRangeKey===history.range&&this.work.basis){const range=this.workRange(now)!;result={...result,since:range.from,to:range.to,activity:this.activity.project(history.activity,range)};}
    if(scope==='quota'&&this.selectedPending())result={...result,series:result.series.map(series=>({...series,selectedWork:{from:result.to,ms:null,agentMs:0}})),activity:{...result.activity,known:null,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}};
    return result;
  }
  private selectedPending(){return !!effectiveFilters()&&(this.workLimit||this.work.loading||!!this.work.error||!this.work.value);}
  activityAt(history:History,by:import('./types').ActivityDimension,now:number,bar?:number,key?:string,retained=false) {
    let fallback=!retained&&effectiveFilters()&&(this.workLimit||this.work.loading||this.work.error||!this.work.value)?{...history.activity,known:null,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}:history.activity;
    if(bar!==undefined){const cell=fallback.cells.find(([at])=>at===bar);fallback={...fallback,activeMs:cell?.[1]??0,agentMs:cell?.[2]??0,agents:cell?.[3]??0,by:{...fallback.by,[by]:fallback.by[by].map(group=>({...group,agentMs:group.cells.find(([at])=>at===bar)?.[1]??0}))}};}
    if(retained||!this.activity||this.workRangeKey!==history.range||!this.work.basis||this.workSelection.mode==='range')return fallback;
    const range=this.workRange(now)!;
    if(bar!==undefined){range.from=Math.max(range.from,bar);range.to=Math.min(range.to,bar+history.activity.barMs);}
    return this.activity.numbers(fallback,range,by,key);
  }
  activityChangesAt(history:History,by:import('./types').ActivityDimension,now:number,read:(at:number)=>string,key?:string) {
    if(!this.workAdvances(now)||this.workRangeKey!==history.range)return null;
    const period=this.workSelection.mode==='live'?this.workSelection.periodMs:0;
    return periodTextChangesAt(now,at=>this.activity?.changesAt(at,period,by,key)??null,read);
  }
  activitySummaryAt(by:import('./types').ActivityDimension,now=hubNow(),key?:string){
    if(!this.work.basis)return null;
    return this.activity?this.activity.summary(this.workRange(now)!,by,key):this.activityRetained;
  }
  activitySelection=()=>this.workSelection;
  activityRangeAt(now=hubNow()){
    return this.work.basis?(this.workRange(now)):null;
  }
  activityCoverageChangesAt(now:number){
    if(!this.activity||!this.workAdvances(now))return null;
    const period=this.workSelection.mode==='live'?this.workSelection.periodMs:0,next=Math.min(...[this.activity.trace.knownFrom+period,(this.activity.trace.cut??Infinity)+period].filter(at=>at>now));
    return Number.isFinite(next)?next:null;
  }
  activitySummaryChangesAt(by:import('./types').ActivityDimension,now:number,read:(at:number)=>string,key?:string){
    if(!this.workAdvances(now))return null;
    return periodTextChangesAt(now,at=>this.activity?.changesAt(at,this.workSelection.mode==='live'?this.workSelection.periodMs:0,by,key)??null,read);
  }
  quotaAt(line:Line,now:number,rangeKey?:string):Line {
    const tape=this.tapes.get('quota');if(!tape||tape.selection.mode!=='live'||rangeKey!==undefined&&tape.rangeKey!==rangeKey)return line;
    const summary=tape.accounting.quotaSummary(line.sourceId,line.windowId,this.tapeRange(tape,now));
    return summary?{...line,...summary,...(this.selectedPending()?{selectedWork:{from:now,ms:null,agentMs:0}}:{})}:line;
  }
  quotaOrderAt(line:Line,now:number,rangeKey:string,active:boolean){
    const tape=this.tapes.get('quota');
    if(!tape||tape.selection.mode!=='live'||tape.rangeKey!==rangeKey||evaluatedRange(tape.selection,now).from<tape.tape.from)return {slope:0,next:Infinity};
    const work=tape.accounting.quotaWorkSlope(line.sourceId,line.windowId,now,tape.selection.periodMs,active);
    return {slope:work?.slope??0,next:Math.min(work?.next??Infinity,tape.accounting.changesAt(now,tape.selection.periodMs,line.sourceId)??Infinity)};
  }
  moneyAt(series:MeterHistory,now:number,rangeKey?:string):MeterHistory {
    const tape=this.tapes.get('budget');if(!tape||tape.selection.mode!=='live'||rangeKey!==undefined&&tape.rangeKey!==rangeKey)return series;
    const summary=tape.accounting.moneySummary(series.sourceId,series.meterId,series.unit,this.tapeRange(tape,now));
    return summary?{...series,...summary}:series;
  }
  moneyWorkAt(source:string,now:number,rangeKey?:string){
    const tape=this.tapes.get('budget'),value=tape&&(tape.sourceEpoch??0)===this.sourceEpoch&&(tape.tape.fixed||!!this.sourceCurves||this.workRangeKey===tape.rangeKey&&!!this.work.value)&&(rangeKey===undefined||rangeKey===tape.rangeKey)?tape.accounting.moneyWorkSummary(source,this.tapeRange(tape,now)):undefined;
    return value&&this.selectedPending()?{...value,selectedWork:{from:now,activeMs:null,agentMs:0}}:value;
  }
  rangeAt(scope:PeriodScope,now:number,rangeKey?:string){const tape=this.tapes.get(scope);return tape&&(rangeKey===undefined||tape.rangeKey===rangeKey)?this.tapeRange(tape,now):null;}
  moneyOrderAt(now:number,rangeKey:string,readOrder?:(at:number)=>string) {
    const tape=this.tapes.get('budget');
    if(tape?.selection.mode!=='live'||tape.rangeKey!==rangeKey||evaluatedRange(tape.selection,now).from<tape.tape.from)return null;
    const boundary=(at:number)=>tape.accounting.changesAt(at,tape.selection.mode==='live'?tape.selection.periodMs:0);
    return readOrder?periodTextChangesAt(now,boundary,readOrder):boundary(now);
  }
  private workBoundary(now:number,refs?:readonly string[],source?:string) {
    if(!this.index||!this.workAdvances(now))return null;
    let next=Infinity;const period=this.workSelection.mode==='live'?this.workSelection.periodMs:0,selected=refs?new Set(refs):null;
    for(const [i,curve] of this.index.curves.contexts.entries())if((!selected||selected.has(this.index.trace.refs[i].ref))&&(!source||this.index.trace.refs[i].source===source))next=Math.min(next,curve.next(now-period)+period,curve.next(now));
    return Number.isFinite(next)?next:null;
  }
  workedAt(refs:readonly string[],fallback:number|null,now:number) {
    if(!refs.length||!this.index||this.workSelection.mode!=='live')return fallback;
    const range=this.workRange(now)!,selected=new Set(refs);
    return this.index.trace.refs.reduce((sum,ref,i)=>sum+(selected.has(ref.ref)?this.index!.curves.contexts[i].read(range):0),0);
  }
  workedChangesAt(refs:readonly string[],now:number,read:(now:number)=>string){return refs.length?periodTextChangesAt(now,at=>this.workBoundary(at,refs),read):null;}
  cellChangesAt(scope:PeriodScope,now:number,read:(now:number)=>string,extra?:(now:number)=>number|null,source?:string,rangeKey?:string){
    const tape=this.tapes.get(scope);if(!tape||tape.selection.mode!=='live'||rangeKey!==undefined&&tape.rangeKey!==rangeKey)return extra?.(now)??null;
    if(evaluatedRange(tape.selection,now).from<tape.tape.from)return null;
    const period=tape.selection.periodMs;
    return periodTextChangesAt(now,at=>{const next=Math.min(tape.accounting.changesAt(at,period,source)??Infinity,scope==='quota'?this.workBoundary(at,undefined,source)??Infinity:Infinity,extra?.(at)??Infinity);return Number.isFinite(next)?next:null;},read);
  }
  projectionState(history:History,scope:PeriodScope){const tape=this.tapes.get(scope),range=evaluatedRange(this.selection,this.evaluatedAt);return {ready:!!tape&&tape.queryKey===this.scopeKeys[scope]&&tape.rangeKey===history.range&&this.tapeCovers(tape,range),error:this.projectionErrors[scope]};}
  /** Native quota readiness cannot confirm a still-pending selected work answer. */
  activityProjectionState(history:History|null){
    const native=history?this.projectionState(history,'quota'):{ready:false,error:undefined};
    const error=this.workLimit?'filters_limit' as const:this.work.error==='history_limit'?'history_limit' as const:this.work.error?'history_failed' as const:native.error;
    return {ready:native.ready&&!this.work.loading&&!error&&!!this.work.value&&!!this.activity&&this.workRangeKey===history?.range,error,retired:!this.work.basis};
  }
  getSource=(id:string)=>this.rowsBySource.get(id)??noSessions;
  getWorkEvidence=()=>this.workEvidence;
  getValue=(id:string)=>this.values.get(id)??noValue;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  subscribeWorkOrder=(read:(rows:WorkedSession[])=>SessionOrder|null)=>{this.workOrders.add(read);this.scheduleClock();return()=>{this.workOrders.delete(read);this.scheduleClock();};};
  wakeCalendar=()=>{
    this.tickCalendar(hubNow(),true);
    this.scheduleClock();
  };
  private tickCalendar(now:number,checkZone=false){
    const generation=this.calendar.generation;this.calendar.tick(now,checkZone);
    if(generation!==this.calendar.generation&&this.calendar.needed){this.revision++;this.transport.change();}
  }
  refreshWorkClock=()=>{if(this.evaluatedAt!==hubNow())this.tick();else{this.retireExpired(hubNow());this.scheduleClock();}};
  subscribeSource=(id:string,listener:()=>void)=>{let set=this.sourceListeners.get(id);if(!set)this.sourceListeners.set(id,set=new Set());set.add(listener);return()=>{set!.delete(listener);};};
  subscribeValue=(id:string,listener:()=>void)=>{let set=this.valueListeners.get(id);if(!set)this.valueListeners.set(id,set=new Set());set.add(listener);return()=>{set!.delete(listener);};};
  private queryKey(query:HistoryQuery,scope?:PeriodScope){const board=page.get().board;return JSON.stringify([query.meters,query.unit,query.currency,query.work,scope==='quota'?query.sources??board?.lineup:scope&&board?.lineup.map(id=>[id,board.cards[id]?.budget])]);}
  private tapeCovers(entry:{tape:PeriodTape;selection:PeriodSelection},range:{from:number;to:number}) {
    const {tape,selection}=entry;
    // A complete fixed summary covers its requested endpoints, even when minute
    // rounding puts the right edge beyond the separate observation cut.
    if(tape.fixed)return this.selection.mode==='range'&&range.from===tape.fixed.range.from&&range.to===tape.fixed.range.to;
    // Each resource's accepted live evidence advances without a sessions reply.
    return range.from>=tape.from&&(range.to<=tape.cut||this.selection.mode==='live'&&selection.mode==='live');
  }
  private needsTape(scope:PeriodScope,key:string,range:{from:number;to:number}){const tape=this.tapes.get(scope);return this.dirtyScopes.has(scope)||!tape||tape.queryKey!==key||!this.tapeCovers(tape,range);}
  private queries(board:NonNullable<PageState['board']>,range:{from:number;to:number}) {
    const cell=cellOf(range.to-range.from),cards=board.lineup.flatMap(id=>board.cards[id]??[]);
    const queries:Partial<Record<PeriodScope,HistoryQuery>>={};
    for(const scope of PERIOD_SCOPES) {
      const visible=(scope==='quota'?[ACTIVITY,...QUOTA_WIDGETS]:scope==='funds'?[SUBSCRIPTION_FUNDS]:BUDGET_WIDGETS).some(id=>widgetVisible(board.view,id,board.lineup.length));if(!visible)continue;
      const meters=scope==='quota'?subscriptionSelection(cards,board.view):moneyReadSelection(cards,board.view,scope==='funds'?prefs().funds:prefs().money,board.currencies,scope==='funds'?'funds':'budget');
      const query:HistoryQuery={cell:String(cell),from:String(Math.floor(range.from/cell)*cell),to:String(Math.ceil(range.to/cell)*cell),cells:'skip',...(meters?{...(meters.sources?{sources:JSON.stringify(meters.sources)}:{}),unit:meters.unit,meters:JSON.stringify(meters.ids),...(meters.displayCurrency?{currency:meters.displayCurrency}:{}),...(meters.work?{work:'1'}:{})}:{})};
      queries[scope]=query;
    }
    return queries;
  }
  private intent():PeriodIntent|null {
    const board=page.get().board;if(!board||!this.active||!filtersReady())return null;
    const pending=!pan.get(),range=evaluatedRange(this.selection,hubNow()),queries=pending?this.queries(board,range):{},filters=effectiveFilters();
    // Native evidence and supplier work keep their queries when selected work cannot execute.
    const sourceNeeded=!!filters&&this.selection.mode==='live'&&!this.sourceTape;
    for(const scope of PERIOD_SCOPES)if(queries[scope]&&(this.projectionErrors[scope]&&!this.dirtyScopes.has(scope)||!this.needsTape(scope,this.queryKey(queries[scope]!,scope),range)&&!(sourceNeeded&&(scope==='quota'||queries[scope]?.work==='1'))))delete queries[scope];
    const request={version:1 as const,selection:this.selection,evaluatedAt:hubNow(),...queries,...(filters&&!this.workLimit?{workFilter:workFilter(filters)}:{}),
      ...(pending&&this.valuesNeeded&&this.selection.mode==='range'&&this.sourceIds.length?{values:this.sourceIds}:{}),
      ...(pending&&this.wantsWork&&this.workNeeded?{sessions:{...(this.cursor?{cursor:this.cursor}:{})}}:{}),
      ...(pending&&this.facetsDemand>0&&this.facetsNeeded?{facets:true as const}:{}),
      ...(!this.workLimit&&this.calendar.demand()?{calendar:this.calendar.demand()}:{}),
      ...(filters&&this.selection.mode==='live'&&(queries.quota||queries.budget?.work==='1')?{sourceWork:{...(this.sourceCursor?{cursor:this.sourceCursor}:{})}}:{})};
    return {board:board.id,generation:this.generation,resourceGeneration:this.resourceGeneration,facetGeneration:this.facetGeneration,calendarGeneration:this.calendar.generation,revision:this.revision,proofEpoch:this.proofEpoch,request};
  }
  private setValue(id:string,value:Reading<PeriodValues>){if(value.value&&value.basis&&value.basis.range.to>value.basis.evaluatedAt)value={...value,value:periodValueNow(value.value,Math.min(value.basis.range.to,hubNow()))};this.values.set(id,value);for(const listener of this.valueListeners.get(id)??[])listener();}
  private publishWork() {this.workState={...this.work,rows:this.workRows,evidence:this.workEvidence,...(this.workLimit?{loading:false,error:'filters_limit'}:{})};for(const listener of this.listeners)listener();}
  private retireWork() {
    this.calendar.clear(true);this.calendar.dirty();
    this.resetFacets();
    this.sourceEpoch++;
    this.sourceTape=null;this.sourceCurves=undefined;this.sourceCursor=undefined;
    this.retained.clear();preparations()?.cancel(this.preparationOwner);
    // Work evidence belongs to its captured attribution. Native financial values
    // retain their independent authority across the replacement.
    if(this.tapes.get('budget')?.tape.fixed?.moneyWork||this.tapes.get('budget')?.tape.money.some(group=>group.workCounter))this.dirtyScopes.add('budget');
    this.workEvidence++;this.retirementAt=Infinity;
    this.work=empty();this.cursor=undefined;this.index=null;this.activity=null;this.activityRetained=null;this.workProofEpoch=-1;
    this.tapes.delete('quota');delete this.projectionErrors.quota;this.transport.forgetEvidence('quota');
    this.workRows=[];
    const previous=this.rowsBySource;this.rowsBySource=new Map();for(const id of previous.keys())for(const listener of this.sourceListeners.get(id)??[])listener();
    this.work={...this.work,loading:this.wantsWork};this.publishWork();this.publishProjection(['quota','budget']);
    this.measureBytes();clock.due(this.watch,null,hubNow());
  }
  private retireFinancialValues() {
    this.generation++;this.revision++;this.resourceGeneration++;
    preparations()?.cancel(this.preparationOwner);
    this.valueCache.clear();this.retained.clear();this.valuesProofEpoch=-1;
    this.valuesNeeded=this.selection.mode==='range';
    for(const [id,reading] of this.values){
      const value=reading.value;
      if(!value)continue;
      // State replays may contain private amounts too. Native quota measurements
      // remain usable while the financial baseline is loading or unavailable.
      this.setValue(id,{...reading,value:{id:value.id,provider:value.provider,windows:value.windows,meters:value.meters.filter(m=>m.kind==='cap'&&m.id.startsWith('quota:')),keys:[],validFor:value.validFor},loading:this.valuesNeeded,error:null});
    }
    for(const scope of ['budget','funds'] as const){this.tapes.delete(scope);this.dirtyScopes.delete(scope);delete this.projectionErrors[scope];this.transport.forgetEvidence(scope);}
    this.measureBytes();this.publishProjection(['budget','funds']);
  }
  private clear() {
    this.calendar.clear();
    this.sourceTape=null;this.sourceCurves=undefined;this.sourceCursor=undefined;this.resetFacets();
    this.workEvidence++;this.retirementAt=Infinity;
    this.proofEpoch++;this.workProofEpoch=-1;this.valuesProofEpoch=-1;this.dirtyScopes.clear();
    this.retained.clear();this.cacheKey='';
    preparations()?.cancel(this.preparationOwner);this.transport.reset();this.work=empty();this.cursor=undefined;this.index=null;this.activity=null;this.activityRetained=null;this.tapes.clear();delete this.projectionErrors.quota;delete this.projectionErrors.budget;delete this.projectionErrors.funds;this.valueCache.clear();this.liveEvidence=false;this.bytes=0;this.workRows=[];this.publishProjection();
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
    const changedWork=this.workAuthority!==undefined&&board.workAuthority!==this.workAuthority;
    if(snapshot||!this.identity||event?.type==='hub'&&event.event.type==='history'&&event.event.data.workAuthority)this.workAuthority=board.workAuthority;
    const selected=timeRange(),selection:PeriodSelection=selected?{mode:'range',...selected}:{mode:'live',periodMs:periodOf(prefs().range).ms};
    const filters=effectiveFilters(),nextFilter=filters?JSON.stringify(workFilter(filters)):'';
    const selectedChanged=nextFilter!==this.filterKey;
    const sources=board.lineup.filter(id=>!filters||matchesSource(filters,id));
    const queries=this.queries(board,evaluatedRange(selection,hubNow()));
    this.workLimit=!!filters&&!executableWorkFilters(filters);
    const wantsWork=!this.workLimit&&(sources.length>0||[AGENTS,ACTIVITY].some(id=>widgetVisible(board.view,id,board.lineup.length)));
    const scopeKeys=Object.fromEntries(Object.entries(queries).map(([scope,query])=>[scope,this.queryKey(query,scope as PeriodScope)]));
    const changedScopes=PERIOD_SCOPES.filter(scope=>scopeKeys[scope]!==this.scopeKeys[scope]);
    const resourceIdentity=JSON.stringify([board.id,periodKey(selection),scopeKeys,board.workAuthority]);
    if(resourceIdentity!==this.resourceIdentity){this.resourceIdentity=resourceIdentity;this.resourceGeneration++;}
    const identity=JSON.stringify([board.id,periodKey(selection),wantsWork]);
    const authority=JSON.stringify([board.id]);
    if(authority!==this.authority){this.clear();this.authority=authority;}
    const financialIdentity=JSON.stringify([board.id,board.currencies?.target.id,board.currencies?.revision,board.lineup.map(id=>[id,board.cards[id]?.budget])]);
    const changedFinancial=!!this.financialIdentity&&financialIdentity!==this.financialIdentity;
    this.financialIdentity=financialIdentity;
    if(changedFinancial)this.retireFinancialValues();
    const calendarChanged=this.configureCalendar(widgetVisible(board.view,AGENT_HOURS_HEATMAP,board.lineup.length),JSON.stringify([board.id,board.workAuthority,nextFilter,this.workLimit]),hubNow(),this.workLimit,selection);
    if(calendarChanged){this.resetFacets();this.revision++;if(this.identity)this.transport.change();}
    const calendarEvent=event?.type==='hub'&&(event.event.type==='hello'||event.event.type==='snapshot'||event.event.type==='mine'||event.event.type==='lineup'||event.event.type==='history'&&(event.event.data.workSince!==undefined||event.event.data.changes?.some(c=>c.workSince!==undefined)));
    if(calendarEvent&&this.calendar.dirty()){this.revision++;this.invalidateFacets();this.transport.change();}
    if(event?.type==='hub'&&['history','hello','snapshot','mine','lineup'].includes(event.event.type))this.retained.clear();
    const cacheKey=JSON.stringify([identity,scopeKeys,nextFilter,financialIdentity]);
    if(cacheKey!==this.cacheKey){this.retainCurrent();this.cacheKey=cacheKey;}
    this.filterKey=nextFilter;
    this.selection=selection;this.sourceIds=sources;this.wantsWork=wantsWork;this.scopeKeys=scopeKeys;
    if(changedWork)this.retireWork();
    if(selectedChanged){
      this.invalidateFacets();
      this.generation++;this.revision++;preparations()?.cancel(this.preparationOwner);this.cursor=undefined;this.index=null;this.activity=null;this.activityRetained=null;
      this.workEvidence++;this.work={...empty(),loading:wantsWork};this.workRows=[];const oldSources=[...this.rowsBySource.keys()];this.rowsBySource.clear();for(const id of oldSources)for(const listener of this.sourceListeners.get(id)??[])listener();this.workNeeded=wantsWork;this.publishWork();
      if(selection.mode==='range')for(const scope of PERIOD_SCOPES)if(scopeKeys[scope])this.dirtyScopes.add(scope);
      this.transport.change();
      this.publishProjection(['quota','budget']);
    }
    if(identity!==this.identity) {
      this.resetFacets();
      const oldBoard=this.identity?JSON.parse(this.identity)[0]:null;
      this.identity=identity;this.generation++;this.revision++;
      this.workEvidence++;this.retirementAt=Infinity;
      this.dirtyScopes.clear();
      for(const scope of PERIOD_SCOPES)delete this.projectionErrors[scope];
      if(oldBoard!==board.id){this.clear();this.configureCalendar(widgetVisible(board.view,AGENT_HOURS_HEATMAP,board.lineup.length),JSON.stringify([board.id,board.workAuthority,nextFilter,this.workLimit]),hubNow(),this.workLimit,selection);}
      this.cacheKey=cacheKey;
      let cached=this.valueCache.get(periodKey(selection));
      if(!cached&&selection.mode==='range')cached=[...this.valueCache.values()].find(c=>sources.every(id=>hasPeriodValue(c.values.get(id)?.value,Math.min(selection.to,hubNow()))));
      const valueStaging={role:'visible' as const};
      if(cached&&!historyPool.reserve(valueStaging,cached.bytes))cached=undefined;
      this.valuesNeeded=selection.mode==='range'&&!cached;
      if(selection.mode==='range')for(const id of sources){const saved=cached?.values.get(id),value=periodValueAt(saved?.value,Math.min(selection.to,hubNow()));this.setValue(id,saved?{...saved,...(value?{value}:{}),basis:saved.basis?{...saved.basis,range:{from:selection.from,to:selection.to}}:null}:{...this.getValue(id),loading:true,error:null});}
      else {for(const id of this.values.keys())this.setValue(id,noValue);this.values.clear();}
      const range=evaluatedRange(selection,hubNow());
      if(this.tapes.size||this.work.value) {
        // Complete evidence belongs either to this target or to the shared LRU.
        // A fixed target replaces its raw ledger with exact summaries and edges.
        if(this.activity&&this.work.basis){
          const range=this.work.basis.range,summary=this.activity.summary(range,'source');
          this.activityRetained={...summary,by:{source:summary.by.source,project:this.activity.summary(range,'project').by.project,device:this.activity.summary(range,'device').by.device}};
        }
        preparations()?.cancel(this.preparationOwner);this.tapes.clear();this.cursor=undefined;this.index=null;this.activity=null;this.work={...this.work,value:null};this.liveEvidence=false;this.transport.forgetEvidence();
        clock.due(this.watch,null,hubNow());
      }
      // The previous target's supplier evidence now belongs to its evictable LRU
      // entry. Fixed summaries do not need a second visible copy of that ledger.
      this.sourceTape=null;this.sourceCurves=undefined;this.sourceCursor=undefined;
      this.bytes=JSON.stringify([...this.values.values()]).length*3+JSON.stringify(this.workRows).length*3+(this.activityRetained?JSON.stringify(this.activityRetained).length*3:0);
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
      for(const tape of this.tapes.values())if(this.tapeCovers(tape,range)){tape.selection=selection;tape.rangeKey=selection.mode==='range'?periodKey(selection):prefs().range;}
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
    if(changedFinancial)this.transport.change();
    if(event?.type==='connection'){this.tick();return;}
    if(event?.type==='hub') {
      const hub=event.event;
      if(hub.type==='hello'||hub.type==='snapshot'||hub.type==='mine'||hub.type==='lineup') {
        this.invalidateFacets();
        this.resourceGeneration++;
        this.generation++;this.revision++;if(hub.type==='hello'||changedWork||!this.index){this.cursor=undefined;this.workNeeded=wantsWork;}this.valuesNeeded=selection.mode==='range';

        if(hub.type==='snapshot'||hub.type==='hello')this.tick();
        this.transport.change();
      }else if(hub.type==='sessions'||hub.type==='unattributedSessions') {
        this.invalidateFacets();if(this.facetsDemand>0){this.revision++;this.transport.change();}
        this.tick();
      }else if(hub.type==='history') {
        const included=hub.data.sources.some(id=>sources.includes(id));
        if(included){this.proofEpoch++;this.valueCache.clear();}
        const own=hub.data.workSince!==undefined&&(selection.mode==='live'||hub.data.workSince<selection.to);
        const relevant=included&&(selection.mode==='live'||hub.data.since<selection.to)||own;
        if(relevant){
          this.resourceGeneration++;
          if(own)this.invalidateFacets();
          const {retired}=workChange(hub.data,sources,selection.mode==='live'?Infinity:selection.to);
          if(retired)this.retireWork();
          if(included&&selection.mode==='range')this.valuesNeeded=true;
          for(const scope of PERIOD_SCOPES){
            const visible=(scope==='quota'?[ACTIVITY,...QUOTA_WIDGETS]:scope==='funds'?[SUBSCRIPTION_FUNDS]:BUDGET_WIDGETS).some(id=>widgetVisible(board.view,id,board.lineup.length));
            if(!visible)continue;
            const selected=scope==='quota'?new Set(sources):new Set(moneyReadSelection(board.lineup.flatMap(id=>board.cards[id]??[]),board.view,scope==='funds'?prefs().funds:prefs().money,board.currencies,scope==='funds'?'funds':'budget')?.ids.map(([id])=>id));
            if(scope==='quota'&&own||(hub.data.changes?hub.data.changes.some(c=>selected.has(c.source)&&c.scope===(scope==='funds'?'budget':scope)&&(c.workSince===undefined||c.since<c.workSince||scope==='budget'&&JSON.parse(this.scopeKeys.budget??'[]')[3]==='1')&&(selection.mode==='live'||c.since<selection.to)):hub.data.sources.some(id=>selected.has(id))))this.dirtyScopes.add(scope);
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
    if(reply.calendar&&intent.board===page.get().board?.id){
      const staging={role:'visible' as const};
      try{this.calendar.receive(reply.calendar,intent.calendarGeneration??-1,reserve??(bytes=>historyPool.reserve(staging,bytes)));}
      finally{if(!reserve)historyPool.release(staging);}
      this.scheduleClock();
    }
    const next=this.receiving.then(()=>this.applyReply(reply,intent,reserve));
    this.receiving=next.catch(()=>{});return next;
  }
  private async applyReply(reply:PeriodReply,intent:PeriodIntent,transferred?:(bytes:number)=>boolean) {
    if(intent.generation!==this.generation||intent.revision!==this.revision)return;
    const proofEpoch=intent.proofEpoch??this.proofEpoch;
    if(!reply.values&&!reply.sessions&&!reply.facets&&!reply.sourceWork&&!PERIOD_SCOPES.some(scope=>reply[scope]?.state==='complete'?reply[scope].value.tape:reply[scope]?.state==='error'&&intent.request[scope]?.evidence!=='skip'))return;
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
    if(reply.facets?.state==='complete')try{charge('facets',this.facetBytes(reply.facets.value));}catch(error){if(error!==limited)throw error;reply.facets={state:'error',error:'history_limit'};}
    const priorWork=this.work.value,priorIndex=this.index,priorTapes=new Map(this.tapes);
    const previousSourceCurves=this.sourceCurves,previousSourceTape=this.sourceTape,sourceEpoch=this.sourceEpoch;
    let nextSourceTape=this.sourceTape,nextSourceCurves=previousSourceCurves,nextSourceCursor=this.sourceCursor;
    const filtered=!!effectiveFilters();
    const retainedFrom=intent.request.selection.mode==='live'?evaluatedRange(intent.request.selection,hubNow()).from:null;
    const queryKeyFor=(scope:PeriodScope)=>this.queryKey(intent.request[scope]!,scope);
    function* build():Preparation<{work:WorkTrace|null;index:PeriodIndex|null;activity:PeriodActivity|null;tapes:typeof priorTapes;edge:number}> {
      let sourcePart=reply.sourceWork;
      if(sourcePart){
        if(sourcePart.state==='error')nextSourceCurves={groups:{source:new Map()},knownFrom:Infinity,available:false};
        else try{
          let sourceBytes=JSON.stringify(sourcePart.value).length*3;
          charge('sourceWork',sourceBytes);
          const reserve=(bytes:number)=>{charge('sourceWork',sourceBytes+bytes);sourceBytes+=bytes;};
          const release=(bytes:number)=>{charge('sourceWork',sourceBytes-bytes);sourceBytes-=bytes;};
          const tape=sourcePart.state==='delta'&&nextSourceTape?mergeSourceWorkTape(nextSourceTape,sourcePart.value,reserve,release):sourcePart.value;
          const curves=sourceWorkCurves(tape,reserve,previousSourceTape&&previousSourceCurves?{tape:previousSourceTape,curves:previousSourceCurves}:undefined,release);
          nextSourceTape=tape;nextSourceCurves=curves;nextSourceCursor=sourcePart.value.cursor;
        }catch(error){if(error!==limited)throw error;nextSourceCurves={groups:{source:new Map()},knownFrom:Infinity,available:false};reply.sourceWork={state:'error',error:'history_limit'};discard('sourceWork');}
      }
      // Later preparation may pause; a rejected decoded body must be unreachable.
      sourcePart=undefined;
      const incomingTapes=new Map<PeriodScope,PeriodTape>();
      // Compact each decoded column before allocating work or accounting indexes.
      // Progress replaces reservations as scratch buffers become unreachable.
      for(const scope of PERIOD_SCOPES){const part=reply[scope],incoming=part?.state==='complete'?part.value.tape:undefined;if(!incoming)continue;
        const old=priorTapes.get(scope),queryKey=queryKeyFor(scope),previous=old?.queryKey===queryKey?old.tape:undefined;
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
          if(retainedFrom!==null){let scratch=0;const before=tapeBytes(ownTape(tape,previous));tape=yield*retention.retainTape(tape,retainedFrom,bytes=>{scratch+=bytes;charge(scope,before+scratch);},bytes=>{scratch-=bytes;charge(scope,before+scratch);});}
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
      try{if(workPart?.state==='complete'&&!priorWork)for(const group of priorTapes.get('budget')?.tape.money??[])if(group.workCounter&&!changedWork.has(group.source)){changedBytes+=64+group.source.length*2;charge('changedWork',changedBytes);changedWork.add(group.source);yield;}
      if(workPart&&workPart.state!=='error')for(const refs of [workPart.value.refs,...(workPart.state==='complete'||retired?[priorWork?.refs??[]]:[])])for(const ref of refs){if(ref.source&&!changedWork.has(ref.source)){changedBytes+=64+ref.source.length*2;charge('changedWork',changedBytes);changedWork.add(ref.source);}yield;}}
      catch(error){if(error!==limited)throw error;reply.sessions={state:'error',error:'history_limit'};work=priorWork;index=null;activity=null;changedWork.clear();discard('changedWork');discard('work');}
      if(reply.sourceWork)for(const curves of [previousSourceCurves,nextSourceCurves])for(const source of curves?.groups.source.keys()??[])if(reply.sourceWork.state==='error'||previousSourceCurves?.available!==nextSourceCurves?.available||previousSourceCurves?.knownFrom!==nextSourceCurves?.knownFrom||previousSourceCurves?.groups.source.has(source)!==nextSourceCurves?.groups.source.has(source)||!sameSourceWork(previousSourceTape,nextSourceTape,source))changedWork.add(source);
      const tapes=new Map(priorTapes);
      for(const scope of PERIOD_SCOPES){
        const old=tapes.get(scope),incoming=incomingTapes.get(scope);
        if(!incoming&&!((scope==='quota'||old?.tape.money.some(g=>g.workCounter&&changedWork.has(g.source)))&&old&&(index||reply.sourceWork)))continue;
        const queryKey=incoming?queryKeyFor(scope):old!.queryKey,tape=incoming??old!.tape;
        const base=staged.get(scope)??0;
        try{
          const accounting=yield*PeriodAccounting.prepare(tape,work,index?.curves??priorIndex?.curves,old?.accounting,changedWork,bytes=>charge(scope,base+bytes),filtered?nextSourceCurves??{groups:{source:new Map()},knownFrom:Infinity,available:false}:undefined);
          if(incoming){changed.add(scope);tapes.set(scope,{tape,accounting,generation:intent.generation,proofEpoch,sourceEpoch,selection:intent.request.selection,rangeKey:intent.request.selection.mode==='range'?periodKey(intent.request.selection):prefs().range,queryKey,basisRange:reply[scope]?.state==='complete'?reply[scope]!.basis.range:reply.basis.range});}
          else {tapes.set(scope,{...old!,accounting});changed.add(scope);}
        }catch(error){if(error!==limited)throw error;incomingTapes.delete(scope);failScope(scope);}
      }
      const edge=retainedFrom===null?Infinity:yield*retention.retirementEdge(work,[...tapes.values()].map(entry=>entry.tape),retainedFrom);
      return {work,index,activity,tapes,edge};
    }
    const valid=()=>intent.generation===this.generation&&intent.revision===this.revision;
    const prepared=await prepareAsync(this.preparationOwner,build(),valid).catch(error=>{release();throw error;});
    if(!prepared||!valid()){release();return;}
    for(const scope of PERIOD_SCOPES){const part=reply[scope];if(part){if(part.state==='error'){this.projectionErrors[scope]=part.error==='history_limit'?'history_limit':'history_failed';this.dirtyScopes.delete(scope);}else delete this.projectionErrors[scope];changed.add(scope);}}
    this.sourceTape=nextSourceTape;this.sourceCurves=nextSourceCurves;this.sourceCursor=nextSourceCursor;
    this.evaluatedAt=hubNow();this.tapes.clear();for(const [scope,tape] of prepared.tapes)this.tapes.set(scope,tape);
    const selectedFixedPending=PERIOD_SCOPES.filter(scope=>reply[scope]?.state==='complete'&&intent.request.selection.mode==='range'&&(scope==='quota'||scope==='budget'&&intent.request.budget?.work==='1')&&(JSON.stringify(intent.request.workFilter)??'')!==this.filterKey);
    for(const scope of PERIOD_SCOPES){const section=reply[scope];if(section?.state==='complete'&&section.value.tape){if(selectedFixedPending.includes(scope))this.dirtyScopes.add(scope);else this.dirtyScopes.delete(scope);}}
    const staleFacets=!!reply.facets&&intent.facetGeneration!==this.facetGeneration;
    if(reply.facets&&!staleFacets){const part=reply.facets;this.facetsNeeded=false;this.facetAt=intent.request.evaluatedAt;this.facetState=part.state==='complete'?{value:part.value,loading:false,error:null}:{value:null,loading:false,error:part.error};for(const listener of this.facetListeners)listener();}
    if(reply.values) {
      if(reply.values.state==='complete'){
        changed.add('quota');this.valuesNeeded=false;this.valuesProofEpoch=proofEpoch;for(const value of reply.values.value)this.setValue(value.id,{value,basis:reply.values.basis,loading:false,error:null});
      }
      else {this.valuesNeeded=false;for(const id of this.sourceIds)this.setValue(id,{...this.getValue(id),loading:false,error:reply.values.error});}
    }
    if(reply.sessions) {
      const section=reply.sessions;
      if(section.state==='error'){changed.add('quota');this.workNeeded=false;this.work={...this.work,loading:false,error:section.error};this.publishWork();}
      else {
        const value=prepared.work!;
        this.workEvidence++;
        this.cursor=section.value.cursor;this.workNeeded=false;this.liveEvidence ||= intent.request.selection.mode==='live';
        this.workProofEpoch=proofEpoch;
        this.workSelection=intent.request.selection;this.workRangeKey=this.workSelection.mode==='range'?periodKey(this.workSelection):prefs().range;
        this.work={value,basis:section.basis,loading:false,error:null};this.index=prepared.index;this.activity=prepared.activity;this.activityRetained=null;
        this.tick(false);
      }
    }
    this.measureBytes();
    release();
    this.publishProjection([...changed]);
    this.retirementAt=intent.request.selection.mode==='live'?prepared.edge+intent.request.selection.periodMs:Infinity;
    this.scheduleClock();
    // Source-wide summaries remain usable while direct hours or facet choices need
    // a newer reply. Reconsider even an already completed transport intent.
    if(selectedFixedPending.length||staleFacets&&this.facetsDemand>0)this.transport.retry();
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
      const sourceCurves=this.sourceCurves;
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
          let scratch=0;const tape=yield*retention.retainTape(entry.tape,from,bytes=>{scratch+=bytes;charge(scope,scratch);},bytes=>{scratch-=bytes;charge(scope,scratch);});
          if(tape!==entry.tape||(scope==='quota'||entry.tape.money.some(g=>g.workCounter))&&work!==previousWork){
            // Retention copies suffix containers; their immutable observations
            // still belong to the previous ledger. Its reservations own the new storage.
            const base=scratch;
            charge(scope,base);const accounting=yield*PeriodAccounting.prepare(tape,work,index?.curves,entry.accounting,changedWork,bytes=>charge(scope,base+bytes),sourceCurves);tapes.set(scope,{...entry,tape,accounting});
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
    // Decoding scratch has gone; retain the tape and the actual shared typed
    // buffers, as for the selected work index, rather than its construction maps.
    this.bytes=this.facetBytes()+(this.sourceTape?JSON.stringify(this.sourceTape).length*3:0)+(this.sourceCurves?.bytes??0)+JSON.stringify([...this.values.values()]).length*3+workBytes(this.work.value,this.index?.curves.bytes)+(this.work.value?0:JSON.stringify(this.workRows).length*3)+(this.activityRetained?JSON.stringify(this.activityRetained).length*3:0)+[...this.tapes.values()].reduce((sum,t)=>sum+tapeBytes(t.tape)+t.accounting.bytes,0);
  }
  /** The current stream is authoritative even while an older analytical reply is being prepared. */
  private present(rows:WorkedSession[]) {
    const board=page.get().board,live=new Map<string,{source:string|null;device:string;presence:NonNullable<WorkedSession['currentPresence']>}>();
    if(board?.presenceConfirmed){
      for(const [source,sessions] of Object.entries(board.sessions??{}))for(const session of sessions)if(session.presenceKey&&session.currentPresence)live.set(session.presenceKey,{source,device:session.device.id,presence:session.currentPresence});
      for(const session of board.unattributedSessions??[])if(session.presenceKey&&session.currentPresence)live.set(session.presenceKey,{source:null,device:session.device.id,presence:session.currentPresence});
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
    this.tickCalendar(now);
    if(now>=this.nativeDue&&this.selection.mode==='range'){
      const at=Math.min(this.selection.to,now);
      for(const [id,reading] of this.values)if(reading.value)this.setValue(id,{...reading,value:periodValueNow(reading.value,at)});
      this.publishProjection();
    }
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
      if(workGap)clock.due(this.watch,null,now);
    }
    this.evaluatedAt=now;
    for(const tape of this.tapes.values()){const range=evaluatedRange(tape.selection,now);if(range.from>=tape.tape.from)tape.basisRange=range;}
    const projected=this.index&&this.work.basis?this.index.advance(this.workRange(now)!,now):{rows:this.workRows,changed:false,limited:false};
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
    if(this.work.basis&&this.index&&this.workAdvances(now))this.work={...this.work,basis:{...this.work.basis,evaluatedAt:now,range:evaluatedRange(this.workSelection,now)}};
    if(changed||this.workState.loading!==this.work.loading||this.workState.error!==this.work.error||this.workSelection.mode==='range'&&!sameJson(this.workState.basis?.range,this.work.basis?.range))this.publishWork();
    if(!fromClock)this.publishProjection(['quota']);
    this.retireExpired(now);
    this.scheduleClock();
  }
  private scheduleClock(){
    const now=hubNow();
    const demands=this.active&&this.workAdvances(now)?[...this.workOrders].flatMap(read=>read(this.workRows)??[]):[];
    const orders=demands.flatMap(order=>order.worked??[]);
    const due=this.workAdvances(now)?this.index?.changesAt(now,this.workSelection.mode==='live'?this.workSelection.periodMs:0,orders)??null:null;
    const activityDue=this.workAdvances(now)?this.activity?.orderChangesAt(now,this.workSelection.mode==='live'?this.workSelection.periodMs:0,demands.flatMap(order=>order.activity?[order.activity]:[])):null;
    this.nativeDue=this.selection.mode==='range'&&this.selection.to>now?Math.min(this.selection.to,...[...this.values.values()].flatMap(reading=>reading.value?[periodValueChangesAt(reading.value,now)??Infinity]:[]),...PERIOD_SCOPES.map(scope=>this.projectionChangesAt(scope,now)??Infinity)):Infinity;
    const next=Math.min(this.nativeDue,this.calendar.nextAt(now),due??Infinity,activityDue??Infinity,this.retiring||pan.get()?Infinity:this.retirementAt);
    clock.due(this.watch,Number.isFinite(next)?next:null,now);
  }
  retryHistory(scope:PeriodScope){
    if(!this.projectionErrors[scope])return;
    delete this.projectionErrors[scope];this.dirtyScopes.add(scope);this.revision++;
    this.publishProjection([scope]);this.transport.retry();
  }
  retry=()=>{
    let needed=!!this.calendar.state.error&&this.calendar.dirty();
    if(this.work.error&&this.wantsWork){needed=this.workNeeded=true;this.work={...this.work,loading:true,error:null};this.publishWork();this.publishProjection(['quota']);}
    if(this.selection.mode==='range'&&[...this.values.values()].some(value=>value.error)){
      needed=this.valuesNeeded=true;for(const id of this.sourceIds)this.setValue(id,{...this.getValue(id),loading:true,error:null});
    }
    if(needed){this.revision++;this.transport.retry();}
  };
}

// Each context also belongs to three numerical group indexes (arrays of shared curve references).
const workBytes=(trace:WorkTrace|null,curves?:number)=>trace?JSON.stringify({...trace,spans:[],packed:undefined}).length*2+(trace.packed?trace.packed.blocks.length*8+trace.packed.patterns.reduce((n,p)=>n+p.length*8+32,0)+(curves??trace.packed.blocks.length/3*144+trace.packed.patterns.reduce((n,p)=>n+p.length*128,0)):trace.spans.length*640)+trace.refs.length*864:0;
const quotaTapeBytes=(series:PeriodTape['quota'][number],wire:boolean)=>JSON.stringify({...series,samples:[]}).length*2+(wire&&!('columns' in series.samples)?series.samples.length*8:sampleBytes(series.samples,series.samplesEncoding==='delta'));
const nativeBytes=(part:Pick<PeriodTape['money'][number],'readings'|'spans'>,shared?:PeriodTape['money'][number]['readings'])=>(part.readings===shared?0:part.readings.reduce((bytes,r)=>bytes+256+2*((r.amount?.length??0)+(r.unit?.length??0)+(r.label?.length??0)+(r.scope?.length??0)+(r.limit?.length??0)),0))+part.spans.length*192;
const tapeBytes=(tape:PeriodTape,wire=false)=>JSON.stringify({...tape,quota:tape.quota.map(s=>({...s,samples:[]})),money:tape.money.map(s=>({...s,readings:[],spans:[],...(s.paired?{paired:{readings:[],spans:[]}}:{}),...(s.workCounter?{workCounter:{...s.workCounter,readings:[],spans:[]}}:{})}))}).length*2+tape.quota.reduce((n,s)=>n+(wire&&!('columns' in s.samples)?s.samples.length*8:sampleBytes(s.samples,s.samplesEncoding==='delta')),0)+tape.money.reduce((n,s)=>n+nativeBytes(s)+(s.paired?nativeBytes(s.paired):0)+(s.workCounter?nativeBytes(s.workCounter,s.readings):0),0);

export const boardPeriod=new BoardPeriod();
export function followPeriod(){
  const stop=page.listen((event,state)=>boardPeriod.changed(event,state)),choose=()=>boardPeriod.changed(),wake=()=>boardPeriod.wakeCalendar();
  const stops=[stop,onDataFilters(choose),onPrefs(choose),onTimeRange(choose),pan.onPhase(()=>boardPeriod.refreshWorkClock())];
  if(typeof window!=='undefined')for(const name of ['focus','pageshow','visibilitychange']){
    const target=name==='visibilitychange'?document:window;target.addEventListener(name,wake);stops.push(()=>target.removeEventListener(name,wake));
  }
  choose();return()=>stops.forEach(stop=>stop());
}
export function usePeriodValues(id:string){return useSyncExternalStore(listener=>boardPeriod.subscribeValue(id,listener),()=>boardPeriod.getValue(id));}

const roster=(rows:readonly WorkedSession[])=>rows.map(({workedMs:_,...row})=>row);
const panelRoster=roster;
export function usePeriodSessions(order:(rows:WorkedSession[])=>SessionOrder|null=()=>null){
  const latest=useRef(order);latest.current=order;
  const [watch]=useState(()=>(rows:WorkedSession[])=>latest.current(rows));
  useLayoutEffect(()=>boardPeriod.subscribeWorkOrder(watch),[watch]);
  useLayoutEffect(()=>boardPeriod.refreshWorkClock());
  // Capture the order with its reading: union sorts also depend on the common clock,
  // so recomputing both old and new keys at the new time would hide a crossing.
  const [read]=useState(()=>selector(boardPeriod,()=>({select:({value:_value,...state})=>({...state,order:latest.current(state.rows)?.key}),equal:(a,b)=>a.evidence===b.evidence&&a.loading===b.loading&&a.error===b.error&&sameJson(panelRoster(a.rows),panelRoster(b.rows))&&sameJson(a.order,b.order)})));
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
