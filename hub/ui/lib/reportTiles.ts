import type {ReportInterval,ReportSeries} from '../../server/domain/reports';
import type {Preparation} from './prepare';

const encoder=new TextEncoder(),decoder=new TextDecoder();
type Packed={series:Omit<ReportSeries,'intervals'>;rows:Map<number,{to:number;bytes:Uint8Array}>};
/** Reports retain their original bounds in small byte leaves within the shared budget. */
export class ReportTile {
  private readonly series=new Map<string,Packed>();
  get bytes(){let bytes=0;for(const s of this.series.values()){bytes+=256;for(const row of s.rows.values())bytes+=row.bytes.byteLength+128;}return bytes;}
  *clonePrepared():Preparation<ReportTile>{const copy=new ReportTile();for(const [key,s] of this.series){copy.series.set(key,s);yield;}return copy;}
  *mergePrepared(from:number,to:number,series:readonly ReportSeries[]):Preparation<void> {
    for(const [key,s] of this.series){const rows=new Map(s.rows);for(const [at,row] of rows){if(at<to&&row.to>from)rows.delete(at);yield;}this.series.set(key,{...s,rows});}
    for(const s of series) {
      const key=JSON.stringify([s.source,s.meter,s.unit]);let packed=this.series.get(key);
      if(!packed){packed={series:{source:s.source,meter:s.meter,kind:s.kind,unit:s.unit},rows:new Map()};this.series.set(key,packed);}
      for(const row of s.intervals){packed.rows.set(row.from,{to:row.to,bytes:encoder.encode(JSON.stringify(row))});yield;}
    }
    for(const [key,s] of this.series){if(!s.rows.size)this.series.delete(key);yield;}
  }
  *chunkPrepared(from:number,to:number):Preparation<ReportSeries[]> {
    const result:ReportSeries[]=[];
    for(const s of this.series.values()) {
      const intervals:ReportInterval[]=[];
      for(const [at,row] of s.rows){if(at<to&&row.to>from)intervals.push(JSON.parse(decoder.decode(row.bytes)));yield;}
      if(intervals.length)result.push({...s.series,intervals});
    }
    return result;
  }
}
