import type {CalendarBasis,CalendarDemand,CalendarSection,CalendarValue} from '../../server/domain/workCalendar.js';

const DAY=86_400_000;
export const CALENDAR_RETENTION=90*DAY;
export const calendarZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
const civilFormatter=(zone:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
function civil(at:number,formatter:Intl.DateTimeFormat){const parts=formatter.formatToParts(at);return ['year','month','day'].map(key=>parts.find(p=>p.type===key)!.value).join('-');}
export function calendarWindow(at:number,zone=calendarZone()){
  const formatter=civilFormatter(zone),today=civil(at,formatter),base=Date.parse(today+'T00:00:00Z');
  const dates=Array.from({length:91},(_,i)=>new Date(base+(i-89)*DAY).toISOString().slice(0,10));
  const edges=dates.map(key=>{
    const utc=Date.parse(key+'T00:00:00Z');let lo=utc-2*DAY,hi=utc+2*DAY;
    // The first instant of the civil date also handles a date skipped by a zone change.
    while(lo<hi){const mid=Math.floor((lo+hi)/2);if(civil(mid,formatter)<key)lo=mid+1;else hi=mid;}
    return lo;
  });
  return {zone,dates:dates.slice(0,90),edges};
}
export const calendarLevel=(ms:number)=>ms===0?0:ms<3_600_000?1:ms<4*3_600_000?2:ms<16*3_600_000?3:ms<64*3_600_000?4:5;
export const CALENDAR_OPACITY=[0,.4,.55,.7,.85,1];
export function exactAgentHours(ms:number,locale:string){
  const scale=1_000_000_000n,rounded=(BigInt(ms)*scale+1_800_000n)/3_600_000n;
  const whole=rounded/scale,fraction=(rounded%scale).toString().padStart(9,'0').replace(/0+$/,'');
  const format=new Intl.NumberFormat(locale,{useGrouping:false});
  const separator=format.formatToParts(1.1).find(p=>p.type==='decimal')!.value;
  return format.format(whole)+(fraction?separator+fraction:'');
}
export type CalendarReading={window:ReturnType<typeof calendarWindow>;value:CalendarValue|null;basis:CalendarBasis|null;loading:boolean;error:string|null};

/** A calendar keeps its own frontier when the analytical period changes. */
export class WorkCalendar {
  private context='';
  visible=false;
  private limited=false;
  needed=false;
  generation=0;
  state:CalendarReading={window:calendarWindow(Date.now()),value:null,basis:null,loading:false,error:null};
  private listeners=new Set<()=>void>();
  get=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(){for(const listener of this.listeners)listener();}
  get bytes(){return !this.visible||!this.context?0:512+JSON.stringify(this.state).length*3;}
  clear(){this.context='';this.needed=false;this.generation++;this.state={...this.state,value:null,basis:null,loading:false,error:null};this.publish();}
  configure(visible:boolean,context:string,now:number,limited=false){
    const changed=this.context!==context||this.visible!==visible;
    this.visible=visible;this.limited=limited;
    if(changed){this.clear();this.context=context;this.needed=visible;this.state={...this.state,loading:visible};}
    this.tick(now,true);
    if(visible&&limited){this.needed=false;this.state={...this.state,value:null,basis:null,loading:false,error:'filters_limit'};}
    if(changed)this.publish();return changed;
  }
  tick(now:number,checkZone=false){
    if(!this.visible)return false;
    const zone=checkZone?calendarZone():this.state.window.zone;
    let changed=false;
    if(this.state.basis&&now<this.state.basis.evidenceCut){
      this.generation++;this.state={...this.state,value:null,basis:null,loading:false,error:null};changed=true;
    }
    if(zone!==this.state.window.zone||now<this.state.window.edges[89]||now>=this.state.window.edges[90]){
      const window=calendarWindow(now,zone),old=this.state;
      const sameZone=old.window.zone===zone;
      const cells=window.dates.map((date,i)=>{const prior=sameZone?old.window.dates.indexOf(date):-1;return prior>=0&&old.value?old.value.cells[prior]:{agentMs:null,from:window.edges[i],to:window.edges[i],validUntil:null};});
      this.generation++;
      this.state={window,value:sameZone&&old.value?{...old.value,zone,edges:window.edges,cells,cursor:''}:null,basis:null,loading:old.loading,error:null};changed=true;
    }
    const value=this.state.value;
    if(value?.cells.some(cell=>cell.validUntil!==null&&now>=cell.validUntil&&cell.agentMs!==null)){
      this.state={...this.state,value:{...value,cells:value.cells.map(cell=>cell.validUntil!==null&&now>=cell.validUntil?{...cell,agentMs:null}:cell)}};changed=true;
    }
    const current=this.state.value,floor=now-CALENDAR_RETENTION;
    if(current?.cells.some(cell=>cell.agentMs!==null&&floor>cell.from)){
      this.state={...this.state,value:{...current,cells:current.cells.map(cell=>cell.agentMs!==null&&floor>cell.from?{...cell,from:Math.min(cell.to,floor),...(floor>=cell.to?{agentMs:null}:{})}:cell)}};changed=true;
    }
    if(changed)this.publish();return changed;
  }
  nextAt(now:number){if(!this.visible)return Infinity;return Math.min(this.state.window.edges[90],...(this.state.value?.cells.flatMap((c,i)=>[...(c.agentMs!==null&&c.validUntil!==null&&c.validUntil>now?[c.validUntil]:[]),...(c.agentMs!==null&&c.from===this.state.window.edges[i]&&c.from+CALENDAR_RETENTION+1>now?[c.from+CALENDAR_RETENTION+1]:[])])??[]));}
  dirty(){if(this.visible&&!this.limited){this.needed=true;return true;}return false;}
  demand(facets=false):CalendarDemand|undefined {return this.visible&&(this.needed||facets)?{zone:this.state.window.zone,edges:this.state.window.edges,...(this.state.value?.cursor?{cursor:this.state.value.cursor}:{})}:undefined;}
  receive(part:CalendarSection,generation:number,reserve:(bytes:number)=>boolean){
    if(!this.visible||generation!==this.generation)return;
    if(part.state==='error'){this.needed=false;this.state={...this.state,value:null,basis:null,loading:false,error:part.error};this.publish();return;}
    const previous=this.state.basis,old=this.state.value;
    if(previous&&part.basis.run===previous.run&&(Number(part.basis.revision)<Number(previous.revision)||part.basis.evidenceCut<previous.evidenceCut))return;
    let value:CalendarValue;
    if(part.state==='delta'){
      if(!old||!previous||(['calendarKey','filterKey','workAuthority','run'] as const).some(key=>previous[key]!==part.basis[key]))return;
      if(!reserve(this.bytes+JSON.stringify(part).length*3+90*16)){this.receive({state:'error',error:'history_limit'},generation,()=>true);return;}
      const cells=old.cells.slice();let prior=-1;
      for(const [i,cell] of part.value.updates){if(!Number.isInteger(i)||i<=prior||i>=90)return;prior=i;cells[i]=cell;}
      value={...old,availableFrom:part.value.availableFrom,retainedFrom:part.value.retainedFrom,cursor:part.value.cursor,cells};
    }else{
      if(part.value.zone!==this.state.window.zone||JSON.stringify(part.value.edges)!==JSON.stringify(this.state.window.edges)||part.value.cells.length!==90)return;
      if(!reserve(JSON.stringify(part).length*3)){this.receive({state:'error',error:'history_limit'},generation,()=>true);return;}
      value=part.value;
    }
    this.needed=false;this.state={...this.state,value,basis:part.basis,loading:false,error:null};this.publish();
  }
}
