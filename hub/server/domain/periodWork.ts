import {drain,ordered,type Preparation} from './prepare.js';
import type {Origin} from './ingest.js';
import type {PeriodRange} from './period.js';

export type WorkRef = {
  ref:string;source:string|null;sourceStatus?:'notProvided';clientId?:string;device:{id:string;name:string};origin:Origin;
  project:string|null;folder:string|null;startedAt:number;
  presenceKey?:string;
  currentPresence?:{working:boolean;through:number;workingThrough?:number;startedAt:number};
};
/** Offsets are exact milliseconds, with one shared origin and no repeated context metadata. */
export const WORK_BLOCK_MS=3_600_000;
export type WorkBlocks={patterns:number[][];blocks:number[]};
export type WorkTrace = {anchor:number;cut?:number;knownFrom:number;available?:false;refs:WorkRef[];spans:[number,number,number][];packed?:WorkBlocks;fixed?:{range:PeriodRange;shift?:import('./periodShift.js').PeriodShift;totals:[number,number,number][];activity:import('./history.js').History['activity']}};
export type WorkDelta = WorkTrace & {replaceFrom:number;replaceTo?:number};
export type WorkedSession = WorkRef & {workedMs:number;lastWorkedAt:number;working:boolean};

export function workedSessions(trace:WorkTrace, range:PeriodRange, now:number):WorkedSession[] {
  if(trace.fixed){
    if(range.from!==trace.fixed.range.from||range.to!==trace.fixed.range.to)throw new Error('history_range_invalid');
    return trace.fixed.totals.map(([id,workedMs,lastWorkedAt])=>{const {currentPresence:previous,...ref}=trace.refs[id],currentPresence=previous&&previous.through>now?previous:undefined,working=!!currentPresence&&currentPresence.working&&Math.min(currentPresence.through,currentPresence.workingThrough??Infinity)>now;return {...ref,workedMs,lastWorkedAt,working,...(currentPresence?{currentPresence}:{})};});
  }
  const sums=new Map<number,{workedMs:number;lastWorkedAt:number}>();
  for(const [index,start,end] of workSpans(trace)) {
    const from=Math.max(range.from,trace.anchor+start),to=Math.min(range.to,trace.anchor+end);
    if(to<=from)continue;
    const previous=sums.get(index);
    sums.set(index,{workedMs:(previous?.workedMs??0)+to-from,lastWorkedAt:Math.max(previous?.lastWorkedAt??0,to)});
  }
  return [...sums].map(([index,worked])=>{
    const ref=trace.refs[index],presence=ref.currentPresence;
    return {...ref,...worked,working:!!presence&&Math.min(presence.through,presence.workingThrough??Infinity)>now&&presence.working};
  });
}

/** Hour blocks share exact interval patterns, including every gap and millisecond. */
export function* workSpans(trace:WorkTrace):Generator<[number,number,number]> {
  yield* trace.spans;
  if(trace.packed){const {blocks,patterns}=trace.packed;for(let i=0;i<blocks.length;i+=3){const at=blocks[i+1]*WORK_BLOCK_MS-trace.anchor,pattern=patterns[blocks[i+2]];for(let j=0;j<pattern.length;j+=2)yield [blocks[i],at+pattern[j],at+pattern[j+1]];}}
}

function expandedBlocks(trace:WorkTrace) {
  let blocks=0,ref=-1,hour=-1;
  for(const [id,a,b] of trace.spans)if(b>a){
    const first=Math.floor((trace.anchor+a)/WORK_BLOCK_MS),last=Math.ceil((trace.anchor+b)/WORK_BLOCK_MS)-1;
    blocks+=last-first+1-Number(ref===id&&hour===first);ref=id;hour=last;
  }
  return blocks;
}

/** Admit the exact output block array before expanding hours; patterns are charged as they appear. */
export function workPackingBytes(trace:WorkTrace) {
  if(trace.packed)return 0;
  return 512+expandedBlocks(trace)*48;
}

/** Curves, context/group indexes and their scratch share the same request budget. */
export function workPreparationBytes(trace:WorkTrace) {
  return trace.refs.length*512+(trace.packed
    ?trace.packed.blocks.length*64+trace.packed.patterns.reduce((n,p)=>n+p.length*128,0)
    :workPackingBytes(trace)+expandedBlocks(trace)*192+trace.spans.length*640);
}

export const packWork=(trace:WorkTrace,reserve?:(bytes:number)=>void,release?:(bytes:number)=>void)=>drain(packWorkPrepared(trace,reserve,release));
export function* packWorkPrepared(trace:WorkTrace,reserve?:(bytes:number)=>void,release?:(bytes:number)=>void):Preparation<WorkTrace> {
  if(trace.packed)return trace;
  let reserved=0,complete=false;
  const charge=(bytes:number)=>{reserve?.(bytes);reserved+=bytes;};
  const drop=(bytes:number)=>{if(reserve&&release){release(bytes);reserved-=bytes;}};
  const count=expandedBlocks(trace);
  charge(512+count*48);
  try {
    const patterns:number[][]=[],blocks=new Array<number>(count*3),ids=new Map<string,number>();
    charge(64);let ref=-1,hour=-1,offset=0,pattern:number[]=[],patternBytes=64;
    const flush=()=>{
      if(!pattern.length)return;
      // Decimal keys and growing numeric arrays are temporary. Repeated hour
      // patterns keep only their shared dictionary entry and output references.
      const keyBytes=64+pattern.length*64;charge(keyBytes);
      let key=pattern.join(',');const id=ids.get(key)??patterns.length,duplicate=id<patterns.length;
      if(!duplicate){
        charge(128);patterns.push(pattern);ids.set(key,id);
        drop(keyBytes-(64+key.length*2));
        drop(patternBytes-(64+pattern.length*16));
      }
      blocks[offset++]=ref;blocks[offset++]=hour;blocks[offset++]=id;
      charge(64);pattern=[];
      if(duplicate){key='';drop(keyBytes+patternBytes);}
      patternBytes=64;
    };
    for(const [id,a,b] of trace.spans){let from=trace.anchor+a;const end=trace.anchor+b;while(from<end){const h=Math.floor(from/WORK_BLOCK_MS),at=h*WORK_BLOCK_MS,to=Math.min(end,at+WORK_BLOCK_MS);if(ref!==id||hour!==h){flush();ref=id;hour=h;}const start=from-at;if(pattern.length&&pattern.at(-1)!>=start)pattern[pattern.length-1]=Math.max(pattern.at(-1)!,to-at);else {charge(64);patternBytes+=64;pattern.push(start,to-at);}from=to;yield;}}
    flush();ids.clear();
    if(reserve&&release){const retained=256+blocks.length*16+patterns.reduce((n,p)=>n+96+p.length*16,0);drop(reserved-retained);}
    complete=true;return {...trace,spans:[],packed:{patterns,blocks}};
  }finally{if(!complete&&reserved)release?.(reserved);}
}

/** Replacement, never addition: a retry or an extended interval cannot count work twice. */
export const mergeWork=(trace:WorkTrace,delta:WorkDelta)=>drain(mergeWorkPrepared(trace,delta));
export function* mergeWorkPrepared(trace:WorkTrace, delta:WorkDelta):Preparation<WorkTrace> {
  const refs=[...trace.refs],indices=new Map(refs.map((ref,i)=>[ref.ref,i]));
  const mapped:number[]=[];
  for(const ref of delta.refs){let index=indices.get(ref.ref);if(index===undefined){index=refs.length;refs.push(ref);indices.set(ref.ref,index);}else refs[index]=ref;mapped.push(index);yield;}
  const anchor=Math.min(trace.anchor,delta.anchor),stop=delta.replaceTo??Infinity;
  if(trace.packed||delta.packed){
    const before=(yield* packWorkPrepared(trace)).packed!,after=(yield* packWorkPrepared(delta)).packed!;
    const rows=new Map<number,{before:number[];after:number[]}>();
    for(const [packed,old] of [[before,true],[after,false]] as const)for(let i=0;i<packed.blocks.length;i+=3){const id=old?packed.blocks[i]:mapped[packed.blocks[i]];let own=rows.get(id);if(!own)rows.set(id,own={before:[],after:[]});own[old?'before':'after'].push(i);yield;}
    const patterns:number[][]=[],blocks:number[]=[],retained:WorkRef[]=[],dictionary=new Map<string,number>();
    for(const [id,own] of rows){let ref=-1,a=0,b=0;while(a<own.before.length||b<own.after.length){
      const hour=Math.min(a<own.before.length?before.blocks[own.before[a]+1]:Infinity,b<own.after.length?after.blocks[own.after[b]+1]:Infinity),at=hour*WORK_BLOCK_MS,pairs:[number,number][]=[];
      const add=(a:number,b:number)=>{if(b>a)pairs.push([a-at,b-at]);};
      for(const [packed,indices,old] of [[before,own.before,true],[after,own.after,false]] as const){const i=indices[old?a:b];if(i===undefined||packed.blocks[i+1]!==hour)continue;const pattern=packed.patterns[packed.blocks[i+2]];
        for(let j=0;j<pattern.length;j+=2){const from=Math.max(delta.knownFrom,at+pattern[j]),to=at+pattern[j+1];if(old){add(from,Math.min(to,delta.replaceFrom));add(Math.max(from,stop),to);}else add(from,to);yield;}if(old)a++;else b++;
      }
      if(!pairs.length)continue;
      const pattern:number[]=[];for(const [a,b] of yield*ordered(pairs,(a,b)=>a[0]-b[0])){if(pattern.length&&pattern.at(-1)!>=a)pattern[pattern.length-1]=Math.max(pattern.at(-1)!,b);else pattern.push(a,b);yield;}
      const key=pattern.join(','),pid=dictionary.get(key)??patterns.length;if(pid===patterns.length){dictionary.set(key,pid);patterns.push(pattern);}if(ref<0){ref=retained.length;retained.push(refs[id]);}blocks.push(ref,hour,pid);yield;
    }}
    return {anchor,...(delta.cut!==undefined?{cut:delta.cut}:{}),knownFrom:delta.knownFrom,...(delta.available===false?{available:false as const}:{}),refs:retained,spans:[],packed:{patterns,blocks}};
  }
  const spans:WorkTrace['spans']=[];
  for(const [id,a,b] of trace.spans){const from=Math.max(delta.knownFrom,a+trace.anchor),to=b+trace.anchor;if(to<=from){yield;continue;}
    if(from<delta.replaceFrom)spans.push([id,from-anchor,Math.min(to,delta.replaceFrom)-anchor]);
    if(to>stop)spans.push([id,Math.max(from,stop)-anchor,to-anchor]);yield;
  }
  for(const [id,a,b] of delta.spans){const from=Math.max(delta.knownFrom,a+delta.anchor),to=b+delta.anchor;if(to>from)spans.push([mapped[id],from-anchor,to-anchor]);yield;}
  const sorted=yield* ordered(spans,(a,b)=>a[0]-b[0]||a[1]-b[1]);
  const compact:WorkTrace['spans']=[];
  for(const row of sorted){const last=compact.at(-1);if(last&&last[0]===row[0]&&last[2]>=row[1])last[2]=Math.max(last[2],row[2]);else compact.push(row);yield;}
  const retained:WorkRef[]=[],remap=new Map<number,number>();
  for(const row of compact){let id=remap.get(row[0]);if(id===undefined){id=retained.length;retained.push(refs[row[0]]);remap.set(row[0],id);}row[0]=id;yield;}
  return {anchor,...(delta.cut!==undefined?{cut:delta.cut}:{}),knownFrom:delta.knownFrom,...(delta.available===false?{available:false as const}:{}),refs:retained,spans:compact};
}
