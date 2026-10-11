import {providerOf, quotaMeter, budgetMeter} from './domain/providers.js';
import {config} from './config.js';
import type {Hub} from './api.js';
import {HistoryLimit, type HistoryTiles} from './history.js';
import {selectionOf, type MeterGroup, type MeterSelection} from './domain/meterHistory.js';
import {CLOCK_TOLERANCE_MS, MAX_READ_TILES, READ_CELLS, cellStart, tileOf, tileStart, type Chunk} from './domain/history.js';
import type {Events} from './events.js';
import {displayHistory} from './currencies/history.js';
import type {WorkRead} from './store/store.js';
import {conversionOrigin} from './domain/currency.js';
import {readingBefore,spanBefore,valuationAt} from './domain/periodMoney.js';

import type {HistoryQuery} from './domain/periodRead.js';
export type {HistoryQuery} from './domain/periodRead.js';
export class ReadError extends Error {
  constructor(readonly statusCode:number, readonly code:string) {super(code);}
}
export function fail(status:number, code:string):never {throw new ReadError(status,code);}

/** Both transports enforce the same tile, authority and currency contract. */
export function readHistory(hub:Hub, history:HistoryTiles, events:Events, board:string, user:string, query:HistoryQuery, work?:WorkRead, cells=true, capturedAt?:number):string {
  const {store,directory}=hub;
    const scope = query.scope;
    if(scope!==undefined&&scope!=='quota'&&scope!=='budget')fail(400, 'invalid_request');
    const now = capturedAt??Date.now();
    // Credit quiet machines before deciding whether their tiles can be reused.
    // A composite read already swept before capturing its journal frontier.
    if(scope!=='budget'&&capturedAt===undefined)hub.ingest.live.sweep(now);
    const number = (value: string | undefined) => value && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
    const cell = number(query.cell);
    const from = number(query.from);
    const askedTo = number(query.to);
    if (query.meta !== undefined && !/^(?:[A-Za-z0-9_-]{43})?$/.test(query.meta)) fail(400, 'invalid_request');
    if (!READ_CELLS.includes(cell) || !Number.isFinite(from) || !Number.isFinite(askedTo) || from % cell || (askedTo <= now && askedTo % cell)) fail(400, 'invalid_request');
    const to = Math.min(Math.ceil(askedTo / cell) * cell, cellStart(now + CLOCK_TOLERANCE_MS, cell) + cell);
    const oldest = tileStart(tileOf(now - config.retention.sampleDays * 86_400_000, cell), cell);
    if (to % cell || tileOf(to - 1, cell) - tileOf(from, cell) + 1 > MAX_READ_TILES) fail(400, 'invalid_request');
    const shown = store.shown(board, directory.view(board).hidden);
    let meters: MeterSelection | undefined;
    if (query.meters !== undefined || query.unit !== undefined) {
      try {meters=selectionOf(JSON.parse(query.meters??''),query.unit);} catch {fail(400, 'invalid_request');}
      // A shared hidden source is not a history capability, even when its id is known.
      if (meters.ids.some(([source])=>!shown.has(source))) fail(404, 'not_found');
      const financial=new Map(store.sources(board).map(s=>[s.id,s]));
      if(meters.ids.some(([source,id])=>{const s=financial.get(source);return s?.budget?.enabled===false&&budgetMeter(providerOf(s.provider),id);}))fail(404,'not_found');
      if(query.currency!==undefined)meters={...meters,nativeCurrencies:true};
    }
    if(scope==='budget'&&!meters || scope==='quota'&&query.currency!==undefined)fail(400, 'invalid_request');
    if(scope&&meters) {
      const sources=new Map(store.sources(board).map(source=>[source.id,providerOf(source.provider)]));
      if(meters.ids.some(([source,id])=>!(scope==='quota'?quotaMeter:budgetMeter)(sources.get(source),id)))fail(400, 'invalid_request');
    }
    if (to <= from || from < oldest) fail(400, scope ? 'history_range_invalid' : 'invalid_request');
    let chunks: string[];
    try {chunks=cells?history.read(board, cell, from, to, now, shown, meters, scope, work):[];}
    catch(error){if(error instanceof HistoryLimit)fail(413, 'history_limit');throw error;}
    if(query.currency!==undefined){
      if(!meters)fail(400, 'invalid_request');
      try {store.currencies.definition(user,query.currency);}catch{fail(404, 'currency_not_found');}
      if(store.currencies.preference(user).id!==query.currency)fail(409, 'currency_changed');
      const reservation=history.reservation();
      try {
        const observed=new Map<string,MeterGroup>();
        const grants=new Map(store.sources(board).map(s=>[s.id,s.provider==='codex'?s.budget?.anchor??Infinity:0]));
        const anchorAt=(source:string,meter:string,until:number,binding:number|null=null)=>{
          const key=source+'\n'+meter;let group=observed.get(key);
          if(!group){
            const part=(id:string)=>conversionOrigin(id)?{readings:store.currencies.readings(source,id,from,to,reservation.add),spans:store.currencies.spans(source,id,to,reservation.add,from)}:
              {readings:store.meters.readings(source,id,from,to,reservation.add),spans:store.meters.spans(source,id,from,to,reservation.add)};
            group={source,meter,...part(meter==='balance'?'usage':meter),...(meter==='balance'?{paired:part('credits')}:{})};observed.set(key,group);
          }
          const grant=grants.get(source)??Infinity;
          const anchor=(part:Pick<MeterGroup,'readings'|'spans'>)=>{
            const reading=readingBefore(part.readings,until);if(!reading||reading.at<grant)return null;
            return valuationAt(reading,spanBefore(part.spans,until,true),until,true,binding);
          };
          const at=anchor(group);if(at===null)return null;
          if(!group.paired)return at;
          const paired=anchor(group.paired);return paired===null?null:Math.min(at,paired);
        };
        const transformed=displayHistory(chunks.map(json=>JSON.parse(json) as Chunk),store.currencies,user,query.currency,cell,anchorAt,anchorAt,reservation.add);
        chunks=transformed.map(chunk=>JSON.stringify(chunk));
        if(chunks.reduce((sum,json)=>sum+Buffer.byteLength(json),0)>16*1024*1024)fail(413, 'history_limit');
      }catch(error){if(error instanceof HistoryLimit)fail(413,'history_limit');throw error;}finally{reservation.close();}
    }
    const basis = {run: events.epoch, historyStart: store.historyStart(now), known: store.historyKnown(shown,scope==='budget'?null:store.privateOwner(board))};
    const tag = query.meta === undefined ? undefined : history.metadata(board, basis, scope);
    const meta = JSON.stringify(tag && query.meta === tag ? {now, run: events.epoch, meta: tag} : {now, ...basis, ...(tag ? {meta: tag} : {})});

    return `${meta.slice(0, -1)},"chunks":[${chunks.join(',')}]}`;
}
