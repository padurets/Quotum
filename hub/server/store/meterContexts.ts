import type {DatabaseSync} from 'node:sqlite';
import {utcPeriods,type BalanceStatus,type KeyPart,type MeterMeasurement} from '../domain/meters.js';
import {amount} from '../domain/amount.js';
import {secretCode} from '../secrets/crypto.js';
import type {CreditBalanceState} from '../domain/resources.js';
import type {SourceState} from '../domain/quota.js';

type Periods={day:string|null;week:string|null;month:string|null};
export type MeterContextValue =
  | ({type:'credit-balance'} & Omit<CreditBalanceState, 'at'|'staleAfterMs'>)
  | {type:'funds';isAvailable:boolean;partial:boolean;issues:BalanceStatus['issues']}
  | {type:'inventory';complete:boolean;error:string|null;keys:string[];uncapped:string[]}
  | {type:'key';id:string;unit:string|null;name:string|null;disabled:boolean;expiresAt:number|null;includeByok:boolean;createdAt:number|null;updatedAt:number|null;periodFrom:{day:number;week:number;month:number};periods:Periods;byokUsage:Periods&{total:string|null}};
export type MeterContext = {from:number;to:number;staleAfterMs:number;value:MeterContextValue};
const exact=(value:string|null|undefined)=>value==null?null:amount(value).toString();
const periods=(value:Periods|undefined):Periods=>({day:exact(value?.day),week:exact(value?.week),month:exact(value?.month)});

/** Provider facts and reported period totals share the money transaction and retention. */
export class MeterContexts {
  constructor(private readonly db:DatabaseSync){}

  seed() {
    for(const row of this.db.prepare('SELECT source_id,payload FROM state').all() as {source_id:string;payload:string}[]) {
      if(this.db.prepare('SELECT 1 FROM meter_contexts WHERE source_id=? LIMIT 1').get(row.source_id))continue;
      const state=JSON.parse(row.payload) as SourceState;
      const units=new Map((state.meters??[]).map(m=>[m.id,m.unit]));
      if(state.balanceStatus)this.funds(row.source_id,state.balanceStatus);
      if(state.creditBalance)this.credit(row.source_id,state.creditBalance);
      for(const key of state.keys??[])this.key(row.source_id,key,units.get(`key:${key.id}:usage`)??null);
    }
  }

  private record(source:string,item:string,at:number,staleAfterMs:number,value:MeterContextValue) {
    if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(staleAfterMs)||staleAfterMs<0)throw new Error('invalid_meter_context');
    const payload=JSON.stringify(value);
    const previous=this.db.prepare('SELECT from_at,to_at,stale_after_ms,payload FROM meter_contexts WHERE source_id=? AND item=? ORDER BY from_at DESC LIMIT 1').get(source,item) as {from_at:number;to_at:number;stale_after_ms:number;payload:string}|undefined;
    if(previous&&at<=previous.to_at)return;
    if(previous&&previous.payload===payload&&at-previous.to_at<=previous.stale_after_ms) {
      this.db.prepare('UPDATE meter_contexts SET to_at=?,stale_after_ms=? WHERE source_id=? AND item=? AND from_at=?').run(at,staleAfterMs,source,item,previous.from_at);
    }else this.db.prepare('INSERT INTO meter_contexts VALUES (?,?,?,?,?,?)').run(source,item,at,at,staleAfterMs,payload);
  }

  observe(source:string,provider:string,measurement:MeterMeasurement,status:BalanceStatus|undefined) {
    if(status)this.funds(source,status);
    if(measurement.creditBalance)this.credit(source,measurement.creditBalance);
    if(provider==='openrouter'||measurement.keys.length) {
      const inventoryAt=Math.max(measurement.observedAt,measurement.inventoryAt??measurement.observedAt,...measurement.keys.map(k=>k.at));
      this.record(source,'inventory',inventoryAt,measurement.staleAfterMs,{type:'inventory',complete:measurement.inventoryComplete,error:secretCode(measurement.inventoryError),keys:measurement.keys.map(k=>k.id).sort(),uncapped:[...(measurement.uncapped??[])].sort()});
    }
    const units=new Map(measurement.meters.map(m=>[m.id,m.unit]));
    for(const key of measurement.keys)this.key(source,key,units.get(`key:${key.id}:usage`)??null);
  }

  private credit(source:string, status:CreditBalanceState) {
    const {at,staleAfterMs,...value}=status;
    this.record(source,'credit-balance',at,staleAfterMs,{type:'credit-balance',...value});
  }

  private funds(source:string,status:BalanceStatus) {
    this.record(source,'funds',status.at,status.staleAfterMs,{type:'funds',isAvailable:status.isAvailable,partial:status.partial,issues:[...status.issues].sort()});
  }

  private key(source:string,key:KeyPart,unit:string|null) {
    this.record(source,'key:'+key.id,key.at,key.staleAfterMs,{type:'key',id:key.id,unit,name:key.name,disabled:key.disabled,expiresAt:key.expiresAt,includeByok:key.includeByok,
      createdAt:key.createdAt??null,updatedAt:key.updatedAt??null,periodFrom:utcPeriods(key.at),periods:periods(key.periods),byokUsage:{total:exact(key.byokUsage?.total),...periods(key.byokUsage)}});
  }

  history(source:string,item:string,from:number,to:number):MeterContext[] {
    const rows=this.db.prepare('SELECT from_at,to_at,stale_after_ms,payload FROM meter_contexts WHERE source_id=? AND item=? AND to_at+stale_after_ms+1>? AND from_at<? ORDER BY from_at').all(source,item,from,to) as {from_at:number;to_at:number;stale_after_ms:number;payload:string}[];
    return rows.map(row=>({from:row.from_at,to:row.to_at,staleAfterMs:row.stale_after_ms,value:JSON.parse(row.payload) as MeterContextValue}));
  }

  prune(cutoff:number) {
    this.db.prepare('DELETE FROM meter_contexts WHERE to_at+stale_after_ms+1<=? AND from_at<(SELECT max(from_at) FROM meter_contexts c WHERE c.source_id=meter_contexts.source_id AND c.item=meter_contexts.item)').run(cutoff);
    this.db.prepare('UPDATE meter_contexts SET from_at=? WHERE from_at<? AND to_at>=?').run(cutoff,cutoff,cutoff);
  }
}
