import {type Preparation} from './prepare.js';
import {workedSessions,type WorkTrace,type WorkedSession} from './periodWork.js';
import type {PeriodRange} from './period.js';
import {PeriodCurves} from './periodCurves.js';

/** Clock reads search shared prefixes; they never expand the retained work ledger. */
export class PeriodIndex {
  readonly curves:PeriodCurves;
  private readonly rows=new Map<number,WorkedSession>();
  private now=0;
  constructor(readonly trace:WorkTrace,curves?:PeriodCurves) {this.curves=curves??new PeriodCurves(trace);}
  static *prepare(trace:WorkTrace):Preparation<PeriodIndex>{return new PeriodIndex(trace,yield*PeriodCurves.prepare(trace));}
  advance(range:PeriodRange,now:number):{rows:WorkedSession[];changed:boolean;limited:boolean} {
    if(range.from<this.trace.anchor)return {rows:[...this.rows.values()],changed:false,limited:true};
    let changed=false;this.now=now;
    if(this.trace.fixed){
      if(range.from!==this.trace.fixed.range.from||range.to!==this.trace.fixed.range.to)return {rows:[...this.rows.values()],changed:false,limited:true};
      for(const [i,row] of workedSessions(this.trace,range,now).entries()){const old=this.rows.get(i);if(!old||old.workedMs!==row.workedMs||old.lastWorkedAt!==row.lastWorkedAt||old.working!==row.working||old.currentPresence!==row.currentPresence){this.rows.set(i,row);changed=true;}}
      return {rows:[...this.rows.values()],changed,limited:false};
    }
    for(let id=0;id<this.trace.refs.length;id++) {
      const curve=this.curves.contexts[id],workedMs=curve.read(range),ref=this.trace.refs[id];
      if(workedMs<=0){if(this.rows.delete(id))changed=true;continue;}
      const lastWorkedAt=curve.last(range.to),presence=ref.currentPresence&&ref.currentPresence.through>now?ref.currentPresence:undefined;
      const working=!!presence&&Math.min(presence.through,presence.workingThrough??Infinity)>now&&presence.working,old=this.rows.get(id);
      if(!old||old.workedMs!==workedMs||old.lastWorkedAt!==lastWorkedAt||old.working!==working||old.currentPresence!==presence){const {currentPresence:_previous,...context}=ref;this.rows.set(id,{...context,...(presence?{currentPresence:presence}:{}),workedMs,lastWorkedAt,working});changed=true;}
    }
    return {rows:[...this.rows.values()],changed,limited:false};
  }
  presenceChangesAt(){let next=Infinity;for(const ref of this.trace.refs){const p=ref.currentPresence;if(!p)continue;for(const at of [p.through,p.working?Math.min(p.through,p.workingThrough??Infinity):0])if(at>this.now)next=Math.min(next,at);}return Number.isFinite(next)?next:null;}
  changesAt(now:number,period:number):number|null {
    if(!this.rows.size)return null;
    let next=this.presenceChangesAt()??Infinity;
    for(const curve of this.curves.contexts){next=Math.min(next,curve.next(now-period)+period);if(curve.working(now-period))next=Math.min(next,Math.floor(now/60_000)*60_000+60_000);}
    return Number.isFinite(next)?next:null;
  }
}
