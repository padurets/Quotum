import {sourceCounterOf} from './domain/providers.js';
import {sourceWorkEligible} from './domain/moneyWork.js';
import {sourceWorkFrom} from './domain/workAccess.js';
import type {CellSamples} from './domain/cells.js';
import type {Store,Shown,WorkRead} from './store/store.js';
import type {PeriodRange} from './domain/period.js';
import {encodeSamples,decodeSamples,sampleBytes,bindRate,type PeriodTape,type MoneyTape} from './domain/periodTape.js';
import type {HistoryScope} from './domain/history.js';
import {selectionOf} from './domain/meterHistory.js';
import type {HistoryQuery} from './domain/periodRead.js';
import {isConvertible} from './domain/currency.js';
import {readingBefore,valuationAt} from './domain/periodMoney.js';
import {admitAvailability} from './domain/periodAdmission.js';
import {periodAdmission} from './periodAdmission.js';

export function periodTape(store:Store,board:string,shown:Shown,user:string,scope:HistoryScope,query:HistoryQuery,range:PeriodRange,cursor:string,replaceFrom:number,reserve:(bytes:number)=>void,membershipAt=range.to,release:(bytes:number)=>void=()=>{},compact=false,evidenceCut=Date.now(),work?:WorkRead):PeriodTape {
  const admitted=Math.min(range.to,evidenceCut);
  membershipAt=Math.min(membershipAt,evidenceCut);
  const tape:PeriodTape={from:range.from,cut:range.to,cursor,replaceFrom,quota:[],money:[]};
  if(replaceFrom>=range.to)return tape;
  if(scope==='quota') {
    const sourceWork=sourceWorkFrom(work?.ensureAccess?.()??work?.access??store.workAccess(board,evidenceCut,reserve));
    const windows=store.db.prepare('SELECT DISTINCT window_id FROM samples WHERE source_id=? AND at<?');
    const descriptor=store.db.prepare('SELECT window_id,kind,label,minutes,at=(SELECT max(at) FROM samples WHERE source_id=? AND at<?) AS member FROM samples WHERE source_id=? AND window_id=? AND at<? ORDER BY at DESC LIMIT 1');
    const read=store.db.prepare('SELECT at,used,reset_at,stale_after_ms,kind,label,minutes FROM samples WHERE source_id=? AND window_id=? AND at<? AND at>=coalesce((SELECT max(at) FROM samples WHERE source_id=? AND window_id=? AND at<?),?) ORDER BY at');
    read.setReturnArrays(true);
    for(const id of shown.keys())for(const raw of windows.iterate(id,admitted)) {
      const window=String(raw.window_id),samples:CellSamples['samples']=[];let transient=0;
      const temporary=(bytes:number)=>{reserve(bytes);transient+=bytes;};
      const descriptors:NonNullable<PeriodTape['quota'][number]['descriptors']>=[];
      for(const raw of read.iterate(id,window,admitted,id,window,replaceFrom,replaceFrom)) {
        temporary(96);const [at,used,resetAt,staleAfterMs,kind,label,minutes]=raw as unknown as [number,number,number|null,number,'session'|'weekly'|'other',string|null,number|null];samples.push({at,used,resetAt,staleAfterMs});
        const previous=descriptors.at(-1)?.value;
        if(!previous||previous.kind!==kind||previous.label!==label||previous.minutes!==minutes){reserve(128+(label?.length??0)*2);descriptors.push({at,value:{id:window,kind,label,minutes}});}
      }
      if(samples.length){
        const row=descriptor.get(id,membershipAt,id,window,membershipAt);if(!row){release(transient);continue;}
        reserve(192+String(row.label??'').length*2);
        // Fixed summaries consume columns locally. Retain their exact buffers,
        // releasing the wire rows before reading the next source's history.
        if(compact)temporary(samples.length*120);else reserve(samples.length*80);
        const encoded=encodeSamples(store.quotaAvailability(id,samples,true,temporary).map(sample=>admitAvailability(sample,evidenceCut))),retained=compact?decodeSamples(encoded):encoded;
        if(compact)reserve(sampleBytes(retained));
        tape.quota.push({source:id,window,workFrom:sourceWork[id]??null,...(!compact?{samplesEncoding:'delta' as const}:{}),samples:retained,descriptors,member:!!row.member,windowValue:{id:window,kind:row.kind as 'session'|'weekly'|'other',label:row.label as string|null,minutes:row.minutes as number|null}});
      }
      release(transient);
    }
  }
  if(query.meters) {
    const selection=selectionOf(JSON.parse(query.meters),query.unit);
    const target=query.currency,bindings=target?store.currencies.history(user,target,replaceFrom,admitted,reserve):null;
    const admit=periodAdmission(store,user,target??store.currencies.preference(user).id,evidenceCut,reserve);
    for(const id of selection.ids.filter(([source])=>shown.has(source))) {
      const group:MoneyTape=store.financialGroups(board,{...selection,ids:[id]},replaceFrom,admitted,evidenceCut,reserve)[0];
      if(id[1].startsWith('key:')&&!store.holds(user,id[0]))for(const reading of group.readings)reading.label=null;
      for(const [meter,part] of [[group.paired?'usage':group.meter,group],...(group.paired?[['credits',group.paired] as const]:[])] as const){
        part.spans=part.spans.flatMap(span=>{const value=admit(group.source,meter,span);return value&&value.to+value.staleAfterMs+1>=replaceFrom?[value]:[];});
      }
      if(bindings&&target) {
        group.displayUnit=target;group.rateBindings={paths:[],entries:{}};
        for(const part of [group,...(group.paired?[group.paired]:[])]) {
          const units=new Set(part.readings.filter(r=>isConvertible(r.unit)).map(r=>r.unit));
          const bind=(unit:string,at:number)=>{const key=unit+'\n'+at;if(!isConvertible(unit)||key in group.rateBindings!.entries)return;
            reserve(bindRate(group,key,bindings.binding(group.source,unit,at)));};
          for(const reading of part.readings)bind(reading.unit,reading.at);
          for(const span of part.spans) {
            // Unchanged amounts still have genuine heartbeat and recorded valuation anchors.
            for(const at of [...(span.observedFrom===undefined?[]:[span.observedFrom]),span.to]){const reading=readingBefore(part.readings,at);if(reading)bind(reading.unit,at);}
            for(const unit of units) {
              for(const at of bindings.changes(group.source,unit,span.observedFrom??span.from,Math.min(span.to+1,admitted))) {
                const reading=readingBefore(part.readings,at);
                if(reading?.unit===unit&&valuationAt(reading,span,at,true,at)===at)bind(unit,at);
              }
            }
          }
        }
      }
      if(scope==='budget'&&query.work==='1'&&group.role==='total'&&sourceWorkEligible(store.state(group.source).provider,id[1])) {
        const meter=sourceCounterOf(store.state(group.source).provider);
        if(meter) {
          const access=work?.ensureAccess?.()??store.workAccess(board,evidenceCut,reserve),from=sourceWorkFrom(access)[group.source]??Infinity;
          const pairs=store.meters.pairReadings(group.source,meter,replaceFrom,admitted,reserve);
          const knownFrom=pairs.knownFrom===null||!Number.isFinite(from)?null:Math.max(pairs.knownFrom,from);
          group.workCounter={source:group.source,unit:pairs.readings.at(-1)?.unit??'USD',knownFrom,workFrom:Number.isFinite(from)?from:null,readings:pairs.readings,spans:pairs.spans};
        }
      }
      tape.money.push(group);
    }
    bindings?.flush();
  }
  return tape;
}
