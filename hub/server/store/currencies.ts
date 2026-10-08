import {createHash} from 'node:crypto';
import {DEFAULT_CURRENCY,defaultCurrencyContext,isCurrency,ratePath,convertBy,conversionId,convertMoney,exchangeRatesOf,ratesCover,type ExchangeRates,type RateSnapshot,type Conversion,type CurrencyContext,type CurrencyBinding,type RateLeg} from '../domain/currency.js';
import {semanticsOf,validateMeter,type Meter,type Reading,type MeterSpan} from '../domain/meters.js';
import {CurrencyBindings,type BindingRange,type UnavailableObservation} from './currencyBindings.js';
import {CurrencyRegistry,type RateChangeRow} from './currencyRegistry.js';
import {pruneCurrencyTimeline} from './currencyRetention.js';

type ValueRow={at:number;previous_at:number|null;native_id:string;native_unit:string;native_amount:string;unit:string;amount:string;quote_id:string;semantics:string;stale_after_ms:number};

/** Shared immutable quotes and derived values, separate from provider readings. */
export class CurrencyStore extends CurrencyRegistry {
  private quoteEpoch=0;
  private quoteLists=new Map<string,{epoch:number;quotes:RateSnapshot[];changes:RateChangeRow[];boundaries:number[];paths:Map<string,RateLeg[]|null>}>();
  private snapshotCache=new Map<string,RateSnapshot>();
  protected invalidate(owner:string){this.quoteLists.delete(owner);this.snapshotCache.clear();}
  binding(owner:string,from:string,target:string,at:number,anchor:string|null=null,source=''):RateLeg[]|null {
    // Existing assignments remain readable even after their target was archived.
    this.definition(owner,target,true);if(from===target)return [];
    const bound=this.history(owner,target,at,at+1),path=bound.binding(source,from,at,anchor);bound.flush();return path;
  }
  private quoteList(owner:string) {
    let cached=this.quoteLists.get(owner);
    if(!cached||cached.epoch!==this.quoteEpoch) {
      const quotes=(this.db.prepare("SELECT id FROM exchange_rates WHERE owner_id='' ORDER BY reference_date DESC,fetched_at DESC").all() as {id:string}[]).flatMap(q=>this.get(q.id)??[]);
      const changes=this.db.prepare('SELECT c.* FROM currency_rate_changes c JOIN currency_definitions d ON d.id=c.currency_id AND d.owner_id=c.owner_id WHERE c.owner_id=? AND d.archived_at IS NULL ORDER BY c.effective_at,c.sequence').all(owner) as RateChangeRow[];
      const boundaries=[...new Set([...quotes.flatMap(q=>q.validUntil===null?[q.date]:[q.date,q.validUntil??q.date+7*86_400_000]),...changes.map(c=>c.effective_at)])].sort((a,b)=>a-b);
      cached={epoch:this.quoteEpoch,quotes,changes,boundaries,paths:new Map()};this.quoteLists.set(owner,cached);
    }
    return cached;
  }
  private interval(owner:string,at:number) {
    const cached=this.quoteList(owner);let low=0,high=cached.boundaries.length;
    while(low<high){const middle=(low+high)>>>1;if(cached.boundaries[middle]<=at)low=middle+1;else high=middle;}return low;
  }
  private path(owner:string,from:string,target:string,at:number,anchor:string|null):RateLeg[]|null {
    const cached=this.quoteList(owner),interval=this.interval(owner,at);
    const key=JSON.stringify([from,target,interval,anchor]);if(cached.paths.has(key))return cached.paths.get(key)!;
    const eligible=new Map<string,RateChangeRow>();
    for(const change of cached.changes){if(change.effective_at>at)break;eligible.set(change.currency_id+'\n'+change.base,change);}
    const quotes=[...cached.quotes,...[...eligible.values()].flatMap(change=>change.kind==='rate'?(this.get(change.quote_id!,owner)??[]):[])];
    const path=ratePath(from,target,quotes,at,anchor);
    if(path){for(const leg of path)Object.freeze(leg);Object.freeze(path);}
    if(cached.paths.size>=1024)cached.paths.delete(cached.paths.keys().next().value!);
    cached.paths.set(key,path);return path;
  }
  history(owner:string,target:string,from=0,to=Number.MAX_SAFE_INTEGER):CurrencyBindings {
    this.definition(owner,target,true);
    const load=this.db.prepare(`SELECT observation_at,through_at,anchor,steps FROM currency_bindings
      WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND observation_at<?
        AND (through_at>=? OR observation_at IN(SELECT max(observation_at) FROM currency_bindings
          WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND observation_at<? GROUP BY anchor))
      ORDER BY observation_at`);
    const save=this.db.prepare('INSERT INTO currency_bindings VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,source_id,from_currency,target_currency,observation_at,anchor) DO UPDATE SET through_at=max(currency_bindings.through_at,excluded.through_at)');
    const loadMissing=this.db.prepare(`SELECT observation_at,anchor FROM currency_unavailable_observations WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND observation_at<?
      AND (observation_at>=? OR observation_at IN(SELECT max(observation_at) FROM currency_unavailable_observations WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND observation_at<? GROUP BY anchor)) ORDER BY observation_at`);
    const missing=this.db.prepare('INSERT OR IGNORE INTO currency_unavailable_observations VALUES (?,?,?,?,?,?)');
    const recovered=this.db.prepare('DELETE FROM currency_unavailable_observations WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND observation_at=? AND anchor=?');
    const active=!target.startsWith('personal:')||this.db.prepare('SELECT 1 FROM currency_definitions WHERE owner_id=? AND id=? AND archived_at IS NULL').get(owner,target);
    return new CurrencyBindings(target,(source,unit)=>load.all(owner,source,unit,target,to,from,owner,source,unit,target,from) as BindingRange[],
      (unit,at,anchor)=>active?this.path(owner,unit,target,at,anchor):null,
      (source,unit,row)=>{save.run(owner,source,unit,target,row.observation_at,row.through_at,row.anchor,row.steps);},
      (source,unit)=>loadMissing.all(owner,source,unit,target,to,from,owner,source,unit,target,from) as UnavailableObservation[],
      (source,unit,point,unavailable)=>{(unavailable?missing:recovered).run(owner,source,unit,target,point.observation_at,point.anchor);},
      (from,to)=>this.interval(owner,from)===this.interval(owner,to));
  }

  context(owner:string,inputs:Record<string,{unit:string;at:number;anchor?:string|null}[]>={}):CurrencyContext {
    const target=this.preference(owner),definitions=this.definitions(owner);if(!definitions.some(d=>d.id===target.id))definitions.push(target);
    const registryRevision=this.registryRevision(owner);
    if(target.id===DEFAULT_CURRENCY)return {...defaultCurrencyContext,target,definitions,registryRevision};
    const sources:CurrencyContext['sources']={};
    for(const [source,points] of Object.entries(inputs)) {
      const seen=new Set<string>(),bindings:CurrencyBinding[]=[];
      for(const point of points){if(!isCurrency(point.unit))continue;const anchor=point.anchor??null,key=JSON.stringify([point.unit,point.at,anchor]);if(seen.has(key))continue;seen.add(key);
        const steps=this.binding(owner,point.unit,target.id,point.at,anchor,source);if(steps)bindings.push({from:point.unit,at:point.at,anchor,steps});}
      sources[source]=bindings;
    }
    const revision=String(this.db.prepare("SELECT value FROM meta WHERE key='currencyRatesRevision::public'").get()?.value??0)+':'+this.pathRevision(owner);
    return {target,definitions,revision,registryRevision,sources};
  }
  observationAt(owner:string,source:string,from:string,target:string,to:number):number|null {
    const row=this.db.prepare('SELECT max(CASE WHEN through_at<=? THEN through_at ELSE observation_at END) at FROM currency_bindings WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND observation_at<=?').get(to,owner,source,from,target,to) as {at:number|null};return row.at;
  }
  value(owner:string,value:string,unit:string,target:string,at:number,anchor:string|null=null):{amount:string;steps:RateLeg[]}|null {
    const steps=this.binding(owner,unit,target,at,anchor);try{return steps?{amount:convertBy(value,steps),steps}:null;}catch{return null;}
  }
  save(input:ExchangeRates,owner=''):RateSnapshot {
    const rates=exchangeRatesOf(input);for(const unit of Object.keys(rates.rates))if(unit.startsWith('personal:'))this.definition(owner,unit);
    const basis={owner,validUntil:rates.validUntil,source:rates.source,base:rates.base,date:rates.date,rates:rates.rates};
    const id=createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0,24);
    const inserted=this.db.prepare('INSERT OR IGNORE INTO exchange_rates(id,source,reference_date,fetched_at,payload,owner_id) VALUES (?,?,?,?,?,?)').run(id,rates.source,rates.date,rates.fetchedAt,JSON.stringify(rates),owner);
    if(inserted.changes){if(owner)this.quoteLists.delete(owner);else this.quoteEpoch++;const units=owner?Object.keys(rates.rates).filter(unit=>unit.startsWith('personal:')):['public'];for(const unit of units){const key='currencyRatesRevision:'+owner+':'+unit;this.db.prepare("INSERT INTO meta(key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run(key);}}
    return this.get(id,owner)!;
  }
  get(id:string,owner=''):RateSnapshot|null {
    const key=owner+'\n'+id,cached=this.snapshotCache.get('\n'+id)??this.snapshotCache.get(key);if(cached)return cached;
    const row=this.db.prepare("SELECT payload,owner_id FROM exchange_rates WHERE id=? AND (owner_id='' OR owner_id=?)").get(id,owner) as {payload:string;owner_id:string}|undefined;
    if(!row)return null;const parsed=exchangeRatesOf(JSON.parse(row.payload) as ExchangeRates),snapshot=Object.freeze({...parsed,rates:Object.freeze(parsed.rates),id});this.snapshotCache.set(row.owner_id?key:'\n'+id,snapshot);return snapshot;
  }
  latest(at:number):RateSnapshot|null {
    const row=this.db.prepare("SELECT id FROM exchange_rates WHERE owner_id='' AND reference_date<=? AND reference_date>? ORDER BY reference_date DESC,fetched_at DESC LIMIT 1").get(at,at-7*86_400_000) as {id:string}|undefined;
    return row?this.get(row.id):null;
  }
  checked():number {return Number(this.db.prepare("SELECT value FROM meta WHERE key='exchangeRatesCheckedAt'").get()?.value??0);}
  markChecked(at:number){this.db.prepare("INSERT OR REPLACE INTO meta VALUES ('exchangeRatesCheckedAt',?)").run(String(at));}

  record(source:string,native:Meter,target:string,quote:RateSnapshot):number|null {
    validateMeter(native);
    const saved=this.get(quote.id);if(!saved)return null;quote=saved;
    if(native.conversion||native.stale||native.kind!=='balance'||!ratesCover(quote,native.at))return null;
    const converted=convertMoney(native,target,quote);if(!converted)return null;
    const id=conversionId(native.id,target),semantics=JSON.stringify(semanticsOf(native));
    const previous=this.db.prepare('SELECT * FROM money_valuations WHERE source_id=? AND meter_id=? ORDER BY at DESC LIMIT 1').get(source,id) as ValueRow|undefined;
    const last=this.lastSpan(source,id);
    if(last&&native.at<=last.to_at)return null;
    if(!previous||previous.amount!==converted.amount||previous.native_amount!==native.amount||previous.native_unit!==native.unit||previous.quote_id!==quote.id||previous.semantics!==semantics) {
      this.db.prepare('INSERT INTO money_valuations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(source,id,native.at,last?.to_at??null,native.id,native.unit,native.amount,target,converted.amount,quote.id,semantics,native.staleAfterMs);
    }
    if(last&&last.interrupted_at===null&&native.at-last.to_at<=last.stale_after_ms) {
      this.db.prepare('UPDATE meter_spans SET to_at=?,stale_after_ms=? WHERE source_id=? AND meter_id=? AND from_at=?').run(native.at,native.staleAfterMs,source,id,last.from_at);
    }else this.db.prepare('INSERT INTO meter_spans(source_id,meter_id,from_at,to_at,stale_after_ms) VALUES (?,?,?,?,?)').run(source,id,native.at,native.at,native.staleAfterMs);
    return last?.to_at??native.at;
  }
  private lastSpan(source:string,id:string) {
    return this.db.prepare('SELECT from_at,to_at,stale_after_ms,interrupted_at FROM meter_spans WHERE source_id=? AND meter_id=? ORDER BY from_at DESC LIMIT 1').get(source,id) as {from_at:number;to_at:number;stale_after_ms:number;interrupted_at:number|null}|undefined;
  }
  interrupt(source:string,nativeId:string,target:string,at:number):boolean {
    const id=conversionId(nativeId,target),last=this.lastSpan(source,id);
    if(!last||at<=last.to_at||last.interrupted_at!==null)return false;
    return !!this.db.prepare('UPDATE meter_spans SET interrupted_at=? WHERE source_id=? AND meter_id=? AND from_at=?').run(at,source,id,last.from_at).changes;
  }
  private conversion(row:ValueRow,at=row.at):Conversion {
    const quote=this.get(row.quote_id);if(!quote)throw new Error('missing_exchange_rates');
    return {original:{meterId:row.native_id,amount:row.native_amount,unit:row.native_unit,at},rate:{id:quote.id,source:quote.source,base:quote.base,date:quote.date,fetchedAt:quote.fetchedAt,from:quote.rates[row.native_unit],to:quote.rates[row.unit]}};
  }
  project(source:string,native:Meter,target:string,now:number):Meter|null {
    const id=conversionId(native.id,target),row=this.db.prepare('SELECT * FROM money_valuations WHERE source_id=? AND meter_id=? ORDER BY at DESC LIMIT 1').get(source,id) as ValueRow|undefined;
    const span=this.lastSpan(source,id);if(!row||!span)return null;
    const at=span.to_at,stale=native.stale||native.amount!==row.native_amount||native.unit!==row.native_unit||native.at!==at||span.interrupted_at!==null||now>at+span.stale_after_ms;
    return {...JSON.parse(row.semantics) as ReturnType<typeof semanticsOf>,id,kind:'balance',unit:target,amount:row.amount,at,staleAfterMs:span.stale_after_ms,stale,conversion:this.conversion(row,at)};
  }
  readings(source:string,id:string,from:number,to:number):Reading[] {
    const rows=this.db.prepare('SELECT * FROM money_valuations WHERE source_id=? AND meter_id=? AND at<? AND at>=coalesce((SELECT max(at) FROM money_valuations WHERE source_id=? AND meter_id=? AND at<?),?) ORDER BY at').all(source,id,to,source,id,from,from) as ValueRow[];
    return rows.map(row=>({...JSON.parse(row.semantics) as ReturnType<typeof semanticsOf>,id,kind:'balance',unit:row.unit,amount:row.amount,at:row.at,previousAt:row.previous_at,staleAfterMs:row.stale_after_ms,conversion:this.conversion(row)}));
  }
  spans(source:string,id:string,to:number):MeterSpan[] {
    return (this.db.prepare('SELECT from_at,to_at,stale_after_ms,interrupted_at FROM meter_spans WHERE source_id=? AND meter_id=? AND from_at<=?').all(source,id,to) as {from_at:number;to_at:number;stale_after_ms:number;interrupted_at:number|null}[]).map(r=>({from:r.from_at,to:r.to_at,staleAfterMs:r.stale_after_ms,...(r.interrupted_at===null?{}:{interruptedAt:r.interrupted_at})}));
  }
  prune(cutoff:number) {
    this.quoteEpoch++;this.quoteLists.clear();this.snapshotCache.clear();
    const changed=this.db.prepare('DELETE FROM money_valuations WHERE at<? AND at<(SELECT max(at) FROM money_valuations v WHERE v.source_id=money_valuations.source_id AND v.meter_id=money_valuations.meter_id AND v.at<?)').run(cutoff,cutoff).changes>0;
    this.db.prepare(`
      DELETE FROM currency_bindings WHERE through_at<? AND (
        observation_at<(SELECT max(b.observation_at) FROM currency_bindings b
          WHERE b.owner_id=currency_bindings.owner_id AND b.source_id=currency_bindings.source_id
            AND b.from_currency=currency_bindings.from_currency AND b.target_currency=currency_bindings.target_currency
            AND b.anchor=currency_bindings.anchor AND b.observation_at<?)
        OR (anchor<>'' AND NOT EXISTS(SELECT 1 FROM money_valuations v
          WHERE v.source_id=currency_bindings.source_id AND v.native_unit=currency_bindings.from_currency AND v.quote_id=currency_bindings.anchor)))
      AND NOT EXISTS(SELECT 1 FROM state,json_each(state.payload,'$.meters') m
        WHERE state.source_id=currency_bindings.source_id AND json_extract(m.value,'$.unit')=currency_bindings.from_currency
          AND json_extract(m.value,'$.at') BETWEEN currency_bindings.observation_at AND currency_bindings.through_at)
      AND NOT EXISTS(SELECT 1 FROM readings r WHERE r.source_id=currency_bindings.source_id AND r.unit=currency_bindings.from_currency
        AND (r.at BETWEEN currency_bindings.observation_at AND currency_bindings.through_at
          OR r.previous_at BETWEEN currency_bindings.observation_at AND currency_bindings.through_at))
      AND NOT EXISTS(SELECT 1 FROM money_valuations v JOIN meter_spans s ON s.source_id=v.source_id AND s.meter_id=v.meter_id
        WHERE v.source_id=currency_bindings.source_id AND v.native_unit=currency_bindings.from_currency AND v.quote_id=currency_bindings.anchor
          AND (v.at BETWEEN currency_bindings.observation_at AND currency_bindings.through_at
            OR s.to_at BETWEEN currency_bindings.observation_at AND currency_bindings.through_at))
    `).run(cutoff,cutoff);
    pruneCurrencyTimeline(this.db,cutoff);
    // Keep the nominal unit definition, the rate predecessor for each pair, and recorded assignments.
    this.db.prepare(`
      WITH predecessors AS (
        SELECT q.id,row_number() OVER (
          PARTITION BY q.owner_id,q.source,json_extract(q.payload,'$.base'),unit.key
          ORDER BY q.reference_date DESC,q.fetched_at DESC,q.id DESC) AS position
        FROM exchange_rates q,json_each(q.payload,'$.rates') unit WHERE q.reference_date<?)
      DELETE FROM exchange_rates WHERE reference_date<?
        AND id NOT IN(SELECT initial_quote_id FROM currency_definitions WHERE initial_quote_id IS NOT NULL)
        AND id NOT IN(SELECT id FROM predecessors WHERE position=1)
        AND id NOT IN(SELECT quote_id FROM money_valuations)
        AND id NOT IN(SELECT quote_id FROM currency_rate_changes WHERE quote_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM currency_bindings b,json_each(b.steps) s WHERE json_extract(s.value,'$.id')=exchange_rates.id)
    `).run(cutoff,cutoff);
    return changed;
  }
}
