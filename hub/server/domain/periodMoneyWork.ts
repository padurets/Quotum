import {continuousMoneyPair,type MoneyWork,type MoneyWorkInput} from './moneyWork.js';
import type {PeriodRange} from './period.js';
import type {WorkTimeline} from './periodCurves.js';
import type {Preparation} from './prepare.js';
import {numberAt,numberBytes,numberColumn,lowerNumber,type Numbers} from './periodTape.js';

export type WorkCounter=Omit<MoneyWorkInput,'work'>&{workFrom:number|null};

/** Whole native observation pairs use the board's existing source work curve. */
export class MoneyWorkIndex {
  private starts:Numbers=new Float64Array(0);
  private ends:Numbers=new Float64Array(0);
  private active:Numbers=new Float64Array(0);
  private agents:Numbers=new Float64Array(0);
  private covered:Numbers=new Float64Array(0);
  private spent:bigint[]=[];
  private during:bigint[]=[];
  private constructor(readonly counter:WorkCounter,private readonly work:WorkTimeline|undefined) {}
  static *prepare(counter:WorkCounter,work:WorkTimeline|undefined):Preparation<MoneyWorkIndex> {
    const index=new MoneyWorkIndex(counter,work),count=Math.max(0,counter.readings.length-1);
    const starts=new Float64Array(count),ends=new Float64Array(count),active=new Float64Array(count+1),agents=new Float64Array(count+1),covered=new Float64Array(count+1);
    const spent=new Array<bigint>(count+1).fill(0n),during=new Array<bigint>(count+1).fill(0n);let span=0;
    for(let i=0;i<count;i++) {
      const a=counter.readings[i],b=counter.readings[i+1],n=i+1;
      starts[i]=a.at;ends[i]=b.at;
      active[n]=active[i];agents[n]=agents[i];covered[n]=covered[i];
      spent[n]=spent[i];during[n]=during[i];
      while(span<counter.spans.length&&counter.spans[span].to<b.at)span++;
      if(continuousMoneyPair(counter,a,b,counter.spans[span])) {
        const range={from:a.at,to:b.at},worked=work?.read(range,true)??0,delta=BigInt(b.amount)-BigInt(a.amount);
        active[n]+=worked;agents[n]+=work?.read(range)??0;covered[n]+=b.at-a.at;
        spent[n]+=delta;if(worked)during[n]+=delta;
      }
      yield;
    }
    index.starts=yield*numberColumn(starts.length,i=>starts[i]);index.ends=yield*numberColumn(ends.length,i=>ends[i]);
    index.active=yield*numberColumn(active.length,i=>active[i]);index.agents=yield*numberColumn(agents.length,i=>agents[i]);index.covered=yield*numberColumn(covered.length,i=>covered[i]);
    // Nonnegative sums ending at zero have one exact value at every endpoint.
    index.spent=spent.at(-1)===0n?[0n]:spent;index.during=during.at(-1)===0n?[0n]:during;
    return index;
  }
  get bytes(){return 512+[this.starts,this.ends,this.active,this.agents,this.covered].reduce((sum,column)=>sum+numberBytes(column),0)+(this.spent.length+this.during.length)*64;}
  at(range:PeriodRange):MoneyWork {
    const first=lowerNumber(this.starts,range.from),end=lowerNumber(this.ends,range.to),start=Math.min(first,end);
    const workRange={from:Math.max(range.from,this.counter.workFrom??range.to),to:range.to};
    const coveredMs=numberAt(this.covered,end)!-numberAt(this.covered,start)!;
    return {source:this.counter.source,unit:this.counter.unit,knownFrom:this.counter.knownFrom,estimate:true,
      activeMs:workRange.to>workRange.from?this.work?.read(workRange,true)??0:0,agentMs:workRange.to>workRange.from?this.work?.read(workRange)??0:0,
      spent:(this.spent[Math.min(end,this.spent.length-1)]-this.spent[Math.min(start,this.spent.length-1)]).toString(),duringWork:(this.during[Math.min(end,this.during.length-1)]-this.during[Math.min(start,this.during.length-1)]).toString(),
      eligibleActiveMs:numberAt(this.active,end)!-numberAt(this.active,start)!,eligibleAgentMs:numberAt(this.agents,end)!-numberAt(this.agents,start)!,coveredMs,
      partial:this.counter.knownFrom===null||this.counter.knownFrom>range.from||coveredMs<Math.max(0,range.to-Math.max(range.from,this.counter.knownFrom??range.from))};
  }
  changesAt(now:number,period:number) {
    const from=now-period;
    const next=Math.min((numberAt(this.starts,lowerNumber(this.starts,from))??Infinity)+period+1,(numberAt(this.ends,lowerNumber(this.ends,now))??Infinity)+1,
      this.work?.next(now)??Infinity,(this.work?.next(from)??Infinity)+period,this.counter.workFrom!==null&&this.counter.workFrom>from?this.counter.workFrom+period:Infinity);
    return Number.isFinite(next)?next:null;
  }
}
