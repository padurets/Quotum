import {calendarPartition,type CalendarBasis,type CalendarCell,type CalendarDemand,type CalendarProof,type CalendarSection,type CalendarValue,type WorkStamp} from '../../server/domain/workCalendar.js';
import {mergeSourceWorkTape,type WorkTimeline} from '../../server/domain/periodCurves.js';
import {calendarProjection} from '../../server/domain/calendarWork.js';
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
export type CalendarIntegral={
  proof:Pick<CalendarProof,'from'|'cut'|'retentionMs'|'periodMs'>;
  curve:Pick<WorkTimeline,'read'|'working'|'next'|'slope'>;
  bytes:number;stamp:WorkStamp;through():number;
  tape?:CalendarProof;owners?:readonly CalendarIntegral[];
};
export type CalendarReading={window:ReturnType<typeof calendarWindow>;value:CalendarValue|null;basis:CalendarBasis|null;loading:boolean;error:string|null;integral?:CalendarIntegral};

/** Accepted data keeps its basis; the live reading surface follows the current clock. */
export function calendarRangeAt(reading:CalendarReading,now:number){
  const range=reading.window.range;
  return reading.integral?evaluatedRange({mode:'live',periodMs:range.to-range.from},now):range;
}

/** Exact anonymous integrals preserve partial work at both moving boundaries. */
export function calendarCellAt(reading:CalendarReading,from:number,to:number,now:number):CalendarCell {
  const {integral,value}=reading,range=calendarRangeAt(reading,now);
  if(!integral||!value)return {agentMs:null,from,to:from,validUntil:null};
  const {proof,curve}=integral,cut=Math.min(range.to,integral.through());
  const start=Math.max(from,range.from,proof.from,value.availableFrom??cut,value.retainedFrom,now-proof.retentionMs),end=Math.min(to,range.to,cut);
  if(value.availableFrom===null||start>=end){const point=Math.max(from,Math.min(to,range.to,cut));return {agentMs:null,from:point,to:point,validUntil:null};}
  const agentMs=curve.read({from:start,to:end});
  if(!Number.isSafeInteger(agentMs))throw new RangeError('calendar_overflow');
  const first=agentMs?(curve.working(start)?start:curve.next(start)):Infinity;
  return {agentMs,from:start,to:end,validUntil:agentMs?first+Math.min(proof.retentionMs,range.to-range.from)+1:null};
}
/** Each operation replaces only this section's charge inside the caller's shared reply. */
export type CalendarAdmission={reserve(bytes:number):boolean;handoff(remainingBytes:number):boolean};

/** Numeric cells have fixed fields; JSON repeats property names they share in memory. */
function valueBytes(value:CalendarValue){
  const {edges,cells,proof,...metadata}=value;
  // Each cell allowance covers its object, boxed numbers and array slot.
  return 1024+edges.length*16+cells.length*160+JSON.stringify(metadata).length*3+(proof?JSON.stringify(proof).length*3:0);
}
function readingBytes(reading:CalendarReading){
  const {window,value,integral:_integral,...metadata}=reading,{edges,dayEdges,dates,...range}=window;
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
  private workStamp:WorkStamp|undefined;
  private coveredStamp:WorkStamp|undefined;
  private cache=new CalendarCache((stamp,cut)=>Math.max(cut,this.workStamp?.watch===stamp.watch&&this.workStamp.seq===stamp.seq&&this.workStamp.authority===stamp.authority?this.workStamp.at:stamp.at));
  constructor(private readonly notify:(listeners:Set<()=>void>)=>void=listeners=>{for(const listener of listeners)listener();}){}
  get=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  matchesFreshness(stamp:WorkStamp|undefined){const accepted=this.state.integral?.stamp;return !!stamp&&!!accepted&&stamp.watch===accepted.watch&&stamp.seq===accepted.seq&&stamp.authority===accepted.authority;}
  knowsFreshness(stamp:WorkStamp|undefined){const accepted=this.workStamp;return !!stamp&&!!accepted&&stamp.watch===accepted.watch&&stamp.seq===accepted.seq&&stamp.authority===accepted.authority;}
  /** Freshness advances time coverage, without publishing or preparing new data. */
  acceptFreshness(stamp:WorkStamp){
    if(!stamp||typeof stamp.watch!=='string'||!stamp.watch||typeof stamp.authority!=='string'||!stamp.authority||!Number.isSafeInteger(stamp.seq)||stamp.seq<0||!Number.isSafeInteger(stamp.at)||stamp.at<0)return false;
    const previous=this.workStamp;
    // A newer heartbeat advances coverage without superseding data of the same version.
    if(previous&&stamp.watch===previous.watch&&stamp.seq===previous.seq&&stamp.authority===previous.authority&&stamp.at<=previous.at)return true;
    if(previous&&(stamp.seq<previous.seq||stamp.seq===previous.seq&&stamp.watch!==previous.watch||stamp.watch===previous.watch&&stamp.seq===previous.seq&&stamp.at<previous.at))return false;
    if(previous&&(stamp.watch!==previous.watch||stamp.seq!==previous.seq||stamp.authority!==previous.authority)&&!(this.coveredStamp?.watch===stamp.watch&&this.coveredStamp.authority===stamp.authority&&this.coveredStamp.seq>=stamp.seq))this.cache.suspend(stamp);
    this.workStamp={...stamp};return true;
  }
  /** A new connection cannot revive a response captured in the retired lifetime. */
  disconnectFreshness(){this.workStamp=undefined;this.coveredStamp=undefined;this.cache.clear();this.generation++;}
  private integrals(){
    const readings=new Set(this.retained.keys());if(this.visible&&this.context)readings.add(this.state);
    return [...readings].flatMap(reading=>reading.integral?[reading.integral]:[]);
  }
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
    const stamps=[this.workStamp,this.coveredStamp].reduce((bytes,stamp)=>bytes+(stamp?256+(stamp.watch.length+stamp.authority.length)*2:0),0);
    return this.accountedBytes+this.cache.residentBytes(this.integrals())+stamps;
  }
  evictionCandidates(){return this.cache.evictionCandidates(this.integrals());}
  clear(retainContext=false){
    const release=this.retain(this.state);
    try{if(!retainContext)this.context='';this.needed=false;this.workStamp=undefined;this.coveredStamp=undefined;this.cache.clear();this.generation++;this.state={...this.state,value:null,basis:null,integral:undefined,loading:false,error:null};this.publish();}
    finally{release();}
  }
  configure(visible:boolean,context:string,now:number,limited=false,selection:PeriodSelection=this.selection,reserve:(bytes:number)=>boolean=()=>true){
    const generation=this.generation;
    const changed=this.context!==context||this.visible!==visible||periodKey(selection)!==periodKey(this.selection);
    const release=changed?this.retain(this.state):()=>{};
    let releaseReading:(()=>void)|undefined;
    try{
      if(this.context!==context||this.visible!==visible||limited){this.cache.clear();this.workStamp=undefined;this.coveredStamp=undefined;}
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
      if(visible&&limited){this.needed=false;this.state={...this.state,value:null,basis:null,integral:undefined,loading:false,error:'filters_limit'};this.accountedBytes=null;}
      if(changed)this.publish();return changed||generation!==this.generation;
    }finally{releaseReading?.();release();}
  }
  tick(now:number,checkZone=false){
    if(!this.visible)return false;
    const old=this.state,range=evaluatedRange(this.selection,now),zone=checkZone?calendarZone():old.window.zone;
    // Buckets expire independently; only civil edges and clock corrections wake the frame.
    const advance=this.selection.mode==='live'?Math.min(old.window.dayEdges.at(-1)!,old.window.dayEdges[1]+this.selection.periodMs):Infinity,moved=now>=advance;
    const invalid=!!old.basis&&now<old.basis.evidenceCut;
    if(old.integral&&!invalid&&zone===old.window.zone)return false;
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
    try{this.state={...old,window,value,integral:undefined,basis:renew?null:old.basis,...(renew&&this.needed?{loading:true,error:null}:{})};this.publish();return true;}
    finally{release();}
  }
  nextAt(_now:number){
    if(!this.visible)return Infinity;
    if(this.state.integral)return Infinity;
    const {window}=this.state;
    const advance=this.selection.mode==='live'?Math.min(window.dayEdges.at(-1)!,window.dayEdges[1]+this.selection.periodMs):Infinity;
    return advance;
  }
  dirty(since=-Infinity,stamp?:WorkStamp){
    this.cache.invalidate(since,stamp);
    if(stamp&&(!this.coveredStamp||stamp.seq>=this.coveredStamp.seq)){this.coveredStamp=stamp;this.acceptFreshness(stamp);}
    if(since===Infinity||this.selection.mode==='range'&&since>=this.selection.to)return false;
    // Decoded replies may still await another resource's adoption. They cannot
    // publish or create a fresh cache proof after this evidence was invalidated.
    this.generation++;
    if(this.visible&&!this.limited){this.needed=true;return true;}
    return false;
  }
  demand():CalendarDemand|undefined {return this.visible&&this.needed?{zone:this.state.window.zone,relative:true,...(this.selection.mode==='live'?{freshness:true as const}:{}),...(this.state.value?.cursor?{cursor:this.state.value.cursor}:{})}:undefined;}
  incomingBytes(part:CalendarSection){return part.state==='complete'?valueBytes(part.value)+JSON.stringify(part.basis).length*3:JSON.stringify(part).length*3;}
  receive(part:CalendarSection,generation:number,memory:CalendarAdmission|((bytes:number)=>boolean)){
    if(!this.visible||generation!==this.generation)return;
    if(part.state==='error'){this.needed=false;this.state={...this.state,loading:false,error:part.error};this.publish();return;}
    const range=evaluatedRange(this.selection,part.basis.evaluatedAt);
    if(range.from!==part.basis.range.from||range.to!==part.basis.range.to)return;
    const previous=this.state.basis,old=this.state.value;
    if(previous&&part.basis.run===previous.run&&(Number(part.basis.revision)<Number(previous.revision)||part.basis.evidenceCut<previous.evidenceCut))return;
    if(part.value.workStamp&&!this.acceptFreshness(part.value.workStamp))return;
    const admission=typeof memory==='function'?{reserve:memory,handoff:memory}:memory;
    const state=this.state,release=this.retain(state);let expected=state,releaseReading:(()=>void)|undefined,releaseIntegral:(()=>void)|undefined;
    const current=()=>this.visible&&generation===this.generation&&this.state===expected&&(!part.value.workStamp||!this.workStamp||part.value.workStamp.watch===this.workStamp.watch&&part.value.workStamp.seq===this.workStamp.seq&&part.value.workStamp.authority===this.workStamp.authority);
    const admit=(bytes:number)=>{const accepted=admission.reserve(bytes);return current()&&accepted;};
    const fail=()=>{if(current()){this.needed=false;this.state={...state,loading:false,error:'history_limit'};this.publish();}};
    try{
      let remaining=this.incomingBytes(part);
      let value:CalendarValue,window=this.state.window,integral:CalendarIntegral|undefined;
      if(part.state==='delta'){
        if(!old||!previous||(['calendarKey','filterKey','workAuthority','run'] as const).some(key=>previous[key]!==part.basis[key]))return;
        if(part.value.proof&&part.value.workStamp){
          const proof=part.value.proof,before=state.integral;
          if(!before?.tape||before.stamp.watch!==part.value.workStamp.watch||before.stamp.authority!==part.value.workStamp.authority||part.value.updates.length||proof.from<before.tape.from||proof.cut<before.tape.cut||!Number.isSafeInteger(proof.replaceFrom)||!Number.isSafeInteger(proof.replaceTo)||proof.replaceFrom!<proof.from||proof.replaceFrom!>proof.replaceTo!||proof.replaceTo!==proof.cut)return;
          let scratch=remaining;
          const add=(bytes:number)=>{scratch+=bytes;if(!admit(scratch))throw new Error('calendar_merge_limit');};
          const drop=(bytes:number)=>{scratch-=bytes;if(!admit(scratch))throw new Error('calendar_merge_limit');};
          let tape:CalendarProof;
          try{tape={...mergeSourceWorkTape(before.tape,proof,add,drop),retentionMs:proof.retentionMs,periodMs:proof.periodMs};}
          catch(error){if(!(error instanceof Error)||error.message!=='calendar_merge_limit')throw error;fail();return;}
          if(!current())return;
          window=calendarWindow(part.basis.evaluatedAt,window.zone,this.selection);
          value={...old,availableFrom:part.value.availableFrom,retainedFrom:part.value.retainedFrom,cursor:part.value.cursor,edges:window.edges,cells:[],proof:tape,workStamp:part.value.workStamp};
          const retainedProofBytes=scratch-remaining,staging=remaining+valueBytes(value)+Math.max(0,retainedProofBytes-JSON.stringify(tape).length*3);
          if(!admit(staging)){fail();return;}
          const lease=this.cache.add(part.basis,value,admit,staging,retainedProofBytes);integral=lease?.integral;releaseIntegral=lease?.release;
          if(!current())return;
          if(!integral||!admit(remaining+window.edges.length*256)){fail();return;}
          value={...value,proof:undefined,cells:calendarProjection(window.edges,range,part.basis.evidenceCut,value.availableFrom,value.retainedFrom,tape.retentionMs,tape.periodMs,[{from:tape.from,to:tape.cut,curve:integral.curve}])};
        }else{
        if(!admit(remaining+old.cells.length*16)){fail();return;}
        const cells=old.cells.slice();let prior=-1;
        for(const [i,cell] of part.value.updates){if(!Number.isInteger(i)||i<=prior||i>=cells.length)return;prior=i;cells[i]=cell;}
        value={...old,availableFrom:part.value.availableFrom,retainedFrom:part.value.retainedFrom,cursor:part.value.cursor,cells};
        }
      }else{
        const days=window.dayEdges,sameDays=range.from>=days[0]&&range.from<days[1]&&range.to>days.at(-2)!&&range.to<=days.at(-1)!;
        if(!sameDays||part.value.edges[0]!==window.edges[0]||part.value.edges.at(-1)!==window.edges.at(-1))window=calendarWindow(part.basis.evaluatedAt,window.zone,this.selection);
        if(part.value.zone!==window.zone||JSON.stringify(part.value.edges)!==JSON.stringify(window.edges)||part.value.cells.length!==window.edges.length-1)return;
        const staging=remaining;
        if(!admit(staging)){fail();return;}
        const lease=this.cache.add(part.basis,part.value,admit,staging);integral=lease?.integral;releaseIntegral=lease?.release;
        if(!current())return;
        if(part.value.workStamp&&!integral){fail();return;}
        // Both numeric roots now belong to the resident reading. The caller still
        // owns the reply envelope and proof until its shared flight finishes.
        window={...window,edges:part.value.edges};
        const {proof:_proof,...accepted}=part.value;value=accepted;
        remaining-=part.value.edges.length*16+part.value.cells.length*160;
        if(integral&&part.value.proof)remaining-=JSON.stringify(part.value.proof).length*3;
      }
      expected={...state,window:{...window,range:part.basis.range},value,integral,basis:part.basis,loading:false,error:null};
      this.state=expected;this.accountedBytes=null;
      releaseReading=this.retain(expected);
      let accepted:boolean;
      try{accepted=admission.handoff(remaining);}
      catch(error){if(current()){this.state=state;this.accountedBytes=null;}throw error;}
      if(!current())return;
      if(!accepted){this.state=state;expected=state;this.accountedBytes=null;releaseReading();releaseReading=undefined;fail();return;}
      this.needed=false;this.publish();
    }finally{releaseReading?.();releaseIntegral?.();release();}
  }
}
