import type {PeriodValues} from './periodValues.js';
import {drain,type Preparation} from './prepare.js';
import {edge} from './quota.js';
import type {History,HistorySeries} from './history.js';
import {sampleAt,sampleCount,numberAt,numberBytes,numberColumn,lowerNumber,rateAt,type Numbers,type MoneyTape,type PeriodTape} from './periodTape.js';
import type {MeterHistory} from './meterHistory.js';
import {meterStep,plottedAmount,semanticsOf,type ExceptionalStep,type MeterSpan,type Reading,type MeterSemantics} from './meters.js';
import {convertBy} from './currency.js';
import type {PeriodRange} from './period.js';
import type {WorkTrace} from './periodWork.js';
import {union} from './work.js';
import {PeriodCurves,type WorkTimeline} from './periodCurves.js';

const lower=lowerNumber;
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
  readonly times:Numbers;
  private deadlines:Numbers=new Float64Array(0);
  private spent:Numbers=new Float64Array(0);
  private covered:Numbers=new Float64Array(0);
  private worked:Numbers=new Float64Array(0);
  private during:Numbers=new Float64Array(0);
  constructor(readonly series:PeriodTape['quota'][number],private readonly activity:WorkTimeline|undefined,private readonly known:number,deferred=false) {
    const count=sampleCount(series.samples);
    this.times='columns' in series.samples?series.samples.columns[0]:new Float64Array(count);
    if(!deferred)drain(this.build());
  }
  static *prepare(series:PeriodTape['quota'][number],activity:WorkTimeline|undefined,known:number):Preparation<QuotaIndex>{const value=new QuotaIndex(series,activity,known,true);yield*value.build();return value;}
  private *build():Preparation<void>{
    const series=this.series,{activity,known}=this;
    const deadlines=new Float64Array(sampleCount(series.samples));
    for(let i=0;i<sampleCount(series.samples);i++){const sample=sampleAt(series.samples,i)!;if(this.times instanceof Float64Array)this.times[i]=sample.at;deadlines[i]=Math.min(sample.at+sample.staleAfterMs+1,sample.resetAt??Infinity,sample.validUntil??Infinity);yield;}
    const sorted=yield*sortedNumbers(deadlines);this.deadlines=yield*numberColumn(sorted.length,i=>sorted[i]);
    const spent=new Float64Array(sampleCount(series.samples)),covered=new Float64Array(spent.length),worked=new Float64Array(spent.length),during=new Float64Array(spent.length);
    for(let i=1;i<sampleCount(series.samples);i++) {
      yield;spent[i]=spent[i-1];covered[i]=covered[i-1];worked[i]=worked[i-1];during[i]=during[i-1];
      const a=sampleAt(series.samples,i-1)!,b=sampleAt(series.samples,i)!,step=edge(a,b);if(!step.valid)continue;
      const work=activity?.read({from:a.at,to:b.at},true)??0;
      spent[i]+=step.delta;covered[i]+=b.at-a.at;
      worked[i]+=a.at>=known?work:0;during[i]+=a.at>=known&&work>0?step.delta:0;
    }
    this.spent=yield*numberColumn(spent.length,i=>spent[i]);this.covered=yield*numberColumn(covered.length,i=>covered[i]);
    this.worked=yield*numberColumn(worked.length,i=>worked[i]);this.during=yield*numberColumn(during.length,i=>during[i]);
  }

  get bytes(){return [this.deadlines,this.spent,this.covered,this.worked,this.during].reduce((n,c)=>n+numberBytes(c),0)+(this.times instanceof Float64Array?numberBytes(this.times):0);}
  changesAt(now:number,period:number){
    const from=now-period,last=sampleAt(this.series.samples,sampleCount(this.series.samples)-1);
    const deadline=last?Math.min(last.at+last.staleAfterMs+1,last.resetAt??Infinity,last.validUntil??Infinity):Infinity;
    return Math.min((numberAt(this.times,lower(this.times,from))??Infinity)+1+period,(numberAt(this.deadlines,lower(this.deadlines,from+1))??Infinity)+period,deadline>now?deadline:Infinity);
  }

  plot(range:PeriodRange,cell:number,previous:HistorySeries['points'],boundaryOnly=false):HistorySeries['points'] {
    const leftEnd=(Math.floor(range.from/cell)+1)*cell,rightStart=Math.floor((range.to-1)/cell)*cell;
    const points=previous.filter(([at])=>at>=leftEnd&&at<rightStart).map(([at,value,segment,validUntil])=>[at,value,segment,validUntil??at+cell] as HistorySeries['points'][number]);
    if(!previous.length&&!boundaryOnly){
      const cells=new Map<number,HistorySeries['points'][number]>();
      for(let i=lower(this.times,leftEnd);i<lower(this.times,rightStart);i++){const s=sampleAt(this.series.samples,i)!,at=Math.floor(s.at/cell)*cell,old=cells.get(at),value=100-s.used;if(!old||value<old[1])cells.set(at,[at,value,i+1,Math.min(at+cell,s.at+s.staleAfterMs+1,s.resetAt??Infinity,s.validUntil??Infinity)]);}
      points.push(...cells.values());
    }
    for(const [from,to] of leftEnd>=rightStart?[[range.from,range.to]]:[[range.from,leftEnd],[rightStart,range.to]]) {
      const first=Math.max(0,lower(this.times,from+1)-1),end=lower(this.times,to);
      for(let i=first;i<end;i++) {
        const sample=sampleAt(this.series.samples,i)!,until=Math.min(sample.at+sample.staleAfterMs+1,sample.resetAt??Infinity,sample.validUntil??Infinity,numberAt(this.times,i+1)??Infinity,to),at=Math.max(from,sample.at);
        if(until>at)points.push([at,100-sample.used,i+1,until]);
      }
    }
    return points.sort((a,b)=>a[0]-b[0]);
  }

  at(range:PeriodRange):QuotaSummary {
    const lo=lower(this.times,range.from),hi=Math.max(0,lower(this.times,range.to)-1),last=sampleAt(this.series.samples,lower(this.times,range.to)-1);
    const first=sampleAt(this.series.samples,lower(this.times,range.from+1)-1);
    const valid=(sample:typeof first,at:number)=>sample&&at<Math.min(sample.at+sample.staleAfterMs+1,sample.resetAt??Infinity,sample.validUntil??Infinity)?100-sample.used:null;
    const sum=(values:Numbers)=>hi>lo?numberAt(values,hi)!-numberAt(values,lo)!:0;
    const workRange={from:Math.max(range.from,this.known),to:range.to};
    const workLo=lower(this.times,workRange.from);
    return {consumed:sum(this.spent),coveredMs:sum(this.covered),remainingAtStart:valid(first,range.from),remainingAtEnd:valid(last,range.to),work:Number.isFinite(this.known)?{from:workRange.from,ms:workRange.to>workRange.from?this.activity?.read(workRange,true)??0:null,agentMs:workRange.to>workRange.from?this.activity?.read(workRange)??0:0,consumed:hi>workLo?numberAt(this.spent,hi)!-numberAt(this.spent,workLo)!:0,coveredMs:sum(this.worked),duringWork:sum(this.during)}:null};
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
  constructor(readonly group:MoneyTape,deferred=false) {if(!deferred)drain(this.build());}
  static *prepare(group:MoneyTape):Preparation<MoneyIndex>{const value=new MoneyIndex(group,true);yield*value.build();return value;}
  private *build():Preparation<void>{
    const group=this.group;
    for(const r of group.readings){this.times.push(r.at);yield;}for(const r of group.paired?.readings??[]){this.pairedTimes.push(r.at);yield;}
    const convert=(amount:string,reading:Reading)=>this.convert(amount,reading);
    this.spent=yield* AmountIndex.prepare(group.accounting?.spending==='unavailable'?[]:group.readings,group.spans,convert);
    // Account credits are a monotonically increasing funding counter; balance-only
    // suppliers have no accounting authority and never reach this result.
    this.topup=group.accounting?.topups==='unavailable'?yield* AmountIndex.prepare([],[],convert):group.paired?yield* AmountIndex.prepare(group.paired.readings,group.paired.spans,convert):yield* AmountIndex.prepare(group.readings,group.spans,convert,true);
    this.coverage=new Intervals(union(group.spans.map(s=>({from:s.from,to:Math.min(s.to+s.staleAfterMs+1,s.holdUntil??Infinity,s.interruptedAt??Infinity)}))));
  }
  private convert(value:string,reading:Reading,at=reading.at) {
    if(!this.group.displayUnit||reading.unit===this.group.displayUnit)return value;
    const rates=rateAt(this.group,reading.unit+'\n'+at);return rates?convertBy(value,rates,reading.scale):null;
  }
  private semantics(reading:Reading,at=reading.at):MeterSemantics {
    const original=semanticsOf(reading),converted=this.group.displayUnit&&this.group.displayUnit!==reading.unit;
    if(!converted)return original;
    const steps=rateAt(this.group,reading.unit+'\n'+at);
    const credits=this.group.paired?.readings[lower(this.pairedTimes,at+1)-1];
    const native=credits?(BigInt(credits.amount)-BigInt(reading.amount)).toString():plottedAmount(reading);
    return {...original,scale:6,limit:reading.limit===null?null:this.convert(reading.limit,reading,at),...(steps?.length?{conversion:{original:{meterId:this.group.meter,amount:native,unit:reading.unit,at,...(reading.scale===undefined?{}:{scale:reading.scale}),limit:reading.limit},rate:steps[0],steps}}:{})};
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
        const semantics=this.semantics(row,group.meter==='balance:credits'?Math.max(row.at,span.to<=at?span.to:span.from):row.at);
        points.push({at:row.kind==='cap'?Math.floor(at/cell)*cell:at,value,knownFrom:at,knownUntil:until,validUntil:until,spent:null,segment:span.from,semantics,steps:[]});
      }
    }
    return points.sort((a,b)=>a.at-b.at||(a.knownFrom??0)-(b.knownFrom??0));
  }
  at(range:PeriodRange):Pick<MeterHistory,'start'|'end'|'startScale'|'endScale'|'spent'|'topup'|'unlocated'|'topupUnlocated'|'coveredMs'|'semantics'> {
    const spent=this.spent.at(range),topup=this.topup.at(range),authority=this.group.accounting;
    const last=this.group.readings[lower(this.times,range.to)-1];
    const first=this.group.readings[lower(this.times,range.from+1)-1],span=this.group.spans.find(s=>s.from<=range.to&&range.to<Math.min(s.to+s.staleAfterMs+1,s.holdUntil??Infinity,s.interruptedAt??Infinity));
    const semantics=last?this.semantics(last,this.group.meter==='balance:credits'&&span?Math.max(last.at,span.to<range.to?span.to:span.from):last.at):null;
    const scale=(row:Reading|undefined)=>row?(this.group.displayUnit&&this.group.displayUnit!==row.unit?6:row.scale):undefined;
    const coveredMs=this.coverage.in(range);
    return {start:this.value(range.from,true),end:this.value(range.to),startScale:scale(first),endScale:scale(last),semantics,spent:authority?.spending==='unavailable'||!coveredMs?null:spent.value,topup:authority?.topups==='unavailable'||!coveredMs?null:topup.value,unlocated:authority?.spending==='unavailable'?[]:spent.unlocated,topupUnlocated:authority?.topups==='unavailable'?[]:topup.unlocated,coveredMs};
  }
  changesAt(now:number,period:number) {
    let next=Infinity;
    const consider=(at:number)=>{for(const offset of [0,period])for(const edge of [at+offset,at+offset+1])if(edge>now)next=Math.min(next,edge);};
    for(const times of [this.times,this.pairedTimes])for(const offset of [0,period]){
      const i=lower(times,now-offset);if(i<times.length)consider(times[i]);
      if(i+1<times.length)consider(times[i+1]);
    }
    for(const part of [this.group,...(this.group.paired?[this.group.paired]:[])]){
      for(const span of part.spans){consider(span.from);consider(span.to);consider(Math.min(span.to+span.staleAfterMs+1,span.holdUntil??Infinity,span.interruptedAt??Infinity));}
      for(const reading of part.readings){consider(reading.previousAt??Infinity);consider(reading.at+reading.staleAfterMs+1);consider(reading.resetAt??Infinity);}
    }
    return next;
  }
}

/** Two fixed buffers keep cooperative sorting within the retained evidence budget. */
function* sortedNumbers(input:Float64Array):Preparation<Float64Array> {
  let rows:Float64Array=input,next:Float64Array=new Float64Array(input.length);
  for(let size=1;size<rows.length;size*=2) {
    for(let start=0;start<rows.length;start+=size*2) {
      let a=start,b=Math.min(start+size,rows.length),out=start;const endA=b,endB=Math.min(start+size*2,rows.length);
      while(a<endA||b<endB){next[out++]=b>=endB||a<endA&&rows[a]<=rows[b]?rows[a++]:rows[b++];yield;}
    }
    [rows,next]=[next,rows];
  }
  return rows;
}

/** Prepared prefixes keep clock arithmetic independent of the number of retained samples. */
export class PeriodAccounting {
  private readonly quota=new Map<string,QuotaIndex>();
  private readonly money=new Map<string,MoneyIndex>();
  private readonly sampleTimes=new Map<string,Numbers>();
  constructor(readonly tape:PeriodTape,work:WorkTrace|null,curves?:PeriodCurves,deferred=false) {if(!deferred)drain(this.build(work,curves));}
  static *prepare(tape:PeriodTape,work:WorkTrace|null,curves?:PeriodCurves,prior?:PeriodAccounting,changedWork:ReadonlySet<string>=new Set(),progress?:(bytes:number)=>void):Preparation<PeriodAccounting>{const value=new PeriodAccounting(tape,work,curves,true);yield*value.build(work,curves,prior,changedWork,progress);return value;}
  private *build(work:WorkTrace|null,curves?:PeriodCurves,prior?:PeriodAccounting,changedWork:ReadonlySet<string>=new Set(),progress?:(bytes:number)=>void):Preparation<void>{
    const tape=this.tape;
    if(tape.fixed)return;
    const workCurves=curves??(work?yield*PeriodCurves.prepare(work):undefined);
    let preparedBytes=0;
    for(const series of tape.quota) {
      const activity=workCurves?.groups.source.get(series.source);
      const key=series.source+'\n'+series.window,old=prior?.quota.get(key),reuse=old?.series===series&&!changedWork.has(series.source);
      if(!reuse)progress?.(preparedBytes+sampleCount(series.samples)*88+1024);
      const index=reuse?old!:yield*QuotaIndex.prepare(series,activity,Math.max(work?.knownFrom??Infinity,series.workFrom??0));
      if(!reuse){preparedBytes+=index.bytes;progress?.(preparedBytes);}
      this.quota.set(key,index);this.sampleTimes.set(key,index.times);
    }
    for(const group of tape.money){const key=group.source+'\n'+group.meter+'\n'+(group.displayUnit??group.readings[0]?.unit),old=prior?.money.get(key);this.money.set(key,old?.group===group?old:yield*MoneyIndex.prepare(group));}
  }
  get quotaBytes(){return [...this.quota.values()].reduce((n,index)=>n+index.bytes,0);}
  quotaSummary(source:string,window:string,range:PeriodRange){return this.quota.get(source+'\n'+window)?.at(range);}
  moneySummary(source:string,meter:string,unit:string,range:PeriodRange){return this.money.get(source+'\n'+meter+'\n'+unit)?.at(range);}
  fixed(range:PeriodRange,cell:number):NonNullable<PeriodTape['fixed']> {
    const blank:History={range:'',live:false,since:range.from,to:range.to,cellMs:cell,historyStart:0,series:[],events:[],activity:{since:range.from,known:null,barMs:cell,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}};
    const quota=this.project(blank,range,undefined,true).series;
    const money=[...this.money.values()].flatMap(index=>{const group=index.group,last=group.readings.filter(row=>row.at<range.to).at(-1);return last?[{sourceId:group.source,meterId:group.meter,kind:group.paired?'balance' as const:last.kind,unit:group.displayUnit??last.unit,accounting:group.accounting,role:group.role,pointMode:last.kind==='cap'?'cell' as const:'observation' as const,...index.at(range),points:index.plot(range,cell,[])}]:[];});
    return {range,cell,quota,money};
  }
  project(history:History,range:PeriodRange,values?:ReadonlyMap<string,PeriodValues>,boundaryOnly=false):History {
    if(range.from<this.tape.from)return history;
    const fixed=this.tape.fixed;
    if(fixed){
      if(range.from!==fixed.range.from||range.to!==fixed.range.to||history.cellMs!==fixed.cell)return history;
      const leftEnd=(Math.floor(range.from/fixed.cell)+1)*fixed.cell,rightStart=Math.floor((range.to-1)/fixed.cell)*fixed.cell;
      const interior=(at:number)=>at>=leftEnd&&at<rightStart;
      return {...history,exact:true,since:range.from,to:range.to,
        series:fixed.quota.map(row=>({...row,points:[...(history.series.find(s=>s.sourceId===row.sourceId&&s.windowId===row.windowId)?.points??[]).filter(([at])=>interior(at)),...row.points].sort((a,b)=>a[0]-b[0])})),
        meterSeries:fixed.money.map(row=>({...row,points:[...(history.meterSeries?.find(s=>s.sourceId===row.sourceId&&s.meterId===row.meterId&&s.unit===row.unit)?.points??[]).filter(p=>interior(p.at)),...row.points].sort((a,b)=>a.at-b.at)}))};
    }
    const previous=new Map(history.series.map(s=>[s.sourceId+'\n'+s.windowId,s]));
    const series:HistorySeries[]=[];
    const batches=new Map<string,number>();
    if(!history.live)for(const row of this.tape.quota){const times=this.sampleTimes.get(row.source+'\n'+row.window)!;const at=numberAt(times,lower(times,range.to)-1);if(at!==undefined)batches.set(row.source,Math.max(batches.get(row.source)??0,at));}
    for(const row of this.tape.quota) {
      const key=row.source+'\n'+row.window,index=this.quota.get(key)!;
      const times=this.sampleTimes.get(key)!,membership=values?.get(row.source),descriptor=row.descriptors?.filter(d=>d.at<range.to).at(-1);
      const windowValue=membership?.windows.find(w=>w.id===row.window)??descriptor?.value;
      if(!history.live&&(membership?!membership.windows.some(w=>w.id===row.window):row.descriptors?numberAt(times,lower(times,range.to)-1)!==batches.get(row.source):row.member===false))continue;
      const old=previous.get(key);if(!old&&history.live)continue;
      const summary=index.at(range),points=!history.live?index.plot(range,history.cellMs,old?.points??[],boundaryOnly):old!.points;
      series.push({...old,sourceId:row.source,windowId:row.window,staleAfterMs:sampleAt(row.samples,sampleCount(row.samples)-1)?.staleAfterMs??0,...summary,points,...(!history.live?{pointMode:'observation' as const,windowValue:windowValue??row.windowValue}:{})});
    }
    return {...history,exact:true,since:range.from,to:range.to,series,meterSeries:history.meterSeries?.map(series=>{const index=this.money.get(series.sourceId+'\n'+series.meterId+'\n'+series.unit);return index?{...series,...index.at(range),...(!history.live?{points:index.plot(range,history.cellMs,series.points),...(series.kind!=='cap'?{pointMode:'observation' as const}:{})}:{})}:series;})};
  }
  changesAt(now:number,period:number,source?:string):number|null {
    if(this.tape.fixed)return null;
    let next=Infinity;for(const index of this.quota.values())if(!source||index.series.source===source)next=Math.min(next,index.changesAt(now,period));
    for(const index of this.money.values())if(!source||index.group.source===source)next=Math.min(next,index.changesAt(now,period));
    return Number.isFinite(next)?next:null;
  }
}
