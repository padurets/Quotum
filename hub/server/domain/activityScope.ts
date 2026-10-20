import {canonicalRefs,filterRefKey,type FamilyRef,type FundingRef,type Selection,type WorkFilter} from './dataFilters.js';
import type {Dimension} from './work.js';
import {sourceKey} from './workAccess.js';
import type {Preparation} from './prepare.js';
import type {WorkTrace} from './periodWork.js';

/** A legend excludes groups within the board predicate; it never selects a page of groups. */
export function activityScope(filters:WorkFilter,by:Dimension,muted:readonly string[]):WorkFilter {
  const exclude=<T extends FamilyRef>(selection:Selection<T>,values:T[]):Selection<T>=>{
    const removed=new Set(values.map(filterRefKey));
    return {mode:selection.mode,values:canonicalRefs(selection.mode==='include'?selection.values.filter(ref=>!removed.has(filterRefKey(ref))):[...selection.values,...values])};
  };
  if(by==='source')return {...filters,sources:exclude(filters.sources,muted.map((key):FundingRef=>key==='unknown'||key==='notProvided'?{status:key}:{source:key}))};
  if(by==='project')return {...filters,projects:exclude(filters.projects,muted.map(key=>JSON.parse(key) as string|null))};
  return {...filters,devices:exclude(filters.devices,[...muted])};
}

export const activityGroupKey=(ref:WorkTrace['refs'][number],by:Dimension)=>by==='source'?sourceKey(ref):by==='project'?JSON.stringify(ref.project):ref.device.id;

/** Keep immutable reference and pattern objects; only the selected block index is owned. */
export function* selectActivityWork(trace:WorkTrace,by:Dimension,muted:ReadonlySet<string>):Preparation<WorkTrace> {
  if(trace.fixed)throw new Error('fixed_activity_requires_exact_read');
  const refs:WorkTrace['refs']=[],ids=new Map<number,number>();
  for(let i=0;i<trace.refs.length;i++){const ref=trace.refs[i];if(!muted.has(activityGroupKey(ref,by))){ids.set(i,refs.length);refs.push(ref);}yield;}
  const spans:WorkTrace['spans']=[];
  for(const [id,a,b] of trace.spans){const next=ids.get(id);if(next!==undefined)spans.push([next,a,b]);yield;}
  let packed:WorkTrace['packed'];
  if(trace.packed){const blocks:number[]=[];for(let i=0;i<trace.packed.blocks.length;i+=3){const id=ids.get(trace.packed.blocks[i]);if(id!==undefined)blocks.push(id,trace.packed.blocks[i+1],trace.packed.blocks[i+2]);yield;}packed={patterns:trace.packed.patterns,blocks};}
  return {...trace,refs,spans,...(packed?{packed}:{})};
}
