import {providerOf,quotaMeter} from '../../server/domain/providers';
const quotaIds=(provider:string)=>{const descriptor=providerOf(provider);return descriptor&&'quotaMeters' in descriptor?descriptor.quotaMeters:[];};
import {MAX_METERS,selectionOf,composeMetersPrepared,type MeterHistory,type MeterSelection} from '../../server/domain/meterHistory';
import type {Card,History,Kind,View,Win} from './types';
import type {CapCell,Line,PlotLine} from './lines';
import {linesPrepared} from './lines';
import type {PlotBuffer} from './historyPlot';
import {hasSubscriptionCaps} from './providers';
import {capPercent} from './money';
import {seriesName} from './quota';
import {colorOf} from './view';
import {effectiveFilters} from './filterSelection';
import {matchesSource,matchesSelection} from '../../server/domain/dataFilters';
import {windowKey} from './types';
import {drain,type Preparation} from './prepare';
import {ordered} from '../../server/domain/prepare';

/** Subscription periods are independent of the provider's stored measurement unit. */
export function quotaPeriods(source:Pick<Card,'provider'|'windows'>,historical?:readonly Win[]):Pick<Win,'id'|'kind'|'label'|'minutes'>[] {
  // Logical choices outlive a missing observation; historical-only windows remain selectable.
  const windows=historical?[...new Map([...source.windows,...historical].map(({id,kind,label,minutes})=>[id,{id,kind,label,minutes}])).values()]:source.windows;
  if(!hasSubscriptionCaps(source.provider))return windows;
  return [...windows,...quotaIds(source.provider).map((id,i)=>({id,kind:i===0?'session':'weekly',label:null,minutes:i===0?300:10080} as Pick<Win,'id'|'kind'|'label'|'minutes'>))];
}

/** Keep both period families; stable IDs break equal-specificity ties across replies. */
export function primaryQuotaPeriods<T extends Pick<Win,'id'|'kind'|'label'|'minutes'>>(periods:readonly T[]):T[] {
  const rank=(period:T)=>period.label===null&&period.kind==='session'&&period.minutes===300?0:period.label===null&&period.kind==='weekly'?1:period.kind==='session'?2:period.kind==='weekly'?3:4;
  const ordered=[...periods].sort((a,b)=>rank(a)-rank(b)||(a.minutes??Infinity)-(b.minutes??Infinity)||(a.id<b.id?1:a.id>b.id?-1:0));
  const pair=['session','weekly'].flatMap(kind=>{const period=ordered.find(period=>period.kind===kind);return period?[period]:[];});
  return [...pair,...ordered.filter(period=>!pair.includes(period))].slice(0,2);
}

export function quotaRemaining(source:Card,id:string):number|null {
  const native=source.windows.find(w=>w.id===id);if(native)return native.remaining;
  if(!hasSubscriptionCaps(source.provider))return null;
  const meter=source.meters?.find(m=>m.id===id),used=meter?capPercent(meter):null;
  return used===null?null:100-used;
}

/** Both periods travel with ordinary subscription history, not a separate analytics mode. */
export function subscriptionSelection(cards:readonly Card[],view:Pick<View,'hidden'|'windows'>):MeterSelection|undefined {
  const filters=effectiveFilters(),sources=filters&&!(filters.sources.mode==='exclude'&&!filters.sources.values.length)?cards.filter(card=>matchesSource(filters,card.id)).map(card=>card.id):undefined;
  const shown=cards.filter(c=>hasSubscriptionCaps(c.provider)&&(!filters||matchesSource(filters,c.id)));
  if(!shown.length)return sources?{unit:'USD',ids:[],sources}:undefined;
  const unit=shown.flatMap(c=>(c.meters??[]).filter(m=>quotaMeter(providerOf(c.provider),m.id))).find(m=>m.kind==='cap')?.unit??'credits:zai';
  const ids=subscriptionIds(shown,view);
  if(!ids.length)return sources?{unit,ids:[],sources}:undefined;
  return {...selectionOf(ids.slice(0,MAX_METERS),unit),...(sources?{sources}:{})};
}
const subscriptionIds=(cards:readonly Card[],view:Pick<View,'hidden'|'windows'>)=>{const filters=effectiveFilters();return cards.filter(c=>hasSubscriptionCaps(c.provider)&&(!filters||matchesSource(filters,c.id))).flatMap(c=>quotaIds(c.provider).filter(id=>filters?matchesSelection(filters.windows,[c.id,id]):!view.windows.includes(windowKey(c.id,id))).map(id=>[c.id,id] as [string,string]));};
export const subscriptionOverflow=(cards:readonly Card[],view:Pick<View,'hidden'|'windows'>)=>Math.max(0,subscriptionIds(cards,view).length-MAX_METERS);

const leftPercent=(left:string,limit:string|null|undefined):number|null=>{
  if(limit==null||BigInt(limit)<=0n)return null;
  const used=(BigInt(limit)-BigInt(left))*10_000n/BigInt(limit);
  return 100-Number(used<0n?0n:used>10_000n?10_000n:used)/100;
};

/** Exact cap cells become percentage lines while preserving their exclusive validity bounds. */
export function* capLinesPrepared(series:readonly MeterHistory[],sources:readonly (Card&{title?:string})[],view:View,kind:Kind,from:number,to:number,exact=false,live=true):Preparation<Line[]> {
  const result:Line[]=[];
  for(const entry of series) {
    yield;
    const source=sources.find(c=>c.id===entry.sourceId);
    const period=source&&quotaPeriods(source).find(q=>q.id===entry.meterId&&q.kind===kind);
    const filters=effectiveFilters();
    if(entry.kind!=='cap'||!source||!hasSubscriptionCaps(source.provider)||!period||(filters?!matchesSource(filters,source.id)||!matchesSelection(filters.windows,[source.id,period.id]):view.windows.includes(windowKey(source.id,period.id))))continue;
    const points:Line['points']=[],capCells:CapCell[]=[];
    for(const point of entry.points) {
      const value=leftPercent(point.value,point.semantics?.limit);
      if(value!==null&&point.knownFrom!==undefined&&point.knownUntil!==undefined&&point.knownFrom<point.knownUntil) {
        points.push([point.at,value,point.segment]);
        capCells.push({at:point.at,from:point.knownFrom,to:point.knownUntil,value});
      }
      yield;
    }
    if(!points.length)continue;
    const current=source.meters?.find(m=>m.id===period.id);
    const edge=(at:number)=>capCells.find(p=>at>=p.from&&at<p.to)?.value??null;
    result.push({sourceId:source.id,windowId:period.id,kind:period.kind,label:period.label,minutes:period.minutes,key:windowKey(source.id,period.id),provider:source.provider,name:seriesName(source,period),color:colorOf(view,source.id,source.provider),dash:'',
      current:live?quotaRemaining(source,period.id):exact?(entry.end===null?null:leftPercent(entry.end,entry.semantics?.limit)):edge(to-1),consumed:0,coveredMs:0,remainingAtStart:edge(from),remainingAtEnd:exact?(entry.end===null?null:leftPercent(entry.end,entry.semantics?.limit)):edge(to-1),staleAfterMs:current?.staleAfterMs??0,points,capCells,work:null});
  }
  return result;
}

export function* subscriptionLinesPrepared(history:History|null,sources:(Card&{title?:string})[],view:View,kind:Kind):Preparation<Line[]> {
  const native=yield* linesPrepared(history,sources,view,kind);
  if(!history)return native;
  const caps=yield* capLinesPrepared(history.meterSeries??[],sources,view,kind,history.since,history.to,history.exact,history.live);
  if(!caps.length)return native;
  return yield* ordered([...native,...caps],(a,b)=>sources.findIndex(s=>s.id===a.sourceId)-sources.findIndex(s=>s.id===b.sourceId));
}
export const subscriptionLinesOf=(...args:Parameters<typeof subscriptionLinesPrepared>)=>drain(subscriptionLinesPrepared(...args));

export function* subscriptionPlotLinesPrepared(strip:PlotBuffer,sources:(Card&{title?:string})[],view:View,kind:Kind):Preparation<PlotLine[]> {
  const native=yield* linesPrepared(strip,sources,view,kind);
  if(!strip.meterChunks)return native;
  const caps=yield* composeMetersPrepared(strip.meterChunks,strip.cell,strip.from,strip.to,strip.meterFrame);
  const projected=yield* capLinesPrepared(caps,sources,view,kind,strip.from,strip.to);
  if(!projected.length)return native;
  return yield* ordered([...native,...projected],(a,b)=>sources.findIndex(s=>s.id===a.sourceId)-sources.findIndex(s=>s.id===b.sourceId));
}
