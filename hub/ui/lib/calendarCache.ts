import type {WorkTimeline} from '../../server/domain/periodCurves';
import {calendarProjection,calendarCurve,type CalendarSegment} from '../../server/domain/calendarWork';
import type {CalendarBasis,CalendarValue,WorkStamp} from '../../server/domain/workCalendar';
import type {PeriodSelection} from '../../server/domain/period';
import type {CalendarIntegral,CalendarReading,calendarWindow} from './workCalendar';

type Entry={basis:CalendarBasis;zone:string;from:number;to:number;cut:number;validBefore:number;known:number|null;retained:number;retention:number;period?:number;cursor:string;curve:WorkTimeline;bytes:number;at:number;integral?:CalendarIntegral};
type IntegralLease={integral:CalendarIntegral;release():void};

export function calendarIntegralOwners(values:Iterable<CalendarIntegral>){
  const roots=new Set<CalendarIntegral>();
  const add=(value:CalendarIntegral)=>{if(roots.has(value))return;roots.add(value);for(const owner of value.owners??[])add(owner);};
  for(const value of values)add(value);return roots;
}

function joinedIntegral(entries:readonly Entry[],segments:readonly CalendarSegment[],from:number,periodMs:number):CalendarIntegral|undefined {
  if(!entries.length||entries.some(entry=>!entry.integral))return;
  const owners=[...new Set(entries.map(entry=>entry.integral!))];
  if(owners.length===1)return owners[0];
  const tail=entries.find(entry=>entry.curve===segments.at(-1)?.curve)!.integral!;
  const parts=segments.map((part,i)=>({...part,to:i===segments.length-1?Infinity:part.to}));
  const at=(time:number)=>parts.find(part=>time>=part.from&&time<part.to);
  const slope=(time:number)=>at(time)?.curve.slope(time)??0;
  return {
    proof:{from,cut:tail.proof.cut,retentionMs:tail.proof.retentionMs,periodMs},stamp:tail.stamp,owners,
    bytes:1024+parts.length*96+owners.length*16,through:()=>tail.through(),
    curve:{
      read:(range,active=false)=>parts.reduce((sum,part)=>sum+part.curve.read({from:Math.max(range.from,part.from),to:Math.min(range.to,part.to)},active),0),
      slope,working:time=>slope(time)>0,
      next:time=>parts.reduce((next,part)=>{
        if(part.to<=time)return next;
        const start=Math.max(time,part.from),boundary=part.curve.next(start);
        return Math.min(next,part.from>time&&part.curve.working(part.from)?part.from:Infinity,boundary<part.to?boundary:Infinity);
      },Infinity),
    },
  };
}

/** Only anonymous integrals are retained; the board's shared pool can evict any frame. */
export class CalendarCache {
  private entries=new Set<Entry>();
  private borrowed=new Map<Entry,number>();
  private revision=0;
  private pendingStamp:WorkStamp|undefined;
  constructor(private readonly through:(stamp:WorkStamp,cut:number)=>number=(_stamp,cut)=>cut){}
  get bytes(){return this.residentBytes();}
  residentBytes(held:Iterable<CalendarIntegral>=[]){
    const roots=calendarIntegralOwners(held);let bytes=this.pendingStamp?256+(this.pendingStamp.watch.length+this.pendingStamp.authority.length)*2:0;
    for(const entry of new Set([...this.entries,...this.borrowed.keys()])){
      if(entry.integral)roots.add(entry.integral);else bytes+=entry.bytes;
    }
    for(const root of roots)bytes+=root.bytes;
    return bytes;
  }
  clear(){this.revision++;this.entries.clear();this.pendingStamp=undefined;}
  suspend(stamp:WorkStamp){this.revision++;this.pendingStamp=stamp;}
  invalidate(since:number,stamp?:WorkStamp){
    if(since===Infinity)return;
    this.revision++;
    if(stamp&&this.pendingStamp?.watch===stamp.watch&&this.pendingStamp.authority===stamp.authority&&stamp.seq>=this.pendingStamp.seq)this.pendingStamp=undefined;
    for(const entry of this.entries){
      if(stamp&&entry.integral?.stamp.watch===stamp.watch&&entry.integral.stamp.authority===stamp.authority&&entry.integral.stamp.seq>=stamp.seq)continue;
      if(since<=entry.from){this.entries.delete(entry);continue;}
      // A later credit changes the tail, not the integrals before its first instant.
      entry.validBefore=Math.min(entry.validBefore,since);entry.to=Math.min(entry.to,since);entry.cut=Math.min(entry.cut,since);
    }
  }
  // Evicting a cache owner cannot free storage still borrowed by a projection.
  evictionCandidates(held:Iterable<CalendarIntegral>=[]){
    const roots=calendarIntegralOwners(held);
    return [...this.entries].map(e=>({bytes:this.borrowed.has(e)||!!e.integral&&roots.has(e.integral)?0:e.bytes,shownAt:e.at,drop:()=>{this.entries.delete(e);}}));
  }
  add(basis:CalendarBasis,value:CalendarValue,reserve:(bytes:number)=>boolean,staging:number,retainedProofBytes=0){
    const proof=value.proof;if(!proof)return;
    // A newer revision can change only a tail. dirty() already bounded every
    // affected proof; unrelated news must not discard its reusable prefix.
    if([...this.entries].some(e=>e.basis.run!==basis.run||e.basis.filterKey!==basis.filterKey||e.basis.workAuthority!==basis.workAuthority||e.zone!==value.zone))this.clear();
    const revision=this.revision;let bytes=staging,remaining=staging,failed=false,lease:IntegralLease|undefined;
    try{
      const result=calendarCurve(proof,basis.range,basis.evidenceCut,value.availableFrom,size=>{
        const next=bytes+size;if(!reserve(next))throw new Error('calendar_cache_limit');bytes=next;
      },size=>{
        // Failed release keeps its admitted charge and cannot hide a builder error.
        const next=Math.max(staging,bytes-size);try{if(reserve(next))bytes=next;}catch{/* Keep the conservative charge. */}
      },!!value.workStamp);
      const proofBytes=Math.max(retainedProofBytes,JSON.stringify(proof).length*3),stamp=value.workStamp,stampBytes=stamp?(stamp.watch.length+stamp.authority.length)*2:0;
      // Losing a watch stops new confirmation; it cannot undo the tail already read.
      let confirmed=proof.cut;
      const integral:CalendarIntegral|undefined=stamp&&proof.periodMs!==undefined?{proof,tape:proof,curve:result.curve,bytes:1024+result.bytes+proofBytes+stampBytes,stamp,through:()=>confirmed=Math.max(confirmed,this.through(stamp,proof.cut))}:undefined;
      const entry:Entry={basis,zone:value.zone,from:basis.range.from,to:integral?proof.cut:basis.range.to,cut:integral?proof.cut:Math.min(basis.range.to,basis.evidenceCut),validBefore:Infinity,known:value.availableFrom,retained:value.retainedFrom,retention:proof.retentionMs,period:proof.periodMs,cursor:value.cursor,curve:result.curve,bytes:integral?.bytes??1024+result.bytes,at:basis.evaluatedAt,integral};
      if(!reserve(bytes+1024+(integral?stampBytes:0))||revision!==this.revision)return;
      for(const prior of this.entries)if(prior.from===entry.from&&prior.to===entry.to)this.entries.delete(prior);
      if(integral){
        // The caller still needs this root to project and adopt its reading.
        this.borrowed.set(entry,(this.borrowed.get(entry)??0)+1);let released=false;
        lease={integral,release:()=>{if(released)return;released=true;const count=this.borrowed.get(entry)!-1;if(count)this.borrowed.set(entry,count);else this.borrowed.delete(entry);}};
        remaining=Math.max(0,staging-proofBytes);
      }
      this.entries.add(entry);
      return lease;
    }catch(error){failed=true;if(!(error instanceof Error)||error.message!=='calendar_cache_limit')throw error;}
    finally{try{reserve(remaining);}catch(error){lease?.release();if(!failed)throw error;}}
  }
  private plan(window:ReturnType<typeof calendarWindow>,selection:PeriodSelection,now:number) {
    const pending=this.pendingStamp;
    const entries=[...this.entries].filter(e=>e.zone===window.zone&&e.basis.evidenceCut<=now&&(!pending||e.integral?.stamp.watch===pending.watch&&e.integral.stamp.authority===pending.authority&&e.integral.stamp.seq>=pending.seq));if(!entries.length)return null;
    const latest=entries.reduce((a,b)=>a.basis.evidenceCut>b.basis.evidenceCut?a:b),range=window.range,segments:CalendarSegment[]=[],used=new Set<Entry>();
    // A live proof can retain its own observation cutoff as the clock moves.
    // Historical-only curves must cover the live tail, never declare it empty.
    const coverage=(entry:Entry)=>Math.min(entry.validBefore,entry.integral?.through()??entry.cut);
    const liveCut=selection.mode==='live'?entries.reduce((cut,e)=>e.integral||e.period===selection.periodMs?Math.max(cut,e.integral?e.integral.through():e.basis.evidenceCut):cut,-Infinity):-Infinity;
    const cut=Math.min(range.to,selection.mode==='live'?(Number.isFinite(liveCut)?liveCut:now):latest.basis.evidenceCut);
    const retained=Math.max(latest.retained,now-latest.retention);if(range.to<=retained||range.from>=now)return null;
    if(selection.mode==='range'&&range.to>latest.basis.evidenceCut&&!entries.some(e=>e.from<=range.from&&e.to>=range.to))return null;
    let from=range.from;
    while(from<cut){
      const next=entries.filter(e=>e.from<=from&&coverage(e)>from).sort((a,b)=>coverage(b)-coverage(a))[0];if(!next)return null;
      const to=Math.min(cut,coverage(next));segments.push({from,to,curve:next.curve});used.add(next);from=to;
    }
    if(!segments.length&&!entries.some(e=>e.from<=range.from&&e.to>=range.to))return null;
    const available=entries.flatMap(e=>e.known===null?[]:[e.known]),known=available.length?Math.min(...available):null;
    const day=86_400_000,cursor=entries.find(e=>selection.mode==='range'?e.period===undefined&&range.to<=e.validBefore&&e.basis.range.from===range.from&&e.basis.range.to===range.to:e.period===selection.periodMs&&e.validBefore===Infinity&&(!!e.integral||Math.floor(e.from/day)*day===window.edges[0]&&Math.ceil(e.to/day)*day===window.edges.at(-1)));
    return {entries:[...used],segments,cut,known,retained,retention:latest.retention,cursor:cursor?.cursor??'',basis:{...(cursor??latest).basis,evaluatedAt:now,evidenceCut:cut,range}};
  }
  read(window:ReturnType<typeof calendarWindow>,selection:PeriodSelection,now:number,reserve:(bytes:number)=>boolean):CalendarReading|null {
    // Planning releases all unused Entry references before reservation can evict
    // them. Metadata alone must not keep an unrelated proof curve alive.
    const plan=this.plan(window,selection,now);if(!plan)return null;
    const revision=this.revision;
    for(const entry of plan.entries)this.borrowed.set(entry,(this.borrowed.get(entry)??0)+1);
    try{
      const joining=selection.mode==='live'&&plan.entries.length>1&&plan.entries.every(entry=>entry.integral);
      if(!reserve(1024+window.edges.length*256+window.dates.length*256+(joining?1024+plan.segments.length*96+plan.entries.length*16:0))||revision!==this.revision)return null;
      const integral=selection.mode==='live'?joinedIntegral(plan.entries,plan.segments,window.range.from,selection.periodMs):undefined;
      const cells=calendarProjection(window.edges,window.range,plan.cut,plan.known,plan.retained,plan.retention,selection.mode==='live'?selection.periodMs:undefined,plan.segments);
      for(const entry of plan.entries)entry.at=now;
      return {window,value:{zone:window.zone,edges:window.edges,availableFrom:plan.known,retainedFrom:plan.retained,cursor:integral?.owners?'':plan.cursor,cells,...(integral?{workStamp:integral.stamp}:{})},basis:plan.basis,loading:false,error:null,...(integral?{integral}:{})};
    }finally{
      for(const entry of plan.entries){const remaining=this.borrowed.get(entry)!-1;if(remaining)this.borrowed.set(entry,remaining);else this.borrowed.delete(entry);}
    }
  }
}
