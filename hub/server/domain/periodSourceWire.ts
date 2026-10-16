import type {Chunk,HistoryBasis,HistoryReply} from './history.js';
import {PERIOD_SCOPES,type PeriodReply,type PeriodScope} from './periodRead.js';

export type HistoryBases=Partial<Record<PeriodScope,HistoryBasis>>;
export type SourceBases=Partial<Record<PeriodScope,{run:string;meta:string;sourceIds:readonly string[]}>>;
type Slot=Record<string,unknown>;

/** Only these fields name sources; project, device and monetary evidence stay literal. */
function sources(chunks:Chunk[],visit:(slot:Slot,key:string)=>void){
  const row=(value:object,key:string)=>visit(value as Slot,key);
  for(const chunk of chunks){
    for(const series of chunk.series)row(series,'source');
    for(const series of chunk.meterSeries??[])row(series,'source');
    for(const session of chunk.activity.sessions)row(session,'1');
    for(const work of chunk.activity.sourceWork??[])row(work,'0');
    for(const cell of chunk.activity.cells)for(const group of cell[3])if(group[0]==='s')row(group,'1');
    for(const reset of chunk.resets)row(reset,'0');
    for(const grant of chunk.grants)row(grant,'0');
    for(const plan of chunk.plans??[])row(plan,'0');
  }
}

/** The token binds this order, so neither producer nor reader sorts the keys. */
function sourceCount(basis:HistoryBasis){let count=0;for(const id in basis.known.sources)if(Object.hasOwn(basis.known.sources,id))count++;return count;}

/** Serialization borrows the exact matched basis without changing cached chunks. */
export function periodSourceDictionary(reply:PeriodReply,bases:SourceBases,reserve:(bytes:number)=>void){
  const values=new WeakMap<object,object>(),slots=new WeakMap<object,{key:string;index:number}>();
  for(const scope of PERIOD_SCOPES){
    const part=reply[scope],basis=bases[scope];
    if(part?.state!=='complete'||'known' in part.value||!basis?.meta||basis.meta!==part.value.meta||basis.run!==part.value.run)continue;
    reserve(256+basis.sourceIds.length*128);
    const ids=new Map(basis.sourceIds.map((id,index)=>[id,index]));let changed=false;
    sources(part.value.chunks,(slot,key)=>{
      const value=slot[key],index=typeof value==='string'?ids.get(value):undefined;
      if(index===undefined)return;
      reserve(128);slots.set(slot,{key,index});changed=true;
    });
    if(changed){reserve(192);values.set(part.value,{...part.value,sourceEncoding:'basis'});}
  }
  return function(this:unknown,key:string,value:unknown):unknown{
    if(value&&typeof value==='object'&&values.has(value))return values.get(value);
    const slot=this&&typeof this==='object'?slots.get(this):undefined;
    return slot?.key===key?slot.index:value;
  };
}

/** Restore only owned parsed slots while their response reservation is still held. */
export function expandPeriodSources(reply:PeriodReply,bases:HistoryBases,reserve:(bytes:number)=>void){
  for(const scope of PERIOD_SCOPES){
    const part=reply[scope];if(part?.state!=='complete')continue;
    const value=part.value as HistoryReply&{sourceEncoding?:unknown};
    if(value.sourceEncoding===undefined)continue;
    const basis=bases[scope];
    if(value.sourceEncoding!=='basis'||'known' in value||!basis?.meta||basis.meta!==value.meta||basis.run!==value.run)throw new Error('invalid_period_sources');
    const count=sourceCount(basis);let bytes=128;
    for(const id in basis.known.sources)if(Object.hasOwn(basis.known.sources,id))bytes+=32+id.length*2;
    sources(value.chunks,(slot,key)=>{
      const index=slot[key];
      if(typeof index==='number'&&(!Number.isSafeInteger(index)||index<0||index>=count))throw new Error('invalid_period_sources');
    });
    // Replacements reuse the basis strings and the existing tuple/object slots.
    reserve(bytes);const ids=Object.keys(basis.known.sources);
    sources(value.chunks,(slot,key)=>{const index=slot[key];if(typeof index==='number')slot[key]=ids[index];});
    delete value.sourceEncoding;
  }
}
