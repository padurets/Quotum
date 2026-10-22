import {numberAt,SAMPLE_WIDTH} from '../server/domain/periodTape.js';

type QuotaRow={sourceId:string;windowId:string;count:number;first:number|null;second:number|null;third:number|null;last:number|null};
export type IdleRetention={
  at:number;evaluatedAt:number;identity:string;generation:number;revision:number;proofEpoch:number;scopeKey:string;
  selection:{mode:string;periodMs?:number};settled:boolean;retirementAt:number|null;
  quota:{from:number;cut:number;cursor:string;rows:QuotaRow[]}|null;
};

/** Read existing admitted storage; no listener, retained object reference or coordinator call. */
export function idleRetentionScript(){
  return `pool=>{
    const numberAt=${numberAt.toString()},width=${SAMPLE_WIDTH};
    const members=[...pool.members].filter(member=>member.tapes instanceof Map);
    if(members.length!==1)return null;
    const p=members[0],entry=p.tapes.get('quota'),tape=entry?.tape;
    if(tape&&tape.quota.length>2000)return null;
    const time=(samples,index)=>{
      if(index<0||index>=samples.length/width)return null;
      return 'columns' in samples?numberAt(samples.columns[0],index):samples[index*width];
    };
    return {at:Date.now(),evaluatedAt:p.evaluatedAt,identity:p.identity,generation:p.generation,revision:p.revision,proofEpoch:p.proofEpoch,
      scopeKey:p.scopeKeys.quota,selection:{...p.selection},retirementAt:Number.isFinite(p.retirementAt)?p.retirementAt:null,
      settled:p.active&&!p.retiring&&!p.retirementPreparing&&!p.workNeeded&&!p.get().loading&&!p.get().error&&!p.projectionErrors.quota&&!p.dirtyScopes.size&&!p.transport.flights.size&&!p.transport.queue.length,
      quota:tape?{from:tape.from,cut:tape.cut,cursor:tape.cursor,rows:tape.quota.map(row=>{
        const count=row.samples.length/width;
        return {sourceId:row.source,windowId:row.window,count,first:time(row.samples,0),second:time(row.samples,1),third:time(row.samples,2),last:time(row.samples,count-1)};
      })}:null};
  }`;
}

/** A calendar boundary alone cannot prove that quota storage actually retired. */
export function idleRetentionProblems(before:IdleRetention|null,after:IdleRetention|null,from:number,to:number,expected:number):string[]{
  if(!before?.quota||!after?.quota)return ['idle quota retention storage unavailable'];
  const problems:string[]=[],period=before.selection.periodMs??NaN;
  if(![from,to,expected,...[before,after].flatMap(s=>[s.at,s.evaluatedAt,s.generation,s.revision,s.proofEpoch,s.quota!.from,s.quota!.cut])].every(Number.isFinite)||!(from<to)||[before,after].some(s=>!s.identity||!s.scopeKey||!s.quota!.cursor))return ['idle quota retention basis unavailable'];
  if(!before.settled||!after.settled)problems.push('idle quota retention did not settle');
  if(before.selection.mode!=='live'||!Number.isFinite(period)||period<=0||JSON.stringify(before.selection)!==JSON.stringify(after.selection))problems.push('idle quota retention selection changed');
  if(['identity','generation','revision','proofEpoch','scopeKey'].some(key=>before[key as keyof IdleRetention]!==after[key as keyof IdleRetention])||before.quota.cursor!==after.quota.cursor||before.quota.cut!==after.quota.cut)problems.push('idle quota retention evidence changed');
  const key=(row:QuotaRow)=>JSON.stringify([row.sourceId,row.windowId]),rows=new Map(after.quota.rows.map(row=>[key(row),row]));
  if(rows.size!==after.quota.rows.length||new Set(before.quota.rows.map(key)).size!==before.quota.rows.length||before.quota.rows.length!==rows.size||before.quota.rows.some(row=>!rows.has(key(row))))problems.push('idle quota retention cohort changed');
  const valid=(row:QuotaRow)=>typeof row.sourceId==='string'&&typeof row.windowId==='string'&&Number.isInteger(row.count)&&row.count>=0&&[row.first,row.second,row.third,row.last].every((at,i)=>at===null?(i<3?row.count<=i:row.count===0):Number.isFinite(at))&&(!row.count||(row.first!)<=(row.last!));
  if(!before.quota.rows.every(valid)||!after.quota.rows.every(valid))return [...problems,'idle quota retention samples unavailable'];
  if(before.quota.rows.some(row=>row.second!==null&&row.second+1+period<=from))problems.push('idle quota retention starts with an overdue prefix');
  const due=before.quota.rows.filter(row=>row.second!==null&&from<row.second+1+period&&row.second+1+period<to);
  if(!due.length||!due.some(row=>row.second!+1+period===expected))problems.push('idle quota retention has no admitted regular boundary');
  if(due.length&&(before.retirementAt===null||before.retirementAt>Math.min(...due.map(row=>row.second!+1+period))))problems.push('idle quota retention deadline misses admitted samples');
  for(const row of due){
    // The following observation must not retire another predecessor in this window.
    if(row.second!+1<=Math.max(before.quota.from,before.evaluatedAt-period)||row.third!==null&&row.third+1+period<=to){problems.push('idle quota retention boundary is ambiguous');continue;}
    const next=rows.get(key(row));
    if(!next||next.count!==row.count-1||next.first!==row.second||next.last!==row.last)problems.push(`idle quota prefix did not retire: ${row.sourceId} ${row.windowId}`);
  }
  return problems;
}
