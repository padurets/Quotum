import {amount, isUnit, type Unit} from './amount.js';
import {locatedIn, meterStep, plottedAmount, semanticsOf, type ExceptionalStep, type MeterKind, type MeterSemantics, type MeterSpan, type Reading} from './meters.js';
import {drain, ordered, type Preparation} from './prepare.js';

export const MAX_METERS = 32;
export type MeterSelection = {unit: Unit; displayCurrency?:string;displayRevision?:string;nativeCurrencies?:boolean; ids: [source: string, meter: string][]};
export type Accounting = {spending:'counter'|'unavailable';topups:'counter'|'unavailable'};
export type MonetaryPolicy = {accounting?:Accounting;role?:'total'|'granted'|'toppedUp';pointMode?:'cell'|'observation'};
export type MeterCellExtra = {pointOffsetMs?:number;openOffsetMs?:number;validUntil?:number;first?: string; open?: string | null; segment?: number; semantics?: MeterSemantics; steps?: ExceptionalStep[]; topupInternal?: string; topupSteps?: ExceptionalStep[]};
export type MeterCell = [index: number, value: string, spentInternal: string|null, spentExceptional: string|null, coveredMs: number, extra?: MeterCellExtra];
export type MeterSeriesCells = MonetaryPolicy & {source: string; meter: string; kind: MeterKind; unit: Unit; semantics: MeterSemantics | null; cells: MeterCell[]};
export type MeterHistory = MonetaryPolicy & {sourceId: string; meterId: string; kind: MeterKind; unit: Unit; semantics: MeterSemantics | null; start: string | null; end: string | null; spent: string|null; unlocated: ExceptionalStep[]; topup: string|null; topupUnlocated: ExceptionalStep[]; coveredMs: number; points: {at: number; value: string; spent:string|null;validUntil?:number;segment: number; semantics: MeterSemantics | null; steps: ExceptionalStep[]}[]};
export type MeterGroup = MonetaryPolicy & {source: string; meter: string; readings: Reading[]; spans: MeterSpan[]; retainedFrom?:number; paired?: {readings: Reading[]; spans: MeterSpan[]}};

export function selectionOf(raw: unknown, unit: unknown): MeterSelection {
  if (!Array.isArray(raw) || !isUnit(unit) || raw.length > MAX_METERS) throw new Error('invalid_meter_selection');
  const ids = new Map<string, [string, string]>();
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(v => typeof v !== 'string' || v.length < 1 || v.length > 160) || !/^[A-Za-z0-9:_-]+$/.test(pair[1])) throw new Error('invalid_meter_selection');
    ids.set(JSON.stringify(pair), pair as [string,string]);
  }
  return {unit, ids: [...ids.values()].sort((a,b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))};
}
export const meterIdentity = (s: Pick<MeterSeriesCells, 'source' | 'meter' | 'kind' | 'unit'>) => JSON.stringify([s.source,s.meter,s.kind,s.unit]);
const predecessor = (rows: readonly Reading[], at: number) => {
  for(let i=rows.length-1;i>=0;i--)if(rows[i].at<=at)return rows[i];
  return undefined;
};
const coverage = (spans: readonly MeterSpan[], from: number, to: number) => spans.reduce((sum,s) => sum + Math.max(0,Math.min(to,s.to)-Math.max(from,s.from)),0);
const fresh = (spans: readonly MeterSpan[], at: number) => spans.some(s => s.from <= at && s.to + s.staleAfterMs >= at && (s.interruptedAt===undefined||at<s.interruptedAt));

/** Values are steps, while spending keeps the original observation intervals. */
export function meterCells(group: MeterGroup, unit: Unit, from: number, to: number, cell: number): MeterSeriesCells[] {
  if(group.pointMode==='observation')return observationCells(group,unit,from,to,cell);
  const identities = [...new Set(group.readings.filter(r => r.unit === unit).map(r => r.kind))];
  const output: MeterSeriesCells[] = [];
  for (const kind of identities) {
    const matches = (r: Reading | undefined): r is Reading => !!r && r.kind === kind && r.unit === unit;
    const spans:MeterSpan[]=[];
    let spanIndex=0;
    for(let i=0;i<group.readings.length;i++) {
      const row=group.readings[i],until=group.readings[i+1]?.at??Infinity;
      if(!matches(row))continue;
      while(spanIndex<group.spans.length&&group.spans[spanIndex].to<=row.at)spanIndex++;
      for(let n=spanIndex;n<group.spans.length&&group.spans[n].from<until;n++) {
        const span=group.spans[n],start=Math.max(span.from,row.at),end=Math.min(span.to,until);
        if(end<=start)continue;
        const previous=spans.at(-1);
        if(previous?.to===start)previous.to=end;else spans.push({...span,from:start,to:end});
      }
    }
    const before = predecessor(group.readings, from - 1);
    const initial = matches(before) ? semanticsOf(before) : null;
    const series: MeterSeriesCells = {...policyOf(group),source: group.source,meter: group.meter,kind: group.paired ? 'balance' : kind,unit,semantics: initial,cells: []};
    let semantics = initial;
    let previousValue: string | null = null;
    const spent: ExceptionalStep[] = [], topups: ExceptionalStep[] = [];
    const deltas = (rows: Reading[], spans: MeterSpan[], dest: ExceptionalStep[]) => {
      for (let i=1;i<rows.length;i++) {
        const a=rows[i-1], b=rows[i];
        if (!matches(a) || !matches(b)) continue;
        const step = meterStep(a,b,spans);
        if (step) dest.push(step);
      }
    };
    if(group.accounting?.spending!=='unavailable')deltas(group.readings,group.spans,spent);
    if (group.paired && group.accounting?.topups!=='unavailable') deltas(group.paired.readings,group.paired.spans,topups);
    else if (kind === 'balance' && group.accounting?.topups!=='unavailable') {
      for (let i=1;i<group.readings.length;i++) {
        const a=group.readings[i-1],b=group.readings[i];
        if (!matches(a) || !matches(b)) continue;
        const delta=amount(b.amount)-amount(a.amount);
        if (delta>0n) topups.push({from:b.previousAt??a.at,to:b.at,amount:delta.toString(),evidence:'estimate'});
      }
    }
    const valueOf = (r: Reading, at: number): string | null => {
      if (!group.paired) return plottedAmount(r);
      const credits=predecessor(group.paired.readings,at);
      if (!credits || credits.unit!==unit || !fresh(group.paired.spans,at)) return null;
      return (amount(credits.amount)-amount(r.amount)).toString();
    };
    for (let at=from,index=0;at<to;at+=cell,index++) {
      const end=Math.min(at+cell,to);
      const closing=predecessor(group.readings,end-1);
      let last=matches(closing)?closing:undefined;
      if(!last)for(let i=group.readings.length-1;i>=0;i--){const row=group.readings[i];if(row.at<at)break;if(row.at<end&&matches(row)){last=row;break;}}
      if (!matches(last) || !fresh(group.spans,Math.max(at,last.at)) || kind==='cap' && last.resetAt!==null && last.resetAt<=at) continue;
      const pointAt=Math.max(at,last.at,group.paired ? predecessor(group.paired.readings,end-1)?.at??at : at);
      const value=valueOf(last,pointAt);
      if (value===null) continue;
      const first=predecessor(group.readings,at-1);
      const open=matches(first) && fresh(group.spans,at) ? valueOf(first,at-1) : null;
      const span=group.spans.filter(s=>s.from<=pointAt && s.to+s.staleAfterMs>=pointAt).at(-1);
      const segment=span?.from??last.at;
      const extra: MeterCellExtra = {segment};
      if (open!==previousValue) extra.open=open;
      const nextSemantics=semanticsOf(last);
      if (JSON.stringify(nextSemantics)!==JSON.stringify(semantics)) extra.semantics=nextSemantics;
      semantics=nextSemantics;
      const steps=spent.filter(s=>s.to>=at && s.to<end);
      const known=steps.filter(s=>locatedIn(s,at,end));
      const exceptional=steps.filter(s=>!locatedIn(s,at,end));
      const top=topups.filter(s=>s.to>=at && s.to<end);
      const topKnown=top.filter(s=>locatedIn(s,at,end));
      const topExceptional=top.filter(s=>!locatedIn(s,at,end));
      if (exceptional.length) extra.steps=exceptional;
      if (topKnown.length) extra.topupInternal=sumSteps(topKnown);
      if (topExceptional.length) extra.topupSteps=topExceptional;
      series.cells.push([index,value,group.accounting?.spending==='unavailable'?null:sumSteps(known),group.accounting?.spending==='unavailable'?null:sumSteps(exceptional),coverage(spans,at,end),extra]);
      previousValue=value;
    }
    if (series.cells.length) output.push(series);
  }
  return output;
}
const policyOf=(group:MonetaryPolicy):MonetaryPolicy=>({...group.accounting?{accounting:group.accounting}:{},...group.role?{role:group.role}:{},...group.pointMode?{pointMode:group.pointMode}:{}});
const availableUntil=(span:MeterSpan)=>Math.min(span.interruptedAt??Infinity,span.to+span.staleAfterMs+1);
/** Observation anchors and exclusive deadlines preserve accepted holes on the fixed grid. */
function observationCells(group:MeterGroup,unit:Unit,from:number,to:number,cell:number):MeterSeriesCells[] {
  const series:MeterSeriesCells={...policyOf(group),source:group.source,meter:group.meter,kind:'balance',unit,semantics:null,cells:[]};
  const retainedFrom=group.retainedFrom??from;
  let semantics:MeterSemantics|null=null;
  for(let at=from,index=0;at<to;at+=cell,index++) {
    const end=at+cell;
    const span=group.spans.filter(s=>s.from<end&&availableUntil(s)>at).at(-1);
    if(!span)continue;
    const last=predecessor(group.readings,Math.min(end,availableUntil(span))-1);
    if(!last||last.unit!==unit)continue;
    const pointAt=Math.max(at,span.from,last.at,retainedFrom),validUntil=Math.min(end,availableUntil(span));
    if(pointAt>=validUntil)continue;
    const openAt=Math.max(at,retainedFrom),first=predecessor(group.readings,openAt);
    const open=span.from<=openAt&&first&&first.unit===unit?plottedAmount(first):null;
    const extra:MeterCellExtra={segment:span.from,open,...(open!==null&&openAt>at?{openOffsetMs:openAt-at}:{}),...(pointAt===at?{}:{pointOffsetMs:pointAt-at}),...(validUntil===end?{}:{validUntil})};
    const next=semanticsOf(last);
    if(JSON.stringify(next)!==JSON.stringify(semantics))extra.semantics=next;
    semantics=next;
    series.cells.push([index,plottedAmount(last),null,null,coverage(group.spans,Math.max(at,retainedFrom),end),extra]);
  }
  return series.cells.length?[series]:[];
}
const sumSteps = (steps: readonly ExceptionalStep[]) => steps.reduce((sum,s)=>sum+BigInt(s.amount),0n).toString();

/** Whole cells and exceptional intervals compose identically, regardless of tile partition. */
export function composeMeters(chunks: readonly {from:number;meterSeries?:MeterSeriesCells[]}[], cell:number, from:number,to:number,quantities={from,to}): MeterHistory[] {
  return drain(composeMetersPrepared(chunks,cell,from,to,quantities));
}
/** Drawing can include neighboring cells; quantities belong only to the factual frame. */
export function* composeMetersPrepared(chunks: readonly {from:number;meterSeries?:MeterSeriesCells[]}[], cell:number, from:number,to:number,quantities={from,to}): Preparation<MeterHistory[]> {
  const groups=new Map<string,{series:MeterSeriesCells; cells:Map<number,{row:MeterCell;semantics:MeterSemantics|null}>}>();
  for(const chunk of yield* ordered(chunks,(a,b)=>a.from-b.from)) for(const series of chunk.meterSeries??[]) {
    const key=meterIdentity(series);
    let group=groups.get(key);
    if(!group)groups.set(key,(group={series,cells:new Map()}));
    let semantics=series.semantics;
    for(const row of series.cells) {
      semantics=row[5]?.semantics??semantics;
      const at=chunk.from+row[0]*cell;
      if(at>=from && at<to)group.cells.set(at,{row,semantics});
      yield;
    }
  }
  const result:MeterHistory[]=[];
  for(const {series,cells} of groups.values()) {
    const rows=yield* ordered(cells,(a,b)=>a[0]-b[0]);
    if(!rows.length)continue;
    let spent=0n,topup=0n,coveredMs=0;
    const unlocated:ExceptionalStep[]=[],topupUnlocated:ExceptionalStep[]=[];
    const seen=new Set<string>();
    const classify=function* (steps:ExceptionalStep[],top:boolean):Preparation<void> {
      for(const step of steps) {
        if(step.to<quantities.from||step.to>quantities.to){yield;continue;}
        const key=JSON.stringify([top,step.from,step.to,step.evidence]);
        if(!seen.has(key)) {
          seen.add(key);
          if(locatedIn(step,quantities.from,quantities.to)){if(top)topup+=BigInt(step.amount);else spent+=BigInt(step.amount);}
          else (top?topupUnlocated:unlocated).push(step);
        }
        yield;
      }
    };
    let segment=0,previous=-Infinity,lastLocal=-1;
    const points:MeterHistory['points']=[];
    for(const [at,{row,semantics}] of rows) {
      const extra=row[5]??{};
      const previousSpent=spent;
      if(at>=quantities.from&&at<quantities.to) {
        coveredMs+=row[4];
        if(series.accounting?.spending!=='unavailable') {
          if(row[2]===null)throw new Error('invalid_meter_accounting');
          spent+=BigInt(row[2]);yield* classify(extra.steps??[],false);
        }
        if(series.accounting?.topups!=='unavailable') {topup+=BigInt(extra.topupInternal??'0');yield* classify(extra.topupSteps??[],true);}
      }
      if(at!==previous+cell || (extra.segment??0)!==lastLocal)segment++;
      previous=at;lastLocal=extra.segment??0;
      const observation=series.pointMode==='observation',pointAt=at+(observation?extra.pointOffsetMs??0:0);
      const validUntil=observation?extra.validUntil??at+cell:undefined;
      const openAt=at+(observation?extra.openOffsetMs??0:0);
      if(observation&&pointAt>openAt&&extra.open!=null)points.push({at:openAt,value:extra.open,spent:null,segment,semantics,steps:[],validUntil:pointAt});
      points.push({at:pointAt,...(observation?{validUntil}:{}),value:row[1],spent:series.accounting?.spending==='unavailable'?null:(spent-previousSpent).toString(),segment,semantics,steps:series.accounting?.spending==='unavailable'?[]:extra.steps??[]});yield;
    }
    const first=rows[0][1].row,last=rows.at(-1)![1];
    const start=first[5] && 'open' in first[5] ? (first[5].openOffsetMs??0)>0?null:first[5].open! : first[5]?.first??first[1];
    result.push({...policyOf(series),sourceId:series.source,meterId:series.meter,kind:series.kind,unit:series.unit,semantics:last.semantics,start,end:last.row[1],spent:series.accounting?.spending==='unavailable'?null:spent.toString(),unlocated,topup:series.accounting?.topups==='unavailable'?null:topup.toString(),topupUnlocated,coveredMs,points});yield;
  }
  return result;
}
