import {continuousMoneyPair,type MoneyWork,type MoneyWorkInput} from './moneyWork.js';
import type {PeriodRange} from './period.js';
import type {WorkTimeline} from './periodCurves.js';
import type {Preparation} from './prepare.js';

export type WorkCounter=Omit<MoneyWorkInput,'work'>&{workFrom:number|null};

const lower=(values:Float64Array,at:number)=>{let a=0,b=values.length;while(a<b){const middle=(a+b)>>>1;if(values[middle]<at)a=middle+1;else b=middle;}return a;};

/** Whole native observation pairs use the board's existing source work curve. */
export class MoneyWorkIndex {
  private readonly starts:Float64Array;
  private readonly ends:Float64Array;
  private readonly active:Float64Array;
  private readonly agents:Float64Array;
  private readonly covered:Float64Array;
  private readonly spent:bigint[];
  private readonly during:bigint[];
  private constructor(readonly counter:WorkCounter,private readonly work:WorkTimeline|undefined) {
    const count=Math.max(0,counter.readings.length-1);
    this.starts=new Float64Array(count);this.ends=new Float64Array(count);
    this.active=new Float64Array(count+1);this.agents=new Float64Array(count+1);this.covered=new Float64Array(count+1);
    this.spent=new Array<bigint>(count+1).fill(0n);this.during=new Array<bigint>(count+1).fill(0n);
  }
  static *prepare(counter:WorkCounter,work:WorkTimeline|undefined):Preparation<MoneyWorkIndex> {
    const index=new MoneyWorkIndex(counter,work);let span=0;
    for(let i=0;i<index.starts.length;i++) {
      const a=counter.readings[i],b=counter.readings[i+1],n=i+1;
      index.starts[i]=a.at;index.ends[i]=b.at;
      index.active[n]=index.active[i];index.agents[n]=index.agents[i];index.covered[n]=index.covered[i];
      index.spent[n]=index.spent[i];index.during[n]=index.during[i];
      while(span<counter.spans.length&&counter.spans[span].to<b.at)span++;
      if(continuousMoneyPair(counter,a,b,counter.spans[span])) {
        const range={from:a.at,to:b.at},active=work?.read(range,true)??0,spent=BigInt(b.amount)-BigInt(a.amount);
        index.active[n]+=active;index.agents[n]+=work?.read(range)??0;index.covered[n]+=b.at-a.at;
        index.spent[n]+=spent;if(active)index.during[n]+=spent;
      }
      yield;
    }
    return index;
  }
  get bytes(){return 512+this.starts.byteLength+this.ends.byteLength+this.active.byteLength+this.agents.byteLength+this.covered.byteLength+(this.spent.length+this.during.length)*64;}
  at(range:PeriodRange):MoneyWork {
    const first=lower(this.starts,range.from),end=lower(this.ends,range.to),start=Math.min(first,end);
    const workRange={from:Math.max(range.from,this.counter.workFrom??range.to),to:range.to};
    const coveredMs=this.covered[end]-this.covered[start];
    return {source:this.counter.source,unit:this.counter.unit,knownFrom:this.counter.knownFrom,estimate:true,
      activeMs:workRange.to>workRange.from?this.work?.read(workRange,true)??0:0,agentMs:workRange.to>workRange.from?this.work?.read(workRange)??0:0,
      spent:(this.spent[end]-this.spent[start]).toString(),duringWork:(this.during[end]-this.during[start]).toString(),
      eligibleActiveMs:this.active[end]-this.active[start],eligibleAgentMs:this.agents[end]-this.agents[start],coveredMs,
      partial:this.counter.knownFrom===null||this.counter.knownFrom>range.from||coveredMs<Math.max(0,range.to-Math.max(range.from,this.counter.knownFrom??range.from))};
  }
  changesAt(now:number,period:number) {
    const from=now-period;
    const next=Math.min((this.starts[lower(this.starts,from)]??Infinity)+period+1,(this.ends[lower(this.ends,now)]??Infinity)+1,
      this.work?.next(now)??Infinity,(this.work?.next(from)??Infinity)+period,this.counter.workFrom!==null&&this.counter.workFrom>from?this.counter.workFrom+period:Infinity);
    return Number.isFinite(next)?next:null;
  }
}
