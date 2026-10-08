import type {RateLeg} from '../domain/currency.js';

export type BindingRange={observation_at:number;through_at:number;anchor:string;steps:string};
export type UnavailableObservation={observation_at:number;anchor:string};
type Range={row:BindingRange;steps:RateLeg[]};
type Index={rows:Range[];starts:number[];ends:number[];maximumEnds:number[]};
type Group={rows:Range[];starts:number[];ends:number[];anchors:Map<string,Index>;dirty:Set<Range>;missing:UnavailableObservation[];missingStarts:number[];missingByAnchor:Map<string,number[]>;missingKeys:Map<string,UnavailableObservation>;missingChanges:Map<string,{point:UnavailableObservation;missing:boolean}>};
const upper=(values:readonly number[],at:number)=>{
  let low=0,high=values.length;while(low<high){const middle=(low+high)>>>1;if(values[middle]<=at)low=middle+1;else high=middle;}return low;
};
function index(group:Group) {
  group.missingStarts=group.missing.map(point=>point.observation_at);group.missingByAnchor.clear();group.missingKeys.clear();
  for(const point of group.missing){let times=group.missingByAnchor.get(point.anchor);if(!times)group.missingByAnchor.set(point.anchor,(times=[]));times.push(point.observation_at);group.missingKeys.set(JSON.stringify([point.observation_at,point.anchor]),point);}
  group.starts=group.rows.map(r=>r.row.observation_at);
  group.ends=group.rows.map(r=>r.row.through_at).sort((a,b)=>a-b);
  group.anchors.clear();
  for(const range of group.rows) {
    let saved=group.anchors.get(range.row.anchor);
    if(!saved)group.anchors.set(range.row.anchor,(saved={rows:[],starts:[],ends:[],maximumEnds:[]}));
    saved.rows.push(range);saved.starts.push(range.row.observation_at);
    saved.maximumEnds.push(Math.max(saved.maximumEnds.at(-1)??0,range.row.through_at));
  }
  for(const saved of group.anchors.values())saved.ends=saved.rows.map(r=>r.row.through_at).sort((a,b)=>a-b);
}

/** One authorized history read loads each binding group once and commits sparse assignments. */
export class CurrencyBindings {
  private groups=new Map<string,{source:string;unit:string;group:Group}>();
  constructor(private readonly target:string,private readonly load:(source:string,unit:string)=>BindingRange[],private readonly path:(unit:string,at:number,anchor:string|null)=>RateLeg[]|null,private readonly save:(source:string,unit:string,row:BindingRange)=>void,
    private readonly loadMissing:(source:string,unit:string)=>UnavailableObservation[]=()=>[],
    private readonly saveMissing:(source:string,unit:string,point:UnavailableObservation,missing:boolean)=>void=()=>{},
    private readonly continuous:(from:number,to:number)=>boolean=()=>false){}
  private group(source:string,unit:string):Group {
    const key=JSON.stringify([source,unit]);let saved=this.groups.get(key);
    if(!saved){const rows=this.load(source,unit).map(row=>({row,steps:JSON.parse(row.steps) as RateLeg[]}));const group:Group={rows,starts:[],ends:[],anchors:new Map(),dirty:new Set(),missing:this.loadMissing(source,unit),missingStarts:[],missingByAnchor:new Map(),missingKeys:new Map(),missingChanges:new Map()};index(group);saved={source,unit,group};this.groups.set(key,saved);}
    return saved.group;
  }
  observationAt(source:string,unit:string,at:number):number|null {
    if(unit===this.target)return null;
    const group=this.group(source,unit),start=upper(group.starts,at)-1;
    const missingAt=upper(group.missingStarts,at)-1,missing=group.missing[missingAt]?.observation_at??null;
    if(start<0)return missing;
    const end=upper(group.ends,at)-1;
    return Math.max(group.starts[start],end<0?0:group.ends[end],missing??0);
  }
  changes(source:string,unit:string,from:number,to:number,anchor:string|null=null):number[] {
    if(unit===this.target)return [];
    const group=this.group(source,unit),saved=group.anchors.get(anchor??'');
    // Native capture can precede normalization, so every anchor must revisit its missing observations.
    const missing=group.missingStarts,times=missing.slice(upper(missing,from),upper(missing,to-1));if(!saved)return times;
    for(let at=upper(saved.starts,from);at<saved.rows.length&&saved.starts[at]<to;at++)times.push(saved.starts[at]);
    for(let at=upper(saved.ends,from);at<saved.ends.length&&saved.ends[at]<to;at++)times.push(saved.ends[at]);
    return times;
  }
  binding(source:string,unit:string,at:number,anchor:string|null=null,observed=true):RateLeg[]|null {
    if(unit===this.target)return [];
    const group=this.group(source,unit),key=anchor??'',saved=group.anchors.get(key);
    const before=saved?upper(saved.starts,at)-1:-1;
    if(saved)for(let position=before;position>=0&&saved.maximumEnds[position]>=at;position--)if(saved.rows[position].row.through_at>=at)return saved.rows[position].steps;
    const previous=saved?.rows[before],steps=this.path(unit,at,anchor),missing=group.missingKeys.get(JSON.stringify([at,key]));
    if(!steps){if(observed&&!missing){const point={observation_at:at,anchor:key};group.missing.push(point);group.missing.sort((a,b)=>a.observation_at-b.observation_at);index(group);group.missingChanges.set(JSON.stringify([at,key]),{point,missing:true});}return null;}
    if(missing)group.missingChanges.set(JSON.stringify([at,key]),{point:missing,missing:false});
    const encoded=JSON.stringify(steps);
    if(previous?.row.steps===encoded&&this.continuous(previous.row.through_at,at)&&upper(group.missingByAnchor.get(key)??[],previous.row.through_at)===upper(group.missingByAnchor.get(key)??[],at)){previous.row.through_at=at;group.dirty.add(previous);}
    else {
      const range={row:{observation_at:at,through_at:at,anchor:key,steps:encoded},steps};
      group.rows.splice(upper(group.starts,at),0,range);group.dirty.add(range);
    }
    index(group);return steps;
  }
  flush() {
    for(const {source,unit,group} of this.groups.values()) {
      for(const range of group.dirty)this.save(source,unit,range.row);
      group.dirty.clear();
      for(const {point,missing} of group.missingChanges.values())this.saveMissing(source,unit,point,missing);
      group.missingChanges.clear();
    }
  }
}
