import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Guards,Hub} from './api.js';
import type {Events} from './events.js';
import {compactJSON, HistoryLimit, type HistoryTiles} from './history.js';
import {fail,readHistory,ReadError} from './historyRead.js';
import {evaluatedRange,parsePeriod,type PeriodBasis,type PeriodSection} from './domain/period.js';
import {PERIOD_SCOPES,type PeriodReply,type PeriodRequest} from './domain/periodRead.js';
import type {HistoryScope,HistoryReply} from './domain/history.js';
import {periodValues,nearbyPeriodValues} from './periodValues.js';
import {sharedWork,periodWork} from './periodWork.js';
import {config} from './config.js';
import {periodTape} from './periodTape.js';
import {workedSessions} from './domain/periodWork.js';
import {fixedTape,fixedWork} from './periodFixed.js';
import {cellOf} from './domain/history.js';

type Cursor = {identity:string;revision:number;from:number;cut:number};
type Change = {revision:number;source:string;since:number};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const number=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;

/** A short journal proves delta frontiers. Falling behind it requires a bounded baseline. */
export class PeriodReader {
  private readonly key=randomBytes(32);
  private revision=0;
  private workChanges:Change[]=[];
  private measurements:(Change&{scopes?:readonly HistoryScope[]})[]=[];
  private floor=0;
  constructor(private readonly hub:Hub,private readonly history:HistoryTiles,private readonly events:Events) {}
  touch(source:string,since:number,_scopes?:readonly HistoryScope[],work=false) {
    this.revision++;
    if(work)this.workChanges.push({revision:this.revision,source,since});
    else this.measurements.push({revision:this.revision,source,since,scopes:_scopes});
    if(this.workChanges.length>2048)this.floor=this.workChanges.shift()!.revision;
    if(this.measurements.length>2048)this.floor=Math.max(this.floor,this.measurements.shift()!.revision);
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
  details(board:string,user:string,raw:unknown):string {
    if(!object(raw)||raw.version!==1||!number(raw.evaluatedAt)||typeof raw.cursor!=='string'||!Array.isArray(raw.refs)||raw.refs.length>100||raw.refs.some(ref=>typeof ref!=='string'||!/^[-_A-Za-z0-9]{8}$/.test(ref))||Object.keys(raw).some(k=>!['version','selection','evaluatedAt','cursor','refs'].includes(k)))fail(400,'invalid_request');
    const selection=parsePeriod(raw.selection),cursor=this.decode(raw.cursor);
    if(!selection||!cursor)fail(400,'history_range_invalid');
    const {store,directory}=this.hub,shown=store.shown(board,directory.view(board).hidden);
    const identity=createHash('sha256').update(JSON.stringify([board,user,store.workKey(board,shown),store.retentionRevision,store.sources(board).map(s=>[s.id,s.budget])])).digest('base64url');
    const range=evaluatedRange(selection,raw.evaluatedAt);
    if(cursor.identity!==identity||cursor.revision!==this.revision||cursor.from>range.from||cursor.cut<Math.min(range.to,raw.evaluatedAt))fail(400,'history_range_invalid');
    const json=this.read(board,user,{version:1,selection,evaluatedAt:raw.evaluatedAt,sessions:{}}),reservation=this.history.reservation();
    try {
      // Detail lookup shares the ceiling, including the decoded index and clipped rows.
      reservation.add(Buffer.byteLength(json)*6);
      const reply=JSON.parse(json) as PeriodReply,section=reply.sessions!;
      if(section.state==='error')return compactJSON({basis:reply.basis,sessions:section});
      const refs=new Set(raw.refs as string[]),rows=workedSessions(section.value,reply.basis.range,reply.basis.evaluatedAt).filter(row=>refs.has(row.ref));
      return compactJSON({basis:reply.basis,sessions:{state:'complete',basis:reply.basis,value:rows}});
    }catch(error){if(error instanceof HistoryLimit)fail(413,'history_limit');throw error;}
    finally{reservation.close();}
  }
  read(board:string,user:string,raw:unknown):string {
    if(!object(raw)||raw.version!==1||!number(raw.evaluatedAt)||Object.keys(raw).some(k=>!['version','selection','evaluatedAt','quota','budget','funds','values','sessions'].includes(k)))fail(400,'invalid_request');
    const selection=parsePeriod(raw.selection);if(!selection)fail(400,'invalid_request');
    for(const name of PERIOD_SCOPES)if(raw[name]!==undefined&&(!object(raw[name])||Object.values(raw[name]).some(v=>typeof v!=='string')||Object.keys(raw[name]).some(k=>!['cell','from','to','meters','unit','currency','meta','evidence','cells'].includes(k))))fail(400,'invalid_request');
    for(const name of PERIOD_SCOPES)if(object(raw[name])&&raw[name].cells!==undefined&&raw[name].cells!=='skip')fail(400,'invalid_request');
    if(raw.values!==undefined&&(!Array.isArray(raw.values)||raw.values.length>2000||raw.values.some(v=>typeof v!=='string'||v.length>256)))fail(400,'invalid_request');
    if(raw.sessions!==undefined&&(!object(raw.sessions)||Object.keys(raw.sessions).some(k=>k!=='cursor')||raw.sessions.cursor!==undefined&&(typeof raw.sessions.cursor!=='string'||raw.sessions.cursor.length>2048)))fail(400,'invalid_request');
    const request=raw as PeriodRequest,{store,directory}=this.hub,now=Date.now();
    if(request.quota||request.sessions)this.hub.ingest.live.sweep(now);
    const evaluatedAt=Math.min(request.evaluatedAt,now),range=evaluatedRange(selection,evaluatedAt);
    if(range.from<now-config.retention.sampleDays*86_400_000||range.from>=now)fail(400,'history_range_invalid');
    const cut=Math.min(range.to,now),shown=store.shown(board,directory.view(board).hidden);
    if(request.values?.some(id=>!shown.has(id)))fail(404,'not_found');
    const identity=createHash('sha256').update(JSON.stringify([board,user,store.workKey(board,shown),store.retentionRevision,store.sources(board).map(s=>[s.id,s.budget])])).digest('base64url');
    const previous=this.decode(request.sessions?.cursor);
    const delta=selection.mode==='live'&&!!previous&&previous.identity===identity&&previous.revision>=this.floor&&previous.revision<=this.revision;
    const frontier=(before:Cursor|null,changes:Change[])=>{
      if(!before)return {from:range.from,to:cut,coveredFrom:range.from,coveredTo:cut};
      const coveredFrom=Math.min(range.from,before.from),coveredTo=Math.max(cut,before.cut);
      const dirty=changes.filter(c=>c.revision>before.revision&&shown.has(c.source)&&c.since<coveredTo);
      const from=Math.min(range.from<before.from?range.from:coveredTo,cut>before.cut?before.cut:coveredTo,...dirty.map(c=>c.since));
      const headOnly=range.from<before.from&&cut<=before.cut&&!dirty.length;
      return {from:Math.max(coveredFrom,from),to:headOnly?before.from:coveredTo,coveredFrom,coveredTo};
    };
    const workFrontier=frontier(delta?previous:null,this.workChanges),replaceFrom=workFrontier.from;
    const basis:PeriodBasis={run:this.events.epoch,revision:String(this.revision),evaluatedAt,evidenceCut:cut,range};
    const response:PeriodReply={basis};
    const reservation=this.history.reservation();
    let replyBytes=0;
    const reserve=(bytes:number)=>{reservation.add(bytes);replyBytes+=bytes;};
    const release=(bytes:number)=>{reservation.remove(bytes);replyBytes-=bytes;};
    const cell=cellOf(range.to-range.from),fixedRange={from:Math.max(0,Math.floor(range.from/cell)*cell-cell),to:Math.min(Math.ceil(range.to/cell)*cell+cell,now)};
    const workRange=selection.mode==='range'&&(request.sessions||request.quota&&request.quota.evidence!=='skip')?fixedRange:request.sessions?{from:replaceFrom,to:workFrontier.to}:null;
    const work=sharedWork(this.hub,shown,workRange,bytes=>reservation.add(bytes),bytes=>reservation.remove(bytes));
    const section=<T>(read:()=>T):PeriodSection<T>=>{
      const before=replyBytes;
      try {return {state:'complete',basis,value:read()};}
      catch(error) {
        reservation.remove(replyBytes-before);replyBytes=before;
        if(error instanceof HistoryLimit||error instanceof ReadError&&error.code==='history_limit')return {state:'error',error:'history_limit'};
        if(error instanceof ReadError&&error.code==='history_range_invalid')return {state:'error',error:'history_range_invalid'};
        if(error instanceof ReadError)throw error;
        throw error;
      }
    };
    let completeWork:ReturnType<typeof periodWork>|undefined;
    const retainedWork=()=>completeWork??=periodWork(this.hub,this.history,board,shown,fixedRange,work,now,reserve);
    const temporary=<T>(read:()=>T)=>{const before=replyBytes;try{return read();}finally{reservation.remove(replyBytes-before);replyBytes=before;}};
    try {
      for(const scope of PERIOD_SCOPES)if(request[scope])response[scope]=section(()=>{
        const historyScope=scope==='funds'?'budget':scope;
        const query=request[scope]!,json=readHistory(this.hub,this.history,this.events,board,user,{...query,scope:historyScope},work,query.cells!=='skip');
        reserve(Buffer.byteLength(json)*2);const value=JSON.parse(json) as HistoryReply;
        if(query.evidence==='skip')return value;
        const tapeIdentity=createHash('sha256').update(JSON.stringify([identity,scope,query.meters,query.unit,query.currency,store.currencies.registryRevision(user)])).digest('base64url');
        const previous=this.decode(query.evidence);
        const delta=selection.mode==='live'&&previous&&previous.identity===tapeIdentity&&previous.revision>=this.floor&&previous.revision<=this.revision;
        const changes=delta?this.measurements.filter(c=>c.revision>previous.revision&&shown.has(c.source)&&(!c.scopes||c.scopes.includes(historyScope))):[];
        const patch=frontier(delta?previous:null,changes);
        const changed=new Set(changes.map(c=>c.source)),extendsRange=!!delta&&range.from<previous.from;
        const tapeShown=delta&&!extendsRange?new Map([...shown].filter(([id])=>changed.has(id))):shown;
        const cursor=this.encode({identity:tapeIdentity,revision:this.revision,from:patch.coveredFrom,cut:patch.coveredTo});
        if(selection.mode==='range'){
          const work=scope==='quota'?retainedWork():null;
          const tape=temporary(()=>fixedTape(periodTape(store,board,tapeShown,user,historyScope,query,fixedRange,cursor,fixedRange.from,reserve,fixedRange.to,release),work,range,Number(query.cell),reserve,release));
          reserve(Buffer.byteLength(JSON.stringify(tape))*3);return {...value,tape};
        }
        const tape=periodTape(store,board,tapeShown,user,historyScope,query,{from:patch.coveredFrom,to:patch.to},cursor,patch.from,reserve,cut,bytes=>{reservation.remove(bytes);replyBytes-=bytes;});
        return {...value,tape:{...tape,cut:patch.coveredTo,...(delta?{replaceTo:patch.to}:{})}};
      });
      if(request.values)response.values=section(()=>{
        const sources=store.sources(board).filter(s=>request.values!.includes(s.id));
        return selection.mode==='range'?nearbyPeriodValues(store,sources,user,cut,cell,reserve,release):periodValues(store,sources,user,cut,reserve);
      });
      if(request.sessions) {
        const covered=selection.mode==='range'?fixedRange:{from:workFrontier.coveredFrom,to:workFrontier.coveredTo};
        const cursor=this.encode({identity,revision:this.revision,from:covered.from,cut:covered.to});
        const part=section(()=>{
          const value=selection.mode==='range'?temporary(()=>fixedWork(retainedWork(),range,cellOf(range.to-range.from),now,reserve,release)):periodWork(this.hub,this.history,board,shown,{from:replaceFrom,to:workFrontier.to},work,now,reserve);
          if(selection.mode==='range')reserve(Buffer.byteLength(JSON.stringify(value))*3);
          return {...value,cut:covered.to,cursor};
        });
        response.sessions=delta&&part.state==='complete'?{state:'delta',basis,value:{...part.value,replaceFrom,replaceTo:workFrontier.to}}:part;
      }
      return compactJSON(response);
    }finally{reservation.close();}
  }
}

export function periodRoutes(app:FastifyInstance,guards:Guards,reader:PeriodReader) {
  app.post<{Params:{board:string}}>('/api/boards/:board/period/sessions',{bodyLimit:8192},(request,reply)=>{
    const access=guards.board(request,reply,request.params.board);if(!access)return reply;
    try{return reply.type('application/json').send(reader.details(access.board.id,access.user.id,request.body));}
    catch(error){if(error instanceof ReadError)return reply.code(error.statusCode).send({error:error.code});throw error;}
  });
  app.post<{Params:{board:string}}>('/api/boards/:board/period',{bodyLimit:76*1024},(request,reply)=>{
    const access=guards.board(request,reply,request.params.board);if(!access)return reply;
    try{return reply.type('application/json').send(reader.read(access.board.id,access.user.id,request.body));}
    catch(error){if(error instanceof ReadError)return reply.code(error.statusCode).send({error:error.code});throw error;}
  });
}
