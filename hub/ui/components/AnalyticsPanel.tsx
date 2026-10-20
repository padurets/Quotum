/** @jsxRuntime automatic */
import {useId,useSyncExternalStore,type ReactNode,type Ref} from 'react';
import type {Shown} from '../lib/history';
import {HistoryFailure} from './HistoryFailure';
import {t} from '../i18n';
import {usePref} from '../lib/prefs';
import {timeRangeKey, timeRangeLabel, useTimeRange} from '../lib/timeRange';
import {seriesFocusStyle,type SeriesFocus} from './seriesFocus';

/** The same heading and reader state for every analytics widget. */
export function AnalyticsPanel({ref, className, title, controls, settings, history, loading, error, retry, chart, children}: {
  ref?: Ref<HTMLElement>; className: string; title: string; controls?: ReactNode; settings?: ReactNode;
  history: Shown['history']; loading: boolean; error: Shown['error']; retry: () => void; chart?: boolean; children: ReactNode;
}) {
  const selected = useTimeRange(), period = usePref('range');
  const retained = history && history.range !== (selected ? timeRangeKey(selected) : period);
  return <section ref={ref} className={`panel ${className}${loading ? ' is-loading' : ''}`} aria-label={title} aria-busy={loading} data-history-range={history?.range} data-time={chart ? 'chart' : undefined}>
    <div className="panel-head">
      <h2 className="panel-heading">{title}</h2>
      {(controls || settings) && <div className="panel-controls">{controls}{settings}</div>}
    </div>
    {retained && <p className="analytics-note history-retained" role="status">{t('analytics.retainedRange', {range: timeRangeLabel({from: history.since, to: history.to})})}</p>}
    <HistoryFailure error={error} retry={retry}/>
    {children}
  </section>;
}

export function AnalyticsNote({children, title}: {children: ReactNode; title?: string}) {
  return <p className="analytics-note" title={title}>{children}</p>;
}

/** Both histories toggle a series without changing their table's selection. */
export function SeriesLegendItem({seriesKey, name, description, color, dash, muted, onToggle, children}: {
  seriesKey: string; name: string; description?: string; color: string; dash?: string; muted: boolean; onToggle: () => void; children: ReactNode;
}) {
  const id=useId();
  return <><button type="button" className="legend-item" data-series-key={seriesKey} style={seriesFocusStyle(seriesKey)} aria-describedby={description?id:undefined} aria-pressed={!muted} onClick={onToggle}>
    <svg width="18" height="6" aria-hidden="true"><line x1="1" x2="17" y1="3" y2="3" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={dash || undefined}/></svg>
    <span>{name}</span>{children}
  </button>{description&&<span id={id} className="sr-only">{muted?t('activity.seriesHidden'):description}</span>}</>;
}

export type SeriesDescription={key:string;name:string;detail:string;muted:boolean};
/** Invisible text variants reserve the maximum detail height without clock subscriptions. */
export function SeriesInformation({focus,entries}:{focus:SeriesFocus;entries:SeriesDescription[]}) {
  const key=useSyncExternalStore(focus.subscribe,focus.get),entry=entries.find(entry=>entry.key===key&&!entry.muted);
  if(!entries.some(entry=>entry.detail))return null;
  return <div className="chart-info money-info" data-series-context={entry?.key}>
    <div className="chart-info-name">{entry?.name??'\u00a0'}</div>
    <div className="chart-info-detail">
      {entries.map(entry=><div className="chart-info-variant" key={entry.key} aria-hidden>{entry.detail}</div>)}
      <div className="chart-info-current">{entry?.detail??'\u00a0'}</div>
    </div>
  </div>;
}
