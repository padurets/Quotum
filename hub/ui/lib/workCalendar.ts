import {calendarPartition,type CalendarBasis,type CalendarDemand,type CalendarSection,type CalendarValue} from '../../server/domain/workCalendar.js';
import {evaluatedRange,periodKey,type PeriodSelection} from '../../server/domain/period.js';
import {CalendarCache} from './calendarCache';

const DAY=86_400_000;
export const CALENDAR_RETENTION=90*DAY;
export const calendarZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
const formatters=new Map<string,Intl.DateTimeFormat>();
const civilFormatter=(zone:string)=>{let formatter=formatters.get(zone);if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});formatters.set(zone,formatter);}return formatter;};
function civil(at:number,formatter:Intl.DateTimeFormat){const parts=formatter.formatToParts(at);return ['year','month','day'].map(key=>parts.find(p=>p.type===key)!.value).join('-');}
export function calendarWindow(at:number,zone=calendarZone(),selection:PeriodSelection={mode:'live',periodMs:DAY}){
  const range=evaluatedRange(selection,at),formatter=civilFormatter(zone),first=civil(range.from,formatter),last=civil(range.to-1,formatter);
  const base=Date.parse(first+'T00:00:00Z'),count=Math.round((Date.parse(last+'T00:00:00Z')-base)/DAY)+1;
  const dates=Array.from({length:count+1},(_,i)=>new Date(base+i*DAY).toISOString().slice(0,10));
  const dayEdges=dates.map(key=>{
    const utc=Date.parse(key+'T00:00:00Z');let lo=utc-2*DAY,hi=utc+2*DAY;
    while(lo<hi){const mid=Math.floor((lo+hi)/2);if(civil(mid,formatter)<key)lo=mid+1;else hi=mid;}
    return lo;
  });
  return {zone,range,dates:dates.slice(0,-1),dayEdges,edges:calendarPartition(range)};
}
export const calendarLevel=(ms:number,span=3_600_000)=>ms===0?0:ms<span*.5?1:ms<span?2:ms<span*2?3:ms<span*4?4:5;
export const CALENDAR_OPACITY=[0,.2,.4,.6,.8,1];
export function exactAgentHours(ms:number,locale:string){
  const scale=1_000_000_000n,rounded=(BigInt(ms)*scale+1_800_000n)/3_600_000n;
  const whole=rounded/scale,fraction=(rounded%scale).toString().padStart(9,'0').replace(/0+$/,'');
  const format=new Intl.NumberFormat(locale,{useGrouping:false});
  const separator=format.formatToParts(1.1).find(p=>p.type==='decimal')!.value;
  return format.format(whole)+(fraction?separator+fraction:'');
}
export type CalendarReading={window:ReturnType<typeof calendarWindow>;value:CalendarValue|null;basis:CalendarBasis|null;loading:boolean;error:string|null};

/** Numeric cells have fixed fields; JSON repeats property names they share in memory. */
function valueBytes(value:CalendarValue){
  const {edges,cells,proof,...metadata}=value;
  // Each cell allowance covers its object, boxed numbers and array slot.
  return 1024+edges.length*16+cells.length*160+JSON.stringify(metadata).length*3+(proof?JSON.stringify(proof).length*3:0);
}
function readingBytes(reading:CalendarReading){
  const {window,value,...metadata}=reading,{edges,dayEdges,dates,...range}=window;
  return 1024+(edges.length+dayEdges.length)*16+dates.length*96+JSON.stringify([metadata,range]).length*3+(value?valueBytes(value):0);
}

/** The heatmap shares the board's selection, authority and event-driven transport. */
export class WorkCalendar {
  private context='';
  private selection:PeriodSelection={mode:'live',periodMs:DAY};
  visible=false;
  private limited=false;
  needed=false;
  generation=0;
  state:CalendarReading={window:calendarWindow(Date.now()),value:null,basis:null,loading:false,error:null};
  private listeners=new Set<()=>void>();
  private accountedState:CalendarReading|null=null;
  private accountedBytes=0;
  private cache=new CalendarCache();
  get=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(){this.accountedState=null;for(const listener of this.listeners)listener();}
  get bytes(){
    if(!this.visible||!this.context)return this.cache.bytes;
    if(this.accountedState!==this.state){this.accountedState=this.state;this.accountedBytes=readingBytes(this.state);}
    return this.accountedBytes+this.cache.bytes;
  }
  evictionCandidates(){return this.cache.evictionCandidates();}
  clear(retainContext=false){if(!retainContext)this.context='';this.needed=false;this.cache.clear();this.generation++;this.state={...this.state,value:null,basis:null,loading:false,error:null};this.publish();}
  configure(visible:boolean,context:string,now:number,limited=false,selection:PeriodSelection=this.selection,reserve:(bytes:number)=>boolean=()=>true){
    const generation=this.generation;
    const changed=this.context!==context||this.visible!==visible||periodKey(selection)!==periodKey(this.selection);
    if(this.context!==context||this.visible!==visible||limited)this.cache.clear();
    this.visible=visible;this.limited=limited;this.selection=selection;
    if(changed){
      this.generation++;this.context=context;const window=calendarWindow(now,calendarZone(),selection);
      if(window.zone!==this.state.window.zone)this.cache.clear();
      const current=this.generation,previous=this.state;
      const reading=visible&&!limited?this.cache.read(window,selection,now,reserve)??{window,value:null,basis:null,loading:true,error:null}:{window,value:null,basis:null,loading:false,error:null};
      if(current!==this.generation||previous!==this.state)return true;
      this.state=reading;this.accountedState=null;
      this.needed=visible&&!this.state.value;
      // This reservation belongs only to configure's projection. The accepted
      // reading is now resident; publication must not charge the same cells twice.
      reserve(0);
      if(current!==this.generation||reading!==this.state)return true;
    }
    else this.tick(now,true);
    if(visible&&limited){this.needed=false;this.state={...this.state,value:null,basis:null,loading:false,error:'filters_limit'};}
    if(changed)this.publish();return changed||generation!==this.generation;
  }
  tick(now:number,checkZone=false){
    if(!this.visible)return false;
    const old=this.state,range=evaluatedRange(this.selection,now),zone=checkZone?calendarZone():old.window.zone;
    // Buckets expire independently; only civil edges and clock corrections wake the frame.
    const advance=this.selection.mode==='live'?Math.min(old.window.dayEdges.at(-1)!,old.window.dayEdges[1]+this.selection.periodMs):Infinity,moved=now>=advance;
    const invalid=!!old.basis&&now<old.basis.evidenceCut;
    if(!moved&&!invalid&&zone===old.window.zone)return false;
    if(invalid||zone!==old.window.zone)this.cache.clear();
    const window=calendarWindow(now,zone,this.selection),partition=zone!==old.window.zone||window.edges[0]!==old.window.edges[0]||window.edges.at(-1)!==old.window.edges.at(-1);
    let value=invalid||zone!==old.window.zone?null:old.value;
    if(value){
      const prior=new Map(value.edges.slice(0,-1).map((edge,i)=>[edge,value!.cells[i]]));
      value={...value,zone,edges:window.edges,cursor:partition?'':value.cursor,cells:window.edges.slice(0,-1).map((edge,i)=>{
        const cell=prior.get(edge),floor=Math.max(range.from,now-CALENDAR_RETENTION);
        if(!cell||window.edges[i+1]<=floor||edge>=range.to)return {agentMs:null,from:edge,to:edge,validUntil:null};
        const from=Math.min(cell.to,Math.max(cell.from,floor));
        return {...cell,from,...(cell.validUntil!==null&&now>=cell.validUntil?{agentMs:null}:{})};
      })};
    }
    const renew=partition||invalid;
    if(renew){this.generation++;this.needed=!this.limited;}
    this.state={...old,window,value,basis:renew?null:old.basis,...(renew&&this.needed?{loading:true,error:null}:{})};this.publish();return true;
  }
  nextAt(_now:number){
    if(!this.visible)return Infinity;
    const {window}=this.state;
    const advance=this.selection.mode==='live'?Math.min(window.dayEdges.at(-1)!,window.dayEdges[1]+this.selection.periodMs):Infinity;
    return advance;
  }
  dirty(){this.cache.clear();if(this.visible&&!this.limited){this.needed=true;return true;}return false;}
  demand():CalendarDemand|undefined {return this.visible&&this.needed?{zone:this.state.window.zone,...(this.state.value?.cursor?{cursor:this.state.value.cursor}:{})}:undefined;}
  receive(part:CalendarSection,generation:number,reserve:(bytes:number)=>boolean){
    if(!this.visible||generation!==this.generation)return;
    if(part.state==='error'){this.needed=false;this.state={...this.state,value:null,basis:null,loading:false,error:part.error};this.publish();return;}
    const range=evaluatedRange(this.selection,part.basis.evaluatedAt);
    if(range.from!==part.basis.range.from||range.to!==part.basis.range.to)return;
    const previous=this.state.basis,old=this.state.value;
    if(previous&&part.basis.run===previous.run&&(Number(part.basis.revision)<Number(previous.revision)||part.basis.evidenceCut<previous.evidenceCut))return;
    let value:CalendarValue,window=this.state.window;
    if(part.state==='delta'){
      if(!old||!previous||(['calendarKey','filterKey','workAuthority','run'] as const).some(key=>previous[key]!==part.basis[key]))return;
      if(!reserve(JSON.stringify(part).length*3+old.cells.length*16)){this.receive({state:'error',error:'history_limit'},generation,()=>true);return;}
      const cells=old.cells.slice();let prior=-1;
      for(const [i,cell] of part.value.updates){if(!Number.isInteger(i)||i<=prior||i>=cells.length)return;prior=i;cells[i]=cell;}
      value={...old,availableFrom:part.value.availableFrom,retainedFrom:part.value.retainedFrom,cursor:part.value.cursor,cells};
    }else{
      const days=window.dayEdges,sameDays=range.from>=days[0]&&range.from<days[1]&&range.to>days.at(-2)!&&range.to<=days.at(-1)!;
      if(!sameDays||part.value.edges[0]!==window.edges[0]||part.value.edges.at(-1)!==window.edges.at(-1))window=calendarWindow(part.basis.evaluatedAt,window.zone,this.selection);
      if(part.value.zone!==window.zone||JSON.stringify(part.value.edges)!==JSON.stringify(window.edges)||part.value.cells.length!==window.edges.length-1)return;
      const staging=valueBytes(part.value)+JSON.stringify(part.basis).length*3;
      if(!reserve(staging)){this.receive({state:'error',error:'history_limit'},generation,()=>true);return;}
      this.cache.add(part.basis,part.value,reserve,staging);
      const {proof:_proof,...accepted}=part.value;value={...accepted,edges:window.edges};
    }
    this.needed=false;this.state={...this.state,window:{...window,range:part.basis.range},value,basis:part.basis,loading:false,error:null};this.publish();
  }
}
