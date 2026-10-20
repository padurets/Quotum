import type {PeriodBasis,PeriodRange} from './period.js';
import type {Stretch} from './work.js';
import type {Preparation} from './prepare.js';

export const CALENDAR_DAYS=90;
const DAY=86_400_000;
export type CalendarDemand={zone:string;edges:number[];cursor?:string};
export type CalendarCell={agentMs:number|null;from:number;to:number;validUntil:number|null};
export type CalendarBasis=PeriodBasis&{calendarKey:string;workAuthority:string;filterKey:string};
export type CalendarValue={zone:string;edges:number[];availableFrom:number|null;retainedFrom:number;cursor:string;cells:CalendarCell[]};
export type CalendarDelta=Pick<CalendarValue,'availableFrom'|'retainedFrom'|'cursor'>&{updates:[number,CalendarCell][]};
export type CalendarSection={state:'complete';basis:CalendarBasis;value:CalendarValue}|{state:'delta';basis:CalendarBasis;value:CalendarDelta}|{state:'error';error:'history_limit'|'history_range_invalid'|'unavailable'};

export function parseCalendar(value:unknown):CalendarDemand|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['zone','edges','cursor'].includes(k))||typeof v.zone!=='string'||!v.zone.length||v.zone.length>128||!/^[\x20-\x7e]+$/.test(v.zone)||v.cursor!==undefined&&(typeof v.cursor!=='string'||v.cursor.length>2048))return null;
  try{new Intl.DateTimeFormat('en',{timeZone:v.zone});}catch{return null;}
  if(!Array.isArray(v.edges)||v.edges.length!==91||v.edges.some((n,i,a)=>!Number.isSafeInteger(n)||n<0||i>0&&(n<a[i-1]||n-a[i-1]>2*DAY))||v.edges[90]<=v.edges[0]||v.edges[90]-v.edges[0]>92*DAY)return null;
  return {zone:v.zone,edges:v.edges,...(v.cursor?{cursor:v.cursor as string}:{})};
}

export function normalizeRanges(ranges:readonly PeriodRange[]):PeriodRange[] {
  const result:PeriodRange[]=[];
  for(const part of ranges.filter(p=>p.from<p.to).slice().sort((a,b)=>a.from-b.from)){
    const last=result.at(-1);
    if(last&&part.from<=last.to)last.to=Math.max(last.to,part.to);else result.push({...part});
  }
  return result;
}

/** Sum credited durations, preserving parallel producers and exact local-day edges. */
export function* calendarCells(rows:Iterable<Stretch>,edges:readonly number[],indices:readonly number[],cut:number,availableFrom:number|null,retainedFrom:number,retentionMs:number):Preparation<[number,CalendarCell][]> {
  const cells=new Map<number,CalendarCell>();
  for(const i of indices){
    const from=Math.max(edges[i],retainedFrom,availableFrom??cut),to=Math.min(edges[i+1],cut);
    const end=Math.max(edges[i],Math.min(edges[i+1],cut));
    cells.set(i,availableFrom===null||from>=to?{agentMs:null,from:end,to:end,validUntil:null}:{agentMs:0,from,to,validUntil:null});
  }
  for(const row of rows){
    // Binary search avoids inspecting ninety cells for each retained stretch.
    let lo=0,hi=90;while(lo<hi){const mid=(lo+hi)>>>1;if(edges[mid+1]<=row.from)lo=mid+1;else hi=mid;}
    for(let i=lo;i<90&&edges[i]<row.to;i++){
      const cell=cells.get(i);if(!cell||cell.agentMs===null)continue;
      const start=Math.max(row.from,cell.from),end=Math.min(row.to,cell.to);
      if(end<=start)continue;
      const total=cell.agentMs+end-start;if(!Number.isSafeInteger(total))throw new RangeError('calendar_overflow');cell.agentMs=total;
      cell.validUntil=Math.min(cell.validUntil??Infinity,start+retentionMs+1);
    }
    yield;
  }
  return [...cells];
}
