import {drain,ordered,type Preparation} from '../../server/domain/prepare';
import type {WorkTrace,WorkedSession} from '../../server/domain/periodWork';
import type {PeriodRange} from '../../server/domain/period';

type Series={spans:[number,number][];prefix:number[]};
function cumulative(series:Series,at:number) {
  let low=0,high=series.spans.length;
  while(low<high){const middle=(low+high)>>>1;if(series.spans[middle][1]<=at)low=middle+1;else high=middle;}
  return (series.prefix[low]??0)+(low<series.spans.length?Math.max(0,at-series.spans[low][0]):0);
}

/** Clock advances visit crossing boundaries and active contexts, never the retained ledger again. */
export class PeriodIndex {
  private readonly series:Series[]=[];
  private edges:{at:number;id:number}[]=[];
  private readonly active=new Set<number>();
  private readonly rows=new Map<number,WorkedSession>();
  private range:PeriodRange|null=null;
  private cursor=0;
  private rightCursor=0;
  private presenceCursor=0;
  private readonly presence:{at:number;id:number}[]=[];
  constructor(readonly trace:WorkTrace,deferred=false) {if(!deferred)drain(this.build());}
  static *prepare(trace:WorkTrace):Preparation<PeriodIndex>{const value=new PeriodIndex(trace,true);yield* value.build();return value;}
  private *build():Preparation<void> {
    const trace=this.trace;
    for(const _ref of trace.refs){this.series.push({spans:[],prefix:[0]});yield;}
    for(const [id,a,b] of trace.spans) {
      const from=trace.anchor+a,to=trace.anchor+b,series=this.series[id];
      series.spans.push([from,to]);series.prefix.push(series.prefix.at(-1)!+to-from);
      this.edges.push({at:from,id},{at:to,id});yield;
    }
    this.edges=yield* ordered(this.edges,(a,b)=>a.at-b.at);
    for(let id=0;id<trace.refs.length;id++){const p=trace.refs[id].currentPresence;if(p){if(p.working)this.presence.push({at:Math.min(p.through,p.workingThrough??Infinity),id});this.presence.push({at:p.through,id});}yield;}
    this.presence.sort((a,b)=>a.at-b.at);
  }

  advance(range:PeriodRange,now:number):{rows:WorkedSession[];changed:boolean;limited:boolean} {
    if(range.from<this.trace.anchor)return {rows:[...this.rows.values()],changed:false,limited:true};
    const reset=!this.range||range.from<this.range.from||range.to<this.range.to;
    const changed=new Set<number>();
    if(reset) {
      this.rows.clear();this.active.clear();this.cursor=0;this.rightCursor=0;this.presenceCursor=0;
      for(let id=0;id<this.series.length;id++)changed.add(id);
    }else {
      for(const id of this.active)changed.add(id);
    }
    while(this.rightCursor<this.edges.length&&this.edges[this.rightCursor].at<=range.to)changed.add(this.edges[this.rightCursor++].id);
    while(this.cursor<this.edges.length&&this.edges[this.cursor].at<=range.from)changed.add(this.edges[this.cursor++].id);
    while(this.presenceCursor<this.presence.length&&this.presence[this.presenceCursor].at<=now)changed.add(this.presence[this.presenceCursor++].id);
    let different=reset;
    for(const id of changed) {
      const series=this.series[id],workedMs=cumulative(series,range.to)-cumulative(series,range.from),ref=this.trace.refs[id];
      let low=0,high=series.spans.length;
      while(low<high){const middle=(low+high)>>>1;if(series.spans[middle][1]<=range.from)low=middle+1;else high=middle;}
      if(low<series.spans.length&&series.spans[low][0]<=range.from)this.active.add(id);else this.active.delete(id);
      if(workedMs<=0){if(this.rows.delete(id))different=true;continue;}
      let end=0,until=series.spans.length;while(end<until){const m=(end+until)>>>1;if(series.spans[m][0]<range.to)end=m+1;else until=m;}
      const lastWorkedAt=end?Math.min(range.to,series.spans[end-1][1]):0;
      const presence=ref.currentPresence&&ref.currentPresence.through>now?ref.currentPresence:undefined,working=!!presence&&Math.min(presence.through,presence.workingThrough??Infinity)>now&&presence.working;
      const old=this.rows.get(id);
      if(!old||old.workedMs!==workedMs||old.lastWorkedAt!==lastWorkedAt||old.working!==working||old.currentPresence!==presence){const {currentPresence:_previous,...context}=ref;this.rows.set(id,{...context,...(presence?{currentPresence:presence}:{}),workedMs,lastWorkedAt,working});different=true;}
    }
    this.range=range;
    return {rows:[...this.rows.values()],changed:different,limited:false};
  }
  presenceChangesAt(){return this.presence[this.presenceCursor]?.at??null;}
  changesAt(now:number,period:number):number|null {
    if(!this.rows.size)return null;
    const edge=this.edges[this.cursor]?.at;
    const due=Math.min(edge===undefined?Infinity:edge+period,this.active.size?Math.floor(now/60_000)*60_000+60_000:Infinity,this.presence[this.presenceCursor]?.at??Infinity);
    return Number.isFinite(due)?due:null;
  }
}
