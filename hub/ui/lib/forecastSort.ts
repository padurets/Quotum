import {LIVE_COLUMNS,RANGE_COLUMNS,outlook,planCell,spentOf,type Context,type ForecastColumn,type Outlook} from './forecast';
import {lineWork,type WorkCell} from './work';
import type {Line} from './lines';
import type {SeriesForecast,Win} from './types';
import type {WeeklyPlan} from './plan';
import {nextTableSort,visibleTableSort} from './table';

export type SortColumn='name'|ForecastColumn;
export type ForecastSort={column:SortColumn;descending:boolean}|null;
export const SORT_COLUMNS:readonly SortColumn[]=['name',...new Set([...LIVE_COLUMNS,...RANGE_COLUMNS])];
export function readForecastSort(value:unknown):ForecastSort {
  if(!value||typeof value!=='object')return null;
  const sort=value as Record<string,unknown>;
  const column = sort.column === 'limit' ? 'name' : sort.column;
  return SORT_COLUMNS.includes(column as SortColumn)&&typeof sort.descending==='boolean'?{column:column as SortColumn,descending:sort.descending}:null;
}
export const nextForecastSort=nextTableSort<SortColumn>;
export const visibleForecastSort=(sort:ForecastSort,columns:readonly ForecastColumn[]):ForecastSort=>visibleTableSort(sort,['name',...columns]);

type Scalar=readonly number[]|null;
export type SortRow={line:Line;live?:Win;validUntil?:number;measuredAt:number|null;ahead:SeriesForecast|null;context:Context;plan:WeeklyPlan|null};
export type SortValue={row:SortRow;current:number|null;spent:number|null;said:Outlook;keys:Partial<Record<ForecastColumn,Scalar>>};
const workKey=(cell:WorkCell|undefined,bound:number|null):Scalar=>!cell||'none' in cell?null:'usedUp' in cell?[0,0]:'value' in cell?[0,cell.value]:[1,'outlasts' in cell?cell.windowMs:bound??Infinity];
const forecastKey=(said:Outlook):Scalar=>said.key==='usedUp'?[0]:said.key==='runsOut'||said.key==='pastZero'?[1,said.at]:said.key==='pace'?[2]:said.key==='left'?[3,said.left]:null;
/** Numeric keys use the same models and exact period line as their cells. */
export function sortValue(row:SortRow,line:Line,now:number,fixed:boolean):SortValue {
  const {live,measuredAt,ahead,context,plan}=row;
  const expired=!fixed&&(live?.resetAt!=null&&live.resetAt<=now||row.validUntil!==undefined&&row.validUntil<=now);
  const current=expired?null:line.current;
  const said=outlook(live,measuredAt,now,ahead,context);
  const spent=line.capCells?null:spentOf(line),spentValue=spent===null||spent.key==='unknown'?null:spent.key==='unused'?0:spent.value;
  const work=line.capCells?null:lineWork(line,fixed,live?.resetAt??null,now);
  const scalar=(value:number|null|undefined):Scalar=>value==null?null:[value];
  return {row,current,spent:spentValue,said,keys:{now:scalar(current),start:scalar(line.remainingAtStart),end:scalar(line.remainingAtEnd),spent:scalar(spentValue),
    plan:line.capCells?null:scalar(planCell(live,measuredAt,now,plan)?.remaining),pace:line.capCells||line.coveredMs<600_000?null:[line.consumed/(line.coveredMs/3_600_000)],
    work:workKey(work?.work,null),agenthours:workKey(work?.agenthours,null),perwork:workKey(work?.perwork,null),during:workKey(work?.during,null),
    workleft:workKey(work?.workleft,fixed?null:live?.resetAt==null?null:live.resetAt-now),forecast:line.capCells?null:forecastKey(said)}};
}
const tuple=(a:readonly number[],b:readonly number[])=>{for(let i=0;i<Math.max(a.length,b.length);i++){const delta=(a[i]??0)-(b[i]??0);if(delta)return delta;}return 0;};
const known=(a:Scalar,b:Scalar,direction=1)=>a===null?b===null?0:1:b===null?-1:direction*tuple(a,b);
export function forecastComparator(sort:ForecastSort,fixed:boolean,locale:string) {
  const collator=new Intl.Collator(locale,{numeric:true,sensitivity:'base'});
  const names=(a:SortValue,b:SortValue)=>collator.compare(a.row.line.name,b.row.line.name)||a.row.line.key.localeCompare(b.row.line.key);
  const importance=(value:SortValue):Scalar=>fixed?value.spent===null?null:[-value.spent]:value.current!==null&&value.current<=0?[0]:value.said.key==='runsOut'||value.said.key==='pastZero'?[1,value.said.at]:value.current===null?null:[2,value.current];
  const defaults=(a:SortValue,b:SortValue)=>known(importance(a),importance(b))||names(a,b);
  return (a:SortValue,b:SortValue)=>{
    if(!sort)return defaults(a,b);
    const direction=sort.descending?-1:1;
    if(sort.column==='name')return direction*collator.compare(a.row.line.name,b.row.line.name)||defaults(a,b);
    const av=a.keys[sort.column]??null,bv=b.keys[sort.column]??null;
    // Bounded hours follow numeric hours in either direction.
    const groups=sort.column==='workleft'&&av&&bv?av[0]-bv[0]:0;
    return groups||known(av,bv,direction)||defaults(a,b);
  };
}
/** Adjacent linear keys can exchange places at equality and one millisecond later. */
export function crossingAt(values:readonly {value:number;slope:number}[],now:number,until:number):number|null {
  let next=until;
  for(let i=1;i<values.length;i++){
    const a=values[i-1],b=values[i],slope=a.slope-b.slope;
    if(!slope)continue;
    const distance=(b.value-a.value)/slope;
    if(distance<0)continue;
    const equality=Math.ceil(now+distance);
    for(const at of [equality,equality+1])if(at>now&&at<next)next=at;
  }
  return Number.isFinite(next)?next:null;
}
