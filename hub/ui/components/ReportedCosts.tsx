import {useCard,useTitle} from '../lib/board';
import {useClock} from '../lib/clock';
import {money} from '../lib/money';
import {stamp} from '../lib/format';
import {t} from '../i18n';
import {reportSummary,REPORT_DAY,type ReportHistory,type ReportInterval,type ReportSummary} from '../../server/domain/reports';

export const reportIdentity=(s:ReportHistory)=>JSON.stringify([s.sourceId,s.meterId,s.kind,s.unit]);
export function ReportDetail({series,row}:{series:ReportHistory;row:ReportInterval}) {
  const card=useCard(series.sourceId),quality=card?.reportQuality?.find(q=>q.unit===series.unit&&q.meterId===series.meterId);
  const now=useClock(now=>reportChangesAt(quality?.confirmation.map(c=>c.readAt+(quality?.staleAfterMs??0)+1)??[],now));
  const summary=reportSummary([row],quality,row.from,row.to,now);
  return <div>{t('money.reported')}: {money(row.amount,series.unit,true)}<div>{stamp(row.from)} — {stamp(row.to)}</div><div>{t('money.reportedAsOf',{time:stamp(summary.asOf??row.valueObservedAt)})}</div>{!summary.confirmed&&<div>{t('money.lastKnown')}</div>}{summary.provisional&&<div>{t('money.provisional')}</div>}</div>;
}
export function reportChangesAt(freshness:readonly number[],now:number) {return Math.min(Math.floor(now/REPORT_DAY)*REPORT_DAY+REPORT_DAY,...freshness.filter(at=>at>now));}
const qualityText=(summary:ReportSummary)=>[!summary.confirmed?t('money.lastKnown'):'',summary.provisional?t('money.provisional'):'',summary.asOf!==null?t('money.reportedAsOf',{time:stamp(summary.asOf)}):''].filter(Boolean).join('\n');
/** Calendar summaries and selected-range totals read the same report classifier. */
export function ReportRows({series,from,to,columns}:{series:ReportHistory;from:number;to:number;columns:readonly (readonly [string,string])[]}) {
  const card=useCard(series.sourceId),quality=card?.reportQuality?.find(q=>q.unit===series.unit&&q.meterId===series.meterId);
  const now=useClock(now=>reportChangesAt(quality?.confirmation.map(c=>c.readAt+(quality?.staleAfterMs??0)+1)??[],now));
  const title=useTitle(series.sourceId);
  const summary=reportSummary(series.intervals,quality,from,to,now);
  const overlaps=summary.overlapping.map(row=>`${t('money.wholeDay')}\n${money(row.amount,series.unit,true)}\n${stamp(row.from)} — ${stamp(row.to)}`).join('\n');
  const calendar=card?.reportedSpending?.find(c=>c.unit===series.unit&&c.meterId===series.meterId);
  return <><tr><td className="report-name"><div>{title||series.sourceId}</div><small>{t('money.reported')}</small></td>{columns.map(([id])=><td key={id} title={id==='spending'?[qualityText(summary),overlaps].filter(Boolean).join('\n'):undefined}>{id==='spending'?<>{money(summary.amount,series.unit)}{(!summary.complete||!summary.confirmed||summary.overlapping.length>0)&&<small className="money-partial">*</small>}</>:'—'}</td>)}</tr>{calendar&&<tr><td colSpan={columns.length+1}><small className="report-periods" data-time="reported-calendar" title={t('money.utcPeriods')}>{(['day','week','month'] as const).map(period=><span key={period} title={qualityText(calendar[period])}>{t(period==='day'?'money.today':period==='week'?'money.week':'money.month')}: {money(calendar[period].amount,series.unit)}{!calendar[period].confirmed?' *':''}</span>)}</small></td></tr>}</>;
}
