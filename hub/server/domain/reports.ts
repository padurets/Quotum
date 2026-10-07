import {amount,isUnit,type Unit} from './amount.js';
import {utcPeriods} from './meters.js';
import {ordered,type Preparation} from './prepare.js';

export const REPORT_DAY=86_400_000;
export type ReportInterval={from:number;to:number;amount:string;valueObservedAt:number;revision:number};
export type ReportInput=Omit<ReportInterval,'valueObservedAt'|'revision'> & {meterId:string;unit:Unit;observedAt:number};
export type ReportRead={status:'ok'|'partial'|'unavailable';observedAt:number;error:string|null;requestFrom:number;requestTo:number;traversalComplete:boolean;intervals:ReportInput[]};
export type ReportQuality={meterId:string;unit:Unit;roundVersion:number;attemptedAt:number;lastCompleteReadAt:number|null;status:ReportRead['status'];acquiredAt:number|null;requestFrom:number;requestTo:number;traversalComplete:boolean;staleAfterMs:number;confirmation:{from:number;to:number;valueRevision:number;readAt:number}[]};
export type MonthlyLimitRead={status:'ok'|'unavailable';observedAt:number;error:string|null;value:{unit:Unit;amount:string;enforcement:'enforcing'|'inactive'|'unknown'}|null};
export type MonthlyLimit=MonthlyLimitRead & {valueAt:number|null;staleAfterMs:number};
export type ReportSeries={source:string;meter:string;kind:'reported';unit:Unit;intervals:ReportInterval[]};
export type ReportSummary={from:number;to:number;amount:string|null;complete:boolean;confirmed:boolean;provisional:boolean;asOf:number|null;overlapping:ReportInterval[]};
export type ReportHistory={sourceId:string;meterId:string;kind:'reported';unit:Unit;intervals:ReportInterval[]};

export function validateReport(row:ReportInput) {
  if(!/^[A-Za-z0-9:_-]{1,120}$/.test(row.meterId)||!isUnit(row.unit)||!Number.isSafeInteger(row.from)||row.from<0||row.from%REPORT_DAY||row.to!==row.from+REPORT_DAY||!Number.isSafeInteger(row.observedAt)||row.observedAt<0)throw new Error('invalid_report');
  amount(row.amount);
}
/** Numeric evidence stays stable; a newer confirmation cannot confirm an old revision. */
export function reportSummary(rows:readonly ReportInterval[],quality:ReportQuality|undefined,from:number,to:number,now:number,calendar=false):ReportSummary {
  const full:ReportInterval[]=[],overlapping:ReportInterval[]=[];
  const visibleFrom=Math.max(from,now-90*REPORT_DAY);
  const end=calendar?utcPeriods(Math.max(from,to-1)).day+REPORT_DAY:to;
  for(const row of rows) {
    if(row.to<=visibleFrom||row.from>=to)continue;
    if(row.from>=visibleFrom&&row.to<=end)full.push(row);else overlapping.push(row);
  }
  const expected=Math.ceil((end-from)/REPORT_DAY);
  const complete=from%REPORT_DAY===0&&end%REPORT_DAY===0&&full.length===expected&&overlapping.length===0;
  let asOf:number|null=null;
  const confirmed=complete&&full.every(row=>{
    const confirmation=quality?.confirmation.find(c=>c.from<=row.from&&c.to>=row.to&&c.valueRevision===row.revision);
    if(!confirmation||now>confirmation.readAt+(quality?.staleAfterMs??0))return false;
    asOf=asOf===null?confirmation.readAt:Math.min(asOf,confirmation.readAt);return true;
  });
  return {from,to,amount:full.length?full.reduce((sum,r)=>sum+BigInt(r.amount),0n).toString():null,complete,confirmed,provisional:full.some(r=>r.to>now),asOf,overlapping};
}
export function reportCalendar(rows:readonly ReportInterval[],quality:ReportQuality|undefined,now:number) {
  const p=utcPeriods(now);
  return {day:reportSummary(rows,quality,p.day,now,now,true),week:reportSummary(rows,quality,p.week,now,now,true),month:reportSummary(rows,quality,p.month,now,now,true)};
}
export type ReportCalendar={unit:Unit;meterId:string}&ReturnType<typeof reportCalendar>;
export type Allowance={unit:Unit;limit:string;remaining:string|null;overspend:string|null;enforcement:'enforcing'|'inactive'|'unknown';stale:boolean};
export function reportAllowance(calendar:readonly ReportCalendar[],limit:MonthlyLimit|undefined,now:number):Allowance|null {
  if(!limit?.value)return null;
  const month=calendar.find(c=>c.unit===limit.value!.unit)?.month;
  const stale=limit.status!=='ok'||limit.valueAt===null||now>limit.valueAt+limit.staleAfterMs;
  const sameCurrency=calendar.every(c=>c.unit===limit.value!.unit||c.month.amount===null);
  const remaining=!stale&&sameCurrency&&month?.confirmed&&month.amount!==null?(BigInt(limit.value.amount)-BigInt(month.amount)).toString():null;
  return {unit:limit.value.unit,limit:limit.value.amount,remaining,overspend:remaining===null?null:BigInt(remaining)<0n?(-BigInt(remaining)).toString():'0',enforcement:stale?'unknown':limit.value.enforcement,stale};
}
/** Duplicate original days across tiles are one report, with the latest accepted revision. */
export function* composeReportsPrepared(chunks:readonly {reportSeries?:ReportSeries[]}[],from:number,to:number):Preparation<ReportHistory[]> {
  const groups=new Map<string,{series:ReportSeries;rows:Map<number,ReportInterval>}>();
  for(const chunk of chunks)for(const series of chunk.reportSeries??[]) {
    const key=JSON.stringify([series.source,series.meter,series.unit]);
    let group=groups.get(key);if(!group)groups.set(key,group={series,rows:new Map()});
    for(const row of series.intervals) {
      if(row.to>from&&row.from<to&&(!group.rows.has(row.from)||group.rows.get(row.from)!.revision<row.revision))group.rows.set(row.from,row);
      yield;
    }
  }
  const result:ReportHistory[]=[];
  for(const {series,rows} of groups.values())result.push({sourceId:series.source,meterId:series.meter,kind:'reported',unit:series.unit,intervals:yield* ordered(rows.values(),(a,b)=>a.from-b.from)});
  return result;
}
