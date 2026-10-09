import {moneySelection} from './moneySelection';
import {subscriptionSelection} from './subscription';
import {cellOf} from '../../server/domain/history';
import {PERIOD_SCOPES,type PeriodScope,type HistoryQuery} from '../../server/domain/periodRead';
import {prepareAsync,preparations,type Preparation} from './prepare';
import {useSyncExternalStore} from 'react';
import {evaluatedRange,periodKey,type PeriodBasis,type PeriodSelection} from '../../server/domain/period';
import type {PeriodValues} from '../../server/domain/periodValues';
import {mergeWorkPrepared,packWorkPrepared,type WorkedSession,type WorkTrace} from '../../server/domain/periodWork';
import type {PeriodReply} from '../../server/domain/periodRead';
import {AGENTS,ACTIVITY,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,widgetVisible} from '../../server/domain/widgets';
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
import {retainSamplesPrepared,sampleBytes,mergeTapePrepared,type PeriodTape} from '../../server/domain/periodTape';
import {PeriodAccounting} from './periodAccounting';
import {PeriodActivity} from './periodActivity';
import type {History} from '../../server/domain/history';
import {canShift,shifted} from '../../server/domain/periodShift';

type Reading<T>={value:T|null;basis:PeriodBasis|null;loading:boolean;error:string|null};
const empty=<T>():Reading<T>=>({value:null,basis:null,loading:false,error:null});
const noValue=empty<PeriodValues>(),noSessions:WorkedSession[]=[];

class BoardPeriod {
  private active=false;
  private readonly preparationOwner={};
  private receiving=Promise.resolve();
  private generation=0;
  private revision=0;
  private proofEpoch=0;
  private workProofEpoch=-1;
  private readonly dirtyScopes=new Set<PeriodScope>();
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
  private readonly tapes=new Map<PeriodScope,{tape:PeriodTape;accounting:PeriodAccounting;generation:number;proofEpoch:number;selection:PeriodSelection;rangeKey:string;queryKey:string}>();
  private readonly projectionRevision={quota:0,budget:0,funds:0};
  private readonly projectionErrors:Partial<Record<PeriodScope,'history_limit'|'history_failed'>>={};
  private readonly projectionListeners={quota:new Set<()=>void>(),budget:new Set<()=>void>(),funds:new Set<()=>void>()};
  private workRows:WorkedSession[]=[];
  private rowsBySource=new Map<string,WorkedSession[]>();
  private listeners=new Set<()=>void>();
  private sourceListeners=new Map<string,Set<()=>void>>();
  private workState={...this.work,rows:this.workRows};
  private readonly watch=clock.watch();
  private bytes=0;
  private cacheKey='';
  private readonly retained=new Map<string,{bytes:number;at:number;fits:(selection:PeriodSelection)=>boolean;restore:(selection:PeriodSelection)=>void}>();
  readonly transport=new PeriodTransport(historyPool,()=>this.intent(),(reply,intent,reserve)=>this.receive(reply,intent,reserve),fetchPeriod,()=>{page.dispatch({type:'board-close'});if(typeof window!=='undefined')window.dispatchEvent(new Event(UNAUTHORIZED));});
  constructor(){historyPool.register(this);clock.subscribe(this.watch,()=>this.tick());}
  get estimatedBytes(){return this.bytes+[...this.valueCache.values(),...this.retained.values()].reduce((sum,c)=>sum+c.bytes,0);}
  evictionCandidates(){return [...this.valueCache].map(([key,c])=>({bytes:c.bytes,shownAt:c.at,drop:()=>{this.valueCache.delete(key);}})).concat([...this.retained].map(([key,c])=>({bytes:c.bytes,shownAt:c.at,drop:()=>{this.retained.delete(key);}})));}
  private retainCurrent(){
    if(!this.cacheKey)return;
    const wanted=this.intent()?.request;
    if(!wanted||this.workNeeded||this.work.loading||this.work.error||this.valuesNeeded||PERIOD_SCOPES.some(scope=>wanted[scope]||this.projectionErrors[scope]))return;
    const tapes=new Map([...this.tapes].map(([scope,tape])=>[scope,{...tape}])),work=this.work,index=this.index,activity=this.activity,workSelection=this.workSelection,workRangeKey=this.workRangeKey,cursor=this.cursor,liveEvidence=this.liveEvidence,values=new Map(this.values),cursors=this.transport.evidence(),bytes=this.bytes;
    const context=JSON.stringify([this.authority,prefs().money,prefs().funds,prefs().kind]);
    const workProofEpoch=this.workProofEpoch,reusable=workProofEpoch===this.proofEpoch&&[...tapes.values()].every(t=>t.proofEpoch===this.proofEpoch);
    this.retained.set(this.cacheKey,{bytes:bytes+this.cacheKey.length*2+context.length*2+256,at:hubNow(),fits:selection=>reusable&&selection.mode==='range'&&work.value?.fixed!==undefined&&canShift(work.value.fixed,selection)&&context===JSON.stringify([this.authority,prefs().money,prefs().funds,prefs().kind])&&[...tapes.values()].every(({tape})=>tape.fixed&&canShift(tape.fixed,selection))&&[...values.values()].every(v=>v.value?.validFor&&v.value.validFor.from<=selection.to&&selection.to<v.value.validFor.to),restore:selection=>{
      this.tapes.clear();for(const [scope,tape] of tapes)this.tapes.set(scope,tape);
      this.work=work;this.index=index;this.activity=activity;this.workSelection=workSelection;this.workRangeKey=workRangeKey;this.cursor=cursor;this.liveEvidence=liveEvidence;this.bytes=bytes;
      for(const id of new Set([...this.values.keys(),...values.keys()]))this.setValue(id,values.get(id)??noValue);
      if(selection.mode==='range'&&workSelection.mode==='range'&&periodKey(selection)!==periodKey(workSelection)){
        const value={...work.value!,fixed:shifted(work.value!.fixed!,selection)!};
        this.work={...work,value,basis:work.basis?{...work.basis,range:selection}:null};this.index=new PeriodIndex(value);this.activity=new PeriodActivity(value,this.index.curves);
        this.workSelection=selection;this.workRangeKey=periodKey(selection);
        for(const [scope,entry] of tapes){const tape={...entry.tape,fixed:shifted(entry.tape.fixed!,selection)!};this.tapes.set(scope,{...entry,tape,accounting:new PeriodAccounting(tape,value),selection,rangeKey:periodKey(selection)});}
        for(const [id,reading] of values)this.setValue(id,{...reading,basis:reading.basis?{...reading.basis,range:selection}:null});
      }
      this.transport.restoreEvidence(cursors);this.workNeeded=false;this.valuesNeeded=false;
      this.workProofEpoch=workProofEpoch;
    }});
  }
  get=()=>this.workState;
  getProjectionRevision=(scope:PeriodScope)=>this.projectionRevision[scope];
  subscribeProjection=(scope:PeriodScope,listener:()=>void)=>{this.projectionListeners[scope].add(listener);return()=>{this.projectionListeners[scope].delete(listener);};};
  private publishProjection(scopes:readonly PeriodScope[]=PERIOD_SCOPES){for(const scope of scopes){this.projectionRevision[scope]++;for(const listener of this.projectionListeners[scope])listener();}}
  project(history:History,scope:PeriodScope) {
    const tape=this.tapes.get(scope),now=this.evaluatedAt;
    let result=history;
    if(tape?.rangeKey===history.range){const range=evaluatedRange(tape.selection,now),values=new Map<string,PeriodValues>();if(tape.selection.mode==='range')for(const [id,reading] of this.values)if(reading.value&&reading.basis?.range.to===range.to)values.set(id,reading.value);result=tape.accounting.project(history,range,values);}
    if(scope==='quota'&&this.activity&&this.workRangeKey===history.range&&this.work.basis)result={...result,since:this.work.basis.range.from,to:this.work.basis.range.to,activity:this.activity.project(history.activity,this.work.basis.range)};
    return result;
  }
  projectionState(history:History,scope:PeriodScope){const tape=this.tapes.get(scope),range=evaluatedRange(this.selection,this.evaluatedAt);return {ready:!!tape&&tape.rangeKey===history.range&&range.from>=tape.tape.from&&(range.to<=tape.tape.cut||this.selection.mode==='live'&&this.liveEvidence),error:this.projectionErrors[scope]};}
  getSource=(id:string)=>this.rowsBySource.get(id)??noSessions;
  getValue=(id:string)=>this.values.get(id)??noValue;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  subscribeSource=(id:string,listener:()=>void)=>{let set=this.sourceListeners.get(id);if(!set)this.sourceListeners.set(id,set=new Set());set.add(listener);return()=>{set!.delete(listener);};};
  subscribeValue=(id:string,listener:()=>void)=>{let set=this.valueListeners.get(id);if(!set)this.valueListeners.set(id,set=new Set());set.add(listener);return()=>{set!.delete(listener);};};
  private intent():PeriodIntent|null {
    const board=page.get().board;if(!board||!this.active)return null;
    const pending=!pan.get();
    const range=evaluatedRange(this.selection,hubNow()),cell=cellOf(range.to-range.from),cards=board.lineup.flatMap(id=>board.cards[id]??[]);
    const queries:Partial<Record<PeriodScope,HistoryQuery>>={};
    if(pending)for(const scope of PERIOD_SCOPES) {
      const visible=(scope==='quota'?[ACTIVITY,...QUOTA_WIDGETS]:scope==='funds'?[SUBSCRIPTION_FUNDS]:BUDGET_WIDGETS).some(id=>widgetVisible(board.view,id,board.lineup.length));if(!visible)continue;
      const meters=scope==='quota'?subscriptionSelection(cards,board.view):moneySelection(cards,board.view.hidden,scope==='funds'?prefs().funds:prefs().money,board.currencies,scope==='funds'?'funds':'budget').selection;
      const query:HistoryQuery={cell:String(cell),from:String(Math.floor(range.from/cell)*cell),to:String(Math.ceil(range.to/cell)*cell),cells:'skip',...(meters?{unit:meters.unit,meters:JSON.stringify(meters.ids),...(meters.displayCurrency?{currency:meters.displayCurrency}:{})}:{})};
      const key=JSON.stringify([query.meters,query.unit,query.currency]),tape=this.tapes.get(scope);
      if(this.dirtyScopes.has(scope)||this.projectionErrors[scope]||!tape||tape.queryKey!==key||range.from<tape.tape.from||range.to>tape.tape.cut&&!this.liveEvidence)queries[scope]=query;
    }
    return {board:board.id,generation:this.generation,revision:this.revision,proofEpoch:this.proofEpoch,request:{version:1,selection:this.selection,evaluatedAt:hubNow(),...queries,...(pending&&this.valuesNeeded&&this.selection.mode==='range'&&this.sourceIds.length?{values:this.sourceIds}:{}),...(pending&&this.wantsWork&&this.workNeeded?{sessions:{...(this.cursor?{cursor:this.cursor}:{})}}:{})}};
  }
  private setValue(id:string,value:Reading<PeriodValues>){this.values.set(id,value);for(const listener of this.valueListeners.get(id)??[])listener();}
  private publishWork() {this.workState={...this.work,rows:this.workRows};for(const listener of this.listeners)listener();}
  private clear() {
    this.proofEpoch++;this.workProofEpoch=-1;this.dirtyScopes.clear();
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
    const selected=timeRange(),selection:PeriodSelection=selected?{mode:'range',...selected}:{mode:'live',periodMs:periodOf(prefs().range).ms};
    const sources=board.lineup.filter(id=>!board.view.hidden.includes('source:'+id));
    const wantsWork=sources.length>0||[AGENTS,ACTIVITY].some(id=>widgetVisible(board.view,id,board.lineup.length));
    const identity=JSON.stringify([board.id,periodKey(selection),sources,wantsWork,board.currencies?.target.id,board.currencies?.revision,board.currencies?.registryRevision,sources.map(id=>[id,board.cards[id]?.budget])]);
    const authority=JSON.stringify([board.id,sources,wantsWork,board.currencies?.target.id,board.currencies?.revision,board.currencies?.registryRevision,sources.map(id=>[id,board.cards[id]?.budget])]);
    if(authority!==this.authority){this.clear();this.authority=authority;}
    if(event?.type==='hub'&&['history','hello','snapshot','mine','lineup'].includes(event.event.type))this.retained.clear();
    const cacheKey=JSON.stringify([identity,prefs().money,prefs().funds,prefs().kind]);
    if(cacheKey!==this.cacheKey){this.retainCurrent();this.cacheKey=cacheKey;}
    this.selection=selection;this.sourceIds=sources;this.wantsWork=wantsWork;
    if(identity!==this.identity) {
      const oldBoard=this.identity?JSON.parse(this.identity)[0]:null;
      this.identity=identity;this.generation++;this.revision++;
      this.dirtyScopes.clear();
      if(oldBoard!==board.id||event?.type==='hub'&&['mine','lineup'].includes(event.event.type))this.clear();
      this.cacheKey=cacheKey;
      let cached=this.valueCache.get(periodKey(selection));
      if(!cached&&selection.mode==='range')cached=[...this.valueCache.values()].find(c=>sources.every(id=>{const interval=c.values.get(id)?.value?.validFor;return interval&&interval.from<=selection.to&&selection.to<interval.to;}));
      this.valuesNeeded=selection.mode==='range'&&!cached;
      if(selection.mode==='range')for(const id of sources){const saved=cached?.values.get(id);this.setValue(id,saved?{...saved,basis:saved.basis?{...saved.basis,range:{from:selection.from,to:selection.to}}:null}:{...this.getValue(id),loading:true,error:null});}
      else {for(const id of this.values.keys())this.setValue(id,noValue);this.values.clear();}
      const range=evaluatedRange(selection,hubNow());
      if(this.tapes.size||this.work.value) {
        // Complete evidence belongs either to this target or to the shared LRU.
        // A fixed target replaces its raw ledger with exact summaries and edges.
        preparations()?.cancel(this.preparationOwner);this.tapes.clear();this.cursor=undefined;this.index=null;this.activity=null;this.work={...this.work,value:null};this.liveEvidence=false;this.transport.forgetEvidence();
        this.bytes=JSON.stringify([...this.values.values()]).length*3+JSON.stringify(this.workRows).length*3;
        clock.due(this.watch,null,hubNow());
      }
      this.workNeeded=wantsWork&&(!this.work.value||range.from<this.work.value.anchor||range.to>(this.work.value.cut??0)&&!this.liveEvidence);
      const saved=this.retained.has(cacheKey)?[cacheKey,this.retained.get(cacheKey)!] as const:[...this.retained].find(([,entry])=>entry.fits(selection));
      if(saved){
        const staging={role:'visible' as const},before=this.bytes;
        this.retained.delete(saved[0]);this.bytes+=saved[1].bytes;
        // The removed cache entry remains owned until its exact shifted copy is ready.
        if(saved[0]===cacheKey||historyPool.reserve(staging,saved[1].bytes)){saved[1].restore(selection);this.tick(false);}
        else this.bytes=before;
        historyPool.release(staging);
      }
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
        const included=hub.data.sources.some(id=>sources.includes(id));
        if(included){this.proofEpoch++;this.valueCache.clear();}
        const relevant=included&&(selection.mode==='live'||hub.data.since<selection.to);
        if(relevant){
          if(selection.mode==='range')this.valuesNeeded=true;
          for(const scope of PERIOD_SCOPES)if(!hub.data.changes||hub.data.changes.some(c=>sources.includes(c.source)&&c.scope===(scope==='funds'?'budget':scope)&&(selection.mode==='live'||c.since<selection.to)))this.dirtyScopes.add(scope);
          const work=hub.data.changes?.some(c=>sources.includes(c.source)&&c.workSince!==undefined)??true;if(work)this.workNeeded=wantsWork;this.revision++;this.transport.change();
        }
      }
    }
  }
  private receive(reply:PeriodReply,intent:PeriodIntent,reserve?:(bytes:number)=>boolean) {
    // Sibling resource replies share one retained projection. Let each commit before
    // taking the next snapshot, so a later chart cannot cancel values or sessions.
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
    const workBytes=(trace:WorkTrace|null,curves?:number)=>trace?JSON.stringify({...trace,spans:[],packed:undefined}).length*2+(trace.packed?trace.packed.blocks.length*8+trace.packed.patterns.reduce((n,p)=>n+p.length*8+32,0)+(curves??trace.packed.blocks.length/3*144+trace.packed.patterns.reduce((n,p)=>n+p.length*128,0)):trace.spans.length*640)+trace.refs.length*768:0;
    const tapeBytes=(tape:PeriodTape,wire=false)=>JSON.stringify({...tape,quota:tape.quota.map(s=>({...s,samples:[]})),money:tape.money.map(s=>({...s,readings:[],spans:[],...(s.paired?{paired:{readings:[],spans:[]}}:{})}))}).length*2+tape.quota.reduce((n,s)=>n+(wire&&!('columns' in s.samples)?s.samples.length*8:sampleBytes(s.samples,s.samplesEncoding==='delta')),0)+tape.money.reduce((n,s)=>n+[...s.readings,...s.paired?.readings??[]].reduce((bytes,r)=>bytes+256+2*((r.amount?.length??0)+(r.unit?.length??0)+(r.label?.length??0)+(r.scope?.length??0)+(r.limit?.length??0)),0)+(s.spans.length+(s.paired?.spans.length??0))*192,0);
    const cellsBytes=PERIOD_SCOPES.reduce((bytes,scope)=>{const part=reply[scope];if(part?.state!=='complete')return bytes;const {tape:_,...cells}=part.value;return bytes+JSON.stringify(cells).length*3;},0);
    const staged=new Map<string,number>(),limited=new Error('history_limit');
    const charge=(key:string,bytes:number)=>{const prior=staged.get(key)??0;staged.set(key,bytes);if(!reserve(cellsBytes+[...staged.values()].reduce((a,b)=>a+b,0))){staged.set(key,prior);throw limited;}};
    const discard=(key:string)=>{staged.delete(key);reserve(cellsBytes+[...staged.values()].reduce((a,b)=>a+b,0));};
    const ownTape=(tape:PeriodTape,prior?:PeriodTape)=>({...tape,quota:tape.quota.filter(row=>!prior?.quota.includes(row)),money:tape.money.filter(row=>!prior?.money.includes(row))});
    const failScope=(scope:PeriodScope)=>{reply[scope]={state:'error',error:'history_limit'};discard(scope);};
    for(const scope of PERIOD_SCOPES){const part=reply[scope];if(part?.state==='complete'&&part.value.tape)try{charge(scope,tapeBytes(part.value.tape,true));}catch(error){if(error!==limited)throw error;failScope(scope);}}
    if(reply.sessions&&reply.sessions.state!=='error')try{charge('work',workBytes(reply.sessions.value,0));}catch(error){if(error!==limited)throw error;reply.sessions={state:'error',error:'history_limit'};}
    if(reply.values?.state==='complete')try{charge('values',JSON.stringify(reply.values.value).length*6);}catch(error){if(error!==limited)throw error;reply.values={state:'error',error:'history_limit'};}
    const priorWork=this.work.value,priorIndex=this.index,priorTapes=new Map(this.tapes);
    function* build():Preparation<{work:WorkTrace|null;index:PeriodIndex|null;activity:PeriodActivity|null;tapes:typeof priorTapes}> {
      const incomingTapes=new Map<PeriodScope,PeriodTape>();
      // Compact each decoded column before allocating work or accounting indexes.
      // Progress replaces reservations as scratch buffers become unreachable.
      for(const scope of PERIOD_SCOPES){const part=reply[scope],incoming=part?.state==='complete'?part.value.tape:undefined;if(!incoming)continue;
        const old=priorTapes.get(scope),queryKey=JSON.stringify([intent.request[scope]?.meters,intent.request[scope]?.unit,intent.request[scope]?.currency]),previous=old?.queryKey===queryKey?old.tape:undefined;
        try{
          for(const series of incoming.quota){charge(scope,tapeBytes(incoming,true)+series.samples.length/5*40);series.samples=yield*retainSamplesPrepared(series.samples,series.samplesEncoding==='delta');delete series.samplesEncoding;charge(scope,tapeBytes(incoming,true));yield;}
          const replacement=previous?.quota.filter(s=>incoming.quota.some(row=>row.source===s.source&&row.window===s.window)).reduce((n,s)=>n+s.samples.length/5*88,0)??0;
          charge(scope,tapeBytes(incoming)+replacement);
          const tape=yield*mergeTapePrepared(previous,incoming);incomingTapes.set(scope,tape);if(part?.state==='complete')part.value.tape=tape;charge(scope,tapeBytes(ownTape(tape,previous)));
        }catch(error){if(error!==limited)throw error;incomingTapes.delete(scope);failScope(scope);}
      }
      let work=priorWork,index:PeriodIndex|null=null,activity:PeriodActivity|null=null;
      const part=reply.sessions;
      if(part&&part.state!=='error')try{
        charge('work',workBytes(part.value)+(part.state==='delta'?workBytes(priorWork):0));
        work=part.state==='delta'&&priorWork?yield*mergeWorkPrepared(priorWork,part.value):part.value;
        if(!work.packed&&!work.fixed)work=yield*packWorkPrepared(work);
        charge('work',workBytes(work));index=yield*PeriodIndex.prepare(work);activity=yield*PeriodActivity.prepare(work,index.curves);charge('work',workBytes(work,index.curves.bytes));
      }catch(error){if(error!==limited)throw error;reply.sessions={state:'error',error:'history_limit'};work=priorWork;index=null;activity=null;discard('work');}
      const workPart=reply.sessions,changedWork=new Set(workPart&&workPart.state!=='error'?[...workPart.value.refs,...(workPart.state==='complete'?priorWork?.refs??[]:[])].map(ref=>ref.source):[]);
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
      return {work,index,activity,tapes};
    }
    const valid=()=>intent.generation===this.generation&&intent.revision===this.revision;
    const prepared=await prepareAsync(this.preparationOwner,build(),valid).catch(error=>{release();throw error;});
    if(!prepared||!valid()){release();return;}
    for(const scope of PERIOD_SCOPES){const part=reply[scope];if(part){if(part.state==='error')this.projectionErrors[scope]=part.error==='history_limit'?'history_limit':'history_failed';else delete this.projectionErrors[scope];changed.add(scope);}}
    this.evaluatedAt=hubNow();this.tapes.clear();for(const [scope,tape] of prepared.tapes)this.tapes.set(scope,tape);
    for(const scope of PERIOD_SCOPES){const section=reply[scope];if(section?.state==='complete'&&section.value.tape)this.dirtyScopes.delete(scope);}
    if(reply.values) {
      if(reply.values.state==='complete'){
        changed.add('quota');this.valuesNeeded=false;for(const value of reply.values.value)this.setValue(value.id,{value,basis:reply.values.basis,loading:false,error:null});
        const values=new Map(this.values);if(proofEpoch===this.proofEpoch)this.valueCache.set(periodKey(intent.request.selection),{values,bytes:JSON.stringify([...values]).length*3,at:hubNow()});
      }
      else for(const id of this.sourceIds)this.setValue(id,{...this.getValue(id),loading:false,error:reply.values.error});
    }
    if(reply.sessions) {
      const section=reply.sessions;
      if(section.state==='error'){this.work={...this.work,loading:false,error:section.error};this.publishWork();}
      else {
        const value=prepared.work!;
        this.cursor=section.value.cursor;this.workNeeded=false;this.liveEvidence ||= intent.request.selection.mode==='live';
        this.workProofEpoch=proofEpoch;
        this.workSelection=intent.request.selection;this.workRangeKey=this.workSelection.mode==='range'?periodKey(this.workSelection):prefs().range;
        this.work={value,basis:section.basis,loading:false,error:null};this.index=prepared.index;this.activity=prepared.activity;
        this.tick(false);
      }
    }
    this.bytes=JSON.stringify([...this.values.values()]).length*3+workBytes(this.work.value,this.index?.curves.bytes)+[...this.tapes.values()].reduce((sum,t)=>sum+tapeBytes(t.tape)+t.accounting.quotaBytes,0);
    release();
    this.publishProjection([...changed]);
    this.scheduleClock();
  }
  private tick(fromClock=true) {
    if(!this.active)return;
    if(!this.index||!this.work.basis){this.evaluatedAt=hubNow();this.publishProjection([...this.tapes].filter(([,t])=>t.selection.mode==='live').map(([scope])=>scope));this.scheduleClock();return;}
    const now=this.evaluatedAt=hubNow(),range=evaluatedRange(this.workSelection,now),projected=this.index.advance(range,now);
    if(projected.limited){this.work={...this.work,error:'history_range_invalid'};this.publishWork();clock.due(this.watch,null,now);return;}
    if(projected.changed||this.workState.value!==this.work.value) {
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
    if(fromClock)this.publishProjection(['budget','funds'].filter(scope=>this.tapes.get(scope as PeriodScope)?.selection.mode==='live') as PeriodScope[]);
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
