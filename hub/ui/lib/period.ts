import {moneySelection} from './moneySelection';
import {subscriptionSelection} from './subscription';
import {cellOf} from '../../server/domain/history';
import type {HistoryQuery} from '../../server/domain/periodRead';
import {prepareAsync,preparations,type Preparation} from './prepare';
import {useSyncExternalStore} from 'react';
import {evaluatedRange,periodKey,type PeriodBasis,type PeriodSelection} from '../../server/domain/period';
import type {PeriodValues} from '../../server/domain/periodValues';
import {mergeWorkPrepared,type WorkedSession,type WorkTrace} from '../../server/domain/periodWork';
import type {PeriodReply} from '../../server/domain/periodRead';
import {AGENTS,ACTIVITY,QUOTA_WIDGETS,BUDGET_WIDGETS,widgetVisible} from '../../server/domain/widgets';
import {PeriodTransport,fetchPeriod,type PeriodIntent} from './periodTransport';
import {PeriodIndex} from './periodIndex';
import {historyPool} from './historyPool';
import {page,type PageEvent,type PageState} from './board';
import {clock,hubNow} from './clock';
import {onPrefs,prefs} from './prefs';
import {periodOf} from './periods';
import {onTimeRange,timeRange} from './timeRange';
import {pan} from './pan';
import {sameJson} from './store';
import {UNAUTHORIZED} from './http';
import {mergeTapePrepared,type PeriodTape} from '../../server/domain/periodTape';
import {PeriodAccounting} from './periodAccounting';
import {PeriodActivity} from './periodActivity';
import type {History,HistoryScope} from '../../server/domain/history';

type Reading<T>={value:T|null;basis:PeriodBasis|null;loading:boolean;error:string|null};
const empty=<T>():Reading<T>=>({value:null,basis:null,loading:false,error:null});
const noValue=empty<PeriodValues>(),noSessions:WorkedSession[]=[];

class BoardPeriod {
  private active=false;
  private readonly preparationOwner={};
  private generation=0;
  private revision=0;
  private evaluatedAt=hubNow();
  private identity='';
  private selection:PeriodSelection={mode:'live',periodMs:86_400_000};
  private sourceIds:string[]=[];
  private wantsWork=false;
  private workNeeded=false;
  private liveEvidence=false;
  private valuesNeeded=false;
  private authority='';
  private readonly valueCache=new Map<string,{values:Map<string,Reading<PeriodValues>>;bytes:number;at:number}>();
  private readonly values=new Map<string,Reading<PeriodValues>>();
  private readonly valueListeners=new Map<string,Set<()=>void>>();
  private work:Reading<WorkTrace>=empty();
  private cursor:string|undefined;
  private index:PeriodIndex|null=null;
  private workSelection:PeriodSelection=this.selection;
  private workRangeKey='24h';
  private activity:PeriodActivity|null=null;
  private readonly tapes=new Map<HistoryScope,{tape:PeriodTape;accounting:PeriodAccounting;generation:number;selection:PeriodSelection;rangeKey:string;queryKey:string}>();
  private readonly projectionRevision={quota:0,budget:0};
  private readonly projectionErrors:Partial<Record<HistoryScope,'history_limit'|'history_failed'>>={};
  private readonly projectionListeners={quota:new Set<()=>void>(),budget:new Set<()=>void>()};
  private workRows:WorkedSession[]=[];
  private rowsBySource=new Map<string,WorkedSession[]>();
  private listeners=new Set<()=>void>();
  private sourceListeners=new Map<string,Set<()=>void>>();
  private workState={...this.work,rows:this.workRows};
  private readonly watch=clock.watch();
  private bytes=0;
  readonly transport=new PeriodTransport(historyPool,()=>this.intent(),(reply,intent)=>this.receive(reply,intent),fetchPeriod,()=>{page.dispatch({type:'board-close'});if(typeof window!=='undefined')window.dispatchEvent(new Event(UNAUTHORIZED));});
  constructor(){historyPool.register(this);clock.subscribe(this.watch,()=>this.tick());}
  get estimatedBytes(){return this.bytes+[...this.valueCache.values()].reduce((sum,c)=>sum+c.bytes,0);}
  evictionCandidates(){return [...this.valueCache].map(([key,c])=>({bytes:c.bytes,shownAt:c.at,drop:()=>{this.valueCache.delete(key);}}));}
  get=()=>this.workState;
  getProjectionRevision=(scope:HistoryScope)=>this.projectionRevision[scope];
  subscribeProjection=(scope:HistoryScope,listener:()=>void)=>{this.projectionListeners[scope].add(listener);return()=>{this.projectionListeners[scope].delete(listener);};};
  private publishProjection(scopes:readonly HistoryScope[]=['quota','budget']){for(const scope of scopes){this.projectionRevision[scope]++;for(const listener of this.projectionListeners[scope])listener();}}
  project(history:History,scope:HistoryScope) {
    const tape=this.tapes.get(scope),now=this.evaluatedAt;
    let result=history;
    if(tape?.rangeKey===history.range){const range=evaluatedRange(tape.selection,now),values=new Map<string,PeriodValues>();if(tape.selection.mode==='range')for(const [id,reading] of this.values)if(reading.value&&reading.basis?.range.to===range.to)values.set(id,reading.value);result=tape.accounting.project(history,range,values);}
    if(scope==='quota'&&this.activity&&this.workRangeKey===history.range&&this.work.basis)result={...result,since:this.work.basis.range.from,to:this.work.basis.range.to,activity:this.activity.project(history.activity,this.work.basis.range)};
    return result;
  }
  projectionState(history:History,scope:HistoryScope){const tape=this.tapes.get(scope),range=evaluatedRange(this.selection,this.evaluatedAt);return {ready:!!tape&&tape.rangeKey===history.range&&range.from>=tape.tape.from&&(range.to<=tape.tape.cut||this.selection.mode==='live'&&this.liveEvidence),error:this.projectionErrors[scope]};}
  getSource=(id:string)=>this.rowsBySource.get(id)??noSessions;
  getValue=(id:string)=>this.values.get(id)??noValue;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  subscribeSource=(id:string,listener:()=>void)=>{let set=this.sourceListeners.get(id);if(!set)this.sourceListeners.set(id,set=new Set());set.add(listener);return()=>{set!.delete(listener);};};
  subscribeValue=(id:string,listener:()=>void)=>{let set=this.valueListeners.get(id);if(!set)this.valueListeners.set(id,set=new Set());set.add(listener);return()=>{set!.delete(listener);};};
  private intent():PeriodIntent|null {
    const board=page.get().board;if(!board||!this.active)return null;
    const pending=!pan.get();
    const range=evaluatedRange(this.selection,hubNow()),cell=cellOf(range.to-range.from),cards=board.lineup.flatMap(id=>board.cards[id]??[]);
    const queries:Partial<Record<HistoryScope,HistoryQuery>>={};
    if(pending)for(const scope of ['quota','budget'] as const) {
      const visible=(scope==='quota'?[ACTIVITY,...QUOTA_WIDGETS]:BUDGET_WIDGETS).some(id=>widgetVisible(board.view,id,board.lineup.length));if(!visible)continue;
      const meters=scope==='quota'?subscriptionSelection(cards,board.view):moneySelection(cards,board.view.hidden,prefs().money,board.currencies).selection;
      const query:HistoryQuery={cell:String(cell),from:String(Math.floor(range.from/cell)*cell),to:String(Math.ceil(range.to/cell)*cell),cells:'skip',...(meters?{unit:meters.unit,meters:JSON.stringify(meters.ids),...(meters.displayCurrency?{currency:meters.displayCurrency}:{})}:{})};
      const key=JSON.stringify([query.meters,query.unit,query.currency]),tape=this.tapes.get(scope);
      if(this.projectionErrors[scope]||!tape||tape.queryKey!==key||range.from<tape.tape.from||range.to>tape.tape.cut&&!this.liveEvidence)queries[scope]=query;
    }
    return {board:board.id,generation:this.generation,revision:this.revision,request:{version:1,selection:this.selection,evaluatedAt:hubNow(),...queries,...(pending&&this.valuesNeeded&&this.selection.mode==='range'&&this.sourceIds.length?{values:this.sourceIds}:{}),...(pending&&this.wantsWork&&this.workNeeded?{sessions:{...(this.cursor?{cursor:this.cursor}:{})}}:{})}};
  }
  private setValue(id:string,value:Reading<PeriodValues>){this.values.set(id,value);for(const listener of this.valueListeners.get(id)??[])listener();}
  private publishWork() {this.workState={...this.work,rows:this.workRows};for(const listener of this.listeners)listener();}
  private clear() {
    preparations()?.cancel(this.preparationOwner);this.transport.reset();this.work=empty();this.cursor=undefined;this.index=null;this.activity=null;this.tapes.clear();delete this.projectionErrors.quota;delete this.projectionErrors.budget;this.valueCache.clear();this.liveEvidence=false;this.bytes=0;this.workRows=[];this.publishProjection();
    for(const id of this.values.keys())this.setValue(id,noValue);this.values.clear();
    const previous=this.rowsBySource;this.rowsBySource=new Map();for(const id of previous.keys())for(const listener of this.sourceListeners.get(id)??[])listener();
    this.publishWork();clock.due(this.watch,null,hubNow());
  }
  activate(active:boolean){if(this.active===active)return;this.active=active;if(!active){this.clear();this.identity='';}else this.changed();}
  changed(event?:PageEvent,state:PageState=page.get()) {
    const board=state.board;
    if(!board||event?.type==='board-close'){this.identity='';this.generation++;this.clear();return;}
    if(!this.active)return;
    const selected=timeRange(),selection:PeriodSelection=selected?{mode:'range',...selected}:{mode:'live',periodMs:periodOf(prefs().range).ms};
    const sources=board.lineup.filter(id=>!board.view.hidden.includes('source:'+id));
    const wantsWork=sources.length>0||[AGENTS,ACTIVITY].some(id=>widgetVisible(board.view,id,board.lineup.length));
    const identity=JSON.stringify([board.id,periodKey(selection),sources,wantsWork,board.currencies?.target.id,board.currencies?.revision,board.currencies?.registryRevision]);
    const authority=JSON.stringify([board.id,sources,wantsWork,board.currencies?.target.id,board.currencies?.revision,board.currencies?.registryRevision]);
    if(authority!==this.authority){this.clear();this.authority=authority;}
    this.selection=selection;this.sourceIds=sources;this.wantsWork=wantsWork;
    if(identity!==this.identity) {
      const oldBoard=this.identity?JSON.parse(this.identity)[0]:null;
      this.identity=identity;this.generation++;this.revision++;
      if(oldBoard!==board.id||event?.type==='hub'&&['mine','lineup'].includes(event.event.type))this.clear();
      let cached=this.valueCache.get(periodKey(selection));
      if(!cached&&selection.mode==='range')cached=[...this.valueCache.values()].find(c=>sources.every(id=>{const interval=c.values.get(id)?.value?.validFor;return interval&&interval.from<=selection.to&&selection.to<interval.to;}));
      this.valuesNeeded=selection.mode==='range'&&!cached;
      if(selection.mode==='range')for(const id of sources){const saved=cached?.values.get(id);this.setValue(id,saved?{...saved,basis:saved.basis?{...saved.basis,range:{from:selection.from,to:selection.to}}:null}:{...this.getValue(id),loading:true,error:null});}
      else {for(const id of this.values.keys())this.setValue(id,noValue);this.values.clear();}
      const range=evaluatedRange(selection,hubNow());
      this.workNeeded=wantsWork&&(!this.work.value||range.from<this.work.value.anchor||range.to>(this.work.value.cut??0)&&!this.liveEvidence);
      if(!this.workNeeded&&this.work.basis){this.workSelection=selection;this.workRangeKey=selection.mode==='range'?periodKey(selection):prefs().range;this.tick(false);}
      for(const tape of this.tapes.values())if(range.from>=tape.tape.from&&(range.to<=tape.tape.cut||this.liveEvidence)){tape.selection=selection;tape.rangeKey=selection.mode==='range'?periodKey(selection):prefs().range;}
      this.work={...this.work,loading:this.workNeeded,error:null};this.publishWork();this.publishProjection();
      this.transport.change();return;
    }
    if(!this.active)return;
    if(event?.type==='hub') {
      const hub=event.event;
      if(hub.type==='hello'||hub.type==='snapshot'||hub.type==='mine'||hub.type==='lineup') {
        this.generation++;this.revision++;this.cursor=undefined;this.workNeeded=wantsWork;this.valuesNeeded=selection.mode==='range';
        if(hub.type==='mine'||hub.type==='lineup')this.clear();
        this.transport.change();
      }else if(hub.type==='history') {
        const relevant=hub.data.sources.some(id=>sources.includes(id))&&(selection.mode==='live'||hub.data.since<selection.to);
        if(relevant){this.valueCache.clear();if(selection.mode==='range')this.valuesNeeded=true;const work=hub.data.changes?.some(c=>sources.includes(c.source)&&c.workSince!==undefined)??true;if(work)this.workNeeded=wantsWork;this.revision++;this.transport.change();}
      }
    }
  }
  private async receive(reply:PeriodReply,intent:PeriodIntent) {
    if(intent.generation!==this.generation||intent.revision!==this.revision)return;
    const changed=new Set<HistoryScope>();
    const staging={role:'visible' as const};
    // Keep the previous complete presentation if the new evidence cannot fit.
    // Charge decoded dictionaries and all derived prefixes before building them.
    const workBytes=(trace:WorkTrace|null)=>trace?JSON.stringify(trace).length*2+trace.spans.length*640+trace.refs.length*768:0;
    const tapeBytes=(tape:PeriodTape)=>JSON.stringify(tape).length*2+tape.quota.reduce((n,s)=>n+s.samples.length*192,0)+tape.money.reduce((n,s)=>n+s.readings.length*256+s.spans.length*192,0);
    let projected=0;
    const admit=(bytes:number)=>{if(!historyPool.reserve(staging,projected+bytes))return false;projected+=bytes;return true;};
    const prefixes=(tape:PeriodTape|undefined)=>tape?tape.quota.reduce((n,s)=>n+s.samples.length*128,0)+tape.money.reduce((n,s)=>n+s.readings.length*192+s.spans.length*96,0):0;
    for(const scope of ['quota','budget'] as const){const part=reply[scope];if(part?.state==='complete'&&part.value.tape&&!admit(tapeBytes(part.value.tape)+prefixes(this.tapes.get(scope)?.tape)))reply[scope]={state:'error',error:'history_limit'};}
    const workPreparation=workBytes(this.work.value)+(reply.quota?.state==='complete'&&reply.quota.value.tape?0:prefixes(this.tapes.get('quota')?.tape));
    if(reply.sessions&&reply.sessions.state!=='error'&&!admit(workBytes(reply.sessions.value)+workPreparation))reply.sessions={state:'error',error:'history_limit'};
    if(reply.values?.state==='complete'&&!admit(JSON.stringify(reply.values.value).length*6))reply.values={state:'error',error:'history_limit'};
    const priorWork=this.work.value,priorTapes=new Map(this.tapes);
    function* build():Preparation<{work:WorkTrace|null;index:PeriodIndex|null;activity:PeriodActivity|null;tapes:typeof priorTapes}> {
      const part=reply.sessions;
      const work=part&&part.state!=='error'?(part.state==='delta'&&priorWork?yield* mergeWorkPrepared(priorWork,part.value):part.value):priorWork;
      yield;
      const index=part&&part.state!=='error'&&work?yield* PeriodIndex.prepare(work):null;
      const activity=part&&part.state!=='error'&&work?yield* PeriodActivity.prepare(work):null;
      const tapes=new Map(priorTapes);
      for(const scope of ['quota','budget'] as const){
        const part=reply[scope],old=tapes.get(scope),incoming=part?.state==='complete'?part.value.tape:undefined;
        if(!incoming&&!(scope==='quota'&&old&&index))continue;
        const queryKey=JSON.stringify([intent.request[scope]?.meters,intent.request[scope]?.unit,intent.request[scope]?.currency]);
        const tape=incoming?yield* mergeTapePrepared(old?.queryKey===queryKey?old.tape:undefined,incoming):old!.tape;
        const accounting=yield* PeriodAccounting.prepare(tape,work);
        if(incoming){changed.add(scope);tapes.set(scope,{tape,accounting,generation:intent.generation,selection:intent.request.selection,rangeKey:intent.request.selection.mode==='range'?periodKey(intent.request.selection):prefs().range,queryKey});}
        else tapes.set(scope,{...old!,accounting});
      }
      return {work,index,activity,tapes};
    }
    const valid=()=>intent.generation===this.generation&&intent.revision===this.revision;
    const prepared=await prepareAsync(this.preparationOwner,build(),valid).catch(error=>{historyPool.release(staging);throw error;});
    if(!prepared||!valid()){historyPool.release(staging);return;}
    for(const scope of ['quota','budget'] as const){const part=reply[scope];if(part){if(part.state==='error')this.projectionErrors[scope]=part.error==='history_limit'?'history_limit':'history_failed';else delete this.projectionErrors[scope];changed.add(scope);}}
    this.evaluatedAt=hubNow();this.tapes.clear();for(const [scope,tape] of prepared.tapes)this.tapes.set(scope,tape);
    if(reply.values) {
      if(reply.values.state==='complete'){
        changed.add('quota');this.valuesNeeded=false;for(const value of reply.values.value)this.setValue(value.id,{value,basis:reply.values.basis,loading:false,error:null});
        const values=new Map(this.values);this.valueCache.set(periodKey(intent.request.selection),{values,bytes:JSON.stringify([...values]).length*3,at:hubNow()});
      }
      else for(const id of this.sourceIds)this.setValue(id,{...this.getValue(id),loading:false,error:reply.values.error});
    }
    if(reply.sessions) {
      const section=reply.sessions;
      if(section.state==='error'){this.work={...this.work,loading:false,error:section.error};this.publishWork();}
      else {
        const value=prepared.work!;
        this.cursor=section.value.cursor;this.workNeeded=false;this.liveEvidence ||= intent.request.selection.mode==='live';
        this.workSelection=intent.request.selection;this.workRangeKey=this.workSelection.mode==='range'?periodKey(this.workSelection):prefs().range;
        this.work={value,basis:section.basis,loading:false,error:null};this.index=prepared.index;this.activity=prepared.activity;
        this.tick(false);
      }
    }
    this.bytes=JSON.stringify([...this.values.values()]).length*3+workBytes(this.work.value)+[...this.tapes.values()].reduce((sum,t)=>sum+tapeBytes(t.tape),0);
    historyPool.release(staging);
    this.publishProjection([...changed]);
    this.scheduleClock();
  }
  private tick(fromClock=true) {
    if(!this.active)return;
    if(!this.index||!this.work.basis){this.evaluatedAt=hubNow();this.publishProjection([...this.tapes].filter(([,t])=>t.selection.mode==='live').map(([scope])=>scope));this.scheduleClock();return;}
    const now=this.evaluatedAt=hubNow(),range=evaluatedRange(this.workSelection,now),projected=this.index.advance(range,now);
    if(projected.limited){this.work={...this.work,error:'history_range_invalid'};this.publishWork();clock.due(this.watch,null,now);return;}
    if(projected.changed) {
      this.workRows=projected.rows;
      this.activity?.update(this.workRows);
      const next=new Map<string,WorkedSession[]>();
      for(const row of this.workRows){let list=next.get(row.source);if(!list)next.set(row.source,list=[]);list.push(row);}
      const old=this.rowsBySource;this.rowsBySource=next;
      for(const id of new Set([...old.keys(),...next.keys()])) {
        if(sameJson(old.get(id)??[],next.get(id)??[])){if(old.has(id))next.set(id,old.get(id)!);continue;}
        for(const listener of this.sourceListeners.get(id)??[])listener();
      }
    }
    this.work={...this.work,basis:{...this.work.basis,evaluatedAt:now,range}};
    if(projected.changed||this.workState.value!==this.work.value||this.workState.loading!==this.work.loading||this.workState.error!==this.work.error||this.workSelection.mode==='range'&&!sameJson(this.workState.basis?.range,range))this.publishWork();
    this.publishProjection(['quota']);
    if(fromClock&&this.tapes.get('budget')?.selection.mode==='live')this.publishProjection(['budget']);
    this.scheduleClock();
  }
  private scheduleClock(){
    const now=hubNow();
    let due=this.workSelection.mode==='live'?this.index?.changesAt(now,this.workSelection.periodMs)??null:this.index?.presenceChangesAt()??null;
    for(const tape of this.tapes.values())if(tape.selection.mode==='live'){const at=tape.accounting.changesAt(now,tape.selection.periodMs);if(at!==null)due=Math.min(due??Infinity,at);}
    clock.due(this.watch,due!==null&&Number.isFinite(due)?due:null,now);
  }
  retry=()=>{this.revision++;this.workNeeded=this.wantsWork;this.valuesNeeded=this.selection.mode==='range';this.transport.retry();};
}

export const boardPeriod=new BoardPeriod();
export function followPeriod(){const stop=page.listen((event,state)=>boardPeriod.changed(event,state));const choose=()=>boardPeriod.changed();const stops=[stop,onPrefs(choose),onTimeRange(choose)];choose();return()=>stops.forEach(stop=>stop());}
export function usePeriodValues(id:string){return useSyncExternalStore(listener=>boardPeriod.subscribeValue(id,listener),()=>boardPeriod.getValue(id));}
export function usePeriodSessions(){return useSyncExternalStore(boardPeriod.subscribe,boardPeriod.get);}
export function useSourcePeriodSessions(id:string){return useSyncExternalStore(listener=>boardPeriod.subscribeSource(id,listener),()=>boardPeriod.getSource(id));}
