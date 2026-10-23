import type {WorkTimeline} from '../../server/domain/periodCurves';
import {calendarProjection,calendarCurve,type CalendarSegment} from '../../server/domain/calendarWork';
import type {CalendarBasis,CalendarValue} from '../../server/domain/workCalendar';
import type {PeriodSelection} from '../../server/domain/period';
import type {CalendarReading,calendarWindow} from './workCalendar';

type Entry={basis:CalendarBasis;zone:string;from:number;to:number;cut:number;validBefore:number;known:number|null;retained:number;retention:number;period?:number;cursor:string;curve:WorkTimeline;bytes:number;at:number};

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
  invalidate(since:number){
    if(since===Infinity)return;
    this.revision++;
    for(const entry of this.entries){
      if(since<=entry.from){this.entries.delete(entry);continue;}
      // A later credit changes the tail, not the integrals before its first instant.
      entry.validBefore=Math.min(entry.validBefore,since);entry.to=Math.min(entry.to,since);entry.cut=Math.min(entry.cut,since);
    }
  }
  // Evicting a cache owner cannot free storage still borrowed by a projection.
  evictionCandidates(){return [...this.entries].map(e=>({bytes:this.borrowed.has(e)?0:e.bytes,shownAt:e.at,drop:()=>{this.entries.delete(e);}}));}
  add(basis:CalendarBasis,value:CalendarValue,reserve:(bytes:number)=>boolean,staging:number){
    const proof=value.proof;if(!proof)return;
    // A newer revision can change only a tail. dirty() already bounded every
    // affected proof; unrelated news must not discard its reusable prefix.
    if([...this.entries].some(e=>e.basis.run!==basis.run||e.basis.filterKey!==basis.filterKey||e.basis.workAuthority!==basis.workAuthority||e.zone!==value.zone))this.clear();
    const revision=this.revision;let bytes=staging,failed=false;
    try{
      const result=calendarCurve(proof,basis.range,basis.evidenceCut,value.availableFrom,size=>{
        const next=bytes+size;if(!reserve(next))throw new Error('calendar_cache_limit');bytes=next;
      },size=>{
        // Failed release keeps its admitted charge and cannot hide a builder error.
        const next=Math.max(staging,bytes-size);try{if(reserve(next))bytes=next;}catch{/* Keep the conservative charge. */}
      });
      const entry:Entry={basis,zone:value.zone,from:basis.range.from,to:basis.range.to,cut:Math.min(basis.range.to,basis.evidenceCut),validBefore:Infinity,known:value.availableFrom,retained:value.retainedFrom,retention:proof.retentionMs,period:proof.periodMs,cursor:value.cursor,curve:result.curve,bytes:1024+result.bytes,at:basis.evaluatedAt};
      if(!reserve(bytes+1024)||revision!==this.revision)return;
      for(const prior of this.entries)if(prior.from===entry.from&&prior.to===entry.to)this.entries.delete(prior);
      this.entries.add(entry);
    }catch(error){failed=true;if(!(error instanceof Error)||error.message!=='calendar_cache_limit')throw error;}
    finally{try{reserve(staging);}catch(error){if(!failed)throw error;}}
  }
  private plan(window:ReturnType<typeof calendarWindow>,selection:PeriodSelection,now:number) {
    const entries=[...this.entries].filter(e=>e.zone===window.zone&&e.basis.evidenceCut<=now);if(!entries.length)return null;
    const latest=entries.reduce((a,b)=>a.basis.evidenceCut>b.basis.evidenceCut?a:b),range=window.range,segments:CalendarSegment[]=[],used=new Set<Entry>();
    // A live proof can retain its own observation cutoff as the clock moves.
    // Historical-only curves must cover the live tail, never declare it empty.
    const liveCut=selection.mode==='live'?entries.reduce((cut,e)=>e.period===selection.periodMs?Math.max(cut,e.basis.evidenceCut):cut,-Infinity):-Infinity;
    const cut=Math.min(range.to,selection.mode==='live'?(Number.isFinite(liveCut)?liveCut:now):latest.basis.evidenceCut);
    const retained=Math.max(latest.retained,now-latest.retention);if(range.to<=retained||range.from>=now)return null;
    if(selection.mode==='range'&&range.to>latest.basis.evidenceCut&&!entries.some(e=>e.from<=range.from&&e.to>=range.to))return null;
    let from=range.from;
    while(from<cut){
      const next=entries.filter(e=>e.from<=from&&e.cut>from).sort((a,b)=>b.cut-a.cut)[0];if(!next)return null;
      const to=Math.min(cut,next.cut);segments.push({from,to,curve:next.curve});used.add(next);from=to;
    }
    if(!segments.length&&!entries.some(e=>e.from<=range.from&&e.to>=range.to))return null;
    const available=entries.flatMap(e=>e.known===null?[]:[e.known]),known=available.length?Math.min(...available):null;
    const day=86_400_000,cursor=entries.find(e=>selection.mode==='range'?e.period===undefined&&range.to<=e.validBefore&&e.basis.range.from===range.from&&e.basis.range.to===range.to:e.period===selection.periodMs&&e.validBefore===Infinity&&Math.floor(e.from/day)*day===window.edges[0]&&Math.ceil(e.to/day)*day===window.edges.at(-1));
    return {entries:[...used],segments,cut,known,retained,retention:latest.retention,cursor:cursor?.cursor??'',basis:{...(cursor??latest).basis,evaluatedAt:now,evidenceCut:cut,range}};
  }
  read(window:ReturnType<typeof calendarWindow>,selection:PeriodSelection,now:number,reserve:(bytes:number)=>boolean):CalendarReading|null {
    // Planning releases all unused Entry references before reservation can evict
    // them. Metadata alone must not keep an unrelated proof curve alive.
    const plan=this.plan(window,selection,now);if(!plan)return null;
    const revision=this.revision;
    for(const entry of plan.entries)this.borrowed.set(entry,(this.borrowed.get(entry)??0)+1);
    try{
      if(!reserve(1024+window.edges.length*256+window.dates.length*256)||revision!==this.revision)return null;
      const cells=calendarProjection(window.edges,window.range,plan.cut,plan.known,plan.retained,plan.retention,selection.mode==='live'?selection.periodMs:undefined,plan.segments);
      for(const entry of plan.entries)entry.at=now;
      return {window,value:{zone:window.zone,edges:window.edges,availableFrom:plan.known,retainedFrom:plan.retained,cursor:plan.cursor,cells},basis:plan.basis,loading:false,error:null};
    }finally{
      for(const entry of plan.entries){const remaining=this.borrowed.get(entry)!-1;if(remaining)this.borrowed.set(entry,remaining);else this.borrowed.delete(entry);}
    }
  }
}
