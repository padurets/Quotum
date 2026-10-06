import {QUOTA_IDS} from '../../server/domain/meters';
import {MAX_METERS,selectionOf,composeMetersPrepared,type MeterHistory,type MeterSelection} from '../../server/domain/meterHistory';
import type {Card,History,Kind,View,Win} from './types';
import type {CapCell,Line,PlotLine} from './lines';
import {linesPrepared} from './lines';
import type {PlotBuffer} from './historyPlot';
import {hasSubscriptionCaps} from './providers';
import {capPercent} from './money';
import {seriesName} from './quota';
import {cardId,colorOf} from './view';
import {windowKey} from './types';
import {drain,type Preparation} from './prepare';
import {ordered} from '../../server/domain/prepare';

/** Subscription periods are independent of the provider's stored measurement unit. */
export function quotaPeriods(source:Pick<Card,'provider'|'windows'>):Pick<Win,'id'|'kind'|'label'|'minutes'>[] {
  if(!hasSubscriptionCaps(source.provider))return source.windows;
  return QUOTA_IDS.map((id,i)=>({id,kind:i===0?'session':'weekly',label:null,minutes:i===0?300:10080}));
}

export function quotaRemaining(source:Card,id:string):number|null {
  if(!hasSubscriptionCaps(source.provider))return source.windows.find(w=>w.id===id)?.remaining??null;
  const meter=source.meters?.find(m=>m.id===id),used=meter?capPercent(meter):null;
  return used===null?null:100-used;
}

/** Both periods travel with ordinary subscription history, not a separate analytics mode. */
export function subscriptionSelection(cards:readonly Card[],view:Pick<View,'hidden'|'windows'>):MeterSelection|undefined {
  const shown=cards.filter(c=>hasSubscriptionCaps(c.provider)&&!view.hidden.includes(cardId(c.id)));
  if(!shown.length)return undefined;
  const unit=shown.flatMap(c=>c.meters??[]).find(m=>m.kind==='cap')?.unit??'credits:zai';
  const ids=subscriptionIds(shown,view);
  return selectionOf(ids.slice(0,MAX_METERS),unit);
}
const subscriptionIds=(cards:readonly Card[],view:Pick<View,'hidden'|'windows'>)=>cards.filter(c=>hasSubscriptionCaps(c.provider)&&!view.hidden.includes(cardId(c.id))).flatMap(c=>QUOTA_IDS.filter(id=>!view.windows.includes(windowKey(c.id,id))).map(id=>[c.id,id] as [string,string]));
export const subscriptionOverflow=(cards:readonly Card[],view:Pick<View,'hidden'|'windows'>)=>Math.max(0,subscriptionIds(cards,view).length-MAX_METERS);

const leftPercent=(left:string,limit:string|null|undefined):number|null=>{
  if(limit==null||BigInt(limit)<=0n)return null;
  const used=(BigInt(limit)-BigInt(left))*10_000n/BigInt(limit);
  return 100-Number(used<0n?0n:used>10_000n?10_000n:used)/100;
};

/** Exact cap cells become percentage lines while preserving their exclusive validity bounds. */
export function* capLinesPrepared(series:readonly MeterHistory[],sources:readonly (Card&{title?:string})[],view:View,kind:Kind,from:number,to:number):Preparation<Line[]> {
  const result:Line[]=[];
  for(const entry of series) {
    yield;
    const source=sources.find(c=>c.id===entry.sourceId);
    const period=source&&quotaPeriods(source).find(q=>q.id===entry.meterId&&q.kind===kind);
    if(entry.kind!=='cap'||!source||!hasSubscriptionCaps(source.provider)||!period||view.hidden.includes(cardId(source.id))||view.windows.includes(windowKey(source.id,period.id)))continue;
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
      current:quotaRemaining(source,period.id),consumed:0,coveredMs:0,remainingAtStart:edge(from),remainingAtEnd:edge(to-1),staleAfterMs:current?.staleAfterMs??0,points,capCells,work:null});
  }
  return result;
}

export function* subscriptionLinesPrepared(history:History|null,sources:(Card&{title?:string})[],view:View,kind:Kind):Preparation<Line[]> {
  const native=yield* linesPrepared(history,sources,view,kind);
  if(!history)return native;
  const caps=yield* capLinesPrepared(history.meterSeries??[],sources,view,kind,history.since,history.to);
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
