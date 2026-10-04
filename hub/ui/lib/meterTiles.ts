import {meterIdentity, type MeterCell, type MeterSeriesCells} from '../../server/domain/meterHistory';
import type {MeterSemantics} from '../../server/domain/meters';
import type {Preparation} from './prepare';

type StoredCell = {row: MeterCell; before: MeterSemantics | null; semantics: MeterSemantics | null};
type Packed = {series: Omit<MeterSeriesCells,'cells'|'semantics'>; bytes: Uint8Array};
const encoder=new TextEncoder(),decoder=new TextDecoder();

/** Exact strings and interval metadata use byte buffers, within the shared tile budget. */
export class MeterTile {
  private readonly series=new Map<string,Packed>();
  constructor(private readonly from:number,private readonly cell:number) {}
  get bytes(){return [...this.series.values()].reduce((sum,s)=>sum+s.bytes.byteLength+256,0);}
  *clonePrepared():Preparation<MeterTile> {
    const copy=new MeterTile(this.from,this.cell);
    for(const [key,packed] of this.series){copy.series.set(key,{...packed});yield;}
    return copy;
  }
  merge(from:number,to:number,series:readonly MeterSeriesCells[]) {
    const first=(from-this.from)/this.cell,last=(to-this.from)/this.cell;
    const rows=new Map<string,Map<number,StoredCell>>();
    for(const [key,packed] of this.series) {
      const cells=new Map<number,StoredCell>(JSON.parse(decoder.decode(packed.bytes)));
      for(const i of cells.keys())if(i>=first && i<last)cells.delete(i);
      rows.set(key,cells);
    }
    for(const s of series) {
      const key=meterIdentity(s);
      const cells=rows.get(key)??new Map<number,StoredCell>();
      rows.set(key,cells);
      let semantics=s.semantics;
      for(const row of s.cells) {
        const before=semantics;
        semantics=row[5]?.semantics??semantics;
        const index=first+row[0];
        cells.set(index,{row:[index,...row.slice(1)] as MeterCell,before,semantics});
      }
      if(!this.series.has(key))this.series.set(key,{series:{source:s.source,meter:s.meter,kind:s.kind,unit:s.unit},bytes:new Uint8Array()});
    }
    for(const [key,cells] of rows) {
      if(!cells.size){this.series.delete(key);continue;}
      this.series.get(key)!.bytes=encoder.encode(JSON.stringify([...cells].sort((a,b)=>a[0]-b[0])));
    }
  }
  chunk(from:number,to:number):MeterSeriesCells[] {
    const first=(from-this.from)/this.cell,last=(to-this.from)/this.cell;
    return [...this.series.values()].flatMap(packed=>{
      const all=JSON.parse(decoder.decode(packed.bytes)) as [number,StoredCell][];
      const cells:MeterCell[]=[];
      const header=all.filter(([i])=>i<first).at(-1)?.[1].semantics??all.find(([i])=>i>=first)?.[1].before??null;
      let semantics=header;
      for(const [i,c] of all)if(i>=first && i<last) {
        const extra={...c.row[5]};
        if(c.semantics && JSON.stringify(c.semantics)!==JSON.stringify(semantics))extra.semantics=c.semantics;
        semantics=c.semantics;
        cells.push([i-first,c.row[1],c.row[2],c.row[3],c.row[4],extra]);
      }
      return cells.length?[{...packed.series,semantics:header,cells}]:[];
    });
  }
}
