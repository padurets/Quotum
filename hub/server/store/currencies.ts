import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {conversionId,convertMoney,exchangeRatesOf,ratesCover,type ExchangeRates,type RateSnapshot,type Conversion} from '../domain/currency.js';
import {semanticsOf,validateMeter,type Meter,type Reading,type MeterSpan} from '../domain/meters.js';

type ValueRow={at:number;previous_at:number|null;native_id:string;native_unit:string;native_amount:string;unit:string;amount:string;quote_id:string;semantics:string;stale_after_ms:number};

/** Shared immutable quotes and derived values, separate from provider readings. */
export class CurrencyStore {
  constructor(private readonly db:DatabaseSync){}
  save(input:ExchangeRates):RateSnapshot {
    const rates=exchangeRatesOf(input),basis={source:rates.source,base:rates.base,date:rates.date,rates:rates.rates};
    const id=createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0,24);
    this.db.prepare('INSERT OR IGNORE INTO exchange_rates(id,source,reference_date,fetched_at,payload) VALUES (?,?,?,?,?)').run(id,rates.source,rates.date,rates.fetchedAt,JSON.stringify(rates));
    return this.get(id)!;
  }
  get(id:string):RateSnapshot|null {
    const row=this.db.prepare('SELECT payload FROM exchange_rates WHERE id=?').get(id) as {payload:string}|undefined;
    return row?{...exchangeRatesOf(JSON.parse(row.payload) as ExchangeRates),id}:null;
  }
  latest(at:number):RateSnapshot|null {
    const row=this.db.prepare('SELECT id FROM exchange_rates WHERE reference_date<=? AND reference_date>? ORDER BY reference_date DESC,fetched_at DESC LIMIT 1').get(at,at-7*86_400_000) as {id:string}|undefined;
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
    const changed=this.db.prepare('DELETE FROM money_valuations WHERE at<? AND at<(SELECT max(at) FROM money_valuations v WHERE v.source_id=money_valuations.source_id AND v.meter_id=money_valuations.meter_id AND v.at<?)').run(cutoff,cutoff).changes>0;
    this.db.prepare('DELETE FROM exchange_rates WHERE reference_date<? AND id NOT IN(SELECT quote_id FROM money_valuations) AND reference_date<(SELECT max(reference_date) FROM exchange_rates)').run(cutoff);
    return changed;
  }
}
