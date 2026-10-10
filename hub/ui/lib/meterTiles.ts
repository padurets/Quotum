import {meterIdentity, type MeterCell, type MeterSeriesCells} from '../../server/domain/meterHistory';
import type {ExceptionalStep, MeterSemantics} from '../../server/domain/meters';
import {drain, type Preparation} from './prepare';
import {ordered} from '../../server/domain/prepare';
import {MeterMetadata} from './meterMetadata';

type StoredCell = {row: MeterCell; before: MeterSemantics | null; semantics: MeterSemantics | null};
type PackedCell = {data: Uint8Array; references: number[]; bytes: number};
type Packed = {series: Omit<MeterSeriesCells,'cells'|'semantics'>; cells: Map<number,PackedCell>; bytes: number};
type EncodedExtra = Omit<NonNullable<MeterCell[5]>, 'semantics' | 'openSemantics' | 'observations'> & {openSemantics?: number};
type Header = {row: [number, string, string | null, string | null, number, EncodedExtra]; before: number | null; semantics: number | null; steps: number; topupSteps: number; observations?: number};
type PackedHeader = [Header['before'],Header['semantics'],[number,string,string|null,string|null,number,Record<string,unknown>],number,number,number?];
const encoder=new TextEncoder(),decoder=new TextDecoder();
const fields=['pointOffsetMs','openOffsetMs','openSemantics','validUntil','first','open','segment','knownFrom','knownUntil','topupInternal','at','value','semantics','from','to','amount','evidence'];
// Cell headers and interval leaves repeat the same field names thousands of times.
// Short local keys keep every value and unknown field without retaining those names.
const compact=(value:object)=>Object.fromEntries(Object.entries(value).map(([key,value])=>{const index=fields.indexOf(key);return [index<0?'x:'+key:String(index),value];}));
const expand=<T>(value:object):T=>Object.fromEntries(Object.entries(value).map(([key,value])=>[key.startsWith('x:')?key.slice(2):fields[Number(key)],value])) as T;

/** Each JSON leaf is small; interval arrays never become one synchronous JSON operation. */
function* pack(cell:StoredCell, metadata:MeterMetadata):Preparation<PackedCell> {
  const references=new Set<number>(),keep=(value:MeterSemantics|null)=>metadata.retainSemantics(value,references);
  const {steps=[],topupSteps=[],observations,semantics:_semantics,openSemantics,...extra}=cell.row[5]??{};
  const row=[...cell.row.slice(0,5),compact({...extra,...(openSemantics?{openSemantics:keep(openSemantics)}:{})})] as PackedHeader[2];
  const head:PackedHeader=[keep(cell.before),keep(cell.semantics),row,steps.length,topupSteps.length];if(observations)head[5]=observations.length;
  const parts:Uint8Array[]=[encoder.encode(JSON.stringify(head))];
  let length=4+parts[0].byteLength;yield;
  for(const values of [steps,topupSteps])for(const step of values){const bytes=encoder.encode(JSON.stringify(compact(step)));parts.push(bytes);length+=4+bytes.byteLength;yield;}
  for(const point of observations??[]){const bytes=encoder.encode(JSON.stringify(compact({...point,...(point.semantics?{semantics:keep(point.semantics)}:{})})));parts.push(bytes);length+=4+bytes.byteLength;yield;}
  const result=new Uint8Array(length),view=new DataView(result.buffer);
  let at=0;
  for(const bytes of parts){view.setUint32(at,bytes.byteLength);result.set(bytes,at+4);at+=4+bytes.byteLength;yield;}
  return {data:result,references:[...references],bytes:result.byteLength+128+references.size*8};
}
const header=(bytes:Uint8Array):Header=>{
  const [before,semantics,row,steps,topupSteps,observations]=JSON.parse(decoder.decode(bytes.subarray(4,4+new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0)))) as PackedHeader;
  return {before,semantics,row:[row[0],row[1],row[2],row[3],row[4],expand(row[5])],steps,topupSteps,...(observations===undefined?{}:{observations})};
};
function* unpack(bytes:Uint8Array,metadata:MeterMetadata):Preparation<StoredCell> {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),head=header(bytes);
  let at=4+view.getUint32(0);yield;
  const {openSemantics,...rest}=head.row[5];
  const extra:NonNullable<MeterCell[5]>={...rest,...(openSemantics===undefined?{}:{openSemantics:metadata.semantics(openSemantics)!})};
  for(const [name,count] of [['steps',head.steps],['topupSteps',head.topupSteps]] as const) {
    if(!count)continue;
    const steps:ExceptionalStep[]=[];
    for(let i=0;i<count;i++){const size=view.getUint32(at);steps.push(expand(JSON.parse(decoder.decode(bytes.subarray(at+4,at+4+size)))));at+=4+size;yield;}
    extra[name]=steps;
  }
  if(head.observations!==undefined) {
    const observations:NonNullable<typeof extra.observations>=[];
    for(let i=0;i<head.observations;i++){
      const size=view.getUint32(at),point=expand<Omit<NonNullable<typeof extra.observations>[number],'semantics'>&{semantics?:number|null}>(JSON.parse(decoder.decode(bytes.subarray(at+4,at+4+size))));
      const {semantics,...rest}=point;observations.push({...rest,...(semantics===undefined?{}:{semantics:metadata.semantics(semantics)})});at+=4+size;yield;
    }
    extra.observations=observations;
  }
  return {row:[head.row[0],head.row[1],head.row[2],head.row[3],head.row[4],extra],before:metadata.semantics(head.before),semantics:metadata.semantics(head.semantics)};
}

/** Exact strings and interval metadata use byte buffers, within the shared tile budget. */
export class MeterTile {
  private readonly series=new Map<string,Packed>();
  private metadata=new MeterMetadata();
  constructor(private readonly from:number,private readonly cell:number) {}
  get bytes(){return this.metadata.bytes+[...this.series.values()].reduce((sum,s)=>sum+s.bytes+256,0);}
  *clonePrepared():Preparation<MeterTile> {
    const copy=new MeterTile(this.from,this.cell);
    copy.metadata=yield* this.metadata.clonePrepared();
    for(const [key,packed] of this.series){copy.series.set(key,packed);yield;}
    return copy;
  }
  merge(from:number,to:number,series:readonly MeterSeriesCells[]) {drain(this.mergePrepared(from,to,series));}
  *mergePrepared(from:number,to:number,series:readonly MeterSeriesCells[]):Preparation<void> {
    const first=(from-this.from)/this.cell,last=(to-this.from)/this.cell;
    for(const [key,packed] of this.series) {
      const cells=new Map<number,PackedCell>();
      let size=0;
      for(const [i,cell] of packed.cells){if(i<first||i>=last){cells.set(i,cell);size+=cell.bytes;}else for(const id of cell.references)this.metadata.release(id);yield;}
      this.series.set(key,{...packed,cells,bytes:size});
    }
    for(const s of series) {
      const key=meterIdentity(s);
      let packed=this.series.get(key);
      if(!packed){packed={series:{source:s.source,meter:s.meter,kind:s.kind,unit:s.unit,accounting:s.accounting,role:s.role,pointMode:s.pointMode},cells:new Map(),bytes:0};this.series.set(key,packed);}
      let semantics=s.semantics;
      for(const row of s.cells) {
        const before=semantics;
        semantics=row[5]?.semantics??semantics;
        const index=first+row[0];
        const cell=yield* pack({row:[index,...row.slice(1)] as MeterCell,before,semantics},this.metadata);
        // Count each packed cell while the rest of this private tile is still yielding.
        const previous=packed.cells.get(index);
        if(previous)for(const id of previous.references)this.metadata.release(id);
        packed.bytes+=cell.bytes-(previous?.bytes??0);
        packed.cells.set(index,cell);
      }
    }
    for(const [key,packed] of this.series)if(!packed.cells.size)this.series.delete(key);
  }
  chunk(from:number,to:number):MeterSeriesCells[] {return drain(this.chunkPrepared(from,to));}
  *chunkPrepared(from:number,to:number):Preparation<MeterSeriesCells[]> {
    const first=(from-this.from)/this.cell,last=(to-this.from)/this.cell;
    const result:MeterSeriesCells[]=[];
    for(const packed of this.series.values()) {
      const all=yield* ordered(packed.cells,(a,b)=>a[0]-b[0]);
      const cells:MeterCell[]=[];
      let before:MeterSemantics|null=null;
      for(const [i,cell] of all){const head=header(cell.data);if(i<first)before=this.metadata.semantics(head.semantics);else{before??=this.metadata.semantics(head.before);break;}yield;}
      let semantics=before;
      for(const [i,cell] of all)if(i>=first && i<last) {
        const c=yield* unpack(cell.data,this.metadata);
        const extra={...c.row[5]};
        if(c.semantics && JSON.stringify(c.semantics)!==JSON.stringify(semantics))extra.semantics=c.semantics;
        semantics=c.semantics;
        cells.push([i-first,c.row[1],c.row[2],c.row[3],c.row[4],extra]);
      }
      if(cells.length)result.push({...packed.series,semantics:before,cells});
    }
    return result;
  }
}
