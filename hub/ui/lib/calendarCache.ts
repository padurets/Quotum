import type {WorkTimeline} from '../../server/domain/periodCurves';
import {calendarProjection,calendarCurve,type CalendarSegment} from '../../server/domain/calendarWork';
import type {CalendarBasis,CalendarValue} from '../../server/domain/workCalendar';
import type {PeriodSelection} from '../../server/domain/period';
import type {CalendarReading,calendarWindow} from './workCalendar';

type Entry={basis:CalendarBasis;zone:string;from:number;to:number;cut:number;validBefore:number;known:number|null;retained:number;retention:number;period?:number;cursor:string;curve:WorkTimeline;bytes:number;at:number};

/** Only anonymous integrals are retained; the board's shared pool can evict any frame. */
export class CalendarCache {
  private entries=new Set<Entry>();
  get bytes(){return [...this.entries].reduce((n,e)=>n+e.bytes,0);}
  clear(){this.entries.clear();}
  invalidate(since:number){
    for(const entry of this.entries){
      if(since<=entry.from){this.entries.delete(entry);continue;}
      // A later credit changes the tail, not the integrals before its first instant.
      entry.validBefore=Math.min(entry.validBefore,since);entry.to=Math.min(entry.to,since);entry.cut=Math.min(entry.cut,since);
    }
  }
  evictionCandidates(){return [...this.entries].map(e=>({bytes:e.bytes,shownAt:e.at,drop:()=>{this.entries.delete(e);}}));}
  add(basis:CalendarBasis,value:CalendarValue,reserve:(bytes:number)=>boolean,staging:number){
    const proof=value.proof;if(!proof)return;
    // A newer revision can change only a tail. dirty() already bounded every
    // affected proof; unrelated news must not discard its reusable prefix.
    if([...this.entries].some(e=>e.basis.run!==basis.run||e.basis.filterKey!==basis.filterKey||e.basis.workAuthority!==basis.workAuthority||e.zone!==value.zone))this.clear();
    let bytes=staging;
    try{
      const result=calendarCurve(proof,basis.range,basis.evidenceCut,value.availableFrom,size=>{bytes+=size;if(!reserve(bytes))throw new Error('calendar_cache_limit');});
      const entry:Entry={basis,zone:value.zone,from:basis.range.from,to:basis.range.to,cut:Math.min(basis.range.to,basis.evidenceCut),validBefore:Infinity,known:value.availableFrom,retained:value.retainedFrom,retention:proof.retentionMs,period:proof.periodMs,cursor:value.cursor,curve:result.curve,bytes:1024+result.bytes,at:basis.evaluatedAt};
      if(!reserve(bytes+1024))return;
      for(const prior of this.entries)if(prior.from===entry.from&&prior.to===entry.to)this.entries.delete(prior);
      this.entries.add(entry);
    }catch(error){if(!(error instanceof Error)||error.message!=='calendar_cache_limit')throw error;}
    finally{reserve(staging);}
  }
  read(window:ReturnType<typeof calendarWindow>,selection:PeriodSelection,now:number,reserve:(bytes:number)=>boolean):CalendarReading|null {
    const entries=[...this.entries].filter(e=>e.zone===window.zone&&e.basis.evidenceCut<=now);if(!entries.length)return null;
    const latest=entries.reduce((a,b)=>a.basis.evidenceCut>b.basis.evidenceCut?a:b),range=window.range,segments:CalendarSegment[]=[];
    // A live proof can retain its own observation cutoff as the clock moves.
    // Historical-only curves must cover the live tail, never declare it empty.
    const liveCut=selection.mode==='live'?entries.reduce((cut,e)=>e.period===selection.periodMs?Math.max(cut,e.basis.evidenceCut):cut,-Infinity):-Infinity;
    const cut=Math.min(range.to,selection.mode==='live'?(Number.isFinite(liveCut)?liveCut:now):latest.basis.evidenceCut);
    const retained=Math.max(latest.retained,now-latest.retention);if(range.to<=retained||range.from>=now)return null;
    if(selection.mode==='range'&&range.to>latest.basis.evidenceCut&&!entries.some(e=>e.from<=range.from&&e.to>=range.to))return null;
    let from=range.from;
    while(from<cut){
      const next=entries.filter(e=>e.from<=from&&e.cut>from).sort((a,b)=>b.cut-a.cut)[0];if(!next)return null;
      const to=Math.min(cut,next.cut);segments.push({from,to,curve:next.curve});from=to;
    }
    if(!segments.length&&!entries.some(e=>e.from<=range.from&&e.to>=range.to))return null;
    // A trim may evict these entries while this projection still reads their curves.
    if(!reserve(this.bytes+1024+window.edges.length*256+window.dates.length*256))return null;
    const available=entries.flatMap(e=>e.known===null?[]:[e.known]),known=available.length?Math.min(...available):null;
    const cells=calendarProjection(window.edges,range,cut,known,retained,latest.retention,selection.mode==='live'?selection.periodMs:undefined,segments);
    const day=86_400_000,cursor=entries.find(e=>selection.mode==='range'?e.period===undefined&&range.to<=e.validBefore&&e.basis.range.from===range.from&&e.basis.range.to===range.to:e.period===selection.periodMs&&e.validBefore===Infinity&&Math.floor(e.from/day)*day===window.edges[0]&&Math.ceil(e.to/day)*day===window.edges.at(-1));
    for(const e of entries)if(segments.some(s=>s.curve===e.curve))e.at=now;
    return {window,value:{zone:window.zone,edges:window.edges,availableFrom:known,retainedFrom:retained,cursor:cursor?.cursor??'',cells},basis:{...(cursor??latest).basis,evaluatedAt:now,evidenceCut:cut,range},loading:false,error:null};
  }
}
