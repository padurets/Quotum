import type {RateLeg} from '../domain/currency.js';

export type BindingRange={observation_at:number;through_at:number;anchor:string;steps:string};
type Range={row:BindingRange;steps:RateLeg[]};
type Group={rows:Range[];ends:number[]|null;dirty:Set<Range>};
const upper=(values:readonly number[],at:number)=>{
  let low=0,high=values.length;while(low<high){const middle=(low+high)>>>1;if(values[middle]<=at)low=middle+1;else high=middle;}return low;
};

/** One authorized history read loads each binding group once and commits sparse assignments. */
export class CurrencyBindings {
  private groups=new Map<string,{source:string;unit:string;group:Group}>();
  constructor(private readonly target:string,private readonly load:(source:string,unit:string)=>BindingRange[],private readonly path:(unit:string,at:number,anchor:string|null)=>RateLeg[]|null,private readonly save:(source:string,unit:string,row:BindingRange)=>void){}
  private group(source:string,unit:string):Group {
    const key=JSON.stringify([source,unit]);let saved=this.groups.get(key);
    if(!saved){const rows=this.load(source,unit).map(row=>({row,steps:JSON.parse(row.steps) as RateLeg[]}));saved={source,unit,group:{rows,ends:null,dirty:new Set()}};this.groups.set(key,saved);}
    return saved.group;
  }
  observationAt(source:string,unit:string,at:number):number|null {
    if(unit===this.target)return null;
    const group=this.group(source,unit),starts=group.rows.map(r=>r.row.observation_at);
    const start=upper(starts,at)-1;
    if(start<0)return null;
    group.ends??=group.rows.map(r=>r.row.through_at).sort((a,b)=>a-b);
    const end=upper(group.ends,at)-1;
    return Math.max(starts[start],end<0?0:group.ends[end]);
  }
  binding(source:string,unit:string,at:number,anchor:string|null=null):RateLeg[]|null {
    if(unit===this.target)return [];
    const group=this.group(source,unit),key=anchor??'';
    let previous:Range|undefined;
    for(let index=group.rows.length-1;index>=0;index--) {
      const candidate=group.rows[index];if(candidate.row.observation_at>at||candidate.row.anchor!==key)continue;
      if(candidate.row.through_at>=at)return candidate.steps;
      previous??=candidate;
    }
    const steps=this.path(unit,at,anchor);if(!steps)return null;
    const encoded=JSON.stringify(steps);
    if(previous?.row.steps===encoded){previous.row.through_at=at;group.dirty.add(previous);}
    else {
      const range={row:{observation_at:at,through_at:at,anchor:key,steps:encoded},steps};
      const index=upper(group.rows.map(r=>r.row.observation_at),at);group.rows.splice(index,0,range);group.dirty.add(range);
    }
    group.ends=null;return steps;
  }
  flush() {
    for(const {source,unit,group} of this.groups.values()) {
      for(const range of group.dirty)this.save(source,unit,range.row);
      group.dirty.clear();
    }
  }
}
