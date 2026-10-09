import type {PeriodValues} from '../../server/domain/periodValues';
import {drain,ordered,type Preparation} from '../../server/domain/prepare';
import {edge} from '../../server/domain/quota';
import type {History,HistorySeries} from '../../server/domain/history';
import type {MoneyTape,PeriodTape} from '../../server/domain/periodTape';
import type {MeterHistory} from '../../server/domain/meterHistory';
import {meterStep,plottedAmount,type ExceptionalStep,type MeterSpan,type Reading} from '../../server/domain/meters';
import {convertBy} from '../../server/domain/currency';
import type {PeriodRange} from '../../server/domain/period';
import type {WorkTrace} from '../../server/domain/periodWork';
import {union} from '../../server/domain/work';

const lower=(values:readonly number[],at:number)=>{let a=0,b=values.length;while(a<b){const m=(a+b)>>>1;if(values[m]<at)a=m+1;else b=m;}return a;};
class Intervals {
  readonly from:number[]=[];
  readonly to:number[]=[];
  readonly sums:number[]=[0];
  constructor(spans:readonly [number,number][]) {for(const [a,b] of spans){this.from.push(a);this.to.push(b);this.sums.push(this.sums.at(-1)!+b-a);}}
  cumulative(at:number){const i=lower(this.to,at);return this.sums[i]+(i<this.from.length?Math.max(0,at-this.from[i]):0);}
  in(range:PeriodRange){return this.cumulative(range.to)-this.cumulative(range.from);}
}
type QuotaSummary=Pick<HistorySeries,'consumed'|'coveredMs'|'remainingAtStart'|'remainingAtEnd'|'work'>;
class QuotaIndex {
  private readonly times:number[]=[];
  private readonly ends:number[]=[];
  private readonly starts:number[]=[];
  private readonly spent=[0];
  private readonly covered=[0];
  private readonly worked=[0];
  private readonly during=[0];
  constructor(private readonly series:PeriodTape['quota'][number],private readonly activity:Intervals,private readonly agent:Intervals[],private readonly known:number,deferred=false) {if(!deferred)drain(this.build());}
  static *prepare(series:PeriodTape['quota'][number],activity:Intervals,agent:Intervals[],known:number):Preparation<QuotaIndex>{const value=new QuotaIndex(series,activity,agent,known,true);yield*value.build();return value;}
  private *build():Preparation<void>{
    const series=this.series,{activity,known}=this;
    for(const s of series.samples){this.times.push(s.at);yield;}
    for(let i=1;i<series.samples.length;i++) {
      yield;const a=series.samples[i-1],b=series.samples[i],step=edge(a,b);if(!step.valid)continue;
      const work=activity.in({from:a.at,to:b.at});
      this.starts.push(a.at);this.ends.push(b.at);this.spent.push(this.spent.at(-1)!+step.delta);this.covered.push(this.covered.at(-1)!+b.at-a.at);
      this.worked.push(this.worked.at(-1)!+(a.at>=known?work:0));this.during.push(this.during.at(-1)!+(a.at>=known&&work>0?step.delta:0));
    }
  }
  plot(range:PeriodRange,cell:number,previous:HistorySeries['points']):HistorySeries['points'] {
    const leftEnd=(Math.floor(range.from/cell)+1)*cell,rightStart=Math.floor((range.to-1)/cell)*cell;
    const points=previous.filter(([at])=>at>=leftEnd&&at<rightStart).map(([at,value,segment,validUntil])=>[at,value,segment,validUntil??at+cell] as HistorySeries['points'][number]);
    if(!previous.length){
      const cells=new Map<number,HistorySeries['points'][number]>();
      for(let i=lower(this.times,leftEnd);i<lower(this.times,rightStart);i++){const s=this.series.samples[i],at=Math.floor(s.at/cell)*cell,old=cells.get(at),value=100-s.used;if(!old||value<old[1])cells.set(at,[at,value,i+1,Math.min(at+cell,s.at+s.staleAfterMs+1,s.resetAt??Infinity,s.validUntil??Infinity)]);}
      points.push(...cells.values());
    }
    for(const [from,to] of leftEnd>=rightStart?[[range.from,range.to]]:[[range.from,leftEnd],[rightStart,range.to]]) {
      const first=Math.max(0,lower(this.times,from+1)-1),end=lower(this.times,to);
      for(let i=first;i<end;i++) {
        const sample=this.series.samples[i],until=Math.min(sample.at+sample.staleAfterMs+1,sample.resetAt??Infinity,sample.validUntil??Infinity,this.times[i+1]??Infinity,to),at=Math.max(from,sample.at);
        if(until>at)points.push([at,100-sample.used,i+1,until]);
      }
    }
    return points.sort((a,b)=>a[0]-b[0]);
  }

  at(range:PeriodRange):QuotaSummary {
    const lo=lower(this.starts,range.from),hi=lower(this.ends,range.to),last=this.series.samples[lower(this.times,range.to)-1];
    const first=this.series.samples[lower(this.times,range.from+1)-1];
    const valid=(sample:typeof first,at:number)=>sample&&at<Math.min(sample.at+sample.staleAfterMs+1,sample.resetAt??Infinity,sample.validUntil??Infinity)?100-sample.used:null;
    const sum=(values:number[])=>hi>lo?values[hi]-values[lo]:0;
    const workRange={from:Math.max(range.from,this.known),to:range.to};
    const workLo=lower(this.starts,workRange.from);
    return {consumed:sum(this.spent),coveredMs:sum(this.covered),remainingAtStart:valid(first,range.from),remainingAtEnd:valid(last,range.to),work:Number.isFinite(this.known)?{from:workRange.from,ms:workRange.to>workRange.from?this.activity.in(workRange):null,agentMs:workRange.to>workRange.from?this.agent.reduce((n,trace)=>n+trace.in(workRange),0):0,consumed:hi>workLo?this.spent[hi]-this.spent[workLo]:0,coveredMs:sum(this.worked),duringWork:sum(this.during)}:null};
  }
}

type AmountStep=ExceptionalStep & {amount:string};
class AmountIndex {
  private readonly steps:AmountStep[]=[];
  private readonly starts:number[]=[];
  private readonly ends:number[]=[];
  private readonly sums:bigint[]=[0n];
  private readonly missing:number[]=[0];
  constructor(readings:readonly Reading[],spans:readonly MeterSpan[],convert:(value:string,reading:Reading)=>string|null,topup=false,deferred=false) {if(!deferred)drain(this.build(readings,spans,convert,topup));}
  static *prepare(readings:readonly Reading[],spans:readonly MeterSpan[],convert:(value:string,reading:Reading)=>string|null,topup=false):Preparation<AmountIndex>{const value=new AmountIndex(readings,spans,convert,topup,true);yield*value.build(readings,spans,convert,topup);return value;}
  private *build(readings:readonly Reading[],spans:readonly MeterSpan[],convert:(value:string,reading:Reading)=>string|null,topup:boolean):Preparation<void>{
    let spanIndex=0;
    for(let i=1;i<readings.length;i++) {
      yield;const a=readings[i-1],b=readings[i],from=b.previousAt??a.at;
      while(spanIndex+1<spans.length&&spans[spanIndex+1].from<=from)spanIndex++;
      const covering=spans[spanIndex]?[spans[spanIndex]]:[];
      const step=topup?meterStep({...a,kind:'counter'},{...b,kind:'counter'},covering):meterStep(a,b,covering);
      if(!step)continue;
      const amount=convert(step.amount,b);
      this.missing.push(this.missing.at(-1)!+Number(amount===null));
      this.steps.push({...step,amount:amount??'0'});this.starts.push(step.from);this.ends.push(step.to);
      this.sums.push(this.sums.at(-1)!+(step.evidence==='continuous'&&amount!==null?BigInt(amount):0n));
    }
  }
  at(range:PeriodRange) {
    const lo=lower(this.starts,range.from),hi=lower(this.ends,range.to),edge=lower(this.ends,range.from);
    const unlocated:ExceptionalStep[]=[];
    for(let i=edge;i<hi;i++){const step=this.steps[i];if(step.from<range.from||step.evidence!=='continuous')unlocated.push(step);}
    return {value:this.missing[hi]>this.missing[edge]?null:hi>lo?(this.sums[hi]-this.sums[lo]).toString():'0',unlocated};
  }
}

class MoneyIndex {
  private times:number[]=[];
  private spent!:AmountIndex;
  private topup!:AmountIndex;
  private coverage!:Intervals;
  private pairedTimes:number[]=[];
  constructor(private readonly group:MoneyTape,deferred=false) {if(!deferred)drain(this.build());}
  static *prepare(group:MoneyTape):Preparation<MoneyIndex>{const value=new MoneyIndex(group,true);yield*value.build();return value;}
  private *build():Preparation<void>{
    const group=this.group;
    for(const r of group.readings){this.times.push(r.at);yield;}for(const r of group.paired?.readings??[]){this.pairedTimes.push(r.at);yield;}
    const convert=(amount:string,reading:Reading)=>this.convert(amount,reading);
    this.spent=yield* AmountIndex.prepare(group.readings,group.spans,convert);
    // Account credits are a monotonically increasing funding counter; balance-only
    // suppliers have no accounting authority and never reach this result.
    this.topup=group.paired?yield* AmountIndex.prepare(group.paired.readings,group.paired.spans,convert):yield* AmountIndex.prepare(group.readings,group.spans,convert,true);
    this.coverage=new Intervals(union(group.spans.map(s=>({from:s.from,to:Math.min(s.to+s.staleAfterMs+1,s.holdUntil??Infinity,s.interruptedAt??Infinity)}))));
  }
  private convert(value:string,reading:Reading,at=reading.at) {
    if(!this.group.displayUnit||reading.unit===this.group.displayUnit)return value;
    const rates=this.group.rates?.[reading.unit+'\n'+at];return rates?convertBy(value,rates,reading.scale):null;
  }
  private value(at:number,inclusive=false) {
    const group=this.group,reading=group.readings[lower(this.times,at+(inclusive?1:0))-1];
    if(!reading)return null;
    const span=group.spans.find(s=>s.from<=at&&at<Math.min(s.to+s.staleAfterMs+1,s.holdUntil??Infinity,s.interruptedAt??Infinity));
    if(!span||reading.kind==='cap'&&reading.resetAt!==null&&reading.resetAt<=at)return null;
    if(group.paired) {
      const credits=group.paired.readings[lower(this.pairedTimes,at+(inclusive?1:0))-1];
      if(!credits||credits.unit!==reading.unit||!group.paired.spans.some(s=>s.from<=at&&at<Math.min(s.to+s.staleAfterMs+1,s.holdUntil??Infinity,s.interruptedAt??Infinity)))return null;
      return this.convert((BigInt(credits.amount)-BigInt(reading.amount)).toString(),reading);
    }
    const observed=group.meter==='balance:credits'?Math.max(reading.at,span.to<at||inclusive&&span.to===at?span.to:span.from):reading.at;
    return this.convert(plottedAmount(reading),reading,observed);
  }
  plot(range:PeriodRange,cell:number,previous:MeterHistory['points']):MeterHistory['points'] {
    const leftEnd=(Math.floor(range.from/cell)+1)*cell,rightStart=Math.floor((range.to-1)/cell)*cell;
    const points=previous.filter(p=>p.at>=leftEnd&&p.at<rightStart).map(p=>({...p,validUntil:p.validUntil??(Math.floor(p.at/cell)+1)*cell}));
    const group=this.group;
    for(const [from,to] of leftEnd>=rightStart?[[range.from,range.to]]:[[range.from,leftEnd],[rightStart,range.to]]) {
      const anchors=new Set([from,...this.times.slice(lower(this.times,from),lower(this.times,to)),...this.pairedTimes.slice(lower(this.pairedTimes,from),lower(this.pairedTimes,to)),...(group.meter==='balance:credits'?group.spans.flatMap(s=>[s.from,s.to]).filter(at=>at>=from&&at<to):[])]);
      for(const at of [...anchors].sort((a,b)=>a-b)) {
        const i=lower(this.times,at+1)-1,row=group.readings[i],value=this.value(at,true);if(!row||value===null)continue;
        const span=group.spans.find(s=>s.from<=at&&at<Math.min(s.to+s.staleAfterMs+1,s.holdUntil??Infinity,s.interruptedAt??Infinity));if(!span)continue;
        const next=Math.min(this.times[i+1]??Infinity,this.pairedTimes[lower(this.pairedTimes,at+1)]??Infinity);
        const until=Math.min(to,next,span.to+span.staleAfterMs+1,span.holdUntil??Infinity,span.interruptedAt??Infinity,row.resetAt??Infinity);
        if(until<=at)continue;
        const semantics={limit:row.limit===null?null:this.convert(row.limit,row),resetAt:row.resetAt,minutes:row.minutes,scope:row.scope,label:row.label};
        points.push({at:row.kind==='cap'?Math.floor(at/cell)*cell:at,value,knownFrom:at,knownUntil:until,validUntil:until,spent:null,segment:span.from,semantics,steps:[]});
      }
    }
    return points.sort((a,b)=>a.at-b.at||(a.knownFrom??0)-(b.knownFrom??0));
  }
  at(range:PeriodRange):Pick<MeterHistory,'start'|'end'|'spent'|'topup'|'unlocated'|'topupUnlocated'|'coveredMs'|'semantics'> {
    const spent=this.spent.at(range),topup=this.topup.at(range),authority=this.group.accounting;
    const last=this.group.readings[lower(this.times,range.to)-1];
    const semantics=last?{limit:last.limit===null?null:this.convert(last.limit,last),resetAt:last.resetAt,minutes:last.minutes,scope:last.scope,label:last.label}:null;
    const coveredMs=this.coverage.in(range);
    return {start:this.value(range.from,true),end:this.value(range.to),semantics,spent:authority?.spending==='unavailable'||!coveredMs?null:spent.value,topup:authority?.topups==='unavailable'||!coveredMs?null:topup.value,unlocated:authority?.spending==='unavailable'?[]:spent.unlocated,topupUnlocated:authority?.topups==='unavailable'?[]:topup.unlocated,coveredMs};
  }
}

/** Prepared prefixes keep clock arithmetic independent of the number of retained samples. */
export class PeriodAccounting {
  private readonly quota=new Map<string,QuotaIndex>();
  private readonly money=new Map<string,MoneyIndex>();
  private readonly sampleTimes=new Map<string,number[]>();
  private boundaries:number[]=[];
  private deadlines:number[]=[];
  constructor(readonly tape:PeriodTape,work:WorkTrace|null,deferred=false) {if(!deferred)drain(this.build(work));}
  static *prepare(tape:PeriodTape,work:WorkTrace|null):Preparation<PeriodAccounting>{const value=new PeriodAccounting(tape,work,true);yield*value.build(work);return value;}
  private *build(work:WorkTrace|null):Preparation<void>{
    const tape=this.tape;
    const boundaries=new Set<number>(),deadlines:number[]=[];
    for(const series of tape.quota){for(const s of series.samples){boundaries.add(s.at+1);boundaries.add(Math.min(s.at+s.staleAfterMs+1,s.resetAt??Infinity,s.validUntil??Infinity));yield;}const last=series.samples.at(-1);if(last)deadlines.push(Math.min(last.at+last.staleAfterMs+1,last.resetAt??Infinity,last.validUntil??Infinity));}
    this.boundaries=yield* ordered([...boundaries].filter(Number.isFinite),(a,b)=>a-b);this.deadlines=deadlines.sort((a,b)=>a-b);
    const sources=new Map<string,Map<number,[number,number][]>>();
    for(const [id,a,b] of work?.spans??[]){const source=work!.refs[id].source;let refs=sources.get(source);if(!refs)sources.set(source,refs=new Map());let spans=refs.get(id);if(!spans)refs.set(id,spans=[]);spans.push([work!.anchor+a,work!.anchor+b]);yield;}
    for(const series of tape.quota) {
      this.sampleTimes.set(series.source+'\n'+series.window,series.samples.map(s=>s.at));
      const traces=[...(sources.get(series.source)?.values()??[])],all=traces.flat();
      const activity=new Intervals(union(all.map(([from,to])=>({from,to}))));
      this.quota.set(series.source+'\n'+series.window,yield* QuotaIndex.prepare(series,activity,traces.map(s=>new Intervals(s)),Math.max(work?.knownFrom??Infinity,series.workFrom??0)));
    }
    for(const group of tape.money)this.money.set(group.source+'\n'+group.meter+'\n'+(group.displayUnit??group.readings[0]?.unit),yield* MoneyIndex.prepare(group));
  }
  project(history:History,range:PeriodRange,values?:ReadonlyMap<string,PeriodValues>):History {
    if(range.from<this.tape.from)return history;
    const previous=new Map(history.series.map(s=>[s.sourceId+'\n'+s.windowId,s]));
    const series:HistorySeries[]=[];
    const batches=new Map<string,number>();
    if(!history.live)for(const row of this.tape.quota){const times=this.sampleTimes.get(row.source+'\n'+row.window)!;const at=times[lower(times,range.to)-1];if(at!==undefined)batches.set(row.source,Math.max(batches.get(row.source)??0,at));}
    for(const row of this.tape.quota) {
      const key=row.source+'\n'+row.window,index=this.quota.get(key)!;
      const times=this.sampleTimes.get(key)!,membership=values?.get(row.source),descriptor=row.descriptors?.filter(d=>d.at<range.to).at(-1);
      const windowValue=membership?.windows.find(w=>w.id===row.window)??descriptor?.value;
      if(!history.live&&(membership?!membership.windows.some(w=>w.id===row.window):row.descriptors?times[lower(times,range.to)-1]!==batches.get(row.source):row.member===false))continue;
      const old=previous.get(key);if(!old&&history.live)continue;
      const summary=index.at(range),points=!history.live?index.plot(range,history.cellMs,old?.points??[]):old!.points;
      series.push({...old,sourceId:row.source,windowId:row.window,staleAfterMs:row.samples.at(-1)?.staleAfterMs??0,...summary,points,...(!history.live?{pointMode:'observation' as const,windowValue:windowValue??row.windowValue}:{})});
    }
    return {...history,exact:true,since:range.from,to:range.to,series,meterSeries:history.meterSeries?.map(series=>{const index=this.money.get(series.sourceId+'\n'+series.meterId+'\n'+series.unit);return index?{...series,...index.at(range),...(!history.live?{points:index.plot(range,history.cellMs,series.points),...(series.kind!=='cap'?{pointMode:'observation' as const}:{})}:{})}:series;})};
  }
  changesAt(now:number,period:number):number|null {
    const from=now-period;if(from>=this.tape.cut)return null;
    let next=Math.min((this.boundaries[lower(this.boundaries,from+1)]??Infinity)+period,this.deadlines[lower(this.deadlines,now+1)]??Infinity);
    if(this.tape.money.length)next=Math.min(next,Math.floor(now/60_000)*60_000+60_000);
    return Number.isFinite(next)?next:null;
  }
}
