import {drain,type Preparation} from './prepare.js';
import type {History} from './history.js';
import type {Dimension as ActivityDimension,ActivityGroup} from './work.js';
type Activity=History['activity'];
import type {PeriodRange} from './period.js';
import type {WorkedSession,WorkTrace} from './periodWork.js';
import {PeriodCurves,type WorkTimeline} from './periodCurves.js';

type Group={name:string|null;curve:WorkTimeline;agentMs:number;agents:number};
const dimensions:ActivityDimension[]=['source','project','device'];
const keys=(row:WorkTrace['refs'][number])=>({source:row.source??'unknown',project:JSON.stringify(row.project),device:row.device.id});

export class PeriodActivity {
  private all!:WorkTimeline;
  private readonly groups:Record<ActivityDimension,Map<string,Group>>={source:new Map(),project:new Map(),device:new Map()};
  private readonly contexts=new Map<string,WorkTimeline>();
  private previous=new Map<string,WorkedSession>();
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
    for(const by of dimensions)for(const [key,curve] of curves.groups[by]){this.groups[by].set(key,{name:by==='source'?null:by==='project'?JSON.parse(key):devices.get(key)??key,curve,agentMs:0,agents:0});yield;}
  }

  update(rows:WorkedSession[]) {
    if(this.trace.fixed)return;
    const next=new Map(rows.map(row=>[row.ref,row]));
    for(const ref of new Set([...this.previous.keys(),...next.keys()])) {
      const old=this.previous.get(ref),row=next.get(ref);if(row===old)continue;
      const groupKeys=keys((row??old)!);
      for(const by of dimensions){const group=this.groups[by].get(groupKeys[by]);if(!group)continue;group.agentMs+=(row?.workedMs??0)-(old?.workedMs??0);group.agents+=Number(!!row)-Number(!!old);}
    }
    this.previous=next;
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
    return {...activity,since:range.from,known:from<to?{from,to}:null,activeMs:this.all.read(range,true),agentMs:this.all.read(range),agents:this.previous.size,cells,by};
  }
}
