import type {PeriodBasis} from './period.js';
import type {CalendarBasis,CalendarCell,CalendarSection,CalendarProof} from './workCalendar.js';
import {calendarProjection,calendarCurve} from './calendarWork.js';

type Cell=null|0|[number|null,number|null]|[number|null,number|null,number,number];
type Basis=CalendarBasis|[string,string,string];
type Common={availableFrom:number|null;retainedFrom:number;cursor:string};
type Packed={state:'complete';basis:Basis;value:Common&{zone:string;grid:[number,number,number];cells?:Cell[];proof?:CalendarProof}}|
  {state:'delta';basis:Basis;value:Common&{patch:[number,number|null,number,number,number|null][]}};

const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const nullable=(value:unknown):value is number|null=>value===null||integer(value);
const sameBasis=(a:PeriodBasis,b:PeriodBasis)=>a.run===b.run&&a.revision===b.revision&&a.evaluatedAt===b.evaluatedAt&&a.evidenceCut===b.evidenceCut&&a.range.from===b.range.from&&a.range.to===b.range.to;
const unknownAt=(edge:number,step:number,basis:PeriodBasis)=>Math.max(edge,Math.min(edge+step,basis.range.to,basis.evidenceCut));

/** Uniform edges and common bounds are implicit; credited amounts remain exact. */
export function packCalendar(part:CalendarSection|undefined,basis:PeriodBasis,reserve:(bytes:number)=>void):Packed|undefined {
  if(!part||part.state==='error')return;
  const packedBasis:Basis=sameBasis(part.basis,basis)?[part.basis.calendarKey,part.basis.workAuthority,part.basis.filterKey]:part.basis;
  const {availableFrom,retainedFrom,cursor}=part.value,common={availableFrom,retainedFrom,cursor};
  if(part.state==='delta'){
    reserve(256+part.value.updates.length*112);
    return {state:'delta',basis:packedBasis,value:{...common,patch:part.value.updates.map(([i,c])=>[i,c.agentMs,c.from,c.to,c.validUntil])}};
  }
  const {edges,cells,zone}=part.value,start=edges[0],step=edges[1]-start;
  if(!integer(start)||![60_000,900_000].includes(step)||cells.length>3072||edges.length!==cells.length+1||edges.some((edge,i)=>edge!==start+i*step))throw new Error('invalid_calendar_grid');
  reserve(256);
  if(part.value.proof)return {state:'complete',basis:packedBasis,value:{...common,zone,grid:[start,step,cells.length],proof:part.value.proof}};
  reserve(cells.length*96);
  return {state:'complete',basis:packedBasis,value:{...common,zone,grid:[start,step,cells.length],cells:cells.map((c,i):Cell=>{
    const from=edges[i],to=edges[i+1],point=unknownAt(from,step,part.basis);
    if(c.agentMs===null&&c.from===point&&c.to===point&&c.validUntil===null)return null;
    if(c.from===from&&c.to===to)return c.agentMs===0&&c.validUntil===null?0:[c.agentMs,c.validUntil];
    return [c.agentMs,c.validUntil,c.from,c.to];
  })}};
}

/** Charge restored cells before allocating them; legacy object replies still decode. */
export function expandCalendar(part:unknown,common:PeriodBasis,reserve:(bytes:number)=>void):CalendarSection|undefined {
  if(!part||typeof part!=='object')return part as undefined;
  const packed=part as Packed;
  if(packed.state!=='complete'&&packed.state!=='delta')return part as CalendarSection;
  let basis=packed.basis;
  if(Array.isArray(basis)){
    if(basis.length!==3||basis.some(v=>typeof v!=='string'))throw new Error('invalid_calendar_basis');
    reserve(256);basis={...common,calendarKey:basis[0],workAuthority:basis[1],filterKey:basis[2]};
  }
  const cell=(agentMs:unknown,from:unknown,to:unknown,validUntil:unknown):CalendarCell=>{
    if(!nullable(agentMs)||!integer(from)||!integer(to)||from>to||!nullable(validUntil))throw new Error('invalid_calendar_cell');
    return {agentMs,from,to,validUntil};
  };
  if(packed.state==='complete'&&'grid' in packed.value){
    const {grid,cells,zone,availableFrom,retainedFrom,cursor,proof}=packed.value;
    if(!Array.isArray(grid)||grid.length!==3||!integer(grid[0])||![60_000,900_000].includes(grid[1])||!integer(grid[2])||grid[2]<1||grid[2]>3072||!integer(grid[0]+grid[1]*grid[2])||!proof&&(!Array.isArray(cells)||cells.length!==grid[2]))throw new Error('invalid_calendar_grid');
    reserve(256+grid[2]*112+(grid[2]+1)*16);
    const [start,step,count]=grid,edges=Array.from({length:count+1},(_,i)=>start+i*step);
    if(proof){
      const {curve}=calendarCurve(proof,basis.range,basis.evidenceCut,availableFrom,reserve);
      const restored=calendarProjection(edges,basis.range,basis.evidenceCut,availableFrom,retainedFrom,proof.retentionMs,proof.periodMs,[{from:proof.from,to:proof.cut,curve}]);
      return {state:'complete',basis,value:{zone,availableFrom,retainedFrom,cursor,edges,cells:restored,proof}};
    }
    const restored=cells!.map((c,i)=>{
      const from=edges[i],to=edges[i+1];
      if(c===null){const point=unknownAt(from,step,basis);return cell(null,point,point,null);}
      if(c===0)return cell(0,from,to,null);
      if(!Array.isArray(c)||c.length!==2&&c.length!==4)throw new Error('invalid_calendar_cell');
      return cell(c[0],c.length===4?c[2]:from,c.length===4?c[3]:to,c[1]);
    });
    return {state:'complete',basis,value:{zone,availableFrom,retainedFrom,cursor,edges,cells:restored}};
  }
  if(packed.state==='delta'&&'patch' in packed.value){
    const {patch,availableFrom,retainedFrom,cursor}=packed.value;
    if(!Array.isArray(patch)||patch.length>3072)throw new Error('invalid_calendar_patch');
    reserve(256+patch.length*160);let previous=-1;
    const updates=patch.map((row):[number,CalendarCell]=>{
      if(!Array.isArray(row)||row.length!==5||!integer(row[0])||row[0]<=previous||row[0]>=3072)throw new Error('invalid_calendar_patch');
      previous=row[0];return [row[0],cell(row[1],row[2],row[3],row[4])];
    });
    return {state:'delta',basis,value:{availableFrom,retainedFrom,cursor,updates}};
  }
  return {...part,basis} as CalendarSection;
}
