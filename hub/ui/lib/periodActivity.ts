import {drain,ordered,type Preparation} from '../../server/domain/prepare';
import type {Activity,ActivityDimension,ActivityGroup} from './types';
import type {PeriodRange} from '../../server/domain/period';
import type {WorkedSession,WorkTrace} from '../../server/domain/periodWork';

/** One sweep prepares both agent duration and the union; clock reads are binary searches. */
class WorkCurve {
  private readonly times:number[]=[];
  private readonly agents:number[]=[];
  private readonly active:number[]=[];
  private readonly slopes:number[]=[];
  constructor(spans:readonly [number,number][],deferred=false) {if(!deferred)drain(this.build(spans));}
  static *prepare(spans:readonly [number,number][]):Preparation<WorkCurve>{const value=new WorkCurve(spans,true);yield* value.build(spans);return value;}
  private *build(spans:readonly [number,number][]):Preparation<void> {
    const changes=new Map<number,number>();
    for(const [a,b] of spans){changes.set(a,(changes.get(a)??0)+1);changes.set(b,(changes.get(b)??0)-1);yield;}
    let previous=0,slope=0,agent=0,active=0;
    for(const [at,delta] of yield* ordered(changes,(a,b)=>a[0]-b[0])){agent+=(at-previous)*slope;if(slope)active+=at-previous;slope+=delta;this.times.push(at);this.agents.push(agent);this.active.push(active);this.slopes.push(slope);previous=at;yield;}
  }
  private at(at:number,active:boolean) {
    let a=0,b=this.times.length;while(a<b){const m=(a+b)>>>1;if(this.times[m]<=at)a=m+1;else b=m;}
    const i=a-1;if(i<0)return 0;
    return (active?this.active[i]:this.agents[i])+(at-this.times[i])*(active?Number(this.slopes[i]>0):this.slopes[i]);
  }
  read(range:PeriodRange,active=false){return this.at(range.to,active)-this.at(range.from,active);}
}
type Group={name:string|null;curve:WorkCurve;agentMs:number;agents:number};
const dimensions:ActivityDimension[]=['source','project','device'];
const keys=(row:WorkTrace['refs'][number])=>({source:row.source,project:JSON.stringify(row.project),device:row.device.id});

export class PeriodActivity {
  private all!:WorkCurve;
  private readonly groups:Record<ActivityDimension,Map<string,Group>>={source:new Map(),project:new Map(),device:new Map()};
  private readonly contexts=new Map<string,WorkCurve>();
  private previous=new Map<string,WorkedSession>();
  private cut=0;
  constructor(readonly trace:WorkTrace,deferred=false) {if(!deferred)drain(this.build());}
  static *prepare(trace:WorkTrace):Preparation<PeriodActivity>{const value=new PeriodActivity(trace,true);yield* value.build();return value;}
  private *build():Preparation<void> {
    const trace=this.trace;
    const all:[number,number][]=[];
    const contexts=new Map<number,[number,number][]>();
    const groups:Record<ActivityDimension,Map<string,[number,number][]>>={source:new Map(),project:new Map(),device:new Map()};
    for(const [id,a,b] of trace.spans){const span:[number,number]=[trace.anchor+a,trace.anchor+b];all.push(span);let own=contexts.get(id);if(!own)contexts.set(id,own=[]);own.push(span);const groupKeys=keys(trace.refs[id]);for(const by of dimensions){let spans=groups[by].get(groupKeys[by]);if(!spans)groups[by].set(groupKeys[by],spans=[]);spans.push(span);}yield;}
    this.all=yield* WorkCurve.prepare(all);
    this.cut=trace.cut??all.reduce((end,span)=>Math.max(end,span[1]),trace.anchor);
    for(const [id,spans] of contexts)this.contexts.set(trace.refs[id].ref,yield* WorkCurve.prepare(spans));
    const devices=new Map(trace.refs.map(r=>[r.device.id,r.device.name]));
    for(const by of dimensions)for(const [key,spans] of groups[by])this.groups[by].set(key,{name:by==='source'?null:by==='project'?JSON.parse(key):devices.get(key)??key,curve:yield* WorkCurve.prepare(spans),agentMs:0,agents:0});
  }
  update(rows:WorkedSession[]) {
    const next=new Map(rows.map(row=>[row.ref,row]));
    for(const ref of new Set([...this.previous.keys(),...next.keys()])) {
      const old=this.previous.get(ref),row=next.get(ref);if(row===old)continue;
      const groupKeys=keys((row??old)!);
      for(const by of dimensions){const group=this.groups[by].get(groupKeys[by]);if(!group)continue;group.agentMs+=(row?.workedMs??0)-(old?.workedMs??0);group.agents+=Number(!!row)-Number(!!old);}
    }
    this.previous=next;
  }
  project(activity:Activity,range:PeriodRange):Activity {
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
        by[dimension].push({key,name:group.name,agentMs:group.agentMs,activeMs:group.curve.read(range,true),agents:group.agents,cells});
      }
      by[dimension].sort((a,b)=>b.agentMs-a.agentMs||a.key.localeCompare(b.key));
    }
    const from=Math.max(range.from,this.trace.knownFrom),to=Math.min(range.to,this.cut);
    return {...activity,since:range.from,known:from<to?{from,to}:null,activeMs:this.all.read(range,true),agentMs:this.all.read(range),agents:this.previous.size,cells,by};
  }
}
