import {createHash,randomBytes} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {DEFAULT_CURRENCY,defaultCurrency,defaultCurrencyContext,currencyDefinitionOf,isCurrency,ratePath,convertBy,conversionId,convertMoney,exchangeRatesOf,ratesCover,type ExchangeRates,type RateSnapshot,type Conversion,type CurrencyDefinition,type CurrencyContext,type CurrencyBinding,type RateLeg} from '../domain/currency.js';
import {semanticsOf,validateMeter,type Meter,type Reading,type MeterSpan} from '../domain/meters.js';
import {CurrencyBindings,type BindingRange} from './currencyBindings.js';

type ValueRow={at:number;previous_at:number|null;native_id:string;native_unit:string;native_amount:string;unit:string;amount:string;quote_id:string;semantics:string;stale_after_ms:number};

/** Shared immutable quotes and derived values, separate from provider readings. */
export class CurrencyStore {
  onChange:((owner:string|null)=>void)|null=null;
  private quoteEpoch=0;
  private quoteLists=new Map<string,{epoch:number;quotes:RateSnapshot[];boundaries:number[];paths:Map<string,RateLeg[]|null>}>();
  private snapshotCache=new Map<string,RateSnapshot>();
  private definitionCache=new Map<string,CurrencyDefinition>();
  constructor(private readonly db:DatabaseSync){}
  definition(owner:string,id:string):CurrencyDefinition {
    const key=owner+'\n'+id,cached=this.definitionCache.get(key);if(cached)return cached;
    if(/^[A-Z]{3}$/.test(id)&&Intl.supportedValuesOf('currency').includes(id)) {
      const definition={id,name:id,symbol:id,fractionDigits:new Intl.NumberFormat('en',{style:'currency',currency:id}).resolvedOptions().maximumFractionDigits!};
      this.definitionCache.set(key,definition);return definition;
    }
    const row=this.db.prepare('SELECT id,name,symbol,fraction_digits FROM currency_definitions WHERE id=? AND owner_id=? AND archived_at IS NULL').get(id,owner) as {id:string;name:string;symbol:string;fraction_digits:number}|undefined;
    if(!row)throw new Error('currency_not_found');const definition={id:row.id,name:row.name,symbol:row.symbol,fractionDigits:row.fraction_digits};this.definitionCache.set(key,definition);return definition;
  }
  definitions(owner:string):CurrencyDefinition[] {
    return [defaultCurrency,...(this.db.prepare('SELECT id,name,symbol,fraction_digits FROM currency_definitions WHERE owner_id=? AND archived_at IS NULL ORDER BY id').all(owner) as {id:string;name:string;symbol:string;fraction_digits:number}[]).map(r=>({id:r.id,name:r.name,symbol:r.symbol,fractionDigits:r.fraction_digits}))];
  }
  preference(owner:string):CurrencyDefinition {return this.definition(owner,String(this.db.prepare('SELECT currency_id FROM currency_preferences WHERE user_id=?').get(owner)?.currency_id??DEFAULT_CURRENCY));}
  select(owner:string,id:string){this.definition(owner,id);this.db.prepare('INSERT OR REPLACE INTO currency_preferences VALUES (?,?)').run(owner,id);this.onChange?.(owner);}
  create(owner:string,input:Omit<CurrencyDefinition,'id'>,base:string,rate:string,at:number):CurrencyDefinition {
    if(!owner||!this.db.prepare('SELECT 1 FROM users WHERE id=?').get(owner)||!this.definition(owner,base)||! /^[A-Z]{3}$/.test(base)||this.definitions(owner).length>64)throw new Error('invalid_currency');
    const definition=currencyDefinitionOf({...input,id:'personal:'+randomBytes(12).toString('hex')});
    this.db.exec('SAVEPOINT personal_currency');
    try {this.db.prepare('INSERT INTO currency_definitions VALUES (?,?,?,?,?,NULL)').run(definition.id,owner,definition.name,definition.symbol,definition.fractionDigits);
      // A declared fixed unit has a timeless initial ratio; later versions are dated.
      this.save({source:'manual',base,date:0,fetchedAt:at,validUntil:null,rates:{[base]:'1000000',[definition.id]:rate}},owner);
      this.db.exec('RELEASE personal_currency');
    }catch(error){this.db.exec('ROLLBACK TO personal_currency');this.db.exec('RELEASE personal_currency');throw error;}
    this.onChange?.(owner);return definition;
  }
  rates(owner:string,id:string):RateSnapshot[] {
    this.definition(owner,id);const scope=id.startsWith('personal:')?owner:'';
    const rows=this.db.prepare('SELECT id FROM exchange_rates WHERE owner_id=? AND json_type(payload,?) IS NOT NULL ORDER BY reference_date DESC,fetched_at DESC LIMIT 128').all(scope,'$.rates."'+id+'"') as {id:string}[];
    return rows.flatMap(row=>this.get(row.id,owner)??[]);
  }
  setRate(owner:string,id:string,base:string,rate:string,date:number,now:number):RateSnapshot {
    this.definition(owner,id);this.definition(owner,base);
    if(!id.startsWith('personal:')||! /^[A-Z]{3}$/.test(base)||date>now)throw new Error('invalid_currency');
    const quote=this.save({source:'manual',base,date,fetchedAt:now,validUntil:null,rates:{[base]:'1000000',[id]:rate}},owner);this.onChange?.(owner);return quote;
  }
  binding(owner:string,from:string,target:string,at:number,anchor:string|null=null,source=''):RateLeg[]|null {
    this.definition(owner,target);if(from===target)return [];
    const row=this.db.prepare('SELECT steps FROM currency_bindings WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND observation_at<=? AND through_at>=? AND anchor=? ORDER BY observation_at DESC LIMIT 1').get(owner,source,from,target,at,at,anchor??'') as {steps:string}|undefined;
    if(row)return JSON.parse(row.steps) as RateLeg[];
    const path=this.path(owner,from,target,at,anchor);if(!path)return null;
    const encoded=JSON.stringify(path),previous=this.db.prepare('SELECT observation_at,through_at,steps FROM currency_bindings WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND observation_at<? AND anchor=? ORDER BY observation_at DESC LIMIT 1').get(owner,source,from,target,at,anchor??'') as {observation_at:number;through_at:number;steps:string}|undefined;
    if(previous?.steps===encoded)this.db.prepare('UPDATE currency_bindings SET through_at=? WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND observation_at=? AND anchor=?').run(at,owner,source,from,target,previous.observation_at,anchor??'');
    else this.db.prepare('INSERT OR IGNORE INTO currency_bindings VALUES (?,?,?,?,?,?,?,?)').run(owner,source,from,target,at,at,anchor??'',encoded);
    return path;
  }
  private path(owner:string,from:string,target:string,at:number,anchor:string|null):RateLeg[]|null {
    let cached=this.quoteLists.get(owner);
    if(!cached||cached.epoch!==this.quoteEpoch) {
      const quotes=(this.db.prepare("SELECT id FROM exchange_rates WHERE owner_id='' OR owner_id=? ORDER BY reference_date DESC,fetched_at DESC").all(owner) as {id:string}[]).flatMap(q=>this.get(q.id,owner)??[]);
      const boundaries=[...new Set(quotes.flatMap(q=>q.validUntil===null?[q.date]:[q.date,q.validUntil??q.date+7*86_400_000]))].sort((a,b)=>a-b);
      cached={epoch:this.quoteEpoch,quotes,boundaries,paths:new Map()};this.quoteLists.set(owner,cached);
    }
    let low=0,high=cached.boundaries.length;while(low<high){const middle=(low+high)>>>1;if(cached.boundaries[middle]<=at)low=middle+1;else high=middle;}
    const key=JSON.stringify([from,target,low,anchor]);if(cached.paths.has(key))return cached.paths.get(key)!;
    const path=ratePath(from,target,cached.quotes,at,anchor);
    if(path){for(const leg of path)Object.freeze(leg);Object.freeze(path);}
    if(cached.paths.size>=1024)cached.paths.delete(cached.paths.keys().next().value!);
    cached.paths.set(key,path);return path;
  }
  history(owner:string,target:string):CurrencyBindings {
    this.definition(owner,target);
    const load=this.db.prepare('SELECT observation_at,through_at,anchor,steps FROM currency_bindings WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? ORDER BY observation_at');
    const save=this.db.prepare('INSERT INTO currency_bindings VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,source_id,from_currency,target_currency,observation_at,anchor) DO UPDATE SET through_at=max(currency_bindings.through_at,excluded.through_at)');
    return new CurrencyBindings(target,(source,unit)=>load.all(owner,source,unit,target) as BindingRange[],(unit,at,anchor)=>this.path(owner,unit,target,at,anchor),(source,unit,row)=>{save.run(owner,source,unit,target,row.observation_at,row.through_at,row.anchor,row.steps);});
  }
  context(owner:string,inputs:Record<string,{unit:string;at:number;anchor?:string|null}[]>={}):CurrencyContext {
    const target=this.preference(owner),definitions=this.definitions(owner);if(!definitions.some(d=>d.id===target.id))definitions.push(target);
    if(target.id===DEFAULT_CURRENCY)return definitions.length===1?defaultCurrencyContext:{target,definitions,sources:{}};
    const sources:CurrencyContext['sources']={};
    for(const [source,points] of Object.entries(inputs)) {
      const seen=new Set<string>(),bindings:CurrencyBinding[]=[];
      for(const point of points){if(!isCurrency(point.unit))continue;const anchor=point.anchor??null,key=JSON.stringify([point.unit,point.at,anchor]);if(seen.has(key))continue;seen.add(key);
        const steps=this.binding(owner,point.unit,target.id,point.at,anchor,source);if(steps)bindings.push({from:point.unit,at:point.at,anchor,steps});}
      sources[source]=bindings;
    }
    const revision=String(this.db.prepare("SELECT value FROM meta WHERE key='currencyRatesRevision::public'").get()?.value??0)+':'+String(this.db.prepare('SELECT value FROM meta WHERE key=?').get('currencyRatesRevision:'+owner+':'+target.id)?.value??0);
    return {target,definitions,revision,sources};
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
    // Keep the nominal unit definition, the rate predecessor for each pair, and recorded assignments.
    this.db.prepare(`
      WITH predecessors AS (
        SELECT q.id,row_number() OVER (
          PARTITION BY q.owner_id,q.source,json_extract(q.payload,'$.base'),unit.key
          ORDER BY q.reference_date DESC,q.fetched_at DESC,q.id DESC) AS position
        FROM exchange_rates q,json_each(q.payload,'$.rates') unit WHERE q.reference_date<?)
      DELETE FROM exchange_rates WHERE reference_date<?
        AND NOT(owner_id<>'' AND reference_date=0)
        AND id NOT IN(SELECT id FROM predecessors WHERE position=1)
        AND id NOT IN(SELECT quote_id FROM money_valuations)
        AND NOT EXISTS(SELECT 1 FROM currency_bindings b,json_each(b.steps) s WHERE json_extract(s.value,'$.id')=exchange_rates.id)
    `).run(cutoff,cutoff);
    return changed;
  }
}
