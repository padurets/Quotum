/** @jsxRuntime automatic */
import type {ReactNode, Ref} from 'react';
import type {Shown} from '../lib/history';
import {HistoryFailure} from './HistoryFailure';

/** The same heading, description and reader state for every analytics widget. */
export function AnalyticsPanel({ref, className, title, description, settings, history, loading, error, retry, chart, children}: {
  ref?: Ref<HTMLElement>; className: string; title: string; description?: ReactNode; settings?: ReactNode;
  history: Shown['history']; loading: boolean; error: Shown['error']; retry: () => void; chart?: boolean; children: ReactNode;
}) {
  return <section ref={ref} className={`panel ${className}${loading ? ' is-loading' : ''}`} aria-label={title} aria-busy={loading} data-history-range={history?.range} data-time={chart ? 'chart' : undefined}>
    <div className="panel-head">
      <div className="panel-heading"><h2>{title}</h2>{description && <div className="panel-description">{description}</div>}</div>
      {settings}
    </div>
    <HistoryFailure error={error} retry={retry}/>
    {children}
  </section>;
}

export function AnalyticsNote({children, title}: {children: ReactNode; title?: string}) {
  return <p className="analytics-note" title={title}>{children}</p>;
}

/** Both histories toggle a series without changing their table's selection. */
export function SeriesLegendItem({name, color, dash, muted, onToggle, children}: {
  name: string; color: string; dash?: string; muted: boolean; onToggle: () => void; children: ReactNode;
}) {
  return <button type="button" className="legend-item" aria-pressed={!muted} onClick={onToggle}>
    <svg width="18" height="6" aria-hidden="true"><line x1="1" x2="17" y1="3" y2="3" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={dash || undefined}/></svg>
    <span>{name}</span>{children}
  </button>;
}
