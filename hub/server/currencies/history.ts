import type {Chunk} from '../domain/history.js';
import type {MeterSemantics} from '../domain/meters.js';
import type {CurrencyStore} from '../store/currencies.js';
import {convertBy,type Conversion} from '../domain/currency.js';

/** Transform the already-accounted native cells; FX changes never become spending. */
export function displayHistory(chunks:readonly Chunk[],currencies:CurrencyStore,owner:string,target:string,cell:number,nativeAt?:(source:string,meter:string,until:number)=>number|null):Chunk[] {
  const bindings=currencies.history(owner,target);
  const result=chunks.map(chunk=>({...chunk,meterSeries:chunk.meterSeries?.map(series=>{
    let semantics=series.semantics,previousMetadata='null';
    type Presented={amount:string;metadata:MeterSemantics|null;encoded:string;convert:(amount:string)=>string};
    const views=new Map<MeterSemantics|null,Map<string,Presented>>();
    const present=(value:string,input:MeterSemantics|null,at:number)=>{
      const proof=input?.conversion,boundAt=bindings.observationAt(series.source,series.unit,at),reportedAt=proof?null:nativeAt?.(series.source,series.meter,at);
      const quoteAt=proof?.original.at??(Math.max(reportedAt??0,boundAt??0)||at),anchor=proof?.rate.id??null;
      const key=JSON.stringify([value,quoteAt,anchor]),cached=views.get(input)?.get(key);if(cached)return cached;
      const path=bindings.binding(series.source,series.unit,quoteAt,anchor);if(!path)return null;
      const amounts=new Map<string,string>();
      const convert=(amount:string)=>{const cached=amounts.get(amount);if(cached!==undefined)return cached;const result=convertBy(amount,path);amounts.set(amount,result);return result;};
      let amount=convert(value),conversion:Conversion|undefined,original=false;
      if(proof&&convertBy(proof.original.amount,proof.steps??[proof.rate])===value) {
        const rootPath=bindings.binding(series.source,proof.original.unit,proof.original.at,proof.rate.id);
        if(rootPath) {
          original=true;amount=convertBy(proof.original.amount,rootPath);
          if(rootPath.length)conversion={original:proof.original,rate:rootPath.at(-1)!,...(rootPath.length>1?{steps:rootPath}:{})};
        }
      }
      if(!original&&path.length)conversion={original:{meterId:series.meter,amount:value,unit:series.unit,at:quoteAt},rate:path.at(-1)!,...(path.length>1?{steps:path}:{})};
      const metadata:MeterSemantics|null=input?{...input,limit:input.limit===null?null:convert(input.limit),...(conversion?{conversion}:{conversion:undefined})}:null;
      const shown={amount,metadata,encoded:JSON.stringify(metadata),convert};
      let saved=views.get(input);if(!saved)views.set(input,(saved=new Map()));saved.set(key,shown);return shown;
    };
    const cells=series.cells.flatMap(row=>{
      const old=semantics;semantics=row[5]?.semantics??semantics;
      const grid=chunk.from+row[0]*cell,at=grid+(row[5]?.pointOffsetMs??cell-1);
      try {
        const shown=present(row[1],semantics,at);if(!shown)return [];
        const {convert,metadata,encoded}=shown,{semantics:_semantics,openSemantics:_opening,...rest}=row[5]??{};
        const extra={...rest,...(row[5]?.first!==undefined?{first:convert(row[5].first)}:{}),...(row[5]?.steps?{steps:row[5].steps.map(step=>({...step,amount:convert(step.amount)}))}:{}),...(row[5]?.topupSteps?{topupSteps:row[5].topupSteps.map(step=>({...step,amount:convert(step.amount)}))}:{}),...(row[5]?.topupInternal!==undefined?{topupInternal:convert(row[5].topupInternal)}:{})} as NonNullable<typeof row[5]>;
        if(metadata&&encoded!==previousMetadata)extra.semantics=metadata;
        previousMetadata=encoded;
        if(row[5]?.open!=null) {
          const opening=present(row[5].open,row[5].openSemantics??(series.pointMode==='observation'?semantics:old??semantics),grid+(row[5].openOffsetMs??0));
          extra.open=opening?.amount??null;
          if(opening?.metadata&&opening.encoded!==encoded)extra.openSemantics=opening.metadata;
        }
        return [[row[0],shown.amount,row[2]===null?null:convert(row[2]),row[3]===null?null:convert(row[3]),row[4],extra] as typeof row];
      }catch{return [];}
    });
    return {...series,unit:target,semantics:null,cells};
  })}));
  bindings.flush();return result;
}
