import type {Chunk} from '../domain/history.js';
import type {MeterSemantics} from '../domain/meters.js';
import type {MeterObservation} from '../domain/meterHistory.js';
import type {CurrencyStore} from '../store/currencies.js';
import {convertBy,type Conversion} from '../domain/currency.js';

/** Transform the already-accounted native cells; FX changes never become spending. */
export function displayHistory(chunks:readonly Chunk[],currencies:CurrencyStore,owner:string,target:string,cell:number,nativeAt?:(source:string,meter:string,until:number)=>number|null):Chunk[] {
  const from=Math.min(...chunks.map(c=>c.from)),to=Math.max(...chunks.map(c=>c.to??c.from+((c.meterSeries??[]).reduce((n,s)=>Math.max(n,...s.cells.map(r=>r[0]+1)),0))*cell));
  const bindings=currencies.history(owner,target,from,to);
  const result=chunks.map(chunk=>({...chunk,meterSeries:chunk.meterSeries?.map(series=>{
    let semantics=series.semantics,previousMetadata='null';
    type Presented={amount:string;metadata:MeterSemantics|null;encoded:string;convert:(amount:string)=>string};
    const views=new Map<MeterSemantics|null,Map<string,Presented>>();
    const present=(value:string,input:MeterSemantics|null,at:number)=>{
      const proof=input?.conversion,boundAt=Math.max(bindings.observationAt(series.source,series.unit,at)??0,proof?bindings.observationAt(series.source,proof.original.unit,at)??0:0),reportedAt=nativeAt?.(series.source,series.meter,at);
      const quoteAt=Math.max(proof?.original.at??0,reportedAt??0,boundAt)||at,anchor=proof?.rate.id??null;
      const key=JSON.stringify([value,quoteAt,anchor]),cached=views.get(input)?.get(key);if(cached)return cached;
      const path=bindings.binding(series.source,series.unit,quoteAt,anchor);if(!path)return null;
      const amounts=new Map<string,string>();
      const convert=(amount:string)=>{const cached=amounts.get(amount);if(cached!==undefined)return cached;const result=convertBy(amount,path);amounts.set(amount,result);return result;};
      let amount=convert(value),conversion:Conversion|undefined,original=false;
      if(proof&&convertBy(proof.original.amount,proof.steps??[proof.rate])===value) {
        const rootPath=bindings.binding(series.source,proof.original.unit,quoteAt,proof.rate.id);
        if(rootPath) {
          original=true;amount=convertBy(proof.original.amount,rootPath);
          if(rootPath.length)conversion={original:{...proof.original,at:quoteAt},rate:rootPath.at(-1)!,...(rootPath.length>1?{steps:rootPath}:{})};
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
        if(series.pointMode==='observation') {
          const start=grid+(row[5]?.pointOffsetMs??0),end=row[5]?.validUntil??grid+cell,openingAt=grid+(row[5]?.openOffsetMs??0),observations:MeterObservation[]=[];
          const segments=[...(row[5]?.open!=null&&openingAt<start?[{from:openingAt,to:start,value:row[5].open,semantics:row[5].openSemantics??semantics}]:[]),{from:start,to:end,value:row[1],semantics}];
          for(const segment of segments) {
            const proof=segment.semantics?.conversion,unit=proof?.original.unit??series.unit,anchor=proof?.rate.id??null;
            const latest=nativeAt?.(series.source,series.meter,segment.to-1);
            const events=[segment.from,...bindings.changes(series.source,unit,segment.from,segment.to,anchor),...(latest!=null&&latest>segment.from&&latest<segment.to?[latest]:[])].sort((a,b)=>a-b);
            const times=[...new Set(events)];
            for(let index=0;index<times.length;index++) {
              const shown=present(segment.value,segment.semantics,times[index]);if(!shown)continue;
              observations.push({at:times[index],value:shown.amount,validUntil:times[index+1]??segment.to,semantics:shown.metadata});
            }
          }
          if(!observations.length)return [];
          const first=observations[0],last=observations.at(-1)!,metadata=last.semantics??null,encoded=JSON.stringify(metadata),{semantics:_semantics,openSemantics:_opening,...rest}=row[5]??{};
          const extra={...rest,pointOffsetMs:last.at-grid,validUntil:last.validUntil,open:observations.length>1||first.at===grid?first.value:null,...(first.at>grid?{openOffsetMs:first.at-grid}:{}),...(encoded!==previousMetadata?{semantics:metadata??undefined}:{}),...(observations.length>1&&JSON.stringify(first.semantics??null)!==encoded?{openSemantics:first.semantics??undefined}:{})} as NonNullable<typeof row[5]>;
          if(observations.length>2){for(const point of observations)if(JSON.stringify(point.semantics??null)===encoded)delete point.semantics;extra.observations=observations;}
          previousMetadata=encoded;
          return [[row[0],last.value,null,null,row[4],extra] as typeof row];
        }
        const shown=present(row[1],semantics,at);if(!shown)return [];
        const {convert,metadata,encoded}=shown,{semantics:_semantics,openSemantics:_opening,...rest}=row[5]??{};
        const extra={...rest,...(row[5]?.first!==undefined?{first:convert(row[5].first)}:{}),...(row[5]?.steps?{steps:row[5].steps.map(step=>({...step,amount:convert(step.amount)}))}:{}),...(row[5]?.topupSteps?{topupSteps:row[5].topupSteps.map(step=>({...step,amount:convert(step.amount)}))}:{}),...(row[5]?.topupInternal!==undefined?{topupInternal:convert(row[5].topupInternal)}:{})} as NonNullable<typeof row[5]>;
        if(metadata&&encoded!==previousMetadata)extra.semantics=metadata;
        previousMetadata=encoded;
        if(row[5]?.open!=null) {
          const opening=present(row[5].open,row[5].openSemantics??old??semantics,grid+(row[5].openOffsetMs??0));
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
