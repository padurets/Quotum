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
const hourFormats=new Map<string,{format:Intl.NumberFormat;separator:string}>();
export function exactAgentHours(ms:number,locale:string){
  const scale=1_000_000_000n,rounded=(BigInt(ms)*scale+1_800_000n)/3_600_000n;
  const whole=rounded/scale,fraction=(rounded%scale).toString().padStart(9,'0').replace(/0+$/,'');
  let stored=hourFormats.get(locale);
  if(!stored){const format=new Intl.NumberFormat(locale,{useGrouping:false});stored={format,separator:format.formatToParts(1.1).find(p=>p.type==='decimal')!.value};if(hourFormats.size>=4)hourFormats.delete(hourFormats.keys().next().value!);hourFormats.set(locale,stored);}
  const {format,separator}=stored;
  return format.format(whole)+(fraction?separator+fraction:'');
}
export type CalendarReading={window:ReturnType<typeof calendarWindow>;value:CalendarValue|null;basis:CalendarBasis|null;loading:boolean;error:string|null};
/** Each operation replaces only this section's charge inside the caller's shared reply. */
export type CalendarAdmission={reserve(bytes:number):boolean;handoff(remainingBytes:number):boolean};

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
function windowBytes(window:CalendarReading['window']){
  const {edges,dayEdges,dates,...range}=window;
  return (edges.length+dayEdges.length)*16+dates.length*96+JSON.stringify(range).length*3;
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
  presentationKey=()=>JSON.stringify([this.context,periodKey(this.selection)]);
  private listeners=new Set<()=>void>();
  private readonly delivery=new Set([()=>this.deliver()]);
  private retained=new Map<CalendarReading,number>();
  private accountedBytes:number|null=null;
  private cache=new CalendarCache();
  constructor(private readonly notify:(listeners:Set<()=>void>)=>void=listeners=>{for(const listener of listeners)listener();}){}
  get=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(){this.notify(this.delivery);}
  private deliver(){
    const release=this.retain(this.state);
    try{for(const listener of [...this.listeners])if(this.listeners.has(listener))listener();}finally{release();}
  }
  /** Captured preparations and displayed grids can outlive the current reading. */
  retain(reading:CalendarReading){
    this.retained.set(reading,(this.retained.get(reading)??0)+1);this.accountedBytes=null;let released=false;
    return ()=>{
      if(released)return;released=true;
      const count=this.retained.get(reading)!-1;if(count)this.retained.set(reading,count);else this.retained.delete(reading);
      this.accountedBytes=null;
    };
  }
  get bytes(){
    if(this.accountedBytes===null){
      const readings=new Set(this.retained.keys()),windows=new Set<CalendarReading['window']>(),values=new Set<CalendarValue>();let bytes=0;
      if(this.visible&&this.context)readings.add(this.state);
      for(const reading of readings){
        bytes+=readingBytes(reading);
        if(windows.has(reading.window))bytes-=windowBytes(reading.window);else windows.add(reading.window);
        if(reading.value){if(values.has(reading.value))bytes-=valueBytes(reading.value);else values.add(reading.value);}
      }
      // Adopted and retained readings can share this numeric boundary payload.
      const edges=new Set<number[]>();
      for(const window of windows){bytes-=window.edges.length*16;edges.add(window.edges);}
      for(const value of values){bytes-=value.edges.length*16;edges.add(value.edges);}
      for(const edge of edges)bytes+=edge.length*16;
      this.accountedBytes=bytes;
    }
    return this.accountedBytes+this.cache.bytes;
  }
  evictionCandidates(){return this.cache.evictionCandidates();}
  clear(retainContext=false){
    const release=this.retain(this.state);
    try{if(!retainContext)this.context='';this.needed=false;this.cache.clear();this.generation++;this.state={...this.state,value:null,basis:null,loading:false,error:null};this.publish();}
    finally{release();}
  }
  configure(visible:boolean,context:string,now:number,limited=false,selection:PeriodSelection=this.selection,reserve:(bytes:number)=>boolean=()=>true){
    const generation=this.generation;
    const changed=this.context!==context||this.visible!==visible||periodKey(selection)!==periodKey(this.selection);
    const release=changed?this.retain(this.state):()=>{};
    let releaseReading:(()=>void)|undefined;
    try{
      if(this.context!==context||this.visible!==visible||limited)this.cache.clear();
      this.visible=visible;this.limited=limited;this.selection=selection;
      if(changed){
        this.generation++;this.context=context;const window=calendarWindow(now,calendarZone(),selection);
        if(window.zone!==this.state.window.zone)this.cache.clear();
        const current=this.generation,previous=this.state;
        const reading=visible&&!limited?this.cache.read(window,selection,now,reserve)??{window,value:null,basis:null,loading:true,error:null}:{window,value:null,basis:null,loading:false,error:null};
        if(current!==this.generation||previous!==this.state)return true;
        this.state=reading;this.accountedBytes=null;
        releaseReading=this.retain(reading);
        this.needed=visible&&!this.state.value;
        // This reservation belongs only to configure's projection. The accepted
        // reading is now resident; publication must not charge the same cells twice.
        const accepted=reserve(0);
        if(current!==this.generation||reading!==this.state)return true;
        if(!accepted){this.needed=false;this.state={window,value:null,basis:null,loading:false,error:'history_limit'};}
      }
      else this.tick(now,true);
      if(visible&&limited){this.needed=false;this.state={...this.state,value:null,basis:null,loading:false,error:'filters_limit'};this.accountedBytes=null;}
      if(changed)this.publish();return changed||generation!==this.generation;
    }finally{releaseReading?.();release();}
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
    const release=this.retain(old);
    try{this.state={...old,window,value,basis:renew?null:old.basis,...(renew&&this.needed?{loading:true,error:null}:{})};this.publish();return true;}
    finally{release();}
  }
  nextAt(_now:number){
    if(!this.visible)return Infinity;
    const {window}=this.state;
    const advance=this.selection.mode==='live'?Math.min(window.dayEdges.at(-1)!,window.dayEdges[1]+this.selection.periodMs):Infinity;
    return advance;
  }
  dirty(since=-Infinity){
    this.cache.invalidate(since);
    if(since===Infinity||this.selection.mode==='range'&&since>=this.selection.to)return false;
    // Decoded replies may still await another resource's adoption. They cannot
    // publish or create a fresh cache proof after this evidence was invalidated.
    this.generation++;
    if(this.visible&&!this.limited){this.needed=true;return true;}
    return false;
  }
  demand():CalendarDemand|undefined {return this.visible&&this.needed?{zone:this.state.window.zone,relative:true,...(this.state.value?.cursor?{cursor:this.state.value.cursor}:{})}:undefined;}
  incomingBytes(part:CalendarSection){return part.state==='complete'?valueBytes(part.value)+JSON.stringify(part.basis).length*3:JSON.stringify(part).length*3;}
  receive(part:CalendarSection,generation:number,memory:CalendarAdmission|((bytes:number)=>boolean)){
    if(!this.visible||generation!==this.generation)return;
    if(part.state==='error'){this.needed=false;this.state={...this.state,loading:false,error:part.error};this.publish();return;}
    const range=evaluatedRange(this.selection,part.basis.evaluatedAt);
    if(range.from!==part.basis.range.from||range.to!==part.basis.range.to)return;
    const previous=this.state.basis,old=this.state.value;
    if(previous&&part.basis.run===previous.run&&(Number(part.basis.revision)<Number(previous.revision)||part.basis.evidenceCut<previous.evidenceCut))return;
    const admission=typeof memory==='function'?{reserve:memory,handoff:memory}:memory;
    const state=this.state,release=this.retain(state);let expected=state,releaseReading:(()=>void)|undefined;
    const current=()=>this.visible&&generation===this.generation&&this.state===expected;
    const admit=(bytes:number)=>{const accepted=admission.reserve(bytes);return current()&&accepted;};
    const fail=()=>{if(current()){this.needed=false;this.state={...state,loading:false,error:'history_limit'};this.publish();}};
    try{
      let remaining=this.incomingBytes(part);
      let value:CalendarValue,window=this.state.window;
      if(part.state==='delta'){
        if(!old||!previous||(['calendarKey','filterKey','workAuthority','run'] as const).some(key=>previous[key]!==part.basis[key]))return;
        if(!admit(remaining+old.cells.length*16)){fail();return;}
        const cells=old.cells.slice();let prior=-1;
        for(const [i,cell] of part.value.updates){if(!Number.isInteger(i)||i<=prior||i>=cells.length)return;prior=i;cells[i]=cell;}
        value={...old,availableFrom:part.value.availableFrom,retainedFrom:part.value.retainedFrom,cursor:part.value.cursor,cells};
      }else{
        const days=window.dayEdges,sameDays=range.from>=days[0]&&range.from<days[1]&&range.to>days.at(-2)!&&range.to<=days.at(-1)!;
        if(!sameDays||part.value.edges[0]!==window.edges[0]||part.value.edges.at(-1)!==window.edges.at(-1))window=calendarWindow(part.basis.evaluatedAt,window.zone,this.selection);
        if(part.value.zone!==window.zone||JSON.stringify(part.value.edges)!==JSON.stringify(window.edges)||part.value.cells.length!==window.edges.length-1)return;
        const staging=remaining;
        if(!admit(staging)){fail();return;}
        this.cache.add(part.basis,part.value,admit,staging);
        if(!current())return;
        // Both numeric roots now belong to the resident reading. The caller still
        // owns the reply envelope and proof until its shared flight finishes.
        window={...window,edges:part.value.edges};
        const {proof:_proof,...accepted}=part.value;value=accepted;
        remaining-=part.value.edges.length*16+part.value.cells.length*160;
      }
      expected={...state,window:{...window,range:part.basis.range},value,basis:part.basis,loading:false,error:null};
      this.state=expected;this.accountedBytes=null;
      releaseReading=this.retain(expected);
      let accepted:boolean;
      try{accepted=admission.handoff(remaining);}
      catch(error){if(current()){this.state=state;this.accountedBytes=null;}throw error;}
      if(!current())return;
      if(!accepted){this.state=state;expected=state;this.accountedBytes=null;releaseReading();releaseReading=undefined;fail();return;}
      this.needed=false;this.publish();
    }finally{releaseReading?.();release();}
  }
}
