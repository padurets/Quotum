import type {QuotaTail} from './periodRetention.js';
import {MoneyWorkIndex} from './periodMoneyWork.js';
import type {PeriodValues} from './periodValues.js';
import {drain,type Preparation} from './prepare.js';
import {edge} from './quota.js';
import type {History,HistorySeries} from './history.js';
import {sameMoneyTape,sampleAt,sampleDeadlineAt,sampleCount,numberAt,numberBytes,numberColumn,numberTail,lowerNumber,rateAt,rateObservations,type NumberColumn,type Numbers,type MoneyTape,type PeriodTape} from './periodTape.js';
import type {MeterHistory} from './meterHistory.js';
import {locatedIn,meterStep,plottedAmount,semanticsOf,type ExceptionalStep,type MeterSpan,type Reading,type MeterSemantics} from './meters.js';
import {convertBy} from './currency.js';
import type {PeriodRange} from './period.js';
import type {WorkTrace} from './periodWork.js';
import {union} from './work.js';
import {spanBefore,spanDeadline,valuationAt} from './periodMoney.js';
import {PeriodCurves,type WorkTimeline,type SourceWorkCurves} from './periodCurves.js';

const lower=lowerNumber;
// Conservative JS storage reserves; typed numeric buffers use their byteLength.
const arrayBytes=(length:number)=>32+length*16;
const bigintBytes=(value:bigint)=>32+Math.max(1,Math.ceil((value<0n?-value:value).toString(16).length/16))*8;
/** Preserve cell support before clipping it into an observation-mode interior. */
function quotaInterior(series:HistorySeries|undefined,range:PeriodRange,cell:number,coverageTo:number):HistorySeries['points'] {
  if(!series)return [];
  const from=(Math.floor(range.from/cell)+1)*cell,to=Math.min(Math.floor((range.to-1)/cell)*cell,coverageTo);
  if(from>=to)return [];
  const result:HistorySeries['points']=[];
  for(let i=0;i<series.points.length;i++){
    const [at,value,segment,bound]=series.points[i],next=series.points[i+1];
    if(series.pointMode==='observation'&&bound===undefined)continue;
    // Sparse cells in the same run prove the intervening cells too. A break
    // proves only this measured cell; the terminal run uses the cell readout hold.
    const until=bound??(next?next[2]===segment?next[0]:at+cell:at+(Math.floor(Math.max(cell,series.staleAfterMs)/cell)+1)*cell);
    const beginning=Math.max(at,from),end=Math.min(until,next?.[0]??Infinity,to);
    if(end>beginning)result.push([beginning,value,segment,end]);
  }
  return result;
}
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
type QuotaSummary=Pick<HistorySeries,'consumed'|'coveredMs'|'remainingAtStart'|'remainingAtEnd'|'work'|'selectedWork'>;
// Strict integer observation order bounds every covered prefix by the complete time span.
function* integerTimes(column:Numbers):Preparation<boolean> {
  if(!('base' in column)||!Object.is(column.base,0)||column.values!==null||!column.runs)return false;
  const {ends,bases,steps}=column.runs;
  if(!ends.length||ends.length!==bases.length||ends.length!==steps.length||ends.at(-1)!==column.length)return false;
  let from=0,previous=-1,first=0;
  for(let i=0;i<ends.length;i++){
    const to=ends[i],base=bases[i],step=steps[i],product=(to-from-1)*step,last=base+product;
    if(to<=from||!Number.isSafeInteger(base)||base<0||!Number.isSafeInteger(step)||step<0||to-from>1&&step===0
      ||!Number.isSafeInteger(product)||!Number.isSafeInteger(last)||base<=previous)return false;
    if(!i)first=base;previous=last;from=to;yield;
  }
  return Number.isSafeInteger(previous-first)&&previous-first<=Number.MAX_SAFE_INTEGER;
}
function* numericDeadlines(column:Numbers):Preparation<boolean> {
  if(!('base' in column))return false;
  if(!column.runs)return column.values===null?!Number.isNaN(column.base):column.values instanceof Uint32Array&&Number.isFinite(column.base);
  const {ends,bases,steps}=column.runs;
  if(!Object.is(column.base,0)||column.values!==null||!ends.length||ends.length!==bases.length||ends.length!==steps.length||ends.at(-1)!==column.length)return false;
  for(let i=0,from=0;i<ends.length;from=ends[i++]){
    const to=ends[i],base=bases[i],step=steps[i],product=(to-from-1)*step;
    if(to<=from||!Number.isSafeInteger(base)||!Number.isSafeInteger(step)||!Number.isSafeInteger(product)||!Number.isSafeInteger(base+product))return false;
    yield;
  }
  return true;
}
function* integerTailReady(column:Numbers,origin:number):Preparation<boolean> {
  if(!('base' in column)||!Number.isSafeInteger(origin)||origin<0||!Number.isSafeInteger(column.base-origin))return false;
  if(column.runs){
    const {ends,bases,steps}=column.runs;
    if(column.values!==null||!ends.length||ends.length!==bases.length||ends.length!==steps.length||ends.at(-1)!==column.length)return false;
    for(let i=0,from=0;i<ends.length;from=ends[i++]){
      const to=ends[i],step=steps[i],base=bases[i],start=Math.max(1,from);
      if(to<=from)return false;
      if(to>1){
        const offset=(start-from)*step,product=(to-from-1)*step,head=base+offset,last=base+product;
        if(step<0||![step,base,offset,product,head,last,head-origin,last-origin].every(Number.isSafeInteger)||head-origin<0)return false;
      }
      yield;
    }
  }
  return true;
}
function* integerTail(column:Numbers,origin:number,reserve:(bytes:number)=>void):Preparation<Numbers> {
  const tail=yield*numberTail(column as NumberColumn,1,reserve);
  if(tail.runs){for(let i=0;i<tail.runs.bases.length;i++){tail.runs.bases[i]-=origin;yield;}}
  else tail.base-=origin;
  return tail;
}
class QuotaIndex {
  readonly times:Numbers;
  private deadlines:Numbers=new Float64Array(0);
  private spent:Numbers=new Float64Array(0);
  private covered:Numbers=new Float64Array(0);
  private worked:Numbers=new Float64Array(0);
  private during:Numbers=new Float64Array(0);
  constructor(readonly series:PeriodTape['quota'][number],private readonly activity:WorkTimeline|undefined,private readonly known:number,deferred=false,prior?:QuotaIndex) {
    const count=sampleCount(series.samples);
    this.times=prior?.series===series?prior.times:'columns' in series.samples?series.samples.columns[0]:new Float64Array(count);
    if(!deferred)drain(QuotaIndex.build(()=>this,prior));
  }
  static prepare(series:PeriodTape['quota'][number],activity:WorkTimeline|undefined,known:number,prior?:QuotaIndex,batchQuota=false):Preparation<QuotaIndex>{return QuotaIndex.build(()=>new QuotaIndex(series,activity,known,true,prior),prior,batchQuota);}
  private static *build(create:()=>QuotaIndex,prior?:QuotaIndex,batchQuota=false):Preparation<QuotaIndex>{
    const value=create();
    const series=value.series,{known}=value,activity=known===Infinity?undefined:value.activity,count=sampleCount(series.samples);
    // Work retirement can leave quota observations untouched. Keep their exact prefixes.
    const reuse=prior?.series===series;
    const deadlines=reuse?null:new Float64Array(count),spent=reuse?null:new Float64Array(count),covered=reuse?null:new Float64Array(count),worked=activity?new Float64Array(count):null,during=activity?new Float64Array(count):null;
    let previous:ReturnType<typeof sampleAt>,orderedDeadlines=true;
    // Decode each observation once; unavailable work keeps constant zero prefixes.
    // Retirement groups avoid resuming every delegation layer per observation.
    // Explicit units preserve the UI's deadline checks across these larger yields.
    for(let i=0;i<count&&(!reuse||activity);i++) {
      if(!batchQuota)yield;else if((i&15)===0)yield 16;
      const sample=sampleAt(series.samples,i)!;
      if(!reuse&&value.times instanceof Float64Array)value.times[i]=sample.at;
      if(deadlines){
        deadlines[i]=Math.min(sample.at+sample.staleAfterMs+1,sample.resetAt??Infinity,sample.validUntil??Infinity);
        if(i&&!(deadlines[i-1]<=deadlines[i]))orderedDeadlines=false;
      }
      if(i) {
        if(spent&&covered){spent[i]=spent[i-1];covered[i]=covered[i-1];}
        if(worked&&during){worked[i]=worked[i-1];during[i]=during[i-1];}
        const a=previous!,b=sample,step=edge(a,b);
        if(step.valid) {
          const work=a.at>=known?activity?.read({from:a.at,to:b.at},true)??0:0;
          if(spent&&covered){spent[i]+=step.delta;covered[i]+=b.at-a.at;}
          if(worked&&during){worked[i]+=work;during[i]+=work>0?step.delta:0;}
        }
      }
      previous=sample;
    }
    // End the grouped region before ordinary packing resumes.
    if(batchQuota&&count>0&&(!reuse||activity))yield 16;
    if(reuse){value.deadlines=prior.deadlines;value.spent=prior.spent;value.covered=prior.covered;}
    else if(deadlines&&spent&&covered){
      const sorted=orderedDeadlines?deadlines:yield*sortedNumbers(deadlines);value.deadlines=yield*numberColumn(sorted.length,i=>sorted[i]);
      value.spent=yield*numberColumn(spent.length,i=>spent[i]);value.covered=yield*numberColumn(covered.length,i=>covered[i]);
    }
    value.worked=worked?yield*numberColumn(count,i=>worked[i]):{length:count,base:0,values:null};
    value.during=during?yield*numberColumn(count,i=>during[i]):{length:count,base:0,values:null};
    return value;
  }

  // This path consumes only a producer-issued, single-observation retirement proof.
  static *retire(series:PeriodTape['quota'][number],activity:WorkTimeline|undefined,known:number,prior:QuotaIndex,tail:QuotaTail,reserve?:(bytes:number)=>void):Preparation<QuotaIndex|undefined>{
    if(tail.removed!==1||tail.before!==prior.series||tail.after!==series||!('columns' in prior.series.samples)||!('columns' in series.samples)
      ||sampleCount(prior.series.samples)!==sampleCount(series.samples)+1||prior.activity!==activity||!Object.is(prior.known,known)
      ||!('base' in prior.spent)||!('base' in prior.during)||!('base' in prior.worked))return undefined;
    const dropped=sampleDeadlineAt(prior.series.samples,0),origin=numberAt(prior.covered,1)!;
    if(!(Number.isFinite(dropped)||dropped===Infinity)||!Object.is(dropped,numberAt(prior.deadlines,0))
      ||!(yield*integerTimes(prior.series.samples.columns[0]))||!(yield*numericDeadlines(prior.deadlines))||!(yield*integerTailReady(prior.covered,origin)))return undefined;
    const value=new QuotaIndex(series,activity,known,true);let scratch=0;
    const copying=(bytes:number)=>{scratch+=bytes;reserve?.(scratch);};
    yield;
    value.deadlines=yield*numberTail(prior.deadlines as NumberColumn,1,copying);
    const rebuildSpent=!Object.is(numberAt(prior.spent,1),0),rebuildWorked=!Object.is(numberAt(prior.worked,1),0),rebuildDuring=!Object.is(numberAt(prior.during,1),0);
    const count=sampleCount(series.samples),columns=Number(rebuildSpent)+Number(rebuildWorked)+Number(rebuildDuring);
    // Removing a nonzero prefix changes floating addition order. Rebuild only
    // those sums forward; independent deadlines and integer coverage keep their tails.
    if(columns)copying(columns*(count*16+64));
    const spent=rebuildSpent?new Float64Array(count):null,worked=rebuildWorked?new Float64Array(count):null,during=rebuildDuring?new Float64Array(count):null;
    // Exact integer coverage already records which observation edges were valid.
    // Keep endpoint values once per observation and add each floating delta forward.
    const fields=series.samples.columns;
    let coverage=0,used=0,reset=-1,at=0,integers=true;
    for(let i=0;i<count&&columns;i++){
      if((i&15)===0)yield 16;
      const nextCoverage=numberAt(prior.covered,i+1)!,nextUsed=spent||during?numberAt(fields[1],i)!:0,nextReset=spent||during?numberAt(fields[2],i)!:-1,nextAt=worked||during?numberAt(value.times,i)!:0;
      if(i){
        if(spent)spent[i]=spent[i-1];if(worked)worked[i]=worked[i-1];if(during)during[i]=during[i-1];
        if(nextCoverage>coverage){
          const delta=reset===-1||nextReset===-1?0:Math.max(0,nextUsed-used);
          if(spent)spent[i]+=delta;
          if(worked||during){const work=at>=known&&known!==Infinity?activity?.read({from:at,to:nextAt},true)??0:0;if(worked)worked[i]+=work;if(during)during[i]+=work>0?delta:0;}
        }
      }
      if(spent)integers&&=Number.isSafeInteger(spent[i]);coverage=nextCoverage;used=nextUsed;reset=nextReset;at=nextAt;
    }
    if(count&&columns)yield 16;
    yield;
    // A finite prefix that cannot use integer packing starts at zero and is
    // nondecreasing, so the ordinary packer would only copy this Float64 column.
    value.spent=spent?!integers&&Number.isFinite(spent[count-1])?{length:count,base:0,values:spent}:yield*numberColumn(count,i=>spent[i]):yield*numberTail(prior.spent as NumberColumn,1,copying);
    yield;
    value.covered=yield*integerTail(prior.covered,origin,copying);
    yield;
    value.worked=worked?yield*numberColumn(count,i=>worked[i]):yield*numberTail(prior.worked as NumberColumn,1,copying);
    yield;
    value.during=during?yield*numberColumn(count,i=>during[i]):yield*numberTail(prior.during as NumberColumn,1,copying);
    return value;
  }

  sharesWork(activity:WorkTimeline|undefined,known:number){return this.activity===activity&&Object.is(this.known,known);}
  get bytes(){return [this.deadlines,this.spent,this.covered,this.worked,this.during].reduce((n,c)=>n+numberBytes(c),0)+(this.times instanceof Float64Array?numberBytes(this.times):0);}
  /** A retained prior still owns every borrowed column during preparation. */
  newBytes(prior?:QuotaIndex){
    const before=prior?[prior.deadlines,prior.spent,prior.covered,prior.worked,prior.during]:[];
    return [this.deadlines,this.spent,this.covered,this.worked,this.during].reduce((n,c,i)=>n+(c===before[i]?0:numberBytes(c)),0)
      +(this.times instanceof Float64Array&&this.times!==prior?.times?numberBytes(this.times):0);
  }
  /** Zero spending is distinguished by whether measured time remains. */
  spendingStateChangesAt(now:number,period:number){
    const count=this.times.length;if(!count)return Infinity;
    if(!Number.isFinite(numberAt(this.spent,count-1))||!Number.isFinite(numberAt(this.covered,count-1)))return this.changesAt(now,period);
    const lo=lower(this.times,now-period),end=lower(this.times,now),hi=Math.max(0,end-1),right=(numberAt(this.times,end)??Infinity)+1;
    if(hi<=lo)return right;
    const start=numberAt(this.spent,lo)!,finish=numberAt(this.spent,hi)!;let next=count;
    if(finish>start){
      let a=lo+1,b=hi+1;
      while(a<b){const middle=(a+b)>>>1;if(numberAt(this.spent,middle)===start)a=middle+1;else b=middle;}
      next=a;
    }else if(numberAt(this.covered,hi)!>numberAt(this.covered,lo)!)next=lower(this.covered,numberAt(this.covered,hi)!);
    return Math.min(right,next<count?(numberAt(this.times,next-1)??Infinity)+1+period:Infinity);
  }
  changesAt(now:number,period:number){
    const from=now-period,deadline=sampleDeadlineAt(this.series.samples,sampleCount(this.series.samples)-1)??Infinity;
    // Work and its clock use the same captured source curve, including after a
    // replacement could not fit. Knowledge changes even without a work interval.
    const work=Number.isFinite(this.known)?Math.min(this.activity?this.activity.next(from)+period:Infinity,this.activity?.next(now)??Infinity,this.known+1>now?this.known+1:Infinity,this.known+period>now?this.known+period:Infinity):Infinity;
    return Math.min((numberAt(this.times,lower(this.times,from))??Infinity)+1+period,(numberAt(this.deadlines,lower(this.deadlines,from+1))??Infinity)+period,deadline>now?deadline:Infinity,work);
  }

  workSlope(now:number,period:number,active:boolean){
    const left=Math.max(now-period,this.known),right=now;
    const slope=(at:number)=>active?Number(this.activity?.working(at)??false):this.activity?.slope(at)??0;
    const next=Math.min(this.changesAt(now,period),this.activity?.next(right)??Infinity,left===now-period?(this.activity?.next(left)??Infinity)+period:this.known+period);
    return {slope:slope(right)-(left===now-period?slope(left):0),next};
  }

  plot(range:PeriodRange,cell:number,previous:HistorySeries|undefined,coverageTo:number,boundaryOnly=false):HistorySeries['points'] {
    const leftEnd=(Math.floor(range.from/cell)+1)*cell,rightStart=Math.floor((range.to-1)/cell)*cell;
    const points=quotaInterior(previous,range,cell,coverageTo);
    if(!previous?.points.length&&!boundaryOnly){
      const cells=new Map<number,HistorySeries['points'][number]>();
      const first=lower(this.times,leftEnd),end=lower(this.times,rightStart);
      for(let i=first;i<end;i++){const s=sampleAt(this.series.samples,i)!,at=Math.floor(s.at/cell)*cell,old=cells.get(at),value=100-s.used;if(!old||value<old[1])cells.set(at,[at,value,i+1,Math.min(at+cell,s.at+s.staleAfterMs+1,s.resetAt??Infinity,s.validUntil??Infinity)]);}
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

  at(range:PeriodRange,spendingOnly:true):Pick<QuotaSummary,'consumed'|'coveredMs'>;
  at(range:PeriodRange,spendingOnly?:false,stateAt?:number):QuotaSummary;
  at(range:PeriodRange,spendingOnly=false,stateAt=range.to):QuotaSummary|Pick<QuotaSummary,'consumed'|'coveredMs'> {
    const lo=lower(this.times,range.from),end=lower(this.times,range.to),hi=Math.max(0,end-1);
    const sum=(values:Numbers)=>hi>lo?numberAt(values,hi)!-numberAt(values,lo)!:0;
    if(spendingOnly)return {consumed:sum(this.spent),coveredMs:sum(this.covered)};
    const last=sampleAt(this.series.samples,end-1),first=sampleAt(this.series.samples,lower(this.times,range.from+1)-1);
    const valid=(sample:typeof first,at:number)=>sample&&at<Math.min(sample.at+sample.staleAfterMs+1,sample.resetAt??Infinity,sample.validUntil??Infinity)?100-sample.used:null;
    const workRange={from:Math.max(range.from,this.known),to:range.to};
    const workLo=lower(this.times,workRange.from);
    return {consumed:sum(this.spent),coveredMs:sum(this.covered),remainingAtStart:valid(first,range.from),remainingAtEnd:valid(last,stateAt),work:Number.isFinite(this.known)?{from:workRange.from,ms:workRange.to>workRange.from?this.activity?.read(workRange,true)??0:null,agentMs:workRange.to>workRange.from?this.activity?.read(workRange)??0:0,consumed:hi>workLo?numberAt(this.spent,hi)!-numberAt(this.spent,workLo)!:0,coveredMs:sum(this.worked),duringWork:sum(this.during)}:null};
  }
  endValidUntil(range:PeriodRange){
    const sample=sampleAt(this.series.samples,lower(this.times,range.to)-1);
    return sample?Math.min(sample.at+sample.staleAfterMs+1,sample.resetAt??Infinity,sample.validUntil??Infinity):null;
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
  readonly group:Omit<MoneyTape,'workCounter'>;
  constructor(group:MoneyTape,deferred=false) {
    // Reusing financial prefixes must not retain an older native work ledger.
    const {workCounter:_work,...financial}=group;this.group=financial;
    if(!deferred)drain(this.build());
  }
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
    return {...original,scale:6,limit:reading.limit===null?null:this.convert(reading.limit,reading,at),...(steps?.length?{conversion:{original:{meterId:this.group.meter,amount:native,unit:reading.unit,at,...(reading.scale===undefined?{}:{scale:reading.scale}),limit:reading.limit},rate:steps.at(-1)!,...(steps.length>1?{steps}:{})}}:{})};
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
  endValidUntil(range:PeriodRange){const deadline=this.observation(range.to)?.deadline;return deadline!==undefined&&Number.isFinite(deadline)?deadline:null;}
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
  at(range:PeriodRange,stateAt=range.to):Pick<MeterHistory,'start'|'end'|'startScale'|'endScale'|'spent'|'topup'|'unlocated'|'topupUnlocated'|'coveredMs'|'semantics'> {
    const spent=this.spent.at(range),topup=this.topup.at(range),authority=this.group.accounting;
    const last=this.observation(range.to),first=this.observation(range.from,true);
    const semantics=last?this.semantics(last.reading,last.observed,last.native):null;
    const scale=(observation:typeof last)=>observation?(this.group.displayUnit&&this.group.displayUnit!==observation.reading.unit?6:observation.reading.scale):undefined;
    const coveredMs=this.coverage.in(range);
    return {start:this.value(first,range.from),end:this.value(last,stateAt),startScale:scale(first),endScale:scale(last),semantics,spent:authority?.spending==='unavailable'||!coveredMs?null:spent.value,topup:authority?.topups==='unavailable'||!coveredMs?null:topup.value,unlocated:authority?.spending==='unavailable'?[]:spent.unlocated,topupUnlocated:authority?.topups==='unavailable'?[]:topup.unlocated,coveredMs};
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

/** Native bounds often arrive ordered; other inputs sort within two fixed buffers. */
function* sortedNumbers(input:Float64Array):Preparation<Float64Array> {
  // Most retained deadlines already follow observation order, including repeated resets.
  let sorted=true;
  for(let i=1;i<input.length;i++){if(!(input[i-1]<=input[i])){sorted=false;break;}yield;}
  if(sorted)return input;
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
  financialAuthority:object={};
  private selectedCurves?:PeriodCurves;
  private selectedKnown=Infinity;
  private readonly moneyWork=new Map<string,MoneyWorkIndex>();
  private readonly quota=new Map<string,QuotaIndex>();
  private readonly money=new Map<string,MoneyIndex>();
  private readonly sampleTimes=new Map<string,Numbers>();
  constructor(readonly tape:PeriodTape,work:WorkTrace|null,curves?:PeriodCurves,deferred=false) {if(!deferred)drain(PeriodAccounting.build(()=>this,work,curves));}
  static prepare(tape:PeriodTape,work:WorkTrace|null,curves?:PeriodCurves,prior?:PeriodAccounting,changedWork:ReadonlySet<string>=new Set(),progress?:(bytes:number)=>void,sourceWide?:SourceWorkCurves,batchQuota=false):Preparation<PeriodAccounting>{return PeriodAccounting.build(()=>new PeriodAccounting(tape,work,curves,true),work,curves,prior,changedWork,progress,sourceWide,batchQuota);}
  private static *build(create:()=>PeriodAccounting,work:WorkTrace|null,curves?:PeriodCurves,prior?:PeriodAccounting,changedWork:ReadonlySet<string>=new Set(),progress?:(bytes:number)=>void,sourceWide?:SourceWorkCurves,batchQuota=false):Preparation<PeriodAccounting>{
    const value=create();
    const tape=value.tape;
    if(tape.fixed){if(prior?.tape.fixed&&JSON.stringify(prior.tape.fixed.money)===JSON.stringify(tape.fixed.money)&&JSON.stringify(prior.tape.fixed.range)===JSON.stringify(tape.fixed.range))value.financialAuthority=prior.financialAuthority;return value;}
    value.selectedCurves=curves??(work?yield*PeriodCurves.prepare(work):undefined);value.selectedKnown=work?.available===false?Infinity:work?.knownFrom??Infinity;
    const workCurves=sourceWide??value.selectedCurves,known=sourceWide?(sourceWide.available===false?Infinity:sourceWide.knownFrom):value.selectedKnown;
    let preparedBytes=0;
    for(const series of tape.quota) {
      const activity=workCurves?.groups.source.get(series.source);
      const key=series.source+'\n'+series.window,old=prior?.quota.get(key),reuse=old?.series===series&&!changedWork.has(series.source);
      const cutoff=series.workFrom===null?Infinity:Math.max(known,series.workFrom??0);
      // Work-only rebuilds borrow native prefixes; only two work columns need scratch and packing.
      if(!reuse)progress?.(preparedBytes+sampleCount(series.samples)*(old?.series===series?(activity&&cutoff!==Infinity?32:0):88)+1024);
      const index=reuse?old!:yield*QuotaIndex.prepare(series,activity,cutoff,old?.series===series?old:undefined,batchQuota);
      if(!reuse){preparedBytes+=index.newBytes(old);progress?.(preparedBytes);}
      value.quota.set(key,index);value.sampleTimes.set(key,index.times);
    }
    for(const group of tape.money){
      const key=group.source+'\n'+group.meter+'\n'+(group.displayUnit??group.readings[0]?.unit),old=prior?.money.get(key),reuse=old?.group===group||!!old&&sameMoneyTape(old.group,group);
      if(!reuse)progress?.(preparedBytes+MoneyIndex.bytes(group));
      const index=reuse?old!:yield*MoneyIndex.prepare(group);
      if(!reuse){preparedBytes+=index.bytes;progress?.(preparedBytes);}
      value.money.set(key,index);
      if(group.workCounter) {
        const counter=group.workCounter,oldWork=prior?.moneyWork.get(group.source),reuse=oldWork?.counter===counter&&!changedWork.has(group.source);
        if(!reuse)progress?.(preparedBytes+1024+counter.readings.length*256);
        const workIndex=reuse?oldWork!:yield*MoneyWorkIndex.prepare(counter,workCurves?.groups.source.get(group.source));
        value.moneyWork.set(group.source,workIndex);
        if(!reuse){preparedBytes+=workIndex.bytes;progress?.(preparedBytes);}
      }
    }
    if(prior&&value.money.size===prior.money.size&&[...value.money].every(([key,index])=>prior.money.get(key)===index))value.financialAuthority=prior.financialAuthority;
    return value;
  }
  // Ordinary preparation stays unchanged; only an actual retirement can enter here.
  static *prepareRetirement(tape:PeriodTape,work:WorkTrace|null,curves:PeriodCurves|undefined,prior:PeriodAccounting,changedWork:ReadonlySet<string>,progress:((bytes:number)=>void)|undefined,tails:ReadonlyMap<PeriodTape['quota'][number],QuotaTail>,sourceWide?:SourceWorkCurves):Preparation<PeriodAccounting>{
    if(tape.fixed||!tails.size)return yield*PeriodAccounting.prepare(tape,work,curves,prior,changedWork,progress,sourceWide);
    let meta=2048+tape.quota.length*640+tape.money.length*256,owned=0,scratch=0,partial:PeriodAccounting|undefined;
    const charge=()=>progress?.(meta+owned+scratch);charge();
    const rows:{key:string;index:QuotaIndex|undefined}[]=[],fallback:PeriodTape['quota']=[];
    try{
      const selectedCurves=curves??(work?yield*PeriodCurves.prepare(work):undefined),selectedKnown=work?.available===false?Infinity:work?.knownFrom??Infinity;
      const workCurves=sourceWide??selectedCurves,known=sourceWide?(sourceWide.available===false?Infinity:sourceWide.knownFrom):selectedKnown;
      for(const series of tape.quota){
        meta+=4*(series.source.length+series.window.length+1);charge();
        const key=series.source+'\n'+series.window,old=prior.quota.get(key);
        let index=old?.series===series&&!changedWork.has(series.source)?old:undefined;
        if(!index){
          const tail=tails.get(series);
          if(tail&&old){
            scratch=sampleCount(series.samples)*88+1024;charge();
            index=yield*QuotaIndex.retire(series,workCurves?.groups.source.get(series.source),series.workFrom===null?Infinity:Math.max(known,series.workFrom??0),old,tail,bytes=>{scratch=Math.max(scratch,bytes);charge();});
            scratch=0;if(index)owned+=index.bytes;charge();
          }
          if(!index)fallback.push(series);
        }
        rows.push({key,index});yield;
      }
      for(const group of tape.money){if(group.workCounter)meta+=256;meta+=4*(group.source.length+group.meter.length+(group.displayUnit??group.readings[0]?.unit??'undefined').length+2);charge();yield;}
      partial=yield*PeriodAccounting.prepare({...tape,quota:fallback},work,selectedCurves,prior,changedWork,bytes=>{scratch=bytes;charge();},sourceWide,true);
      const value=new PeriodAccounting(tape,work,selectedCurves,true);
      value.selectedCurves=partial.selectedCurves;value.selectedKnown=partial.selectedKnown;
      for(const row of rows){const index=row.index??partial.quota.get(row.key)!;value.quota.set(row.key,index);value.sampleTimes.set(row.key,index.times);yield;}
      for(const [key,index] of partial.money){value.money.set(key,index);yield;}
      for(const [key,index] of partial.moneyWork){value.moneyWork.set(key,index);yield;}
      value.financialAuthority=partial.financialAuthority;
      return value;
    }finally{rows.length=0;fallback.length=0;partial=undefined;}
  }
  get quotaBytes(){let bytes=0;for(const index of this.quota.values())bytes+=index.bytes;return bytes;}
  get bytes(){let bytes=this.quotaBytes;for(const index of this.money.values())bytes+=index.bytes;for(const index of this.moneyWork.values())bytes+=index.bytes;return bytes;}
  private directWork(source:string,range:PeriodRange,cutoff:number) {
    const from=Math.max(range.from,this.selectedKnown,cutoff),curve=this.selectedCurves?.groups.source.get(source);
    return {from:Number.isFinite(from)?from:range.to,ms:Number.isFinite(from)&&range.to>from?curve?.read({from,to:range.to},true)??0:null,agentMs:Number.isFinite(from)&&range.to>from?curve?.read({from,to:range.to})??0:0};
  }
  private directWorkChangesAt(source:string,now:number,period:number,cutoff:number) {
    const known=Math.max(this.selectedKnown,cutoff);if(!Number.isFinite(known))return Infinity;
    if(now<=known)return known+1;
    const curve=this.selectedCurves?.groups.source.get(source),left=Math.max(now-period,known);
    return Math.min(curve?.next(now)??Infinity,left===now-period?(curve?.next(left)??Infinity)+period:known+period);
  }
  quotaSummary(source:string,window:string,range:PeriodRange){
    const index=this.quota.get(source+'\n'+window);if(!index)return;
    const summary=index.at(range),cutoff=index.series.workFrom===null?Infinity:index.series.workFrom??0;
    const selectedWork=index.sharesWork(this.selectedCurves?.groups.source.get(source),Math.max(this.selectedKnown,cutoff))
      ?{from:summary.work?.from??range.to,ms:summary.work?.ms??null,agentMs:summary.work?.agentMs??0}:this.directWork(source,range,cutoff);
    return {...summary,selectedWork};
  }
  quotaSpendingSummary(source:string,window:string,range:PeriodRange){return this.quota.get(source+'\n'+window)?.at(range,true);}
  quotaWorkSlope(source:string,window:string,now:number,period:number,active:boolean){
    const index=this.quota.get(source+'\n'+window);if(!index)return;
    const curve=this.selectedCurves?.groups.source.get(source),known=Math.max(this.selectedKnown,index.series.workFrom===null?Infinity:index.series.workFrom??0);
    const left=Math.max(now-period,known),slope=(at:number)=>active?Number(curve?.working(at)??false):curve?.slope(at)??0;
    return {slope:slope(now)-(left===now-period?slope(left):0),next:Math.min(index.changesAt(now,period),this.directWorkChangesAt(source,now,period,known))};
  }
  moneySummary(source:string,meter:string,unit:string,range:PeriodRange){return this.money.get(source+'\n'+meter+'\n'+unit)?.at(range);}
  moneyWorkSummary(source:string,range:PeriodRange){const fixed=this.tape.fixed?.moneyWork?.find(row=>row.source===source);if(fixed)return fixed;const index=this.moneyWork.get(source);if(!index)return;const selected=this.directWork(source,range,index.counter.workFrom??Infinity);return {...index.at(range),selectedWork:{from:selected.from,activeMs:selected.ms,agentMs:selected.agentMs}};}
  fixed(range:PeriodRange,cell:number,evaluatedAt=Infinity):NonNullable<PeriodTape['fixed']> {
    const blank:History={range:'',live:false,since:range.from,to:range.to,cellMs:cell,historyStart:0,series:[],events:[],activity:{since:range.from,known:null,barMs:cell,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}};
    const quota=this.project(blank,range,undefined,true,Math.min(range.to,evaluatedAt)).series.map(row=>({...row,endValidUntil:this.quota.get(row.sourceId+'\n'+row.windowId)!.endValidUntil(range)}));
    const money=[...this.money.values()].flatMap(index=>{const group=index.group,last=group.readings.filter(row=>row.at<range.to).at(-1);return last?[{sourceId:group.source,meterId:group.meter,kind:group.paired?'balance' as const:last.kind,unit:group.displayUnit??last.unit,accounting:group.accounting,role:group.role,pointMode:last.kind==='cap'?'cell' as const:'observation' as const,...index.at(range,Math.min(range.to,evaluatedAt)),endValidUntil:index.endValidUntil(range),points:index.plot(range,cell,[])}]:[];});
    return {range,cell,quota,money,...(this.moneyWork.size?{moneyWork:[...this.moneyWork.keys()].map(source=>this.moneyWorkSummary(source,range)!)}:{})};
  }
  project(history:History,range:PeriodRange,values?:ReadonlyMap<string,PeriodValues>,boundaryOnly=false,stateAt=range.to):History {
    if(range.from<this.tape.from&&!this.tape.fixed&&!boundaryOnly)return history;
    const fixed=this.tape.fixed;
    if(fixed){
      if(range.from!==fixed.range.from||range.to!==fixed.range.to||history.cellMs!==fixed.cell)return history;
      return {...history,exact:true,since:range.from,to:range.to,...(fixed.moneyWork?{moneyWork:fixed.moneyWork}:{}),
        series:fixed.quota.map(({endValidUntil,...row})=>({...row,...(endValidUntil!==undefined&&(endValidUntil===null||stateAt>=endValidUntil)?{remainingAtEnd:null}:{}),points:[...quotaInterior(history.series.find(s=>s.sourceId===row.sourceId&&s.windowId===row.windowId),range,fixed.cell,history.to),...row.points].sort((a,b)=>a[0]-b[0])})),
        meterSeries:fixed.money.map(({endValidUntil,...row})=>({...row,...(endValidUntil!==undefined&&(endValidUntil===null||stateAt>=endValidUntil)?{end:null}:{}),points:[...moneyInterior(history.meterSeries?.find(s=>s.sourceId===row.sourceId&&s.meterId===row.meterId&&s.unit===row.unit)?.points??[],range,fixed.cell,{from:history.since,to:history.to}),...row.points].sort((a,b)=>a.at-b.at)}))};
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
      const summary={...this.quotaSummary(row.source,row.window,range)!,...index.at(range,false,stateAt)},points=!history.live?index.plot(range,history.cellMs,old,history.to,boundaryOnly):old!.points;
      series.push({...old,sourceId:row.source,windowId:row.window,staleAfterMs:sampleAt(row.samples,sampleCount(row.samples)-1)?.staleAfterMs??0,...summary,points,...(!history.live?{pointMode:'observation' as const,windowValue:windowValue??row.windowValue}:{})});
    }
    return {...history,exact:true,since:range.from,to:range.to,series,...(this.moneyWork.size?{moneyWork:[...this.moneyWork.keys()].map(source=>this.moneyWorkSummary(source,range)!)}:{}),meterSeries:history.meterSeries?.map(series=>{const index=this.money.get(series.sourceId+'\n'+series.meterId+'\n'+series.unit);return index?{...series,...index.at(range),...(!history.live?{points:index.plot(range,history.cellMs,series.points,{from:history.since,to:history.to}),...(series.kind!=='cap'?{pointMode:'observation' as const}:{})}:{})}:series;})};
  }
  /** Undefined leaves a missing window's captured fallback with its existing clock. */
  quotaSelectedWorkChangesAt(source:string,window:string,now:number,period:number):number|null|undefined {
    const index=this.quota.get(source+'\n'+window);if(!index)return undefined;
    const cutoff=index.series.workFrom===null?Infinity:index.series.workFrom??0;
    // Unknown work can name the current time; retain its existing display clock.
    if(!Number.isFinite(Math.max(this.selectedKnown,cutoff)))return undefined;
    const next=this.directWorkChangesAt(source,now,period,cutoff);return Number.isFinite(next)?next:null;
  }
  quotaSpendingStateChangesAt(source:string,window:string,now:number,period:number):number|null|undefined {
    const index=this.quota.get(source+'\n'+window);if(!index)return undefined;
    const next=index.spendingStateChangesAt(now,period);return Number.isFinite(next)?next:null;
  }
  quotaChangesAt(source:string,window:string,now:number,period:number):number|null|undefined {
    const index=this.quota.get(source+'\n'+window);if(!index)return undefined;
    const next=Math.min(index.changesAt(now,period),this.directWorkChangesAt(source,now,period,index.series.workFrom===null?Infinity:index.series.workFrom??0));return Number.isFinite(next)?next:null;
  }
  changesAt(now:number,period:number,source?:string):number|null {
    if(this.tape.fixed){
      const fixed=this.tape.fixed,rows=[...fixed.quota.filter(row=>row.remainingAtEnd!==null),...fixed.money.filter(row=>row.end!==null)];
      const deadlines=rows.flatMap(row=>(!source||row.sourceId===source)&&row.endValidUntil!==null&&row.endValidUntil!==undefined&&row.endValidUntil>now&&row.endValidUntil<=fixed.range.to?[row.endValidUntil]:[]);
      return deadlines.length?Math.min(...deadlines):null;
    }
    let next=Infinity;for(const index of this.quota.values())if(!source||index.series.source===source)next=Math.min(next,index.changesAt(now,period),this.directWorkChangesAt(index.series.source,now,period,index.series.workFrom===null?Infinity:index.series.workFrom??0));
    for(const index of this.money.values())if(!source||index.group.source===source)next=Math.min(next,index.changesAt(now,period));
    for(const index of this.moneyWork.values())if(!source||index.counter.source===source)next=Math.min(next,index.changesAt(now,period)??Infinity,this.directWorkChangesAt(index.counter.source,now,period,index.counter.workFrom??Infinity));
    return Number.isFinite(next)?next:null;
  }
}
