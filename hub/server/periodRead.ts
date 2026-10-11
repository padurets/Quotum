import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Guards,Hub} from './api.js';
import type {Events} from './events.js';
import {compactJSON, HistoryLimit, type HistoryTiles} from './history.js';
import {periodDictionary} from './domain/periodWire.js';
import {fail,readHistory,ReadError} from './historyRead.js';
import {evaluatedRange,parsePeriod,type PeriodBasis,type PeriodSection} from './domain/period.js';
import {PERIOD_SCOPES,type PeriodReply,type PeriodRequest} from './domain/periodRead.js';
import type {HistoryScope,HistoryReply} from './domain/history.js';
import {periodValues,prepareNearbyPeriodValues} from './periodValues.js';
import {sharedWork,periodWork,preparePeriodWork} from './periodWork.js';
import {config} from './config.js';
import {periodTape} from './periodTape.js';
import {workedSessions} from './domain/periodWork.js';
import {prepareFixedTape,prepareFixedWork} from './periodFixed.js';
import {drain,type Preparation} from './domain/prepare.js';
import {PeriodPreparation} from './periodPrepare.js';
import {selectionOf} from './domain/meterHistory.js';
import {cellOf} from './domain/history.js';

class PeriodChanged extends Error {}

type Cursor = {identity:string;revision:number;from:number;cut:number};
type Change = {revision:number;source:string;since:number;owner?:string};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const number=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;

/** A short journal proves delta frontiers. Falling behind it requires a bounded baseline. */
export class PeriodReader {
  private readonly key=randomBytes(32);
  private readonly preparation=new PeriodPreparation();
  private revision=0;
  private workChanges:Change[]=[];
  private measurements:(Change&{scopes?:readonly HistoryScope[]})[]=[];
  private floor=0;
  constructor(private readonly hub:Hub,private readonly history:HistoryTiles,private readonly events:Events) {}
  private append<T extends Change>(journal:T[],change:T) {
    journal.push(change);
    // All journals share the cursor admission frontier. Evicting an older
    // change cannot recover proof already discarded by another journal.
    if(journal.length>2048)this.floor=Math.max(this.floor,journal.shift()!.revision);
  }
  touch(source:string,since:number,_scopes?:readonly HistoryScope[],work=false) {
    this.revision++;
    if(work)this.append(this.workChanges,{revision:this.revision,source,since});
    else this.append(this.measurements,{revision:this.revision,source,since,scopes:_scopes});
  }
  touchClient(owner:string,since:number) {
    this.revision++;this.append(this.workChanges,{revision:this.revision,source:'',owner,since});
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
  private identity(board:string,user:string,shown=this.hub.store.shown(board,this.hub.directory.view(board).hidden)) {
    const {store}=this.hub;
    return createHash('sha256').update(JSON.stringify([board,user,store.workKey(board,shown),store.retentionRevision,store.sources(board).map(s=>[s.id,s.budget])])).digest('base64url');
  }
  private detailRequest(board:string,user:string,raw:unknown) {
    if(!object(raw)||raw.version!==1||!number(raw.evaluatedAt)||typeof raw.cursor!=='string'||!Array.isArray(raw.refs)||raw.refs.length>100||raw.refs.some(ref=>typeof ref!=='string'||!/^[-_A-Za-z0-9]{8}$/.test(ref))||Object.keys(raw).some(k=>!['version','selection','evaluatedAt','cursor','refs'].includes(k)))fail(400,'invalid_request');
    const selection=parsePeriod(raw.selection),cursor=this.decode(raw.cursor);
    if(!selection||!cursor)fail(400,'history_range_invalid');
    const {store,directory}=this.hub,shown=store.shown(board,directory.view(board).hidden);
    const identity=this.identity(board,user,shown);
    const range=evaluatedRange(selection,raw.evaluatedAt);
    if(cursor.identity!==identity||cursor.revision!==this.revision||cursor.from>range.from||cursor.cut<Math.min(range.to,raw.evaluatedAt))fail(400,'history_range_invalid');
    return {request:{version:1 as const,selection,evaluatedAt:raw.evaluatedAt,sessions:{}},refs:new Set(raw.refs as string[])};
  }
  details(board:string,user:string,raw:unknown):string {
    const {request,refs}=this.detailRequest(board,user,raw);
    return this.detailRows(this.read(board,user,request),refs);
  }
  async detailsAsync(board:string,user:string,raw:unknown,signal?:AbortSignal):Promise<string> {
    const {request,refs}=this.detailRequest(board,user,raw);
    const json=await this.readAsync(board,user,request,signal);
    this.detailRequest(board,user,raw);
    return this.detailRows(json,refs);
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
    for(let attempt=0;;attempt++){
      let check=()=>{};
      try{return await this.preparation.run(()=>this.prepareRead(board,user,raw,guard=>{check=guard;}),signal,()=>check());}
      catch(error){if(!(error instanceof PeriodChanged))throw error;if(attempt===1)fail(503,'unavailable');}
    }
  }
  private *prepareRead(board:string,user:string,raw:unknown,guard?:(check:()=>void)=>void):Preparation<string> {
    const self=this;
    if(!object(raw)||raw.version!==1||!number(raw.evaluatedAt)||Object.keys(raw).some(k=>!['version','selection','evaluatedAt','quota','budget','funds','values','sessions'].includes(k)))fail(400,'invalid_request');
    const selection=parsePeriod(raw.selection);if(!selection)fail(400,'invalid_request');
    for(const name of PERIOD_SCOPES)if(raw[name]!==undefined&&(!object(raw[name])||Object.values(raw[name]).some(v=>typeof v!=='string')||Object.keys(raw[name]).some(k=>!['cell','from','to','meters','unit','currency','meta','evidence','cells'].includes(k))))fail(400,'invalid_request');
    for(const name of PERIOD_SCOPES)if(object(raw[name])&&raw[name].cells!==undefined&&raw[name].cells!=='skip')fail(400,'invalid_request');
    if(raw.values!==undefined&&(!Array.isArray(raw.values)||raw.values.length>2000||raw.values.some(v=>typeof v!=='string'||v.length>256)))fail(400,'invalid_request');
    if(raw.sessions!==undefined&&(!object(raw.sessions)||Object.keys(raw.sessions).some(k=>k!=='cursor')||raw.sessions.cursor!==undefined&&(typeof raw.sessions.cursor!=='string'||raw.sessions.cursor.length>2048)))fail(400,'invalid_request');
    const request=raw as PeriodRequest,{store,directory}=self.hub,now=Date.now();
    if(request.quota||request.sessions)self.hub.ingest.live.sweep(now);
    const revision=self.revision;
    const evaluatedAt=Math.min(request.evaluatedAt,now),range=evaluatedRange(selection,evaluatedAt);
    if(range.from<now-config.retention.sampleDays*86_400_000||range.from>=now)fail(400,'history_range_invalid');
    const cut=Math.min(range.to,now),shown=store.shown(board,directory.view(board).hidden),owner=store.privateOwner(board);
    if(request.values?.some(id=>!shown.has(id)))fail(404,'not_found');
    const identity=self.identity(board,user,shown);
    const previous=self.decode(request.sessions?.cursor);
    const delta=selection.mode==='live'&&!!previous&&previous.identity===identity&&previous.revision>=self.floor&&previous.revision<=revision&&range.from>=previous.from;
    const frontier=(before:Cursor|null,changes:Change[])=>{
      if(!before)return {from:range.from,to:cut,coveredFrom:range.from,coveredTo:cut};
      const coveredFrom=range.from,coveredTo=Math.max(cut,before.cut);
      const dirty=changes.filter(c=>c.revision>before.revision&&c.revision<=revision&&(c.owner?c.owner===owner:shown.has(c.source))&&c.since<coveredTo);
      const from=Math.min(cut>before.cut?before.cut:coveredTo,...dirty.map(c=>c.since));
      return {from:Math.max(coveredFrom,from),to:coveredTo,coveredFrom,coveredTo};
    };
    const workFrontier=frontier(delta?previous:null,self.workChanges),replaceFrom=workFrontier.from;
    const basis:PeriodBasis={run:self.events.epoch,revision:String(revision),evaluatedAt,evidenceCut:cut,range};
    const response:PeriodReply={basis};
    const reservation=self.history.reservation();
    let replyBytes=0;
    const reserve=(bytes:number)=>{reservation.add(bytes);replyBytes+=bytes;};
    const release=(bytes:number)=>{reservation.remove(bytes);replyBytes-=bytes;};
    const cell=cellOf(range.to-range.from),fixedRange={from:Math.max(0,Math.floor(range.from/cell)*cell-cell),to:Math.min(Math.ceil(range.to/cell)*cell+cell,now)};
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
      const workUpper=request.quota||request.sessions?Math.max(upper,selection.mode==='range'?fixedRange.to:workFrontier.to):0;
      const currency=()=>JSON.stringify([store.currencies.registryRevision(user),store.currencies.pathRevision(user),store.db.prepare("SELECT value FROM meta WHERE key='currencyRatesRevision::public'").get()?.value??0]);
      const currencyKey=currency();
      if(!directory.boards(user).some(part=>part.id===board))fail(404,'board_not_found');
      // Directory, resource grants and CurrencyStore write through this connection.
      // Its counter only invalidates the fingerprints; unrelated writes still pass.
      const changes=store.db.prepare('SELECT total_changes() AS value');
      let checkedChanges=changes.get()!.value,checkedRetention=store.retentionRevision,checkedRevision=revision;
      guard(()=>{
        if(revision<self.floor)throw new PeriodChanged();
        if(changes.get()!.value!==checkedChanges||store.retentionRevision!==checkedRetention){
          if(!directory.boards(user).some(part=>part.id===board))fail(404,'board_not_found');
          if(self.identity(board,user)!==identity||currency()!==currencyKey)throw new PeriodChanged();
          checkedChanges=changes.get()!.value;checkedRetention=store.retentionRevision;
        }
        if(checkedRevision!==self.revision){
          if(self.measurements.some(c=>c.revision>revision&&c.since<upper&&sources.has(c.source)&&(!c.scopes||c.scopes.some(scope=>sources.get(c.source)!.has(scope)))))throw new PeriodChanged();
          if(workUpper&&self.workChanges.some(c=>c.revision>revision&&c.since<workUpper&&(c.owner?c.owner===owner:shown.has(c.source))))throw new PeriodChanged();
          checkedRevision=self.revision;
        }
      });
    }
    const workRange=selection.mode==='range'&&(request.sessions||request.quota&&request.quota.evidence!=='skip')?fixedRange:request.sessions?{from:replaceFrom,to:workFrontier.to}:null;
    const work=sharedWork(self.hub,shown,workRange,bytes=>reservation.add(bytes),bytes=>reservation.remove(bytes),owner,now);
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
    let presence=self.hub.ingest.live.presence.bind(self.hub.ingest.live),presenceLimited=false;
    function* retainedWork():Preparation<ReturnType<typeof periodWork>> {
      if(presenceLimited)throw new HistoryLimit();
      if(completeWork)return completeWork;
      let bytes=0,complete=false;
      try{
        completeWork=yield*preparePeriodWork(self.hub,self.history,board,shown,fixedRange,work,now,size=>{reservation.add(size);bytes+=size;},size=>{reservation.remove(size);bytes-=size;},presence);
        complete=true;return completeWork;
      }finally{if(!complete)reservation.remove(bytes);}
    }
    function* temporary<T>(read:()=>Preparation<T>):Preparation<T>{const before=replyBytes;try{return yield*read();}finally{reservation.remove(replyBytes-before);replyBytes=before;}}
    try {
      if(request.quota||request.sessions){
        let bytes=0;
        try{presence=self.hub.ingest.live.presenceSnapshot(size=>{reservation.add(size);bytes+=size;},(person,source)=>person===owner||source!==null&&!!shown.get(source)?.holders.some(holder=>holder.user===person));}
        catch(error){reservation.remove(bytes);if(!(error instanceof HistoryLimit))throw error;presenceLimited=true;}
      }
      yield;
      for(const scope of PERIOD_SCOPES)if(request[scope])response[scope]=yield*section((function*(){
        const historyScope=scope==='funds'?'budget':scope;
        const query=request[scope]!,json=readHistory(self.hub,self.history,self.events,board,user,{...query,scope:historyScope},work,query.cells!=='skip',now);
        reserve(Buffer.byteLength(json)*2);const value=JSON.parse(json) as HistoryReply;
        if(query.evidence==='skip')return value;
        const tapeIdentity=createHash('sha256').update(JSON.stringify([identity,scope,query.meters,query.unit,query.currency,store.currencies.registryRevision(user)])).digest('base64url');
        const previous=self.decode(query.evidence);
        const delta=selection.mode==='live'&&previous&&previous.identity===tapeIdentity&&previous.revision>=self.floor&&previous.revision<=revision&&range.from>=previous.from;
        const changes=delta?self.measurements.filter(c=>c.revision>previous.revision&&c.revision<=revision&&shown.has(c.source)&&(!c.scopes||c.scopes.includes(historyScope))):[];
        const patch=frontier(delta?previous:null,changes);
        const changed=new Set(changes.map(c=>c.source));
        const tapeShown=delta?new Map([...shown].filter(([id])=>changed.has(id))):shown;
        const cursor=self.encode({identity:tapeIdentity,revision,from:patch.coveredFrom,cut:patch.coveredTo});
        if(selection.mode==='range'){
          const work=scope==='quota'?yield*retainedWork():null;
          const tape=yield*temporary(()=>prepareFixedTape(periodTape(store,board,tapeShown,user,historyScope,query,fixedRange,cursor,fixedRange.from,reserve,fixedRange.to,release,true,now),work,range,Number(query.cell),reserve,release));
          reserve(Buffer.byteLength(JSON.stringify(tape))*3);return {...value,tape};
        }
        const tape=periodTape(store,board,tapeShown,user,historyScope,query,{from:patch.coveredFrom,to:patch.to},cursor,patch.from,reserve,cut,bytes=>{reservation.remove(bytes);replyBytes-=bytes;},false,now);
        return {...value,tape:{...tape,cut:patch.coveredTo,...(delta?{replaceTo:patch.to}:{})}};
      })());
      if(request.values)response.values=yield*section((function*(){
        const sources=store.sources(board).filter(s=>request.values!.includes(s.id));
        return selection.mode==='range'?yield*prepareNearbyPeriodValues(store,sources,user,range.to,cell,reserve,release,now):periodValues(store,sources,user,cut,reserve,now);
      })());
      if(request.sessions) {
        const covered=selection.mode==='range'?fixedRange:{from:workFrontier.coveredFrom,to:workFrontier.coveredTo};
        const cursor=self.encode({identity,revision,from:covered.from,cut:covered.to});
        const part=yield*section((function*(){
          if(presenceLimited)throw new HistoryLimit();
          const value=selection.mode==='range'?yield*temporary(function*(){return yield*prepareFixedWork(yield*retainedWork(),range,cellOf(range.to-range.from),now,reserve,release);}):yield*preparePeriodWork(self.hub,self.history,board,shown,{from:replaceFrom,to:workFrontier.to},work,now,reserve,release,presence);
          if(selection.mode==='range')reserve(Buffer.byteLength(JSON.stringify(value))*3);
          return {...value,cut:covered.to,cursor};
        })());
        response.sessions=delta&&part.state==='complete'?{state:'delta',basis,value:{...part.value,replaceFrom,replaceTo:workFrontier.to}}:part;
      }
      const before=replyBytes;
      try {
        const dictionary=periodDictionary(response,reserve);
        return compactJSON({...response,...(dictionary.moneySemantics.length?{moneySemantics:dictionary.moneySemantics}:{}),...(dictionary.rateLegs.length?{rateLegs:dictionary.rateLegs}:{})},dictionary.replacer);
      } catch(error){
        if(!(error instanceof HistoryLimit))throw error;
        // Optional wire sharing cannot discard a section that already fits.
        reservation.remove(replyBytes-before);replyBytes=before;return compactJSON(response);
      }
    }finally{reservation.close();}
  }
}

export function periodRoutes(app:FastifyInstance,guards:Guards,reader:PeriodReader) {
  for(const [path,limit,read] of [
    ['/api/boards/:board/period/sessions',8192,reader.detailsAsync.bind(reader)],
    ['/api/boards/:board/period',76*1024,reader.readAsync.bind(reader)],
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
