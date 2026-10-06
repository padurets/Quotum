import type {Chunk} from '../domain/history.js';
import type {MeterSemantics} from '../domain/meters.js';
import type {CurrencyStore} from '../store/currencies.js';
import {convertBy,type Conversion} from '../domain/currency.js';

/** Transform the already-accounted native cells; FX changes never become spending. */
export function displayHistory(chunks:readonly Chunk[],currencies:CurrencyStore,owner:string,target:string,cell:number,nativeAt?:(source:string,meter:string,until:number)=>number|null):Chunk[] {
  return chunks.map(chunk=>({...chunk,meterSeries:chunk.meterSeries?.map(series=>{
    let semantics=series.semantics;
    const cells=series.cells.flatMap(row=>{
      const old=semantics;semantics=row[5]?.semantics??semantics;
      const at=chunk.from+row[0]*cell+(row[5]?.pointOffsetMs??cell-1),proof=semantics?.conversion;
      const boundAt=currencies.observationAt(owner,series.source,series.unit,target,at),reportedAt=proof?null:nativeAt?.(series.source,series.meter,at),quoteAt=proof?.original.at??(Math.max(reportedAt??0,boundAt??0)||at),anchor=proof?.rate.id??null;
      const basePath=currencies.binding(owner,series.unit,target,quoteAt,anchor,series.source);if(!basePath)return [];
      const convert=(value:string)=>convertBy(value,basePath);
      try {
      let value=convert(row[1]),conversion:Conversion|undefined;
      if(proof) {
        const path=currencies.binding(owner,proof.original.unit,target,proof.original.at,proof.rate.id,series.source);
        const prior=proof.steps??[proof.rate];
        if(path&&convertBy(proof.original.amount,prior)===row[1]){value=convertBy(proof.original.amount,path);if(path.length)conversion={original:proof.original,rate:path.at(-1)!,...(path.length>1?{steps:path}:{})};}
      }
      if(!conversion&&basePath.length)conversion={original:{meterId:series.meter,amount:row[1],unit:series.unit,at:quoteAt},rate:basePath.at(-1)!,...(basePath.length>1?{steps:basePath}:{})};
      const metadata:MeterSemantics|null=semantics?{...semantics,limit:semantics.limit===null?null:convert(semantics.limit),...(conversion?{conversion}:{conversion:undefined})}:null;
      const extra={...row[5],...(metadata?{semantics:metadata}:{}),...(row[5]?.open!=null?{open:convert(row[5].open)}:{}),...(row[5]?.first!==undefined?{first:convert(row[5].first)}:{}),...(row[5]?.steps?{steps:row[5].steps.map(step=>({...step,amount:convert(step.amount)}))}:{}),...(row[5]?.topupSteps?{topupSteps:row[5].topupSteps.map(step=>({...step,amount:convert(step.amount)}))}:{}),...(row[5]?.topupInternal!==undefined?{topupInternal:convert(row[5].topupInternal)}:{})};
      if(old?.conversion&&extra.open!=null){const previous=old.conversion,path=currencies.binding(owner,previous.original.unit,target,previous.original.at,previous.rate.id,series.source);if(path&&convertBy(previous.original.amount,previous.steps??[previous.rate])===row[5]?.open)extra.open=convertBy(previous.original.amount,path);}
      return [[row[0],value,row[2]===null?null:convert(row[2]),row[3]===null?null:convert(row[3]),row[4],extra] as typeof row];
      }catch{return [];}
    });
    return {...series,unit:target,semantics:null,cells};
  })}));
}
