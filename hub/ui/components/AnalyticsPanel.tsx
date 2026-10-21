/** @jsxRuntime automatic */
import {useId,type ReactNode,type Ref} from 'react';
import type {Shown} from '../lib/history';
import {ReadState} from './ReadState';
import {t} from '../i18n';
import {usePref} from '../lib/prefs';
import {timeRangeKey, useTimeRange} from '../lib/timeRange';
import {seriesFocusStyle} from './seriesFocus';

/** The same heading and reader state for every analytics widget. */
export function AnalyticsPanel({ref, className, title, controls, settings, history, loading, error, retry, chart, children,details}: {
  ref?: Ref<HTMLElement>; className: string; title: string; controls?: ReactNode; settings?: ReactNode;
  history: Shown['history']; loading: boolean; error: Shown['error']; retry: () => void; chart?: boolean; children: ReactNode;
  details?:ReactNode;
}) {
  const selected = useTimeRange(), period = usePref('range');
  const retained = history && history.range !== (selected ? timeRangeKey(selected) : period);
  return <section ref={ref} className={`panel ${className}${loading ? ' is-loading' : ''}`} aria-label={title} aria-busy={loading} data-history-range={history?.range} data-time={chart ? 'chart' : undefined}>
    <div className="panel-head">
      <h2 className="panel-heading">{title}</h2>
      <div className="panel-controls"><ReadState loading={loading&&!!retained} error={error} retained={!!retained} range={history?{from:history.since,to:history.to}:null} retry={retry}>{details}</ReadState>{controls}{settings}</div>
    </div>
    {!history&&loading&&<span className="initial-reader" role="status" aria-label={t('period.loading')}><span className="spinner" aria-hidden="true"/></span>}
    {children}
  </section>;
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
