import type {PeriodValues} from './periodValues.js';
import {drain,type Preparation} from './prepare.js';
import {edge} from './quota.js';
import type {History,HistorySeries} from './history.js';
import {sampleAt,sampleCount,numberAt,numberBytes,numberColumn,lowerNumber,rateAt,rateObservations,type Numbers,type MoneyTape,type PeriodTape} from './periodTape.js';
import type {MeterHistory} from './meterHistory.js';
import {locatedIn,meterStep,plottedAmount,semanticsOf,type ExceptionalStep,type MeterSpan,type Reading,type MeterSemantics} from './meters.js';
import {convertBy} from './currency.js';
import type {PeriodRange} from './period.js';
import type {WorkTrace} from './periodWork.js';
import {union} from './work.js';
import {spanBefore,spanDeadline,valuationAt} from './periodMoney.js';
import {PeriodCurves,type WorkTimeline} from './periodCurves.js';

const lower=lowerNumber;
// Conservative JS storage reserves; typed numeric buffers use their byteLength.
const arrayBytes=(length:number)=>32+length*16;
const bigintBytes=(value:bigint)=>32+Math.max(1,Math.ceil((value<0n?-value:value).toString(16).length/16))*8;
/** Interior cells retain their own spending, but a crossing step belongs to the exact frame. */
function moneyInterior(points:MeterHistory['points'],range:PeriodRange,cell:number,previous:PeriodRange) {
  const leftEnd=(Math.floor(range.from/cell)+1)*cell,rightStart=Math.floor((range.to-1)/cell)*cell;
  return points.filter(p=>p.at>=leftEnd&&p.at<rightStart).map(point=>{
    if(point.spent===null||!point.steps.length)return point;
    let spent=BigInt(point.spent);
    for(const step of point.steps){
      const before=locatedIn(step,previous.from,previous.to),after=step.to<range.to&&locatedIn(step,range.from,range.to);
      if(before!==after)spent+=BigInt(step.amount)*(after?1n:-1n);
    }
    return {...point,spent:spent.toString()};
  });
}
class Intervals {
  readonly from:Float64Array;
  readonly to:Float64Array;
  readonly sums:Float64Array;
  constructor(spans:readonly [number,number][]) {
    this.from=new Float64Array(spans.length);this.to=new Float64Array(spans.length);this.sums=new Float64Array(spans.length+1);
    for(let i=0;i<spans.length;i++){const [a,b]=spans[i];this.from[i]=a;this.to[i]=b;this.sums[i+1]=this.sums[i]+b-a;}
  }
  get bytes(){return 96+3*128+this.from.byteLength+this.to.byteLength+this.sums.byteLength;}
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

class AmountIndex {
  private retainedBytes=0;
  get bytes(){return this.retainedBytes;}
  static preparationBytes(readings:number){
    const count=Math.max(0,readings-1),prefixes=count+1;
    const limbs=Math.ceil((64+Math.ceil(Math.log2(Math.max(1,count))))/64);
    // Three growing numeric builders overlap their final typed buffers. Each
    // independent accounting branch may retain every step as an exception.
    return 1024+3*arrayBytes(prefixes)+3*(128+prefixes*8)+arrayBytes(prefixes)
      +prefixes*(32+limbs*8)+count*(64+64+32+40);
  }
  private readonly exceptional=new Map<number,ExceptionalStep>();
  private starts=new Float64Array(0);
  private ends=new Float64Array(0);
  private readonly sums:bigint[]=[0n];
  private missing=new Float64Array(0);
  constructor(readings:readonly Reading[],spans:readonly MeterSpan[],convert:(value:string,reading:Reading)=>string|null,topup=false,deferred=false) {if(!deferred)drain(this.build(readings,spans,convert,topup));}
  static *prepare(readings:readonly Reading[],spans:readonly MeterSpan[],convert:(value:string,reading:Reading)=>string|null,topup=false):Preparation<AmountIndex>{const value=new AmountIndex(readings,spans,convert,topup,true);yield*value.build(readings,spans,convert,topup);return value;}
  private *build(readings:readonly Reading[],spans:readonly MeterSpan[],convert:(value:string,reading:Reading)=>string|null,topup:boolean):Preparation<void>{
    const starts:number[]=[],ends:number[]=[],missing=[0];
    let spanIndex=0,payloadBytes=bigintBytes(0n),exceptionBytes=0;
    for(let i=1;i<readings.length;i++) {
      yield;const a=readings[i-1],b=readings[i],from=b.previousAt??a.at;
      while(spanIndex+1<spans.length&&spans[spanIndex+1].from<=from)spanIndex++;
      const covering=spans[spanIndex]?[spans[spanIndex]]:[];
      const step=topup?meterStep({...a,kind:'counter'},{...b,kind:'counter'},covering):meterStep(a,b,covering);
      if(!step)continue;
      const amount=convert(step.amount,b);
      missing.push(missing.at(-1)!+Number(amount===null));
      if(step.evidence!=='continuous'){this.exceptional.set(starts.length,{...step,amount:amount??'0'});exceptionBytes+=64+64+32+(amount??'0').length*2;}
      starts.push(step.from);ends.push(step.to);
      const sum=this.sums.at(-1)!+(step.evidence==='continuous'&&amount!==null?BigInt(amount):0n);this.sums.push(sum);payloadBytes+=bigintBytes(sum);
    }
    this.starts=Float64Array.from(starts);this.ends=Float64Array.from(ends);this.missing=Float64Array.from(missing);
    this.retainedBytes=256+arrayBytes(this.sums.length)+3*128+this.starts.byteLength+this.ends.byteLength+this.missing.byteLength+192+exceptionBytes+payloadBytes;
  }
  at(range:PeriodRange) {
    const lo=lower(this.starts,range.from),hi=lower(this.ends,range.to),edge=lower(this.ends,range.from);
    const unlocated:ExceptionalStep[]=[];
    for(let i=edge;i<hi;i++){const step=this.exceptional.get(i);if(this.starts[i]<range.from||step)unlocated.push(step??{from:this.starts[i],to:this.ends[i],amount:(this.sums[i+1]-this.sums[i]).toString(),evidence:'continuous'});}
    return {value:this.missing[hi]>this.missing[edge]?null:hi>lo?(this.sums[hi]-this.sums[lo]).toString():'0',unlocated};
  }
  /** A boundary observation owns its original step, never a fraction of the interval. */
  point(at:number,range:PeriodRange,cell:number):Pick<MeterHistory['points'][number],'spent'|'steps'> {
    const lo=lower(this.ends,at),hi=lower(this.ends,at+1),from=Math.max(range.from,Math.floor(at/cell)*cell),to=Math.min(range.to,(Math.floor(at/cell)+1)*cell);
    let spent=0n;const steps:ExceptionalStep[]=[];
    for(let i=lo;i<hi;i++){
      const step=this.exceptional.get(i)??{from:this.starts[i],to:this.ends[i],amount:(this.sums[i+1]-this.sums[i]).toString(),evidence:'continuous' as const};
      if(locatedIn(step,range.from,range.to))spent+=BigInt(step.amount);
      if(!locatedIn(step,from,to))steps.push(step);
    }
    return {spent:this.missing[hi]>this.missing[lo]?null:spent.toString(),steps};
  }
}

class MoneyIndex {
  private retainedBytes=0;
  private times=new Float64Array(0);
  private spent!:AmountIndex;
  private topup!:AmountIndex;
  private coverage!:Intervals;
  private pairedTimes=new Float64Array(0);
  private valuations=new Map<string,Float64Array>();
  private anchors:Float64Array=new Float64Array(0);
  /** Separate from the tape: reserve construction overlap before any allocation. */
  static bytes(group:MoneyTape) {
    const primary=group.readings.length,paired=group.paired?.readings.length??0;
    const spans=group.spans.length+(group.paired?.spans.length??0);
    let rates=0,keyChars=0,maxLegs=0;
    for(const key in group.rates){rates++;keyChars+=key.length;maxLegs=Math.max(maxLegs,group.rates![key]?.length??0);}
    for(const key in group.rateBindings?.entries){rates++;keyChars+=key.length;}
    for(const path of group.rateBindings?.paths??[])maxLegs=Math.max(maxLegs,path?.length??0);
    const anchors=primary+paired+rates+3*spans;
    // Numeric buffers are exact; JS builders allow two slots per element. The
    // anchor allowance covers Set entries, typed sorting buffers and iterators
    // simultaneously. Rate keys include their sliced unit strings and per-unit
    // builders/typed outputs. Coverage includes mapped spans, union and indexes.
    const numeric=3*128+8*(primary+paired+anchors);
    const valuations=512+rates*512+keyChars*4;
    const anchorScratch=1024+anchors*160;
    const coverage=1024+spans*320;
    // A native difference has at most 64 bits. Conversion may temporarily
    // multiply by every route leg (63 bits each), with up to 60 scale bits.
    const conversionBits=124+64*maxLegs;
    const conversion=2048+16*(32+8*Math.ceil(conversionBits/64))+2*conversionBits;
    const spent=AmountIndex.preparationBytes(group.accounting?.spending==='unavailable'?0:primary);
    const topup=AmountIndex.preparationBytes(group.accounting?.topups==='unavailable'?0:group.paired?paired:primary);
    return 4096+numeric+valuations+anchorScratch+coverage+conversion+spent+topup;
  }
  get bytes(){return this.retainedBytes;}
  constructor(readonly group:MoneyTape,deferred=false) {if(!deferred)drain(this.build());}
  static *prepare(group:MoneyTape):Preparation<MoneyIndex>{const value=new MoneyIndex(group,true);yield*value.build();return value;}
  private *build():Preparation<void>{
    const group=this.group;
    this.times=new Float64Array(group.readings.length);this.pairedTimes=new Float64Array(group.paired?.readings.length??0);
    for(const [i,r] of group.readings.entries()){this.times[i]=r.at;yield;}for(const [i,r] of (group.paired?.readings??[]).entries()){this.pairedTimes[i]=r.at;yield;}
    const valuations=new Map<string,number[]>();let valuationBytes=0;
    for(const [unit,at] of rateObservations(group)){const times=valuations.get(unit)??[];times.push(at);valuations.set(unit,times);yield;}
    for(const [unit,times] of valuations){const sorted=yield*sortedNumbers(Float64Array.from(times));this.valuations.set(unit,sorted);valuationBytes+=96+32+unit.length*2+128+sorted.byteLength;}
    valuations.clear();
    this.anchors=yield*this.buildAnchors();
    const convert=(amount:string,reading:Reading)=>this.convert(amount,reading);
    this.spent=yield* AmountIndex.prepare(group.accounting?.spending==='unavailable'?[]:group.readings,group.spans,convert);
    // Account credits are a monotonically increasing funding counter; balance-only
    // suppliers have no accounting authority and never reach this result.
    this.topup=group.accounting?.topups==='unavailable'?yield* AmountIndex.prepare([],[],convert):group.paired?yield* AmountIndex.prepare(group.paired.readings,group.paired.spans,convert):yield* AmountIndex.prepare(group.readings,group.spans,convert,true);
    // Accounting is confirmed only between observations. A held value's TTL is not
    // evidence of zero spending in the unobserved tail.
    this.coverage=new Intervals(union(group.spans.map(s=>({from:Math.max(s.from,group.retainedFrom??0),to:Math.min(s.to,s.holdUntil??Infinity,s.interruptedAt??Infinity)})).filter(s=>s.to>s.from)));
    this.retainedBytes=512+3*128+this.times.byteLength+this.pairedTimes.byteLength+this.anchors.byteLength+this.spent.bytes+this.topup.bytes+this.coverage.bytes+valuationBytes;
  }
  private *buildAnchors():Preparation<Float64Array>{
    const unique=new Set<number>();
    for(const times of [this.times,this.pairedTimes,...this.valuations.values()])for(const at of times){unique.add(at);yield;}
    for(const part of [this.group,...(this.group.paired?[this.group.paired]:[])])for(const span of part.spans){unique.add(span.from);unique.add(span.to);if(span.observedFrom!==undefined)unique.add(span.observedFrom);yield;}
    const values=new Float64Array(unique.size);let at=0;for(const value of unique){values[at++]=value;yield;}
    unique.clear();return yield*sortedNumbers(values);
  }
  private convert(value:string,reading:Reading,at=reading.at) {
    if(!this.group.displayUnit||reading.unit===this.group.displayUnit)return value;
    const rates=rateAt(this.group,reading.unit+'\n'+at);return rates?convertBy(value,rates,reading.scale):null;
  }
  private semantics(reading:Reading,at=reading.at,native=plottedAmount(reading)):MeterSemantics {
    const original=semanticsOf(reading),converted=this.group.displayUnit&&this.group.displayUnit!==reading.unit;
    if(!converted)return original.conversion?{...original,conversion:{...original.conversion,original:{...original.conversion.original,at}}}:original;
    const steps=rateAt(this.group,reading.unit+'\n'+at);
    return {...original,scale:6,limit:reading.limit===null?null:this.convert(reading.limit,reading,at),...(steps?.length?{conversion:{original:{meterId:this.group.meter,amount:native,unit:reading.unit,at,...(reading.scale===undefined?{}:{scale:reading.scale}),limit:reading.limit},rate:steps.at(-1)!,steps}}:{})};
  }
  private observation(at:number,inclusive=false) {
    const group=this.group,edge=at+(inclusive?1:0),reading=group.readings[lower(this.times,edge)-1];
    if(!reading)return null;
    const span=spanBefore(group.spans,at,inclusive),times=this.valuations.get(reading.unit)??[];
    const anchor=(row:Reading,span:MeterSpan|undefined)=>valuationAt(row,span,at,inclusive,times[lower(times,Math.min(edge,(span?.to??row.at)+1))-1]??null);
    let observed=anchor(reading,span),native=plottedAmount(reading);
    let deadline=Math.min(span?spanDeadline(span):-Infinity,reading.resetAt??Infinity);
    if(group.paired) {
      const credits=group.paired.readings[lower(this.pairedTimes,edge)-1],pairedSpan=spanBefore(group.paired.spans,at,inclusive);
      if(!credits||credits.unit!==reading.unit)return null;
      native=(BigInt(credits.amount)-BigInt(reading.amount)).toString();
      observed=Math.min(observed,anchor(credits,pairedSpan));
      deadline=Math.min(deadline,pairedSpan?spanDeadline(pairedSpan):-Infinity,credits.resetAt??Infinity);
    }
    return {reading,span,observed,native,deadline};
  }
  private value(observation:ReturnType<MoneyIndex['observation']>,at:number) {
    return observation&&at<observation.deadline?this.convert(observation.native,observation.reading,observation.observed):null;
  }
  plot(range:PeriodRange,cell:number,previous:MeterHistory['points'],quantities=range):MeterHistory['points'] {
    const leftEnd=(Math.floor(range.from/cell)+1)*cell,rightStart=Math.floor((range.to-1)/cell)*cell;
    const points=moneyInterior(previous,range,cell,quantities).map(p=>({...p,validUntil:p.validUntil??(Math.floor(p.at/cell)+1)*cell}));
    for(const [from,to] of leftEnd>=rightStart?[[range.from,range.to]]:[[range.from,leftEnd],[rightStart,range.to]]) {
      const anchors=[...new Set([from,...this.anchors.slice(lower(this.anchors,from),lower(this.anchors,to))])];
      for(const at of anchors) {
        const observation=this.observation(at,true),value=this.value(observation,at);if(!observation?.span||value===null)continue;
        const {reading,span,observed,native,deadline}=observation;
        const until=Math.min(to,this.anchors[lower(this.anchors,at+1)]??Infinity,deadline);
        if(until<=at)continue;
        const spending=reading.kind==='cap'||this.group.accounting?.spending==='unavailable'?{spent:null,steps:[]}:this.spent.point(at,range,cell);
        points.push({at:reading.kind==='cap'?Math.floor(at/cell)*cell:at,value,knownFrom:at,knownUntil:until,validUntil:until,segment:span.from,semantics:this.semantics(reading,observed,native),...spending});
      }
    }
    return points.sort((a,b)=>a.at-b.at||(a.knownFrom??0)-(b.knownFrom??0));
  }
  at(range:PeriodRange):Pick<MeterHistory,'start'|'end'|'startScale'|'endScale'|'spent'|'topup'|'unlocated'|'topupUnlocated'|'coveredMs'|'semantics'> {
    const spent=this.spent.at(range),topup=this.topup.at(range),authority=this.group.accounting;
    const last=this.observation(range.to),first=this.observation(range.from,true);
    const semantics=last?this.semantics(last.reading,last.observed,last.native):null;
    const scale=(observation:typeof last)=>observation?(this.group.displayUnit&&this.group.displayUnit!==observation.reading.unit?6:observation.reading.scale):undefined;
    const coveredMs=this.coverage.in(range);
    return {start:this.value(first,range.from),end:this.value(last,range.to),startScale:scale(first),endScale:scale(last),semantics,spent:authority?.spending==='unavailable'||!coveredMs?null:spent.value,topup:authority?.topups==='unavailable'||!coveredMs?null:topup.value,unlocated:authority?.spending==='unavailable'?[]:spent.unlocated,topupUnlocated:authority?.topups==='unavailable'?[]:topup.unlocated,coveredMs};
  }
  changesAt(now:number,period:number) {
    let next=Infinity;
    const consider=(at:number)=>{for(const offset of [0,period])for(const edge of [at+offset,at+offset+1])if(edge>now)next=Math.min(next,edge);};
    for(const times of [this.anchors])for(const offset of [0,period]){
      const i=lower(times,now-offset);if(i<times.length)consider(times[i]);
      if(i+1<times.length)consider(times[i+1]);
    }
    for(const part of [this.group,...(this.group.paired?[this.group.paired]:[])]){
      for(const span of part.spans){consider(span.from);consider(span.to);consider(span.observedFrom??Infinity);consider(Math.min(span.to+span.staleAfterMs+1,span.holdUntil??Infinity,span.interruptedAt??Infinity));}
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
    for(const group of tape.money){
      const key=group.source+'\n'+group.meter+'\n'+(group.displayUnit??group.readings[0]?.unit),old=prior?.money.get(key),reuse=old?.group===group;
      if(!reuse)progress?.(preparedBytes+MoneyIndex.bytes(group));
      const index=reuse?old!:yield*MoneyIndex.prepare(group);
      if(!reuse){preparedBytes+=index.bytes;progress?.(preparedBytes);}
      this.money.set(key,index);
    }
  }
  get quotaBytes(){let bytes=0;for(const index of this.quota.values())bytes+=index.bytes;return bytes;}
  get bytes(){let bytes=this.quotaBytes;for(const index of this.money.values())bytes+=index.bytes;return bytes;}
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
        meterSeries:fixed.money.map(row=>({...row,points:[...moneyInterior(history.meterSeries?.find(s=>s.sourceId===row.sourceId&&s.meterId===row.meterId&&s.unit===row.unit)?.points??[],range,fixed.cell,{from:history.since,to:history.to}),...row.points].sort((a,b)=>a.at-b.at)}))};
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
    return {...history,exact:true,since:range.from,to:range.to,series,meterSeries:history.meterSeries?.map(series=>{const index=this.money.get(series.sourceId+'\n'+series.meterId+'\n'+series.unit);return index?{...series,...index.at(range),...(!history.live?{points:index.plot(range,history.cellMs,series.points,{from:history.since,to:history.to}),...(series.kind!=='cap'?{pointMode:'observation' as const}:{})}:{})}:series;})};
  }
  changesAt(now:number,period:number,source?:string):number|null {
    if(this.tape.fixed)return null;
    let next=Infinity;for(const index of this.quota.values())if(!source||index.series.source===source)next=Math.min(next,index.changesAt(now,period));
    for(const index of this.money.values())if(!source||index.group.source===source)next=Math.min(next,index.changesAt(now,period));
    return Number.isFinite(next)?next:null;
  }
}
