import {parseCalendar,calendarPartition,calendarCells,normalizeRanges,type CalendarBasis} from './domain/workCalendar.js';
import {calendarProof} from './domain/calendarWork.js';
import {workKnownFrom} from './domain/history.js';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Guards,Hub} from './api.js';
import type {Events} from './events.js';
import {compactJSON, HistoryLimit, type HistoryTiles} from './history.js';
import {periodDictionary} from './domain/periodWire.js';
import {fail,readHistory,ReadError} from './historyRead.js';
import {periodKey,evaluatedRange,parsePeriod,type PeriodBasis,type PeriodSection} from './domain/period.js';
import {PERIOD_BODY_BYTES,PERIOD_SCOPES,type PeriodReply,type PeriodRequest} from './domain/periodRead.js';
import type {HistoryScope,HistoryReply} from './domain/history.js';
import {periodValues,prepareNearbyPeriodValues} from './periodValues.js';
import {sharedWork,selectedWork,periodWork,preparePeriodWork} from './periodWork.js';
import {config} from './config.js';
import {periodTape} from './periodTape.js';
import {workPreparationBytes as importWorkBytes,workedSessions} from './domain/periodWork.js';
import {prepareFixedTape,prepareFixedWork} from './periodFixed.js';
import {drain,type Preparation} from './domain/prepare.js';
import {PeriodPreparation} from './periodPrepare.js';
import {selectionOf} from './domain/meterHistory.js';
import {parseWorkFilter,type WorkFilter} from './domain/dataFilters.js';
import {cellOf,cellStart,CLOCK_TOLERANCE_MS} from './domain/history.js';
import {PeriodCurves,sourceWorkTape,type SourceWorkCurves} from './domain/periodCurves.js';
import {sourceWorkFrom} from './domain/workAccess.js';
import {retainedWorkChoices} from './dataFilters.js';

class PeriodChanged extends Error {}

type Cursor = {identity:string;revision:number;from:number;cut:number;kind?:'calendar';retainedFrom?:number};
type Change = {revision:number;source:string;since:number;owner?:string;device?:string};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const number=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;

/** Retain the parsed body and its canonical copy under the shared ceiling while queued. */
export function periodInputBytes(raw:unknown) {
  let bytes=1024;const pending=[raw];
  while(pending.length){
    const value=pending.pop();
    if(typeof value==='string')bytes+=64+value.length*2;
    else if(value&&typeof value==='object'){
      bytes+=128;
      if(Array.isArray(value)){bytes+=value.length*16;for(const part of value)pending.push(part);}
      else for(const [key,part] of Object.entries(value)){bytes+=64+key.length*2;pending.push(part);}
    }else bytes+=16;
  }
  return bytes*2;
}

/** A short journal proves delta frontiers. Falling behind it requires a bounded baseline. */
export class PeriodReader {
  private readonly key=randomBytes(32);
  private readonly preparation=new PeriodPreparation();
  private revision=0;
  private workChanges:Change[]=[];
  private measurements:(Change&{scopes?:readonly HistoryScope[]})[]=[];
  private workFloor=0;
  private measurementFloor=0;
  constructor(private readonly hub:Hub,private readonly history:HistoryTiles,private readonly events:Events) {}
  private append<T extends Change>(journal:T[],change:T) {
    journal.push(change);
    if(journal.length>2048){const revision=journal.shift()!.revision;if(journal===this.workChanges)this.workFloor=Math.max(this.workFloor,revision);else this.measurementFloor=Math.max(this.measurementFloor,revision);}
  }
  touch(source:string,since:number,_scopes?:readonly HistoryScope[],work=false) {
    this.revision++;
    if(work)this.append(this.workChanges,{revision:this.revision,source,since});
    else this.append(this.measurements,{revision:this.revision,source,since,scopes:_scopes});
  }
  touchClient(owner:string,since:number,device?:string) {
    this.revision++;this.append(this.workChanges,{revision:this.revision,source:'',owner,device,since});
  }
  private tag(body:string){return createHmac('sha256',this.key).update(body).digest();}
  private encode(value:Cursor){const body=Buffer.from(JSON.stringify(value)).toString('base64url');return body+'.'+this.tag(body).toString('base64url');}
  private decode(cursor:string|undefined):Cursor|null {
    if(!cursor)return null;
    try {
      if(cursor.length>2048||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(cursor))return null;
      const [body,tag]=cursor.split('.'),actual=Buffer.from(tag,'base64url'),expected=this.tag(body);
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
      return JSON.parse(Buffer.from(body,'base64url').toString()) as Cursor;
    }catch{return null;}
  }
  private identity(board:string,user:string,access?:import('./domain/workAccess.js').WorkAccess,reservation?:{add(bytes:number):void;remove(bytes:number):void},authority?:string,filter?:WorkFilter) {
    const {store}=this.hub;
    return createHash('sha256').update(JSON.stringify([board,user,authority??store.workKey(board,undefined,access,reservation?bytes=>reservation.add(bytes):undefined,reservation?bytes=>reservation.remove(bytes):undefined),filter])).digest('base64url');
  }
  private detailRequest(board:string,user:string,raw:unknown) {
    if(!object(raw)||raw.version!==1||!number(raw.evaluatedAt)||typeof raw.cursor!=='string'||!Array.isArray(raw.refs)||raw.refs.length>100||raw.refs.some(ref=>typeof ref!=='string'||!/^[-_A-Za-z0-9]{8}$/.test(ref))||Object.keys(raw).some(k=>!['version','selection','evaluatedAt','cursor','refs','workFilter'].includes(k)))fail(400,'invalid_request');
    const filter=raw.workFilter===undefined?undefined:parseWorkFilter(raw.workFilter);if(filter===null)fail(400,'invalid_request');
    const selection=parsePeriod(raw.selection),cursor=this.decode(raw.cursor);
    if(!selection||!cursor)fail(400,'history_range_invalid');
    const {store}=this.hub;
    const reservation=this.history.reservation();
    try{
    const access=store.workAccess(board,Date.now(),bytes=>reservation.add(bytes));
    const identity=this.identity(board,user,access,reservation,undefined,filter);
    const range=evaluatedRange(selection,raw.evaluatedAt);
    const changed=this.workChanges.some(c=>c.revision>cursor.revision&&c.since<cursor.cut&&(c.owner?c.device?access?.devices.get(c.device)?.owner===c.owner:[...(access?.devices.values()??[])].some(d=>d.owner===c.owner):access.sources.has(c.source)));
    if(cursor.identity!==identity||cursor.revision<this.workFloor||cursor.revision>this.revision||changed||cursor.from>range.from||cursor.cut<Math.min(range.to,raw.evaluatedAt))fail(400,'history_range_invalid');
    return {request:{version:1 as const,selection,evaluatedAt:raw.evaluatedAt,sessions:{},...(filter?{workFilter:filter}:{})},refs:new Set(raw.refs as string[])};
    }catch(error){if(error instanceof HistoryLimit)fail(413,'history_limit');throw error;}finally{reservation.close();}
  }
  details(board:string,user:string,raw:unknown):string {
    const {request,refs}=this.detailRequest(board,user,raw);
    return this.detailRows(this.read(board,user,request),refs);
  }
  async detailsAsync(board:string,user:string,raw:unknown,signal?:AbortSignal):Promise<string> {
    const input=this.history.reservation();
    try{
    // The original body survives the queued read for final cursor revalidation.
    // Charge it before deduplication, including repeated refs and predicate values.
    input.add(periodInputBytes(raw));
    const {request,refs}=this.detailRequest(board,user,raw);
    const json=await this.readAsync(board,user,request,signal);
    this.detailRequest(board,user,raw);
    return this.detailRows(json,refs);
    }catch(error){if(error instanceof HistoryLimit)fail(413,'history_limit');throw error;}
    finally{input.close();}
  }
  private detailRows(json:string,refs:Set<string>) {
    const reservation=this.history.reservation();
    try {
      // Detail lookup shares the ceiling, including the decoded index and clipped rows.
      reservation.add(Buffer.byteLength(json)*6);
      const reply=JSON.parse(json) as PeriodReply,section=reply.sessions!;
      if(section.state==='error')return compactJSON({basis:reply.basis,sessions:section});
      const rows=workedSessions(section.value,reply.basis.range,reply.basis.evaluatedAt).filter(row=>refs.has(row.ref));
      return compactJSON({basis:reply.basis,sessions:{state:'complete',basis:reply.basis,value:rows}});
    }catch(error){if(error instanceof HistoryLimit)fail(413,'history_limit');throw error;}
    finally{reservation.close();}
  }
  read(board:string,user:string,raw:unknown):string {return drain(this.prepareRead(board,user,raw));}
  async readAsync(board:string,user:string,raw:unknown,signal?:AbortSignal):Promise<string> {
    const input=this.history.reservation();let admitted=false;
    try{input.add(periodInputBytes(raw));admitted=true;
    for(let attempt=0;;attempt++){
      let check=()=>{};
      // The final check runs after the generator releases its projection.
      const validation=this.history.reservation();
      try{return await this.preparation.run(()=>this.prepareRead(board,user,raw,guard=>{check=guard;},validation),signal,()=>check());}
      catch(error){if(!(error instanceof PeriodChanged))throw error;if(attempt===1)fail(503,'unavailable');}
      finally{validation.close();}
    }
    }catch(error){if(error instanceof HistoryLimit)fail(413,'history_limit',{stage:admitted?'preparation':'input',cause:error});throw error;}
    finally{input.close();}
  }
  private *prepareRead(board:string,user:string,raw:unknown,guard?:(check:()=>void)=>void,validation?:{add(bytes:number):void}):Preparation<string> {
    const self=this;
    if(!object(raw)||raw.version!==1||!number(raw.evaluatedAt)||Object.keys(raw).some(k=>!['version','selection','evaluatedAt','quota','budget','funds','values','sessions','workFilter','facets','sourceWork','calendar'].includes(k)))fail(400,'invalid_request');
    const selection=parsePeriod(raw.selection);if(!selection)fail(400,'invalid_request');
    for(const name of PERIOD_SCOPES)if(raw[name]!==undefined&&(!object(raw[name])||Object.values(raw[name]).some(v=>typeof v!=='string')||Object.keys(raw[name]).some(k=>!['cell','from','to','meters','unit','currency','meta','evidence','cells','work','sources'].includes(k))))fail(400,'invalid_request');
    for(const name of PERIOD_SCOPES)if(object(raw[name])&&raw[name].cells!==undefined&&raw[name].cells!=='skip')fail(400,'invalid_request');
    for(const name of PERIOD_SCOPES)if(object(raw[name])&&raw[name].work!==undefined&&(name!=='budget'||raw[name].work!=='1'))fail(400,'invalid_request');
    if(raw.values!==undefined&&(!Array.isArray(raw.values)||raw.values.length>2000||raw.values.some(v=>typeof v!=='string'||v.length>256)))fail(400,'invalid_request');
    if(raw.sessions!==undefined&&(!object(raw.sessions)||Object.keys(raw.sessions).some(k=>k!=='cursor')||raw.sessions.cursor!==undefined&&(typeof raw.sessions.cursor!=='string'||raw.sessions.cursor.length>2048)))fail(400,'invalid_request');
    if(raw.sourceWork!==undefined&&(!object(raw.sourceWork)||Object.keys(raw.sourceWork).some(k=>k!=='cursor')||raw.sourceWork.cursor!==undefined&&(typeof raw.sourceWork.cursor!=='string'||raw.sourceWork.cursor.length>2048)||!raw.quota&&(!object(raw.budget)||raw.budget.work!=='1')))fail(400,'invalid_request');
    const filter=raw.workFilter===undefined?undefined:parseWorkFilter(raw.workFilter);if(filter===null||raw.facets!==undefined&&raw.facets!==true)fail(400,'invalid_request');
    const calendarDemand=raw.calendar===undefined?undefined:parseCalendar(raw.calendar);if(calendarDemand===null)fail(400,'invalid_request');
    const request={...raw,...(filter?{workFilter:filter}:{})} as PeriodRequest,{store,directory}=self.hub,now=Date.now();
    if(request.calendar||request.quota||request.sessions||request.budget?.work==='1')self.hub.ingest.live.sweep(now);
    const revision=self.revision;
    const evaluatedAt=Math.min(request.evaluatedAt,now),range=evaluatedRange(selection,evaluatedAt);
    if(range.to<=now-config.retention.sampleDays*86_400_000||range.from>=now)fail(400,'history_range_invalid');
    const calendar=calendarDemand?{...calendarDemand,edges:calendarPartition(range)}:undefined;
    const retainedFrom=Math.max(0,now-config.retention.sampleDays*86_400_000);
    const cut=Math.min(range.to,evaluatedAt),shown=store.authorizedSources(board),owner=store.privateOwner(board);
    const reservation=self.history.reservation();
    try{
    let workRange:import('./domain/period.js').PeriodRange[]=[],ordinaryWork:typeof workRange=[],calendarLimited=false;
    const workLimit=(from:number,to:number)=>{
      if(!calendar||calendarLimited)return false;
      calendarLimited=true;response.calendar={state:'error',error:'history_limit'};
      if(request.facets)response.facets={state:'error',error:'history_limit'};
      workRange=ordinaryWork;
      return ordinaryWork.some(range=>range.from<=from&&range.to>=to);
    };
    let validationBytes=0;
    const work:import('./store/store.js').WorkRead=request.calendar||request.sessions||request.facets||request.quota||request.budget?.work==='1'?sharedWork(self.hub,shown,()=>workRange,bytes=>reservation.add(bytes),bytes=>reservation.remove(bytes),owner,now,board,workLimit,validation?bytes=>{validation.add(bytes);validationBytes=bytes;}:undefined):()=>[],access=work.access;
    if(request.values?.some(id=>!shown.has(id)))fail(404,'not_found');
    const views={sourceWide:work,selected:filter?selectedWork(work,filter):work};
    const workRequested=!!(request.calendar||request.sessions||request.facets||request.quota||request.budget?.work==='1');
    const identity=workRequested&&access?self.identity(board,user,access,reservation,work.authority,filter):'';
    const sourceIdentity=workRequested&&access?self.identity(board,user,access,reservation,work.authority):'';
    const resourceKey=()=>JSON.stringify([[...store.authorizedSources(board)].map(([id,s])=>[id,s.since]),request.budget||request.funds||request.values?store.sources(board).map(s=>[s.id,s.budget]):null]);
    const capturedResources=resourceKey();
    const previous=self.decode(request.sessions?.cursor);
    const delta=selection.mode==='live'&&!!previous&&previous.identity===identity&&previous.revision>=self.workFloor&&previous.revision<=revision&&range.from>=previous.from;
    const frontier=(before:Cursor|null,changes:Change[],work=false)=>{
      if(!before)return {from:range.from,to:cut,coveredFrom:range.from,coveredTo:cut};
      const coveredFrom=range.from,coveredTo=Math.max(cut,before.cut);
      const dirty=changes.filter(c=>c.revision>before.revision&&c.revision<=revision&&(c.owner?c.device?access?.devices.get(c.device)?.owner===c.owner:[...(access?.devices.values()??[])].some(d=>d.owner===c.owner):(work?access?.sources.has(c.source):shown.has(c.source)))&&c.since<coveredTo);
      const from=Math.min(cut>before.cut?before.cut:coveredTo,...dirty.map(c=>c.since));
      return {from:Math.max(coveredFrom,from),to:coveredTo,coveredFrom,coveredTo};
    };
    const workFrontier=frontier(delta?previous:null,self.workChanges,true),replaceFrom=workFrontier.from;
    const basis:PeriodBasis={run:self.events.epoch,revision:String(revision),evaluatedAt,evidenceCut:cut,range};
    const response:PeriodReply={basis};
    let replyBytes=0;
    const reserve=(bytes:number)=>{reservation.add(bytes);replyBytes+=bytes;};
    const release=(bytes:number)=>{reservation.remove(bytes);replyBytes-=bytes;};
    const cell=cellOf(range.to-range.from),fixedRange={from:Math.max(retainedFrom,Math.floor(range.from/cell)*cell-cell),to:Math.min(Math.ceil(range.to/cell)*cell+cell,evaluatedAt)};
    const sourcePlan=request.sourceWork&&selection.mode==='live'?(()=>{
      try{
      // Resource families keep one source cursor, independently of selected sessions.
      const sources=shown;
      let scratch=256;for(const id of sources.keys())scratch+=128+id.length*4;
      reserve(scratch);let key:string;
      try{key=createHash('sha256').update(JSON.stringify([sourceIdentity,[...sources.keys()].sort()])).digest('base64url');}
      finally{release(scratch);}
      const previous=self.decode(request.sourceWork.cursor);
      const delta=previous?.identity===key&&previous.revision>=self.workFloor&&previous.revision<=revision&&range.from>=previous.from;
      const patch=frontier(delta?previous:null,self.workChanges,true),cursor=self.encode({identity:key,revision,from:patch.coveredFrom,cut:patch.coveredTo});
      return {sources,delta,patch,cursor};
      }catch(error){
        if(!(error instanceof HistoryLimit))throw error;
        response.sourceWork={state:'error',error:'history_limit'};return null;
      }
    })():null;
    const calendarPlan=calendar?(()=>{
      const calendarKey=createHash('sha256').update(JSON.stringify([periodKey(selection),calendar.zone,calendar.edges[0],calendar.edges.at(-1),calendar.edges[1]-calendar.edges[0]])).digest('base64url');
      const filterKey=createHash('sha256').update(JSON.stringify(filter??null)).digest('base64url');
      const key=createHash('sha256').update(JSON.stringify(['calendar',identity,calendarKey,self.events.epoch])).digest('base64url');
      const before=self.decode(calendar.cursor);
      const delta=before?.kind==='calendar'&&before.identity===key&&before.revision>=self.workFloor&&before.revision<=revision&&before.cut<=evaluatedAt&&before.retainedFrom!==undefined&&before.retainedFrom<=retainedFrom;
      const indices:number[]=[];
      const dirty=delta?self.workChanges.filter(c=>c.revision>before.revision&&c.revision<=revision&&(c.owner?c.device?access?.devices.get(c.device)?.owner===c.owner:[...(access?.devices.values()??[])].some(d=>d.owner===c.owner):access?.sources.has(c.source))):[];
      for(let i=0;i<calendar.edges.length-1;i++)if(!delta||calendar.edges[i]<range.from&&calendar.edges[i+1]>before.from||calendar.edges[i]<cut&&calendar.edges[i+1]>before.cut||calendar.edges[i]<retainedFrom&&calendar.edges[i+1]>before.retainedFrom!||calendar.edges[i]<cut&&calendar.edges[i+1]>range.from&&dirty.some(c=>c.since<calendar.edges[i+1]))indices.push(i);
      const cursor=self.encode({kind:'calendar',identity:key,revision,from:range.from,cut,retainedFrom});
      const basis:CalendarBasis={run:self.events.epoch,revision:String(revision),evaluatedAt,evidenceCut:cut,range,calendarKey,workAuthority:sourceIdentity,filterKey};
      return {delta,indices,cursor,basis};
    })():null;
    // Plan every consumer before the first extraction, including independently advanced cursors.
    const workRanges:import('./domain/period.js').PeriodRange[]=[];
    const includeWork=(from:number,to:number)=>{
      from=Math.max(from,retainedFrom);to=Math.min(to,evaluatedAt);if(Number.isFinite(from)&&Number.isFinite(to)&&from<to)workRanges.push({from,to});
    };
    if(selection.mode==='range'&&(request.sessions||request.quota&&request.quota.evidence!=='skip'||request.budget?.work==='1'))includeWork(fixedRange.from,fixedRange.to);
    if(selection.mode==='live'&&request.sessions)includeWork(replaceFrom,workFrontier.to);
    const facetRanges=normalizeRanges([{from:Math.max(range.from,retainedFrom),to:cut}]);
    if(sourcePlan)includeWork(sourcePlan.patch.from,sourcePlan.patch.to);
    if(request.quota&&request.quota.cells!=='skip'){
      const query=request.quota,cell=Number(query.cell);
      includeWork(Number(query.from),Math.min(Math.ceil(Number(query.to)/cell)*cell,cellStart(now+CLOCK_TOLERANCE_MS,cell)+cell,now));
    }
    ordinaryWork=normalizeRanges(workRanges);
    if(request.facets)for(const part of facetRanges)includeWork(part.from,part.to);
    if(calendarPlan)for(const i of calendarPlan.indices)includeWork(Math.max(range.from,calendar!.edges[i]),Math.min(cut,calendar!.edges[i+1]));
    workRange=normalizeRanges(workRanges);
    if(guard){
      const sources=new Map<string,Set<HistoryScope>>();
      const include=(id:string,scope:HistoryScope)=>{let scopes=sources.get(id);if(!scopes)sources.set(id,scopes=new Set());scopes.add(scope);};
      let upper=request.values?.length?Math.min(now,selection.mode==='range'?range.to+cell+1:cut):0;
      for(const scope of PERIOD_SCOPES)if(request[scope]){
        const query=request[scope]!;
        upper=Math.max(upper,Math.min(now,Number(query.to)),query.evidence==='skip'?0:selection.mode==='range'?fixedRange.to:cut);
        if(scope==='quota')for(const id of shown.keys())include(id,'quota');
        if(query.meters){
          try{for(const [id] of selectionOf(JSON.parse(query.meters),query.unit).ids)include(id,scope==='quota'?'quota':'budget');}
          catch{fail(400,'invalid_request');}
        }
      }
      for(const id of request.values??[]){include(id,'quota');include(id,'budget');}
      const workUpper=workRange.at(-1)?.to??0;
      const currency=()=>JSON.stringify([store.currencies.registryRevision(user),store.currencies.pathRevision(user),store.db.prepare("SELECT value FROM meta WHERE key='currencyRatesRevision::public'").get()?.value??0]);
      const currencyKey=currency();
      if(!directory.boards(user).some(part=>part.id===board))fail(404,'board_not_found');
      // Directory, resource grants and CurrencyStore write through this connection.
      // Its counter only invalidates the fingerprints; unrelated writes still pass.
      const changes=store.db.prepare('SELECT total_changes() AS value');
      let checkedChanges=changes.get()!.value,checkedRetention=store.retentionRevision,checkedRevision=revision;
      guard(()=>{
        if(workRequested&&revision<self.workFloor||sources.size&&revision<self.measurementFloor)throw new PeriodChanged();
        if(changes.get()!.value!==checkedChanges||store.retentionRevision!==checkedRetention){
          if(!directory.boards(user).some(part=>part.id===board))fail(404,'board_not_found');
          if(workRequested&&access){
            let used=0;
            const checking={
              add:(bytes:number)=>{const next=used+bytes;if(next>validationBytes){validation!.add(next-validationBytes);validationBytes=next;}used=next;},
              remove:(bytes:number)=>{used-=bytes;},
            };
            try{
              const current=store.workAccess(board,now,checking.add);
              if(self.identity(board,user,current,checking,undefined,filter)!==identity)throw new PeriodChanged();
            }catch(error){if(error instanceof HistoryLimit)fail(413,'history_limit',{stage:'work-access',cause:error});throw error;}
          }
          if(resourceKey()!==capturedResources||currency()!==currencyKey)throw new PeriodChanged();
          checkedChanges=changes.get()!.value;checkedRetention=store.retentionRevision;
        }
        if(checkedRevision!==self.revision){
          if(self.measurements.some(c=>c.revision>revision&&c.since<upper&&sources.has(c.source)&&(!c.scopes||c.scopes.some(scope=>sources.get(c.source)!.has(scope)))))throw new PeriodChanged();
          if(workUpper&&self.workChanges.some(c=>c.revision>revision&&c.since<workUpper&&(c.owner?c.device?access?.devices.get(c.device)?.owner===c.owner:[...(access?.devices.values()??[])].some(d=>d.owner===c.owner):access?.sources.has(c.source))))throw new PeriodChanged();
          checkedRevision=self.revision;
        }
      });
    }
    function* section<T>(read:Preparation<T>):Preparation<PeriodSection<T>> {
      const before=replyBytes;
      try {return {state:'complete',basis,value:yield*read};}
      catch(error) {
        reservation.remove(replyBytes-before);replyBytes=before;
        if(error instanceof HistoryLimit||error instanceof ReadError&&error.code==='history_limit')return {state:'error',error:'history_limit'};
        if(error instanceof ReadError&&error.code==='history_range_invalid')return {state:'error',error:'history_range_invalid'};
        if(error instanceof ReadError)throw error;
        throw error;
      }
    };
    let completeWork:ReturnType<typeof periodWork>|undefined;
    let sourceCurves:SourceWorkCurves|undefined;
    let presence=self.hub.ingest.live.presence.bind(self.hub.ingest.live),presenceLimited=false;
    function* retainedWork():Preparation<ReturnType<typeof periodWork>> {
      if(presenceLimited)throw new HistoryLimit();
      if(completeWork)return completeWork;
      let bytes=0,complete=false;
      try{
        completeWork=yield*preparePeriodWork(self.hub,self.history,board,shown,fixedRange,views.selected,now,size=>{reservation.add(size);bytes+=size;},size=>{reservation.remove(size);bytes-=size;},presence);
        complete=true;return completeWork;
      }finally{if(!complete)reservation.remove(bytes);}
    }
    function* fullSourceCurves(range:import('./domain/period.js').PeriodRange):Preparation<SourceWorkCurves> {
      if(sourceCurves)return sourceCurves;
      let bytes=0,retained=0;
      const charge=(size:number)=>{reservation.add(size);bytes+=size;};
      try{
        const trace=yield*preparePeriodWork(self.hub,self.history,board,shown,range,views.sourceWide,now,charge,size=>{reservation.remove(size);bytes-=size;},()=>undefined);
        charge(importWorkBytes(trace));
        const curves=yield*PeriodCurves.prepare(trace);
        charge(curves.bytes);retained=curves.bytes;
        return sourceCurves={groups:{source:curves.groups.source},knownFrom:trace.knownFrom,available:trace.available};
      }finally{reservation.remove(bytes-retained);}
    }
    function* temporary<T>(read:()=>Preparation<T>):Preparation<T>{const before=replyBytes;try{return yield*read();}finally{reservation.remove(replyBytes-before);replyBytes=before;}}
    try {
      if(request.quota||request.sessions||request.budget?.work==='1'){
        let bytes=0;
        try{work.ensureAccess?.();presence=self.hub.ingest.live.presenceSnapshot(size=>{reservation.add(size);bytes+=size;},(device,person)=>work.access?.devices.get(device)?.owner===person);}
        catch(error){reservation.remove(bytes);if(!(error instanceof HistoryLimit))throw error;presenceLimited=true;}
      }
      yield;
      for(const scope of PERIOD_SCOPES)if(request[scope])response[scope]=yield*section((function*(){
        const historyScope=scope==='funds'?'budget':scope;
        // Work estimates use the common tape and curves, without a second copy in drawing cells.
        const query=request[scope]!,json=readHistory(self.hub,self.history,self.events,board,user,{...query,scope:historyScope},views,query.cells!=='skip',now,false);
        reserve(Buffer.byteLength(json)*2);const value=JSON.parse(json) as HistoryReply;
        if(query.evidence==='skip')return value;
        const tapeIdentity=createHash('sha256').update(JSON.stringify([board,user,scope,scope==='quota'||query.work==='1'?sourceIdentity:null,[...shown].map(([id,s])=>[id,s.since]),scope==='quota'?null:store.financialKey(board),query.meters,query.unit,query.currency,query.work,query.sources,store.currencies.registryRevision(user)])).digest('base64url');
        const previous=self.decode(query.evidence);
        const delta=selection.mode==='live'&&previous&&previous.identity===tapeIdentity&&previous.revision>=Math.max(self.measurementFloor,scope==='quota'||query.work==='1'?self.workFloor:0)&&previous.revision<=revision&&range.from>=previous.from;
        const changes=delta?self.measurements.filter(c=>c.revision>previous.revision&&c.revision<=revision&&shown.has(c.source)&&(!c.scopes||c.scopes.includes(historyScope))):[];
        const patch=frontier(delta?previous:null,changes);
        const changed=new Set(changes.map(c=>c.source));
        const admitted=query.sources?new Set<string>(JSON.parse(query.sources)):null;
        const tapeShown=new Map([...shown].filter(([id])=>(!delta||changed.has(id))&&(!admitted||admitted.has(id))));
        const cursor=self.encode({identity:tapeIdentity,revision,from:patch.coveredFrom,cut:patch.coveredTo});
        if(selection.mode==='range'){
          const trace=scope==='quota'||query.work==='1'?yield*retainedWork():null;
          const full=filter&&(scope==='quota'||query.work==='1')?yield*fullSourceCurves(fixedRange):undefined;
          const tape=yield*temporary(()=>prepareFixedTape(periodTape(store,board,tapeShown,user,historyScope,query,fixedRange,cursor,fixedRange.from,reserve,fixedRange.to,release,true,now,work),trace,range,Number(query.cell),reserve,release,full,evaluatedAt));
          reserve(Buffer.byteLength(JSON.stringify(tape))*3);return {...value,tape};
        }
        const tape=periodTape(store,board,tapeShown,user,historyScope,query,{from:patch.coveredFrom,to:patch.to},cursor,patch.from,reserve,cut,bytes=>{reservation.remove(bytes);replyBytes-=bytes;},false,now,work);
        return {...value,tape:{...tape,cut:patch.coveredTo,...(delta?{replaceTo:patch.to}:{})}};
      })());
      if(request.values)response.values=yield*section((function*(){
        const sources=store.sources(board).filter(s=>request.values!.includes(s.id));
        return selection.mode==='range'?yield*prepareNearbyPeriodValues(store,sources,user,Math.min(range.to,evaluatedAt),cell,reserve,release,evaluatedAt):periodValues(store,sources,user,cut,reserve,now);
      })());
      if(request.sessions) {
        const covered=selection.mode==='range'?fixedRange:{from:workFrontier.coveredFrom,to:workFrontier.coveredTo};
        const cursor=self.encode({identity,revision,from:covered.from,cut:covered.to});
        const part=yield*section((function*(){
          if(presenceLimited)throw new HistoryLimit();
          const value=selection.mode==='range'?yield*temporary(function*(){return yield*prepareFixedWork(yield*retainedWork(),range,cellOf(range.to-range.from),now,reserve,release);}):yield*preparePeriodWork(self.hub,self.history,board,shown,{from:replaceFrom,to:workFrontier.to},views.selected,now,reserve,release,presence);
          if(selection.mode==='range')reserve(Buffer.byteLength(JSON.stringify(value))*3);
          return {...value,cut:covered.to,cursor};
        })());
        response.sessions=delta&&part.state==='complete'?{state:'delta',basis,value:{...part.value,replaceFrom,replaceTo:workFrontier.to}}:part;
      }
      if(request.facets&&!calendarLimited)response.facets=yield*section((function*(){
        const projects=new Set<string|null>(),devices=new Map<string,string>(),clients=new Set<string|null>(),funding=new Set<'unknown'|'notProvided'>();
        const add=(project:string|null,device:string,name:string,client:string|null,source:string|null,status?:'notProvided')=>{
          if(source===null)funding.add(status??'unknown');
          client=client==='unknown'?null:client;
          if(!projects.has(project)){reserve(128+(project?.length??0)*2);projects.add(project);}
          if(!devices.has(device)){reserve(256+name.length*2);devices.set(device,name);}
          if(!clients.has(client)){reserve(128+(client?.length??0)*2);clients.add(client);}
        };
        for(const part of facetRanges)for(const row of work(part.from,part.to)){add(row.project,row.device,row.rawContext?.deviceName??row.device,row.rawContext?.client??null,row.source,row.sourceStatus);yield;}
        if(access&&selection.mode==='live'){const live=self.hub.ingest.live.board(access,now);for(const row of live.unattributedSessions){add(row.project,row.device.id,row.device.name,row.clientId??null,null,row.sourceStatus);yield;}for(const [source,rows] of live.sessions)for(const row of rows){add(row.project,row.device.id,row.device.name,row.clientId??null,source);yield;}}
        const value={projects:[...projects].sort(),devices:[...devices].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)),clients:[...clients].sort(),funding:[...funding].sort()};
        const retained=retainedWorkChoices(store,work.ensureAccess!(),self.hub.ingest,filter,value,now,reserve,release);
        return {...value,ranges:facetRanges,...(retained?{retained}:{})};
      })());
      if(response.facets?.state==='complete'&&facetRanges.length)response.facets.basis={...basis,range:{from:facetRanges[0].from,to:facetRanges.at(-1)!.to}};
      if(calendarPlan&&!calendarLimited){
        const before=replyBytes;
        try{
          work.ensureAccess?.();
          const known=workKnownFrom(store.historyKnown(shown,access?.owner,access));
          reserve(1024+calendarPlan.indices.length*160+calendar!.edges.length*16);
          const rows=function*(){for(const part of normalizeRanges(calendarPlan.indices.map(i=>({from:Math.max(range.from,calendar!.edges[i],retainedFrom),to:Math.min(calendar!.edges[i+1],cut)}))))yield*views.selected(part.from,part.to);};
          const updates=yield*calendarCells(rows(),calendar!.edges,calendarPlan.indices,evaluatedAt,known,retainedFrom,config.retention.sampleDays*86_400_000,range,selection.mode==='live'?selection.periodMs:undefined);
          const proof=calendarPlan.delta?undefined:{...yield*calendarProof(rows(),range,cut,known,retainedFrom,reserve),retentionMs:config.retention.sampleDays*86_400_000,...(selection.mode==='live'?{periodMs:selection.periodMs}:{})};
          const common={availableFrom:known,retainedFrom,cursor:calendarPlan.cursor};
          response.calendar=calendarPlan.delta?{state:'delta',basis:calendarPlan.basis,value:{...common,updates}}:{state:'complete',basis:calendarPlan.basis,value:{...common,zone:calendar!.zone,edges:calendar!.edges,cells:updates.map(([,cell])=>cell),proof}};
        }catch(error){if(!(error instanceof HistoryLimit)&&!(error instanceof RangeError))throw error;release(replyBytes-before);response.calendar={state:'error',error:'history_limit'};}
      }
      if(sourcePlan){
        const {sources,delta,patch,cursor}=sourcePlan;
        const part=yield*section((function*(){
          const curves=yield*fullSourceCurves({from:patch.from,to:patch.to}),access=work.ensureAccess!();
          const scratch=256+access.devices.size*128+sources.size*512;reserve(scratch);
          try{
            const known=sourceWorkFrom(access),directory=new Map<string,number|null>();
            for(const id of sources.keys())directory.set(id,known[id]??null);
            const value=sourceWorkTape(curves,patch.coveredFrom,patch.coveredTo,directory,reserve,release);
            return {...value,...(delta?{sources:value.sources.filter(source=>source.blocks.length)}:{}),cursor,replaceFrom:patch.from,replaceTo:patch.to};
          }finally{release(scratch);}
        })());
        response.sourceWork=delta&&part.state==='complete'?{state:'delta',basis,value:part.value}:part;
      }
      const before=replyBytes;
      try {
        const dictionary=periodDictionary(response,reserve,!!filter,request.calendar?.relative===true);
        return compactJSON({...response,...(dictionary.moneySemantics.length?{moneySemantics:dictionary.moneySemantics}:{}),...(dictionary.rateLegs.length?{rateLegs:dictionary.rateLegs}:{})},dictionary.replacer);
      } catch(error){
        if(!(error instanceof HistoryLimit))throw error;
        // Optional wire sharing cannot discard a section that already fits.
        reservation.remove(replyBytes-before);replyBytes=before;return compactJSON(response);
      }
    }finally{reservation.close();}
    }finally{reservation.close();}
  }
}

export function periodRoutes(app:FastifyInstance,guards:Guards,reader:PeriodReader) {
  for(const [path,limit,read] of [
    ['/api/boards/:board/period/sessions',80*1024,reader.detailsAsync.bind(reader)],
    ['/api/boards/:board/period',PERIOD_BODY_BYTES,reader.readAsync.bind(reader)],
  ] as const)app.post<{Params:{board:string}}>(path,{bodyLimit:limit},async(request,reply)=>{
    const access=guards.board(request,reply,request.params.board);if(!access)return reply;
    const controller=new AbortController(),abort=()=>controller.abort();
    const closed=()=>{if(!reply.raw.writableFinished)abort();};
    request.raw.once('aborted',abort);reply.raw.once('close',closed);
    try{
      const json=await read(access.board.id,access.user.id,request.body,controller.signal);
      if(!guards.board(request,reply,request.params.board))return reply;
      return reply.type('application/json').send(json);
    }catch(error){
      if(controller.signal.aborted)return reply;
      if(error instanceof ReadError)return reply.code(error.statusCode).send({error:error.code});
      throw error;
    }finally{request.raw.off('aborted',abort);reply.raw.off('close',closed);}
  });
}
