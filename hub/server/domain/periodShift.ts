import type {PeriodRange} from './period.js';

/** Between evidence boundaries only exact durations and clipped timestamps move. */
type Path=(string|number)[];
type Change=[number,unknown]|[number];
type ShiftWindow={start:Fixed;paths:Path[];slopes:[number,number][][];pieces:[number,number,number,Change[]][]};
export type PeriodShift={until:number;steps:[Path,number][];window?:ShiftWindow};
type Fixed={range:PeriodRange;shift?:PeriodShift};

export function shiftLimit(range:PeriodRange,cell:number,cut:number,anchors:Iterable<number>):number {
  let distance=Math.min((Math.floor(range.from/cell)+1)*cell-range.from,(Math.floor(range.to/cell)+1)*cell-range.to,cut-range.to);
  for(const at of anchors)if(Number.isFinite(at))for(const edge of [range.from,range.to])for(const boundary of [at,at+1])if(boundary>edge)distance=Math.min(distance,boundary-edge);
  return Math.max(0,Math.floor(distance));
}

/** The evidence-free interval is established by the reader, never guessed here. */
export function withShift<T extends Fixed>(base:T,read:(offset:number)=>T,distance:number):T {
  if(distance<2)return base;
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
  return range.from-fixed.range.from===offset&&(offset===0||!!fixed.shift&&(fixed.shift.window?fixed.shift.window.pieces.some(([from,to])=>range.to>=from&&range.to<to):offset>0&&range.to<fixed.shift.until));
}

export function shifted<T extends Fixed>(fixed:T,range:PeriodRange):T|null {
  if(!canShift(fixed,range))return null;
  const offset=range.to-fixed.range.to;
  if(offset===0)return fixed;
  if(fixed.shift!.window){
    const {start,paths,slopes,pieces}=fixed.shift!.window,copy={...structuredClone(start),shift:fixed.shift} as T;
    let at=start.range.to,previous:[number,number][]=[];
    for(const [from,to,slope,changes] of pieces){
      advance(copy,paths,previous,from-at);for(const change of changes){const [parent,key]=leaf(copy,paths[change[0]]);if(change.length===1)delete parent[key];else parent[key]=structuredClone(change[1]);}
      previous=slopes[slope];at=from;
      if(range.to<to){advance(copy,paths,previous,range.to-at);return copy;}
    }
    return null;
  }
  const copy=structuredClone(fixed);
  for(const [path,step] of fixed.shift!.steps){let part:Record<string|number,unknown>=copy as unknown as Record<string|number,unknown>;for(const key of path.slice(0,-1))part=part[key] as typeof part;const key=path.at(-1)!;part[key]=(part[key] as number)+offset*step;}
  return copy;
}

function leaf(value:unknown,path:Path):[Record<string|number,unknown>,string|number] {
  let part=value as Record<string|number,unknown>;for(const key of path.slice(0,-1))part=part[key] as typeof part;
  return [part,path.at(-1)!];
}
function advance(value:unknown,paths:Path[],steps:[number,number][],offset:number) {
  if(!offset)return;
  for(const [path,step] of steps){const [parent,key]=leaf(value,paths[path]);parent[key]=(parent[key] as number)+offset*step;}
}

/** Neighboring endpoint cells provide exact event partitions, including grid changes. */
export function shiftBoundaries(range:PeriodRange,from:number,to:number,cells:readonly number[],anchors:Iterable<number>,reserve:(bytes:number)=>void=()=>{}):number[] {
  reserve(256);
  const result=new Set([from,to]);
  const add=(at:number)=>{if(Number.isSafeInteger(at)&&at>from&&at<to&&!result.has(at)){reserve(64);result.add(at);}};
  for(const edge of [range.from,range.to])for(const cell of cells)for(let at=Math.floor((edge+from)/cell)*cell;at<edge+to;at+=cell){add(at-edge);add(at+1-edge);}
  for(const at of anchors)for(const edge of [range.from,range.to]){add(at-edge);add(at+1-edge);}
  return [...result].sort((a,b)=>a-b);
}

/** Sparse changes preserve full values across boundaries; only proven integer slopes interpolate. */
export function withShiftWindow<T extends Fixed>(base:T,read:(offset:number)=>T,boundaries:readonly number[],reserve:(bytes:number)=>void):T&{shift:PeriodShift} {
  const start=read(boundaries[0]);reserve(JSON.stringify(start).length*6+128);
  const window:ShiftWindow={start,paths:[],slopes:[],pieces:[]},paths=new Map<string,number>(),slopes=new Map<string,number>();
  const pathId=(path:Path)=>{const key=JSON.stringify(path),old=paths.get(key);if(old!==undefined)return old;reserve(key.length*6+96);const id=window.paths.length;paths.set(key,id);window.paths.push(path);return id;};
  const changes=(before:unknown,after:unknown,path:Path,output:Change[])=>{
    if(Object.is(before,after))return;
    if(before&&after&&typeof before==='object'&&typeof after==='object'&&Array.isArray(before)===Array.isArray(after)&&(!Array.isArray(before)||before.length===(after as unknown[]).length)){
      const a=before as Record<string,unknown>,b=after as Record<string,unknown>;
      for(const key of new Set([...Object.keys(a),...Object.keys(b)])){
        const next=[...path,Array.isArray(before)?Number(key):key];
        if(b[key]===undefined){if(a[key]!==undefined)output.push([pathId(next)]);}
        else if(a[key]===undefined)output.push([pathId(next),b[key]]);
        else changes(a[key],b[key],next,output);
      }
    }else output.push([pathId(path),after]);
  };
  let previous=start,at=start.range.to,steps:[number,number][]=[];
  for(let i=0;i+1<boundaries.length;i++){
    const offset=boundaries[i],distance=boundaries[i+1]-offset,target=i===0?start:offset===0?base:read(offset);
    const prediction=structuredClone(previous);advance(prediction,window.paths,steps,target.range.to-at);
    const patch:Change[]=[];changes(prediction,target,[],patch);
    const proof=withShift(target,n=>read(offset+n),distance);
    // A one-position piece needs no interpolation. Keeping applicable old slopes
    // predicts the next patch without repeating every moving timestamp and total.
    const next:typeof steps=proof.shift?proof.shift.steps.map(([path,step])=>[pathId(path),step]):steps.filter(([id])=>typeof window.paths[id].reduce<unknown>((part,key)=>part&&typeof part==='object'?(part as Record<string|number,unknown>)[key]:undefined,target)==='number');
    const key=JSON.stringify(next);let slope=slopes.get(key);
    if(slope===undefined){reserve(key.length*6+64);slope=window.slopes.length;slopes.set(key,slope);window.slopes.push(next);}
    reserve(JSON.stringify(patch).length*6+128);
    window.pieces.push([target.range.to,proof.shift?.until??target.range.to+1,slope,patch]);
    previous=target;at=target.range.to;steps=next;
  }
  return {...base,shift:{until:base.range.to,steps:[],window}};
}
