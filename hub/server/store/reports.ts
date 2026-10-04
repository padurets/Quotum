import type {DatabaseSync} from 'node:sqlite';
import {amount} from '../domain/amount.js';
import {reportCalendar,validateReport,type ReportInterval,type ReportQuality,type ReportRead,type ReportSeries} from '../domain/reports.js';
import type {MeterSelection} from '../domain/meterHistory.js';

/** Accepted report values and their current confirmation share the source transaction. */
export class ReportStore {
  constructor(private readonly db:DatabaseSync) {}
  record(source:string,read:ReportRead,staleAfterMs:number):{quality:ReportQuality[];since:number|null} {
    const old=this.quality(source),version=Math.max(0,...old.map(q=>q.roundVersion))+1;
    const groups=new Map([...old,...read.intervals].map(row=>[JSON.stringify([row.meterId,row.unit]),{meterId:row.meterId,unit:row.unit}]));
    let since:number|null=null;
    const result:ReportQuality[]=[];
    for(const {meterId,unit} of groups.values()) {
      const previous=old.find(q=>q.unit===unit&&q.meterId===meterId);
      const quality:ReportQuality={meterId,unit,roundVersion:version,attemptedAt:read.observedAt,lastCompleteReadAt:read.traversalComplete?read.observedAt:previous?.lastCompleteReadAt??null,status:read.status,acquiredAt:null,requestFrom:read.requestFrom,requestTo:read.requestTo,traversalComplete:read.traversalComplete,staleAfterMs,confirmation:[]};
      for(const row of read.intervals.filter(r=>r.unit===unit&&r.meterId===meterId)) {
        validateReport(row);
        const query=this.db.prepare('SELECT amount,revision FROM reported_intervals WHERE source_id=? AND meter_id=? AND unit=? AND from_at=? AND to_at=?');query.setReadBigInts(true);
        const current=query.get(source,row.meterId,unit,row.from,row.to) as {amount:bigint;revision:bigint}|undefined;
        const revision=current&&current.amount===amount(row.amount)?Number(current.revision):version;
        if(!current||current.amount!==amount(row.amount)) {
          this.db.prepare('INSERT OR REPLACE INTO reported_intervals VALUES (?,?,?,?,?,?,?,?)').run(source,row.meterId,unit,row.from,row.to,amount(row.amount),row.observedAt,revision);
          since=since===null?row.from:Math.min(since,row.from);
        }
        quality.confirmation.push({from:row.from,to:row.to,valueRevision:revision,readAt:row.observedAt});
        quality.acquiredAt=Math.max(quality.acquiredAt??0,row.observedAt);
      }
      this.db.prepare('INSERT OR REPLACE INTO reported_components VALUES (?,?,?,?)').run(source,meterId,unit,JSON.stringify(quality));result.push(quality);
    }
    return {quality:result,since};
  }
  quality(source:string):ReportQuality[] {return (this.db.prepare('SELECT payload FROM reported_components WHERE source_id=?').all(source) as {payload:string}[]).map(r=>JSON.parse(r.payload));}
  intervals(source:string,meter:string,unit:string,from:number,to:number):ReportInterval[] {
    const query=this.db.prepare('SELECT from_at,to_at,amount,observed_at,revision FROM reported_intervals WHERE source_id=? AND meter_id=? AND unit=? AND to_at>? AND from_at<? ORDER BY from_at');query.setReadBigInts(true);
    return (query.all(source,meter,unit,from,to) as {from_at:bigint;to_at:bigint;amount:bigint;observed_at:bigint;revision:bigint}[]).map(r=>({from:Number(r.from_at),to:Number(r.to_at),amount:r.amount.toString(),valueObservedAt:Number(r.observed_at),revision:Number(r.revision)}));
  }
  series(selection:MeterSelection,from:number,to:number):ReportSeries[] {
    return selection.ids.flatMap(([source,meter])=>{const intervals=this.intervals(source,meter,selection.unit,from,to);return intervals.length?[{source,meter,unit:selection.unit,kind:'reported' as const,intervals}]:[];});
  }
  calendar(source:string,now:number) {
    return this.quality(source).map(quality=>({unit:quality.unit,meterId:quality.meterId,...reportCalendar(this.intervals(source,quality.meterId,quality.unit,now-40*86_400_000,now),quality,now)}));
  }
  prune(cutoff:number){return this.db.prepare('DELETE FROM reported_intervals WHERE to_at<=?').run(cutoff).changes>0;}
}
