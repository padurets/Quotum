import {meterIdentity, type MeterCell, type MeterSeriesCells} from '../../server/domain/meterHistory';
import type {ExceptionalStep, MeterSemantics} from '../../server/domain/meters';
import {drain, type Preparation} from './prepare';
import {ordered} from '../../server/domain/prepare';

type StoredCell = {row: MeterCell; before: MeterSemantics | null; semantics: MeterSemantics | null};
type Packed = {series: Omit<MeterSeriesCells,'cells'|'semantics'>; cells: Map<number,Uint8Array>; bytes: number};
const encoder=new TextEncoder(),decoder=new TextDecoder();

/** Each JSON leaf is small; interval arrays never become one synchronous JSON operation. */
function* pack(cell:StoredCell):Preparation<Uint8Array> {
  const {steps=[],topupSteps=[],observations,...extra}=cell.row[5]??{};
  const head={...cell,row:[...cell.row.slice(0,5),extra],steps:steps.length,topupSteps:topupSteps.length,...(observations?{observations:observations.length}:{})};
  const parts:Uint8Array[]=[encoder.encode(JSON.stringify(head))];
  let length=4+parts[0].byteLength;yield;
  for(const values of [steps,topupSteps,observations??[]])for(const step of values){const bytes=encoder.encode(JSON.stringify(step));parts.push(bytes);length+=4+bytes.byteLength;yield;}
  const result=new Uint8Array(length),view=new DataView(result.buffer);
  let at=0;
  for(const bytes of parts){view.setUint32(at,bytes.byteLength);result.set(bytes,at+4);at+=4+bytes.byteLength;yield;}
  return result;
}
const header=(bytes:Uint8Array):StoredCell&{steps:number;topupSteps:number;observations?:number}=>JSON.parse(decoder.decode(bytes.subarray(4,4+new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0))));
function* unpack(bytes:Uint8Array):Preparation<StoredCell> {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),head=header(bytes);
  let at=4+view.getUint32(0);yield;
  const extra={...head.row[5]};
  for(const [name,count] of [['steps',head.steps],['topupSteps',head.topupSteps]] as const) {
    if(!count)continue;
    const steps:ExceptionalStep[]=[];
    for(let i=0;i<count;i++){const size=view.getUint32(at);steps.push(JSON.parse(decoder.decode(bytes.subarray(at+4,at+4+size))));at+=4+size;yield;}
    extra[name]=steps;
  }
  if(head.observations!==undefined) {
    const observations:NonNullable<typeof extra.observations>=[];
    for(let i=0;i<head.observations;i++){const size=view.getUint32(at);observations.push(JSON.parse(decoder.decode(bytes.subarray(at+4,at+4+size))));at+=4+size;yield;}
    extra.observations=observations;
  }
  return {row:[head.row[0],head.row[1],head.row[2],head.row[3],head.row[4],extra],before:head.before,semantics:head.semantics};
}

/** Exact strings and interval metadata use byte buffers, within the shared tile budget. */
export class MeterTile {
  private readonly series=new Map<string,Packed>();
  constructor(private readonly from:number,private readonly cell:number) {}
  get bytes(){return [...this.series.values()].reduce((sum,s)=>sum+s.bytes+256,0);}
  *clonePrepared():Preparation<MeterTile> {
    const copy=new MeterTile(this.from,this.cell);
    for(const [key,packed] of this.series){copy.series.set(key,packed);yield;}
    return copy;
  }
  merge(from:number,to:number,series:readonly MeterSeriesCells[]) {drain(this.mergePrepared(from,to,series));}
  *mergePrepared(from:number,to:number,series:readonly MeterSeriesCells[]):Preparation<void> {
    const first=(from-this.from)/this.cell,last=(to-this.from)/this.cell;
    for(const [key,packed] of this.series) {
      const cells=new Map<number,Uint8Array>();
      let size=0;
      for(const [i,bytes] of packed.cells){if(i<first||i>=last){cells.set(i,bytes);size+=bytes.byteLength+128;}yield;}
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
        const bytes=yield* pack({row:[index,...row.slice(1)] as MeterCell,before,semantics});
        // Count each packed cell while the rest of this private tile is still yielding.
        packed.bytes+=bytes.byteLength+128-(packed.cells.has(index)?packed.cells.get(index)!.byteLength+128:0);
        packed.cells.set(index,bytes);
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
      for(const [i,bytes] of all){const head=header(bytes);if(i<first)before=head.semantics;else{before??=head.before;break;}yield;}
      let semantics=before;
      for(const [i,bytes] of all)if(i>=first && i<last) {
        const c=yield* unpack(bytes);
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
