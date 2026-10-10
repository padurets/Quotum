import type {CellSamples} from './domain/cells.js';
import type {Store,Shown} from './store/store.js';
import type {PeriodRange} from './domain/period.js';
import {encodeSamples,decodeSamples,sampleBytes,bindRate,type PeriodTape,type MoneyTape} from './domain/periodTape.js';
import type {HistoryScope} from './domain/history.js';
import {selectionOf} from './domain/meterHistory.js';
import type {HistoryQuery} from './domain/periodRead.js';
import {isConvertible} from './domain/currency.js';

export function periodTape(store:Store,board:string,shown:Shown,user:string,scope:HistoryScope,query:HistoryQuery,range:PeriodRange,cursor:string,replaceFrom:number,reserve:(bytes:number)=>void,membershipAt=range.to,release:(bytes:number)=>void=()=>{},compact=false):PeriodTape {
  const tape:PeriodTape={from:range.from,cut:range.to,cursor,replaceFrom,quota:[],money:[]};
  if(replaceFrom>=range.to)return tape;
  if(scope==='quota') {
    const windows=store.db.prepare('SELECT DISTINCT window_id FROM samples WHERE source_id=? AND at<?');
    const descriptor=store.db.prepare('SELECT window_id,kind,label,minutes,at=(SELECT max(at) FROM samples WHERE source_id=? AND at<?) AS member FROM samples WHERE source_id=? AND window_id=? AND at<? ORDER BY at DESC LIMIT 1');
    const read=store.db.prepare('SELECT at,used,reset_at,stale_after_ms,kind,label,minutes FROM samples WHERE source_id=? AND window_id=? AND at<? AND at>=coalesce((SELECT max(at) FROM samples WHERE source_id=? AND window_id=? AND at<?),?) ORDER BY at');
    read.setReturnArrays(true);
    for(const id of shown.keys())for(const raw of windows.iterate(id,range.to)) {
      const window=String(raw.window_id),samples:CellSamples['samples']=[];let transient=0;
      const temporary=(bytes:number)=>{reserve(bytes);transient+=bytes;};
      const descriptors:NonNullable<PeriodTape['quota'][number]['descriptors']>=[];
      for(const raw of read.iterate(id,window,range.to,id,window,replaceFrom,replaceFrom)) {
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
        const encoded=encodeSamples(store.quotaAvailability(id,samples,true,temporary)),retained=compact?decodeSamples(encoded):encoded;
        if(compact)reserve(sampleBytes(retained));
        tape.quota.push({source:id,window,workFrom:shown.get(id)!.since,...(!compact?{samplesEncoding:'delta' as const}:{}),samples:retained,descriptors,member:!!row.member,windowValue:{id:window,kind:row.kind as 'session'|'weekly'|'other',label:row.label as string|null,minutes:row.minutes as number|null}});
      }
      release(transient);
    }
  }
  if(query.meters) {
    const selection=selectionOf(JSON.parse(query.meters),query.unit);
    const target=query.currency,bindings=target?store.currencies.history(user,target,replaceFrom,range.to,reserve):null;
    for(const id of selection.ids.filter(([source])=>shown.has(source))) {
      const group:MoneyTape=store.financialGroups(board,{...selection,ids:[id]},replaceFrom,range.to,Date.now(),reserve)[0];
      if(id[1].startsWith('key:')&&!store.holds(user,id[0]))for(const reading of group.readings)reading.label=null;
      group.spans=group.spans.filter(s=>s.to+s.staleAfterMs+1>=replaceFrom);
      if(group.paired)group.paired.spans=group.paired.spans.filter(s=>s.to+s.staleAfterMs+1>=replaceFrom);
      if(bindings&&target) {
        group.displayUnit=target;group.rateBindings={paths:[],entries:{}};
        for(const reading of [...group.readings,...group.paired?.readings??[]])if(isConvertible(reading.unit)) {
          const steps=bindings.binding(group.source,reading.unit,reading.at);
          reserve(bindRate(group,reading.unit+'\n'+reading.at,steps));

        }
        if(group.meter==='balance:credits')for(const span of group.spans)for(const at of [span.from,span.to]) {
          const key='credits:codex\n'+at;if(key in group.rateBindings.entries)continue;
          const steps=bindings.binding(group.source,'credits:codex',at);
          reserve(bindRate(group,key,steps));
        }
      }
      tape.money.push(group);
    }
    bindings?.flush();
  }
  return tape;
}
