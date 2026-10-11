import type {Store} from './store/store.js';
import type {MeterSpan,Reading} from './domain/meters.js';
import {conversionOrigin,isConvertible} from './domain/currency.js';
import {admitSpan} from './domain/periodAdmission.js';

/** One bounded predecessor per affected meter; ordinary historical spans need none. */
export function periodAdmission(store:Store,user:string,target:string,cut:number,reserve:(bytes:number)=>void) {
  const readings=new Map<string,Reading|undefined>(),observations=new Map<string,number|null>();
  const bound=store.db.prepare(`SELECT max(at) AS at FROM (
    SELECT max(observation_at) AS at FROM currency_bindings WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND observation_at<?
    UNION ALL SELECT max(through_at) FROM currency_bindings WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND through_at<?
    UNION ALL SELECT max(observation_at) FROM currency_unavailable_observations WHERE owner_id=? AND source_id=? AND from_currency=? AND target_currency=? AND observation_at<?)`);
  return (source:string,meter:string,span:MeterSpan):MeterSpan|undefined=>{
    let reading:Reading|undefined,binding:number|null=null;
    if(span.to>=cut&&span.from<cut){
      const key=source+'\n'+meter;
      if(!readings.has(key)){
        reserve(128+key.length*2);
        readings.set(key,(conversionOrigin(meter)?store.currencies:store.meters).readings(source,meter,cut,cut,reserve)[0]);
      }
      reading=readings.get(key);
      if(reading&&isConvertible(reading.unit)&&reading.unit!==target){
        const unitKey=source+'\n'+reading.unit;
        if(!observations.has(unitKey)){
          reserve(192+unitKey.length*2);
          const args=[user,source,reading.unit,target,cut];
          const row=bound.get(...args,...args,...args) as {at:number|null};observations.set(unitKey,row.at);
        }
        binding=observations.get(unitKey)!;
      }
    }
    const admitted=admitSpan(span,cut,reading,binding);
    if(admitted&&admitted!==span)reserve(192);
    return admitted;
  };
}
