import type {FastifyInstance} from 'fastify';
import type {Guards, Hub} from '../api.js';
import type {Events} from '../events.js';
import {HistoryLimit, type HistoryTiles} from '../history.js';
import {config} from '../config.js';
import {budgetMeter, providerOf, quotaMeter} from '../domain/providers.js';
import {selectionOf, type MeterSelection} from '../domain/meterHistory.js';
import {CLOCK_TOLERANCE_MS, MAX_READ_TILES, READ_CELLS, cellStart, tileOf, tileStart, type Chunk, type HistoryScope} from '../domain/history.js';
import {displayHistory} from '../currencies/history.js';
import {transaction} from '../touches.js';
import type {Shown} from '../store/store.js';

type Query = {cell?: unknown; from?: unknown; to?: unknown; board?: string; meters?: unknown; unit?: unknown; currency?: string; meta?: string; scope?: string; work?: unknown};
type Read = {cell:number;from:number;to:number;tiles:number;scope?:HistoryScope;meters?:MeterSelection;currency?:string;meta?:string;work:boolean};
class RequestError extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
const invalid=():never=>{throw new RequestError(400,'invalid_request');};

/** Both transports validate before reading and use the same financial and work capabilities. */
export function historyRoutes(app:FastifyInstance,hub:Hub,guards:Guards,events:Events,history:HistoryTiles) {
  const {store,directory}=hub;
  const prepare=(query:Query,board:string,user:string,shown:Shown,now:number):Read=>{
    const scope=query.scope;if(scope!==undefined&&scope!=='quota'&&scope!=='budget')return invalid();
    const number=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)?value:typeof value==='string'&&/^\d{1,15}$/.test(value)?Number(value):NaN;
    const cell=number(query.cell),from=number(query.from),askedTo=number(query.to);
    if(query.meta!==undefined&&(typeof query.meta!=='string'||!/^(?:[A-Za-z0-9_-]{43})?$/.test(query.meta)))return invalid();
    if(!READ_CELLS.includes(cell)||!Number.isFinite(from)||!Number.isFinite(askedTo)||from%cell||(askedTo<=now&&askedTo%cell))return invalid();
    const to=Math.min(Math.ceil(askedTo/cell)*cell,cellStart(now+CLOCK_TOLERANCE_MS,cell)+cell),tiles=tileOf(to-1,cell)-tileOf(from,cell)+1;
    if(to%cell||tiles>MAX_READ_TILES)return invalid();
    let meters:MeterSelection|undefined;
    if(query.meters!==undefined||query.unit!==undefined){
      try{meters=selectionOf(typeof query.meters==='string'?JSON.parse(query.meters):query.meters,query.unit);}catch{return invalid();}
      if(meters.ids.some(([source])=>!shown.has(source)))throw new RequestError(404,'not_found');
      const sources=new Map(store.sources(board).map(source=>[source.id,source]));
      if(meters.ids.some(([source,meter])=>{const s=sources.get(source);return s?.budget?.enabled===false&&budgetMeter(providerOf(s.provider),meter);}))throw new RequestError(404,'not_found');
      if(scope&&meters.ids.some(([source,id])=>!(scope==='quota'?quotaMeter:budgetMeter)(providerOf(sources.get(source)?.provider??''),id)))return invalid();
      if(query.currency!==undefined)meters={...meters,nativeCurrencies:true};
    }
    if(scope==='budget'&&!meters||scope==='quota'&&query.currency!==undefined)return invalid();
    if(to<=from||from<tileStart(tileOf(now-config.retention.sampleDays*86_400_000,cell),cell))throw new RequestError(400,scope?'history_range_invalid':'invalid_request');
    const work=query.work!==undefined;
    if(work&&(query.work!=='1'&&query.work!==1||scope!=='budget'||!meters||!store.moneyWorkSources(board,meters).length))return invalid();
    if(query.currency!==undefined){
      if(!meters||typeof query.currency!=='string')return invalid();
      try{store.currencies.definition(user,query.currency);}catch{throw new RequestError(404,'currency_not_found');}
      if(store.currencies.preference(user).id!==query.currency)throw new RequestError(409,'currency_changed');
    }
    return {cell,from,to,tiles,scope,meters,currency:query.currency,meta:query.meta,work};
  };
  const read=(part:Read,board:string,user:string,shown:Shown,now:number):string=>{
    const {cell,from,to,meters,scope,work}=part;
    let chunks=history.read(board,cell,from,to,now,shown,meters,scope,work);
    if(part.currency!==undefined){
      const observed=new Map<string,number[]>(),grants=new Map(store.sources(board).map(source=>[source.id,source.provider==='codex'?source.budget?.anchor??Infinity:0]));
      const transformed=displayHistory(chunks.map(json=>JSON.parse(json) as Chunk),store.currencies,user,part.currency,cell,(source,meter,until)=>{
        const id=meter==='balance'?'usage':meter,key=source+'\n'+id;let times=observed.get(key);
        if(!times){const rows=store.meters.readings(source,id,from,to),spans=store.meters.spans(source,id,from,to);times=[...rows.map(r=>r.at),...spans.flatMap(s=>id==='balance:credits'?[s.from,s.to]:[s.to])].filter(at=>at>=(grants.get(source)??Infinity)).sort((a,b)=>a-b);observed.set(key,times);}
        let low=0,high=times.length;while(low<high){const middle=(low+high)>>>1;if(times[middle]<=until)low=middle+1;else high=middle;}return low?times[low-1]:null;
      });
      chunks=transformed.map(chunk=>JSON.stringify(chunk));
    }
    if(chunks.reduce((sum,json)=>sum+Buffer.byteLength(json),0)>16*1024*1024)throw new HistoryLimit();
    const basis={run:events.epoch,historyStart:store.historyStart(now),known:store.historyKnown(shown,scope==='budget'?null:store.privateOwner(board))};
    const tag=part.meta===undefined?undefined:history.metadata(board,basis,scope),meta=JSON.stringify(tag&&part.meta===tag?{now,run:events.epoch,meta:tag}:{now,...basis,...(tag?{meta:tag}:{})});
    return `${meta.slice(0,-1)},"chunks":[${chunks.join(',')}]}`;
  };
  const failure=(error:unknown)=>error instanceof RequestError?{status:error.status,code:error.code}:error instanceof HistoryLimit?{status:413,code:'history_limit'}:null;
  app.get<{Querystring:Query}>('/api/history',(request,reply)=>{
    const access=guards.board(request,reply,request.query.board);if(!access)return reply;
    try {
      const now=Date.now(),board=access.board.id;
      if(request.query.scope!=='budget'||request.query.work!==undefined)hub.ingest.live.sweep(now);
      const body=transaction(store.db,()=>{
        const current=guards.board(request,reply,board);if(!current)return null;
        const shown=store.shown(board,directory.view(board).hidden),part=prepare(request.query,board,current.user.id,shown,now);
        return read(part,board,current.user.id,shown,now);
      });
      return body===null?reply:reply.type('application/json').send(body);
    }catch(error){const value=failure(error);if(!value)throw error;return reply.code(value.status).send({error:value.code});}
  });
  app.post<{Body:{board?:string;reads?:Query[]}}>('/api/history',{bodyLimit:512*1024},(request,reply)=>{
    const access=guards.board(request,reply,request.body?.board);if(!access)return reply;
    try {
      const queries=request.body?.reads;
      if(!Array.isArray(queries)||queries.length!==2||!queries.every(query=>query&&typeof query==='object'&&!Array.isArray(query)))return invalid();
      const quota=queries.find(query=>query.scope==='quota'),budget=queries.find(query=>query.scope==='budget');
      if(!quota||!budget||quota.work!==undefined||budget.work!==1||queries.some(query=>query.board!==undefined))return invalid();
      const now=Date.now(),board=access.board.id,shown=store.shown(board,directory.view(board).hidden),parts=queries.map(query=>prepare(query,board,access.user.id,shown,now));
      if(parts.reduce((sum,part)=>sum+part.tiles,0)>MAX_READ_TILES)return invalid();
      hub.ingest.live.sweep(now);
      const body=transaction(store.db,()=>{
        const current=guards.board(request,reply,board);if(!current)return null;
        const permitted=store.shown(board,directory.view(board).hidden),currentParts=queries.map(query=>prepare(query,board,current.user.id,permitted,now));
        return store.withHistoryWork(board,Math.min(...currentParts.map(part=>part.from)),Math.min(now,Math.max(...currentParts.map(part=>part.to))),permitted,()=>'{"parts":['+currentParts.map(part=>`{"scope":"${part.scope}","reply":${read(part,board,current.user.id,permitted,now)}}`).join(',')+']}');
      });
      if(body===null)return reply;
      if(Buffer.byteLength(body)>16*1024*1024)throw new HistoryLimit();
      return reply.type('application/json').send(body);
    }catch(error){const value=failure(error);if(!value)throw error;return reply.code(value.status).send({error:value.code});}
  });
}
