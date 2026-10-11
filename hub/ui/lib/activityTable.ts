import type {ActivityDimension,ActivityGroup} from './types';
import type {WorkedSession} from '../../server/domain/periodWork';

export const ACTIVITY_COLUMNS=['agenthours','active','sessions','concurrency'] as const;
export type ActivityColumn=typeof ACTIVITY_COLUMNS[number];
export type ActivitySort={column:ActivityColumn|'name';descending:boolean}|null;
export const DEFAULT_ACTIVITY_SORT={column:'agenthours',descending:true} as const;
export function readActivitySort(value:unknown):ActivitySort{
  if(!value||typeof value!=='object')return null;
  const {column,descending}=value as Record<string,unknown>;
  return (column==='name'||ACTIVITY_COLUMNS.includes(column as ActivityColumn))&&typeof descending==='boolean'?{column:column as ActivityColumn|'name',descending}:null;
}
export const effectiveActivitySort=(sort:ActivitySort,visible:readonly ActivityColumn[])=>sort&&(sort.column==='name'||visible.includes(sort.column))?sort:DEFAULT_ACTIVITY_SORT;
export function nextActivitySort(sort:ActivitySort,column:ActivityColumn|'name'):ActivitySort{
  return sort?.column!==column?{column,descending:false}:sort.descending?null:{column,descending:true};
}
export const activityKey=(row:Pick<WorkedSession,'project'|'source'|'device'>,by:ActivityDimension)=>by==='project'?JSON.stringify(row.project):by==='source'?row.source??'unknown':row.device.id;
export function sortedActivity(groups:readonly ActivityGroup[],sort:NonNullable<ActivitySort>,name:(group:ActivityGroup)=>string,locale:string,by:ActivityDimension){
  const value=(group:ActivityGroup)=>sort.column==='active'?group.activeMs:sort.column==='sessions'?group.agents:sort.column==='concurrency'?group.activeMs?group.agentMs/group.activeMs:0:group.agentMs;
  const tie=(a:ActivityGroup,b:ActivityGroup)=>name(a).localeCompare(name(b),locale)||a.key.localeCompare(b.key);
  return [...groups].sort((a,b)=>{
    if(sort.column==='name'&&by==='project'&&(a.name===null)!==(b.name===null))return a.name===null?1:-1;
    const difference=sort.column==='name'?name(a).localeCompare(name(b),locale):value(a)-value(b);
    return (sort.descending?-difference:difference)||tie(a,b);
  });
}
