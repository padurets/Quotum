import {providerOf, quotaMeter, budgetMeter} from './domain/providers.js';
import {config} from './config.js';
import type {Hub} from './api.js';
import {HistoryLimit, type HistoryTiles} from './history.js';
import {selectionOf, type MeterSelection} from './domain/meterHistory.js';
import {CLOCK_TOLERANCE_MS, MAX_READ_TILES, READ_CELLS, cellStart, tileOf, tileStart, type Chunk} from './domain/history.js';
import type {Events} from './events.js';
import {displayHistory} from './currencies/history.js';
import type {WorkRead} from './store/store.js';

import type {HistoryQuery} from './domain/periodRead.js';
export type {HistoryQuery} from './domain/periodRead.js';
export class ReadError extends Error {
  constructor(readonly statusCode:number, readonly code:string) {super(code);}
}
export function fail(status:number, code:string):never {throw new ReadError(status,code);}

/** Both transports enforce the same tile, authority and currency contract. */
export function readHistory(hub:Hub, history:HistoryTiles, events:Events, board:string, user:string, query:HistoryQuery, work?:WorkRead, cells=true):string {
  const {store,directory}=hub;
    const scope = query.scope;
    if(scope!==undefined&&scope!=='quota'&&scope!=='budget')fail(400, 'invalid_request');
    const now = Date.now();
    // Credit quiet machines before deciding whether their tiles can be reused.
    if(scope!=='budget')hub.ingest.live.sweep(now);
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
      const observed=new Map<string,number[]>();
      const grants=new Map(store.sources(board).map(s=>[s.id,s.provider==='codex'?s.budget?.anchor??Infinity:0]));
      const transformed=displayHistory(chunks.map(json=>JSON.parse(json) as Chunk),store.currencies,user,query.currency,cell,(source,meter,until)=>{
        const id=meter==='balance'?'usage':meter,key=source+'\n'+id;let times=observed.get(key);
        if(!times){const rows=store.meters.readings(source,id,from,to),spans=store.meters.spans(source,id,from,to);times=[...rows.map(r=>r.at),...spans.flatMap(s=>id==='balance:credits'?[s.from,s.to]:[s.to])].filter(at=>at>=(grants.get(source)??Infinity)).sort((a,b)=>a-b);observed.set(key,times);}
        let low=0,high=times.length;while(low<high){const middle=(low+high)>>>1;if(times[middle]<=until)low=middle+1;else high=middle;}return low?times[low-1]:null;
      });
      chunks=transformed.map(chunk=>JSON.stringify(chunk));
      if(chunks.reduce((sum,json)=>sum+Buffer.byteLength(json),0)>16*1024*1024)fail(413, 'history_limit');
    }
    const basis = {run: events.epoch, historyStart: store.historyStart(now), known: store.historyKnown(shown)};
    const tag = query.meta === undefined ? undefined : history.metadata(board, basis, scope);
    const meta = JSON.stringify(tag && query.meta === tag ? {now, run: events.epoch, meta: tag} : {now, ...basis, ...(tag ? {meta: tag} : {})});

    return `${meta.slice(0, -1)},"chunks":[${chunks.join(',')}]}`;
}
