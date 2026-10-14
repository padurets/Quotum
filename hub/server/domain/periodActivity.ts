import {compareWorkRatio,firstPolynomialChange} from './workRatio.js';
import {sourceKey} from './workAccess.js';
import {drain,type Preparation} from './prepare.js';
import type {History} from './history.js';
import type {Dimension as ActivityDimension,ActivityGroup} from './work.js';
type Activity=History['activity'];
import type {PeriodRange} from './period.js';
import type {WorkedSession,WorkTrace} from './periodWork.js';
import {PeriodCurves,type WorkTimeline} from './periodCurves.js';

type Group={name:string|null;curve:WorkTimeline;contexts:WorkTimeline[];agentMs:number;agents:number};
const dimensions:ActivityDimension[]=['source','project','device'];
const keys=(row:WorkTrace['refs'][number])=>({source:sourceKey(row),project:JSON.stringify(row.project),device:row.device.id});
export type ActivityOrder={by:ActivityDimension;column:'active'|'concurrency';keys:readonly string[]};

export class PeriodActivity {
  private all!:WorkTimeline;
  private readonly groups:Record<ActivityDimension,Map<string,Group>>={source:new Map(),project:new Map(),device:new Map()};
  private readonly contexts=new Map<string,WorkTimeline>();
  private previous=new Map<string,Omit<WorkedSession,'currentPresence'>>();
  private cut=0;
  constructor(readonly trace:WorkTrace,private curves?:PeriodCurves,deferred=false) {if(!deferred)drain(this.build());}
  static *prepare(trace:WorkTrace,curves?:PeriodCurves):Preparation<PeriodActivity>{const value=new PeriodActivity(trace,curves,true);yield* value.build();return value;}
  private *build():Preparation<void> {
    if(this.trace.fixed)return;
    const trace=this.trace,curves=this.curves??(yield*PeriodCurves.prepare(trace));
    this.all=curves.all;
    this.cut=trace.cut??curves.all.last(Infinity);
    for(let id=0;id<trace.refs.length;id++){this.contexts.set(trace.refs[id].ref,curves.contexts[id]);yield;}
    const devices=new Map(trace.refs.map(r=>[r.device.id,r.device.name]));
    for(const by of dimensions)for(const [key,curve] of curves.groups[by]){this.groups[by].set(key,{name:by==='source'?null:by==='project'?JSON.parse(key):devices.get(key)??key,curve,contexts:[],agentMs:0,agents:0});yield;}
    for(const ref of trace.refs){const context=this.contexts.get(ref.ref)!;for(const by of dimensions)this.groups[by].get(keys(ref)[by])?.contexts.push(context);yield;}
  }

  update(rows:Omit<WorkedSession,'currentPresence'>[]) {
    if(this.trace.fixed)return;
    const next=new Map(rows.map(row=>[row.ref,row]));
    for(const ref of new Set([...this.previous.keys(),...next.keys()])) {
      const old=this.previous.get(ref),row=next.get(ref);if(row===old)continue;
      const groupKeys=keys((row??old)!);
      for(const by of dimensions){const group=this.groups[by].get(groupKeys[by]);if(!group)continue;group.agentMs+=(row?.workedMs??0)-(old?.workedMs??0);group.agents+=Number(!!row)-Number(!!old);}
    }
    this.previous=next;
  }
  /** Numerical labels read exact endpoints without rebuilding any chart cells. */
  numbers(activity:Activity,range:PeriodRange,dimension:ActivityDimension,key?:string):Activity {
    if(this.trace.fixed)return activity;
    const selected=key===undefined?this.groups[dimension]:new Map(this.groups[dimension].has(key)?[[key,this.groups[dimension].get(key)!]]:[]);
    const groups:ActivityGroup[]=[];let agents=0;
    for(const [id,group] of selected){const count=range.to>range.from?group.contexts.reduce((sum,curve)=>sum+Number(curve.read(range)>0),0):0;agents+=count;if(count)groups.push({key:id,name:group.name,agentMs:group.curve.read(range),activeMs:group.curve.read(range,true),agents:count,cells:[]});}
    const from=Math.max(range.from,this.trace.knownFrom),to=Math.min(range.to,this.cut);
    return {...activity,...(this.trace.available===false?{available:false as const}:{}),known:this.trace.available!==false&&from<to?{from,to}:null,agentMs:key!==undefined?groups[0]?.agentMs??0:agents?this.all.read(range):0,activeMs:key!==undefined?groups[0]?.activeMs??0:agents?this.all.read(range,true):0,agents,by:{...activity.by,[dimension]:groups}};
  }
  changesAt(now:number,period:number,dimension:ActivityDimension,key?:string) {
    if(this.trace.fixed)return null;
    const contexts=key===undefined?this.contexts.values():this.groups[dimension].get(key)?.contexts??[];
    let next=Infinity;for(const curve of contexts)next=Math.min(next,curve.next(now-period)+period,curve.next(now));
    return Number.isFinite(next)?next:null;
  }
  /** Both scalar presentations use the same exact group and whole-period curves. */
  summary(range:PeriodRange,dimension:ActivityDimension,key?:string):Activity {
    const empty:Activity={...(this.trace.available===false?{available:false as const}:{}),since:this.trace.knownFrom,known:null,barMs:60_000,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}};
    if(this.trace.fixed)return this.trace.fixed.activity;
    return this.numbers(empty,range,dimension,key);
  }
  /** Union and ratio sorts can cross between ledger endpoints, without a report. */
  orderChangesAt(now:number,period:number,orders:readonly ActivityOrder[]):number|null {
    if(this.trace.fixed||!orders.length)return null;
    const range={from:now-period,to:now};let next=Infinity;
    for(const order of orders){
      const pieces=order.keys.flatMap(key=>{const curve=this.groups[order.by].get(key)?.curve;if(!curve)return [];
        return [{curve,agent:curve.read(range),active:curve.read(range,true),agentSlope:curve.slope(now)-curve.slope(range.from),activeSlope:Number(curve.working(now))-Number(curve.working(range.from))}];});
      for(let i=1;i<pieces.length;i++){
        const a=pieces[i-1],b=pieces[i];
        const boundary=Math.min(a.curve.next(now),b.curve.next(now),a.curve.next(range.from)+period,b.curve.next(range.from)+period);
        const before=order.column==='active'?Math.sign(a.active-b.active):compareWorkRatio(a.agent,a.active,b.agent,b.active);
        const A=BigInt(a.agent),E=BigInt(a.active),B=BigInt(b.agent),F=BigInt(b.active),da=BigInt(a.agentSlope),de=BigInt(a.activeSlope),db=BigInt(b.agentSlope),df=BigInt(b.activeSlope);
        const c0=order.column==='active'?E-F:A*F-B*E;
        const c1=order.column==='active'?de-df:da*F+A*df-db*E-B*de;
        const c2=order.column==='active'?0n:da*df-db*de;
        const change=firstPolynomialChange(c0,c1,c2,boundary-now,before);
        if(change!==null)next=Math.min(next,now+change);

      }
    }
    return Number.isFinite(next)?next:null;
  }
  project(activity:Activity,range:PeriodRange):Activity {
    const fixed=this.trace.fixed;
    if(fixed){
      if(range.from!==fixed.range.from||range.to!==fixed.range.to||activity.barMs!==fixed.activity.barMs)return activity;
      const {barMs}=activity,leftEnd=(Math.floor(range.from/barMs)+1)*barMs,rightStart=Math.floor((range.to-1)/barMs)*barMs;
      const interior=(at:number)=>at>=leftEnd&&at<rightStart;
      return {...fixed.activity,cells:[...activity.cells.filter(([at])=>interior(at)),...fixed.activity.cells].sort((a,b)=>a[0]-b[0]),by:Object.fromEntries(dimensions.map(by=>[by,fixed.activity.by[by].map(group=>({...group,cells:[...(activity.by[by].find(g=>g.key===group.key)?.cells??[]).filter(([at])=>interior(at)),...group.cells].sort((a,b)=>a[0]-b[0])}))])) as Activity['by']};
    }
    const part=(at:number)=>({from:Math.max(range.from,at),to:Math.min(range.to,at+activity.barMs)});
    const cells:Activity['cells']=activity.cells.filter(([at])=>at<range.to&&at+activity.barMs>range.from).map(([at,active,agent,count])=>{
      const cut=part(at);if(cut.from===at&&cut.to===at+activity.barMs)return [at,active,agent,count];
      let agents=0;for(const curve of this.contexts.values())if(curve.read(cut)>0)agents++;
      return [at,this.all.read(cut,true),this.all.read(cut),agents];
    });
    const by:Activity['by']={source:[],project:[],device:[]};
    for(const dimension of dimensions) {
      const old=new Map(activity.by[dimension].map(g=>[g.key,g]));
      for(const [key,group] of this.groups[dimension])if(group.agents) {
        const cells:ActivityGroup['cells']=(old.get(key)?.cells??[]).filter(([at])=>at<range.to&&at+activity.barMs>range.from).map(([at,ms])=>{const cut=part(at);return [at,cut.from===at&&cut.to===at+activity.barMs?ms:group.curve.read(cut)];});
        by[dimension].push({key,name:group.name,agentMs:group.curve.read(range),activeMs:group.curve.read(range,true),agents:group.agents,cells});
      }
      by[dimension].sort((a,b)=>b.agentMs-a.agentMs||a.key.localeCompare(b.key));
    }
    const from=Math.max(range.from,this.trace.knownFrom),to=Math.min(range.to,this.cut);
    return {...activity,...(this.trace.available===false?{available:false as const}:{}),since:this.trace.knownFrom,known:this.trace.available!==false&&from<to?{from,to}:null,activeMs:this.all.read(range,true),agentMs:this.all.read(range),agents:this.previous.size,cells,by};
  }
}
