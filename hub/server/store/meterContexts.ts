import type {DatabaseSync} from 'node:sqlite';
import {utcPeriods,type BalanceStatus,type KeyPart,type MeterMeasurement} from '../domain/meters.js';
import {amount} from '../domain/amount.js';
import {secretCode} from '../secrets/crypto.js';
import type {CreditBalanceState} from '../domain/resources.js';
import type {SourceState} from '../domain/quota.js';
import {transaction} from '../touches.js';

type Periods={day:string|null;week:string|null;month:string|null};
export type MeterContextValue =
  | ({type:'credit-balance'} & Omit<CreditBalanceState, 'at'|'staleAfterMs'>)
  | {type:'funds';isAvailable:boolean;partial:boolean;issues:BalanceStatus['issues']}
  | {type:'inventory';complete:boolean;error:string|null;keys:string[];uncapped:string[]}
  | {type:'key-cap';present:boolean}
  | {type:'key';id:string;unit:string|null;name:string|null;disabled:boolean;expiresAt:number|null;includeByok:boolean;createdAt:number|null;updatedAt:number|null;periodFrom:{day:number;week:number;month:number};periods:Periods;byokUsage:Periods&{total:string|null}};
export type MeterContext = {observedFrom?:number;from:number;to:number;staleAfterMs:number;value:MeterContextValue};
const exact=(value:string|null|undefined)=>value==null?null:amount(value).toString();
const periods=(value:Periods|undefined):Periods=>({day:exact(value?.day),week:exact(value?.week),month:exact(value?.month)});

/** Provider facts and reported period totals share the money transaction and retention. */
export class MeterContexts {
  constructor(private readonly db:DatabaseSync){}

  seed() {
    transaction(this.db,()=>this.seedKeyCaps());
    for(const row of this.db.prepare('SELECT source_id,payload FROM state').all() as {source_id:string;payload:string}[]) {
      if(this.db.prepare('SELECT 1 FROM meter_contexts WHERE source_id=? LIMIT 1').get(row.source_id))continue;
      const state=JSON.parse(row.payload) as SourceState;
      const units=new Map((state.meters??[]).map(m=>[m.id,m.unit]));
      if(state.balanceStatus)this.funds(row.source_id,state.balanceStatus);
      if(state.creditBalance)this.credit(row.source_id,state.creditBalance);
      for(const key of state.keys??[])this.key(row.source_id,key,units.get(`key:${key.id}:usage`)??null);
    }
  }

  /** Older inventories prove absence by completion time, never by an inferred key-page time. */
  private seedKeyCaps() {
    const keys=this.db.prepare(`SELECT DISTINCT c.source_id,j.value AS key_id FROM meter_contexts c,json_each(c.payload,'$.uncapped') j
      WHERE c.item='inventory' AND NOT EXISTS(SELECT 1 FROM meter_contexts known WHERE known.source_id=c.source_id AND known.item='key-cap:'||j.value)`).all() as {source_id:string;key_id:string}[];
    const inventories=this.db.prepare(`SELECT observed_from,to_at,stale_after_ms FROM meter_contexts c WHERE source_id=? AND item='inventory'
      AND EXISTS(SELECT 1 FROM json_each(c.payload,'$.uncapped') WHERE value=?) ORDER BY from_at`);
    const readings=this.db.prepare('SELECT at,stale_after_ms FROM readings WHERE source_id=? AND meter_id=? ORDER BY at');
    for(const {source_id:source,key_id:key} of keys) {
      if(!/^[0-9a-f]{12}$/.test(key))continue;
      const events:{at:number;staleAfterMs:number;present:boolean}[]=[];
      for(const row of readings.iterate(source,`key:${key}:cap`))events.push({at:Number(row.at),staleAfterMs:Number(row.stale_after_ms),present:true});
      for(const row of inventories.iterate(source,key))for(const at of new Set([...(row.observed_from===null?[]:[Number(row.observed_from)]),Number(row.to_at)]))events.push({at,staleAfterMs:Number(row.stale_after_ms),present:false});
      // An exact positive observation takes priority over a coincident legacy upper bound.
      events.sort((a,b)=>a.at-b.at||Number(b.present)-Number(a.present));
      for(const event of events)this.record(source,'key-cap:'+key,event.at,event.staleAfterMs,{type:'key-cap',present:event.present});
    }
  }

  private record(source:string,item:string,at:number,staleAfterMs:number,value:MeterContextValue) {
    if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(staleAfterMs)||staleAfterMs<0)throw new Error('invalid_meter_context');
    const payload=JSON.stringify(value);
    const previous=this.db.prepare('SELECT from_at,to_at,stale_after_ms,payload,observed_from FROM meter_contexts WHERE source_id=? AND item=? ORDER BY from_at DESC LIMIT 1').get(source,item) as {from_at:number;to_at:number;stale_after_ms:number;payload:string}|undefined;
    if(previous&&at<=previous.to_at)return;
    if(previous&&previous.payload===payload&&at-previous.to_at<=previous.stale_after_ms) {
      this.db.prepare('UPDATE meter_contexts SET to_at=?,stale_after_ms=?,observed_from=coalesce(observed_from,to_at) WHERE source_id=? AND item=? AND from_at=?').run(at,staleAfterMs,source,item,previous.from_at);
    }else this.db.prepare('INSERT INTO meter_contexts(source_id,item,from_at,to_at,stale_after_ms,payload,observed_from) VALUES (?,?,?,?,?,?,?)').run(source,item,at,at,staleAfterMs,payload,at);
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
    for(const meter of measurement.meters) {
      const key=meter.kind==='cap'?/^key:([0-9a-f]{12}):cap$/.exec(meter.id)?.[1]:undefined;
      if(key)this.record(source,'key-cap:'+key,meter.at,meter.staleAfterMs,{type:'key-cap',present:true});
    }
    const keys=new Map(measurement.keys.map(key=>[key.id,key]));
    for(const id of measurement.uncapped??[]) {
      const key=keys.get(id)!;
      this.record(source,'key-cap:'+id,key.at,key.staleAfterMs,{type:'key-cap',present:false});
    }
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
    const rows=this.db.prepare('SELECT from_at,to_at,stale_after_ms,payload,observed_from FROM meter_contexts WHERE source_id=? AND item=? AND to_at+stale_after_ms+1>? AND from_at<? ORDER BY from_at').all(source,item,from,to) as {from_at:number;to_at:number;observed_from:number|null;stale_after_ms:number;payload:string}[];
    return rows.map(row=>({from:row.from_at,to:row.to_at,...(row.observed_from===null?{}:{observedFrom:row.observed_from}),staleAfterMs:row.stale_after_ms,value:JSON.parse(row.payload) as MeterContextValue}));
  }

  prune(cutoff:number) {
    this.db.prepare("DELETE FROM meter_contexts WHERE item NOT LIKE 'key-cap:%' AND to_at+stale_after_ms+1<=? AND from_at<(SELECT max(from_at) FROM meter_contexts c WHERE c.source_id=meter_contexts.source_id AND c.item=meter_contexts.item)").run(cutoff);
    // Membership lasts until another explicit observation. Keep its predecessor,
    // even when its measurement TTL ended, and preserve the real transition time.
    this.db.prepare("DELETE FROM meter_contexts WHERE item LIKE 'key-cap:%' AND from_at<(SELECT max(from_at) FROM meter_contexts c WHERE c.source_id=meter_contexts.source_id AND c.item=meter_contexts.item AND c.from_at<?)").run(cutoff);
    this.db.prepare("UPDATE meter_contexts SET from_at=? WHERE item NOT LIKE 'key-cap:%' AND from_at<? AND to_at>=?").run(cutoff,cutoff,cutoff);
  }
}
