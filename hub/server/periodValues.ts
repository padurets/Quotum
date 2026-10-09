import type {Store} from './store/store.js';
import type {PeriodValues, WindowValue} from './domain/periodValues.js';
import type {Meter, KeyPart} from './domain/meters.js';
import type {MeterContextValue} from './store/meterContexts.js';
import {convertBy, conversionId, isCurrency} from './domain/currency.js';

type WindowRow = {window_id:string;at:number;kind:WindowValue['kind'];label:string|null;used:number;reset_at:number|null;minutes:number|null;stale_after_ms:number};
type ContextRow = {from_at:number;to_at:number;stale_after_ms:number;payload:string};

/** The last retained native batch defines membership, including windows that disappeared. */
export function periodValues(store:Store, sources:readonly {id:string;provider:string}[], user:string, to:number, reserve:(bytes:number)=>void):PeriodValues[] {
  const target=store.currencies.preference(user).id;
  const bindings=store.currencies.history(user,target,0,to,reserve);
  const batch=store.db.prepare('SELECT window_id,at,kind,label,used,reset_at,minutes,stale_after_ms FROM samples WHERE source_id=? AND at=(SELECT max(at) FROM samples WHERE source_id=? AND at<?)');
  const context=store.db.prepare('SELECT from_at,to_at,stale_after_ms,payload FROM meter_contexts WHERE source_id=? AND item=? AND from_at<? ORDER BY from_at DESC LIMIT 1');
  const ids=store.db.prepare('SELECT DISTINCT meter_id FROM readings WHERE source_id=? AND at<?');
  // A right edge may move inside this interval without changing any retained value.
  // Include exclusive observations, compressed anchors and availability deadlines.
  const bounds=store.db.prepare(`WITH changes(at) AS (
    SELECT at+1 FROM samples WHERE source_id=:source
    UNION ALL SELECT min(at+stale_after_ms+1,coalesce(reset_at,9223372036854775807)) FROM samples WHERE source_id=:source
    UNION ALL SELECT at+1 FROM readings WHERE source_id=:source
    UNION ALL SELECT at+stale_after_ms+1 FROM readings WHERE source_id=:source
    UNION ALL SELECT reset_at FROM readings WHERE source_id=:source
    UNION ALL SELECT from_at+1 FROM meter_spans WHERE source_id=:source
    UNION ALL SELECT to_at+1 FROM meter_spans WHERE source_id=:source
    UNION ALL SELECT min(to_at+stale_after_ms+1,coalesce(interrupted_at,9223372036854775807),coalesce(hold_until,9223372036854775807)) FROM meter_spans WHERE source_id=:source
    UNION ALL SELECT from_at+1 FROM meter_contexts WHERE source_id=:source
    UNION ALL SELECT to_at+1 FROM meter_contexts WHERE source_id=:source
    UNION ALL SELECT to_at+stale_after_ms+1 FROM meter_contexts WHERE source_id=:source
  ) SELECT coalesce(max(CASE WHEN at<=:edge THEN at END),0) AS start,
    coalesce(min(CASE WHEN at>:edge THEN at END),:edge+1) AS end FROM changes`);
  const result:PeriodValues[]=[];
  for(const {id,provider} of sources) {
    const owned=!!store.db.prepare('SELECT 1 FROM holders WHERE source_id=? AND user_id=?').get(id,user);
    const windows:WindowValue[]=[];
    for(const raw of batch.iterate(id,id,to)) {
      const r=raw as WindowRow,validUntil=Math.min(r.at+r.stale_after_ms+1,r.reset_at??Infinity);
      reserve(256+(r.label?.length??0)*2);
      windows.push({id:r.window_id,kind:r.kind,label:r.label,used:r.used,remaining:100-r.used,resetAt:r.reset_at,minutes:r.minutes,observedAt:r.at,validUntil,stale:to>=validUntil});
    }
    const meters:Meter[]=[],keys:KeyPart[]=[];
    for(const raw of ids.iterate(id,to)) {
      const meter=String(raw.meter_id),reading=store.meters.readings(id,meter,to,to,reserve)[0];
      if(!reading)continue;
      const spans=store.meters.spans(id,meter,reading.at,to,reserve),span=spans.filter(s=>s.from<to).at(-1);
      const deadline=span?Math.min(span.to+span.staleAfterMs+1,span.interruptedAt??Infinity,span.holdUntil??Infinity,reading.resetAt??Infinity):reading.at+reading.staleAfterMs+1;
      // A compressed span has two known anchors; an interior heartbeat time is not recoverable.
      const at=span&&span.to<to?Math.max(reading.at,span.to):reading.at;
      reserve(512);
      const {previousAt:_previousAt,...value}=reading;
      meters.push({...value,...(!owned&&meter.startsWith('key:')?{label:null}:{}),at,stale:to>=deadline});
    }
    const credits=meters.find(m=>m.id==='credits'),usage=meters.find(m=>m.id==='usage');
    if(provider==='openrouter'&&credits&&usage&&credits.unit===usage.unit)meters.push({...usage,id:'balance',kind:'balance',amount:(BigInt(credits.amount)-BigInt(usage.amount)).toString(),at:Math.min(credits.at,usage.at),stale:credits.stale||usage.stale});
    const inventory=context.get(id,'inventory',to) as ContextRow|undefined;
    const saved=inventory?JSON.parse(inventory.payload) as MeterContextValue:null;
    if(saved?.type==='inventory')for(const key of saved.keys) {
      const row=context.get(id,'key:'+key,to) as ContextRow|undefined;
      if(!row)continue;
      reserve(512+row.payload.length*2);
      const v=JSON.parse(row.payload) as MeterContextValue;
      if(v.type!=='key')continue;
      const at=row.to_at<to?row.to_at:row.from_at;
      keys.push({id:v.id,name:owned?v.name:null,disabled:v.disabled,expiresAt:v.expiresAt,includeByok:v.includeByok,at,staleAfterMs:row.stale_after_ms,presence:to>=row.to_at+row.stale_after_ms+1?'missing':'observed',missCount:0,periods:v.periods,byokUsage:v.byokUsage,createdAt:v.createdAt,updatedAt:v.updatedAt});
    }
    let currencyUnavailable=false;
    // Keep native cap denominators and provenance; the common money renderer selects the valuation.
    for(const meter of [...meters])if(isCurrency(meter.unit)&&meter.unit!==target) {
      const steps=bindings.binding(id,meter.unit,meter.at);
      if(!steps?.length){currencyUnavailable=true;continue;}
      reserve(768+JSON.stringify(steps).length*2);
      const original={meterId:meter.id,amount:meter.amount,unit:meter.unit,at:meter.at,...(meter.kind==='cap'?{limit:meter.limit}:{})};
      meters.push({...meter,id:conversionId(meter.id,target),unit:target,amount:convertBy(meter.amount,steps),limit:meter.limit===null?null:convertBy(meter.limit,steps),conversion:{original,rate:steps.at(-1)!,...(steps.length>1?{steps}:{})}});
    }
    const interval=bounds.get({source:id,edge:to}) as {start:number;end:number};
    result.push({id,provider,windows,meters,keys,validFor:{from:interval.start,to:interval.end},...(currencyUnavailable?{currencyUnavailable:true}:{})});
  }
  bindings.flush();
  return result;
}
