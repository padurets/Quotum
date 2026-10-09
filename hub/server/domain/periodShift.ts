import type {PeriodRange} from './period.js';

/** Between evidence boundaries only exact durations and clipped timestamps move. */
export type PeriodShift={until:number;steps:[(string|number)[],number][]};
type Fixed={range:PeriodRange;shift?:PeriodShift};

export function shiftLimit(range:PeriodRange,cell:number,cut:number,anchors:Iterable<number>):number {
  let distance=Math.min((Math.floor(range.from/cell)+1)*cell-range.from,(Math.floor(range.to/cell)+1)*cell-range.to,cut-range.to);
  for(const at of anchors)if(Number.isFinite(at))for(const edge of [range.from,range.to])for(const boundary of [at,at+1])if(boundary>edge)distance=Math.min(distance,boundary-edge);
  return Math.max(0,Math.floor(distance));
}

/** The evidence-free interval is established by the reader, never guessed here. */
export function withShift<T extends Fixed>(base:T,read:(offset:number)=>T,distance:number):T {
  if(distance<3)return base;
  const steps:PeriodShift['steps']=[],next=read(1),last=read(distance-1);
  const compare=(a:unknown,b:unknown,c:unknown,path:(string|number)[]):boolean=>{
    if(typeof a==='number'&&typeof b==='number'&&typeof c==='number'){
      const step=b-a;
      if(!Number.isSafeInteger(step)||c!==a+(distance-1)*step)return false;
      if(step)steps.push([path,step]);return true;
    }
    if(a===null||typeof a!=='object')return a===b&&a===c;
    if(!b||typeof b!=='object'||!c||typeof c!=='object'||Array.isArray(a)!==Array.isArray(b)||Array.isArray(a)!==Array.isArray(c))return false;
    const keys=Object.keys(a).filter(k=>(a as Record<string,unknown>)[k]!==undefined);
    if([b,c].some(v=>Object.keys(v).filter(k=>(v as Record<string,unknown>)[k]!==undefined).join('\n')!==keys.join('\n')))return false;
    return keys.every(key=>compare((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],(c as Record<string,unknown>)[key],[...path,Array.isArray(a)?Number(key):key]));
  };
  return compare(base,next,last,[])?{...base,shift:{until:base.range.to+distance,steps}}:base;
}

export function canShift(fixed:Fixed,range:PeriodRange):boolean {
  const offset=range.to-fixed.range.to;
  return range.from-fixed.range.from===offset&&(offset===0||offset>0&&!!fixed.shift&&range.to<fixed.shift.until);
}

export function shifted<T extends Fixed>(fixed:T,range:PeriodRange):T|null {
  if(!canShift(fixed,range))return null;
  const offset=range.to-fixed.range.to;
  if(offset===0)return fixed;
  const copy=structuredClone(fixed);
  for(const [path,step] of fixed.shift!.steps){let part:Record<string|number,unknown>=copy as unknown as Record<string|number,unknown>;for(const key of path.slice(0,-1))part=part[key] as typeof part;const key=path.at(-1)!;part[key]=(part[key] as number)+offset*step;}
  return copy;
}
