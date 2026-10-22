import type {WorkTimeline} from '../../server/domain/periodCurves';
import {calendarProjection,calendarCurve,type CalendarSegment} from '../../server/domain/calendarWork';
import type {CalendarBasis,CalendarValue} from '../../server/domain/workCalendar';
import type {PeriodSelection} from '../../server/domain/period';
import type {CalendarReading,calendarWindow} from './workCalendar';

type Entry={basis:CalendarBasis;zone:string;from:number;to:number;cut:number;known:number|null;retained:number;retention:number;period?:number;cursor:string;curve:WorkTimeline;bytes:number;at:number};

/** Only anonymous integrals are retained; the board's shared pool can evict any frame. */
export class CalendarCache {
  private entries=new Set<Entry>();
  private borrowed=new Map<Entry,number>();
  private revision=0;
  get bytes(){
    let bytes=0;for(const entry of this.entries)bytes+=entry.bytes;
    for(const entry of this.borrowed.keys())if(!this.entries.has(entry))bytes+=entry.bytes;
    return bytes;
  }
  clear(){this.revision++;this.entries.clear();}
  // Evicting a cache owner cannot free storage still borrowed by a projection.
  evictionCandidates(){return [...this.entries].map(e=>({bytes:this.borrowed.has(e)?0:e.bytes,shownAt:e.at,drop:()=>{this.entries.delete(e);}}));}
  add(basis:CalendarBasis,value:CalendarValue,reserve:(bytes:number)=>boolean,staging:number){
    const proof=value.proof;if(!proof)return;
    if([...this.entries].some(e=>e.basis.run!==basis.run||e.basis.revision!==basis.revision))this.clear();
    let bytes=staging;
    try{
      const result=calendarCurve(proof,basis.range,basis.evidenceCut,value.availableFrom,size=>{bytes+=size;if(!reserve(bytes))throw new Error('calendar_cache_limit');});
      const entry:Entry={basis,zone:value.zone,from:basis.range.from,to:basis.range.to,cut:basis.evidenceCut,known:value.availableFrom,retained:value.retainedFrom,retention:proof.retentionMs,period:proof.periodMs,cursor:value.cursor,curve:result.curve,bytes:1024+result.bytes,at:basis.evaluatedAt};
      if(!reserve(bytes+1024))return;
      for(const prior of this.entries)if(prior.from===entry.from&&prior.to===entry.to)this.entries.delete(prior);
      this.entries.add(entry);
    }catch(error){if(!(error instanceof Error)||error.message!=='calendar_cache_limit')throw error;}
    finally{reserve(staging);}
  }
  read(window:ReturnType<typeof calendarWindow>,selection:PeriodSelection,now:number,reserve:(bytes:number)=>boolean):CalendarReading|null {
    const entries=[...this.entries].filter(e=>e.zone===window.zone&&e.basis.evidenceCut<=now);if(!entries.length)return null;
    const latest=entries.reduce((a,b)=>a.cut>b.cut?a:b),range=window.range,cut=Math.min(range.to,latest.cut),segments:CalendarSegment[]=[];
    const retained=Math.max(latest.retained,now-latest.retention);if(range.to<=retained||range.from>=now)return null;
    if(selection.mode==='range'&&range.to>latest.cut&&!entries.some(e=>e.from<=range.from&&e.to>=range.to))return null;
    let from=range.from;
    while(from<cut){
      const next=entries.filter(e=>e.from<=from&&e.cut>from).sort((a,b)=>b.cut-a.cut)[0];if(!next)return null;
      const to=Math.min(cut,next.cut);segments.push({from,to,curve:next.curve});from=to;
    }
    if(!segments.length&&!entries.some(e=>e.from<=range.from&&e.to>=range.to))return null;
    // LRU removal retires the cache owner, but a synchronous projection still owns
    // its captured curves. Count that shared storage once until the last read ends.
    const revision=this.revision;
    for(const entry of entries)this.borrowed.set(entry,(this.borrowed.get(entry)??0)+1);
    try{
      if(!reserve(1024+window.edges.length*256+window.dates.length*256)||revision!==this.revision)return null;
      const available=entries.flatMap(e=>e.known===null?[]:[e.known]),known=available.length?Math.min(...available):null;
      const cells=calendarProjection(window.edges,range,cut,known,retained,latest.retention,selection.mode==='live'?selection.periodMs:undefined,segments);
      const day=86_400_000,cursor=entries.find(e=>selection.mode==='range'?e.period===undefined&&e.from===range.from&&e.to===range.to:e.period===selection.periodMs&&Math.floor(e.from/day)*day===window.edges[0]&&Math.ceil(e.to/day)*day===window.edges.at(-1));
      for(const e of entries)if(segments.some(s=>s.curve===e.curve))e.at=now;
      return {window,value:{zone:window.zone,edges:window.edges,availableFrom:known,retainedFrom:retained,cursor:cursor?.cursor??'',cells},basis:{...(cursor??latest).basis,evaluatedAt:now,evidenceCut:cut,range},loading:false,error:null};
    }finally{
      for(const entry of entries){const remaining=this.borrowed.get(entry)!-1;if(remaining)this.borrowed.set(entry,remaining);else this.borrowed.delete(entry);}
    }
  }
}
