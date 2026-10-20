import {semanticsOf, type MeterSpan, type Reading} from './meters.js';
import type {Preparation} from './prepare.js';
import type {Span} from './work.js';
import {conversionOrigin} from './currency.js';
import {sourceCounterOf} from './providers.js';

/** Source-wide estimates never treat a converted key allowance as an account. */
export const sourceWorkEligible=(provider:string,meter:string)=>sourceCounterOf(provider)!==null&&!(conversionOrigin(meter)?.meter??meter).startsWith('key:');

export type MoneyWorkCell = [index: number, activeMs: number, agentMs: number, spent: string, eligibleActiveMs: number, eligibleAgentMs: number, coveredMs: number, duringWork: string];
export type MoneyWorkEdge = [from: number, to: number, spent: string, eligibleActiveMs: number, eligibleAgentMs: number, coveredMs: number, duringWork: string, evidence: 'continuous' | 'gap'];
export type MoneyWorkCells = {source: string; unit: string; knownFrom: number | null; partial: boolean; cells: MoneyWorkCell[]; edges: MoneyWorkEdge[]};
export type MoneyWork = {selectedWork?:{from:number;activeMs:number|null;agentMs:number};source: string; unit: string; activeMs: number; agentMs: number; spent: string; duringWork: string; eligibleActiveMs: number; eligibleAgentMs: number; coveredMs: number; knownFrom: number | null; partial: boolean; estimate: true};
export type MoneyWorkInput = {source: string; unit: string; knownFrom: number | null; readings: Reading[]; spans: MeterSpan[]; work: Span[]};

/** Prefix integrals count overlapping agents once for active time, separately for agent time. */
function workIntegral(work: Span[]) {
  const changes = new Map<number, number>();
  for (const span of work) {changes.set(span.from, (changes.get(span.from) ?? 0) + 1); changes.set(span.to, (changes.get(span.to) ?? 0) - 1);}
  const times = [...changes.keys()].sort((a,b) => a-b), active = [0], agents = [0], counts: number[] = [];
  let count = 0;
  for (let i = 0; i < times.length; i++) {count += changes.get(times[i])!; counts.push(count);
    if (i + 1 < times.length) {const elapsed = times[i+1]-times[i]; active.push(active[i]+(count ? elapsed : 0)); agents.push(agents[i]+count*elapsed);}}
  const value = (at: number): [number,number] => {
    if (!times.length || at <= times[0]) return [0,0];
    let low=0,high=times.length; while(low<high) {const middle=(low+high)>>>1;if(times[middle]<=at)low=middle+1;else high=middle;}
    const i=low-1,elapsed=at-times[i];return [active[i]+(counts[i]?elapsed:0),agents[i]+counts[i]*elapsed];
  };
  return (from:number,to:number):[number,number] => {const a=value(from),b=value(to);return [b[0]-a[0],b[1]-a[1]];};
}

/** Financial cells and exact period accounting apply the same native evidence rule. */
export function continuousMoneyPair(input:Pick<MoneyWorkInput,'unit'|'knownFrom'>,a:Reading,b:Reading,span:MeterSpan|undefined):boolean {
  const delta=BigInt(b.amount)-BigInt(a.amount);
  return input.knownFrom!==null&&a.at>=input.knownFrom&&b.previousAt===a.at&&a.kind==='counter'&&b.kind===a.kind&&a.unit===b.unit&&b.unit===input.unit&&delta>=0n&&b.at-a.at<=a.staleAfterMs
    &&JSON.stringify(semanticsOf(a))===JSON.stringify(semanticsOf(b))&&!!span&&span.from<=a.at&&span.to>=b.at&&(span.observedFrom===undefined||span.observedFrom<=a.at)&&(span.interruptedAt===undefined||span.interruptedAt>=b.at)&&(span.holdUntil==null||span.holdUntil>b.at);
}

/** Original accepted pairs stay whole; crossing pairs are carried once by their closing cell. */
export function packMoneyWork(input: MoneyWorkInput, from: number, to: number, cell: number,reserve?:(bytes:number)=>void): MoneyWorkCells {
  // Dense native pairs can produce small JSON. Admit the integral, worst-case
  // edges and cell builders before allocating them.
  reserve?.(1024+input.work.length*512+Math.ceil((to-from)/cell)*384+input.readings.reduce((bytes,reading)=>bytes+256+reading.amount.length*8,0));
  const integral=workIntegral(input.work), values=new Map<number,MoneyWorkCell>(), edges:MoneyWorkEdge[]=[];
  const row=(at:number) => {const index=Math.floor((at-from)/cell);let value=values.get(index);if(!value){const start=from+index*cell,[active,agent]=integral(start,Math.min(start+cell,to));value=[index,active,agent,'0',0,0,0,'0'];values.set(index,value);}return value;};
  for(let at=from;at<to;at+=cell) {const [active,agent]=integral(at,Math.min(at+cell,to));if(active||agent)row(at);}
  let partial=input.knownFrom===null||input.knownFrom>from,spanIndex=0;
  for(let i=1;i<input.readings.length;i++) {
    const a=input.readings[i-1],b=input.readings[i];if(b.at<from||b.at>=to)continue;
    while(spanIndex<input.spans.length&&input.spans[spanIndex].to<b.at)spanIndex++;
    const span=input.spans[spanIndex],delta=BigInt(b.amount)-BigInt(a.amount);
    const continuous=continuousMoneyPair(input,a,b,span);
    const [active,agent]=continuous?integral(a.at,b.at):[0,0],spent=delta>0n?delta.toString():'0',during=active?spent:'0';
    if(!continuous)partial=true;
    const value=row(b.at),start=from+value[0]*cell;
    if(continuous&&a.at>=start) {value[3]=(BigInt(value[3])+delta).toString();value[4]+=active;value[5]+=agent;value[6]+=b.at-a.at;value[7]=(BigInt(value[7])+BigInt(during)).toString();}
    else edges.push([a.at,b.at,spent,active,agent,continuous?b.at-a.at:0,during,continuous?'continuous':'gap']);
  }
  return {source:input.source,unit:input.unit,knownFrom:input.knownFrom,partial,cells:[...values.values()].sort((a,b)=>a[0]-b[0]),edges};
}

export function* composeMoneyWorkPrepared(chunks: readonly {from:number;to:number;moneyWork?:MoneyWorkCells[]}[], cell:number, from:number, to:number):Preparation<MoneyWork[]> {
  const values=new Map<string,MoneyWork>();
  for(const chunk of chunks)for(const group of chunk.moneyWork??[]) {
    const key=JSON.stringify([group.source,group.unit]);let value=values.get(key);
    if(!value){value={source:group.source,unit:group.unit,activeMs:0,agentMs:0,spent:'0',duringWork:'0',eligibleActiveMs:0,eligibleAgentMs:0,coveredMs:0,knownFrom:group.knownFrom,partial:group.partial,estimate:true};values.set(key,value);}
    value.partial||=group.partial;value.knownFrom=value.knownFrom===null||group.knownFrom===null?null:Math.max(value.knownFrom,group.knownFrom);
    for(const [index,active,agent,spent,h,a,covered,during] of group.cells) {
      const at=chunk.from+index*cell;if(at<from||at>=to)continue;
      value.activeMs+=active;value.agentMs+=agent;
      if(at+cell>to){value.partial=true;continue;}
      value.spent=(BigInt(value.spent)+BigInt(spent)).toString();value.duringWork=(BigInt(value.duringWork)+BigInt(during)).toString();value.eligibleActiveMs+=h;value.eligibleAgentMs+=a;value.coveredMs+=covered;yield;
    }
    for(const [start,end,spent,h,a,covered,during,evidence] of group.edges) {
      if(end<from||start>=to)continue;
      if(evidence!=='continuous'||start<from||end>=to){value.partial=true;continue;}
      value.spent=(BigInt(value.spent)+BigInt(spent)).toString();value.duringWork=(BigInt(value.duringWork)+BigInt(during)).toString();value.eligibleActiveMs+=h;value.eligibleAgentMs+=a;value.coveredMs+=covered;yield;
    }
  }
  for(const value of values.values())value.partial||=value.knownFrom===null||value.coveredMs<Math.max(0,to-Math.max(from,value.knownFrom??from));
  return [...values.values()];
}

/** A rate estimates source-level spending per active hour; it does not price a session. */
export function moneyWorkRate(value:MoneyWork, remaining:string|null, stale=false):{rate:string|null;remainingMs:string|null;status:'insufficient'|'zero'|'estimate'} {
  if(value.eligibleActiveMs<1_800_000)return {rate:null,remainingMs:remaining!==null&&!stale&&BigInt(remaining)<=0n?'0':null,status:'insufficient'};
  const d=BigInt(value.spent),h=BigInt(value.eligibleActiveMs),rate=((d*3_600_000n+h/2n)/h).toString();
  return {rate,remainingMs:remaining===null||stale?null:BigInt(remaining)<=0n?'0':d===0n?null:(BigInt(remaining)*h/d).toString(),status:d===0n?'zero':'estimate'};
}
