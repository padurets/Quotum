import {useMemo} from 'react';
import type {History as HistoryData, Kind, Overview} from '../lib/types';
import {day, num} from '../lib/format';
import {sourceLabel} from '../lib/quota';
import {planAt, weeklyPlanLine} from '../lib/plan';
import {PROVIDERS} from '../lib/providers';
import {HORIZONS, setMuted, setPrefs, usePrefs, type Horizon} from '../lib/prefs';
import {HISTORY, planOf, withHidden, type Arrange} from '../lib/view';
import {linesOf} from '../lib/lines';
import {Chart, type Marker, type PlanLine} from './Chart';
import type {PastResets, Resets} from '../lib/resets';
import {t, useLocale} from '../i18n';
import {Segmented} from './Kit';
import {HideRow, Popover, SlidersIcon} from './Popover';

const DAY = 86_400_000;
/** How much future the chart keeps on its right when its horizon is `auto`, per range. */
const FUTURE: Record<string, number> = {'24h': 4 * 3_600_000, '7d': DAY, '30d': 3 * DAY};
const HORIZON: Record<Exclude<Horizon, 'auto'>, number> = {'1d': DAY, '3d': 3 * DAY, '7d': 7 * DAY};

/** The chart's own settings: how far it looks ahead, and (for the board's owner) hiding it. */
function HistorySettings({arrange}: {arrange: Arrange}) {
  const {horizon} = usePrefs();
  return (
    <Popover label={t('history.settings')} icon={<SlidersIcon />}>
      <div className="popover-title">{t('history.horizon')}</div>
      <div className="popover-pad">
        <Segmented
          value={horizon}
          onChange={value => setPrefs({horizon: value})}
          options={HORIZONS.map(h => [h, h === 'auto' ? t('history.horizonAuto') : t('history.daysShort', {count: parseInt(h)})])}
          label={t('history.horizon')}
        />
      </div>
      {arrange.owner && <HideRow onHide={() => arrange.update(view => withHidden(view, HISTORY, true))}>{t('history.hide')}</HideRow>}
    </Popover>
  );
}

/** Weekly or 5-hour windows. */
export function KindSwitch({value, onChange}: {value: Kind; onChange: (kind: Kind) => void}) {
  return (
    <Segmented
      value={value}
      onChange={onChange}
      options={[
        ['weekly', t('history.weekly')],
        ['session', t('history.session')],
      ]}
      label={t('history.kind')}
    />
  );
}

/** The last 24 hours, 7 or 30 days. */
export function PeriodSwitch({value, onChange}: {value: string; onChange: (range: string) => void}) {
  return (
    <Segmented
      value={value}
      onChange={onChange}
      options={[
        ['24h', t('history.hours', {count: 24})],
        ['7d', t('history.days', {count: 7})],
        ['30d', t('history.days', {count: 30})],
      ]}
      label={t('history.range')}
    />
  );
}

/** The remaining share of every window of one kind over the period, with its legend. */
export function History({
  history,
  loading,
  overview,
  resets,
  past,
  now,
  arrange,
}: {
  history: HistoryData | null;
  /** Another period is loading; `history` is the previous one until it comes. */
  loading: boolean;
  overview: Overview | null;
  resets: Resets;
  past: PastResets;
  now: number;
  arrange: Arrange;
}) {
  const prefs = usePrefs();
  const {view} = arrange;
  // Series names and markers are text: they are rebuilt when the language changes.
  const locale = useLocale();

  const lines = useMemo(() => linesOf(history, overview, view, prefs.kind), [history, overview, prefs.kind, view.windows, locale]);

  const visible = useMemo(() => lines.filter(line => !prefs.muted[line.key]), [lines, prefs.muted]);
  const from = history ? Math.max(history.since, history.historyStart) : now - 86_400_000;
  const measuredTo = history?.now ?? now;
  const announced = resets.codex?.scheduled?.scheduledFor ?? null;
  // The spending plan applies to weekly windows; the days ahead are there for it.
  const planAvailable = prefs.kind === 'weekly' && visible.length > 0;
  const planShown = planAvailable && prefs.showPlan;
  // Without the plan the chart ends now (an announced reset is pointed at from the right
  // edge). With it, on `auto` some future stays on the right, stretched to include an
  // announced reset when close: it may take up to ~40% of the width, a reset further
  // out is pointed at from the edge instead. A chosen horizon is kept as is.
  const future = prefs.horizon === 'auto' ? (FUTURE[prefs.range] ?? FUTURE['24h']) : HORIZON[prefs.horizon];
  const reach = measuredTo + (measuredTo - from) * 0.75;
  const to = !planShown
    ? measuredTo
    : prefs.horizon === 'auto' && announced && announced > measuredTo && announced + future * 0.25 > measuredTo + future
      ? Math.min(reach, announced + future * 0.25)
      : measuredTo + future;

  const markers: Marker[] = useMemo(() => {
    const list: Marker[] = [];
    if (announced && announced > from) {
      list.push({key: 'announced-codex', at: announced, label: t('chart.announcedCodex'), color: 'var(--accent)', strong: true});
    }
    const seen = new Set<string>();
    for (const line of visible) {
      const live = overview?.sources.find(s => s.id === line.sourceId)?.windows.find(w => w.id === line.windowId);
      if (!live?.resetAt || live.resetAt <= measuredTo || live.resetAt > to || !planAt(live, measuredTo, planOf(view, line.sourceId))) continue;
      const key = `${line.sourceId}@${Math.round(live.resetAt / 60_000)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source = overview?.sources.find(s => s.id === line.sourceId);
      list.push({key, at: live.resetAt, label: t('chart.reset', {source: source ? sourceLabel(source) : line.provider}), color: line.color});
    }
    // What happened to the sources on the chart: their limits came back early, or free resets were granted.
    for (const event of history?.events ?? []) {
      const shown = visible.filter(line => line.sourceId === event.sourceId && (event.kind !== 'early_reset' || event.windows.includes(line.windowId)));
      if (event.at < from || !shown.length) continue;
      const source = overview?.sources.find(s => s.id === event.sourceId);
      const name = source ? sourceLabel(source) : shown[0].provider;
      list.push({
        key: `${event.kind}-${event.sourceId}-${event.at}`,
        at: event.at,
        label: event.kind === 'early_reset' ? t('chart.earlyReset', {source: name}) : t('chart.resetsGranted', {count: event.count, source: name}),
        color: shown[0].color,
        past: true,
      });
    }
    // Resets for everyone the trackers reported, on the providers the chart shows.
    for (const [provider, reported] of Object.entries(past)) {
      const line = visible.find(l => l.provider === provider);
      for (const reset of reported ?? []) {
        if (!line || reset.at < from || reset.at > measuredTo) continue;
        list.push({
          key: `announced-${provider}-${reset.at}`,
          at: reset.at,
          label: t('chart.resetForAll', {source: PROVIDERS[provider]?.name ?? provider}),
          detail: reset.text,
          color: line.color,
          past: true,
        });
      }
    }
    return list;
  }, [announced, visible, overview, history, past, from, to, measuredTo, view, locale]);

  // One plan line per distinct weekly window; windows of a source that share a reset
  // (e.g. Claude weekly and Fable) share one plan.
  const plans: PlanLine[] = useMemo(() => {
    if (!planShown) return [];
    const seen = new Map<string, PlanLine>();
    for (const line of visible) {
      const live = overview?.sources.find(s => s.id === line.sourceId)?.windows.find(w => w.id === line.windowId);
      // Idle rolling windows (reset = now + 7 days) have not started: no plan to show.
      if (!live?.resetAt || live.minutes !== 10080 || !planAt(live, now, planOf(view, line.sourceId))) continue;
      const key = `${line.sourceId}@${Math.round(live.resetAt / 3_600_000)}`;
      if (seen.has(key)) continue;
      const source = overview?.sources.find(s => s.id === line.sourceId);
      seen.set(key, {
        key,
        name: t('chart.plan', {source: source ? sourceLabel(source) : line.provider}),
        color: line.color,
        runs: weeklyPlanLine(live.resetAt, from, to, planOf(view, line.sourceId)),
      });
    }
    return [...seen.values()];
  }, [visible, overview, from, to, now, planShown, view, locale]);

  return (
    <section className={`panel history ${loading ? 'is-loading' : ''}`} aria-label={t('history.label')} aria-busy={loading}>
      <div className="panel-head">
        <h2>{t('history.title')}</h2>
        <div className="controls">
          <KindSwitch value={prefs.kind} onChange={kind => setPrefs({kind})} />
          <PeriodSwitch value={prefs.range} onChange={range => setPrefs({range})} />
          <HistorySettings arrange={arrange} />
        </div>
      </div>

      <div className="legend">
        {lines.map(line => (
          <button
            key={line.key}
            type="button"
            className="legend-item"
            aria-pressed={!prefs.muted[line.key]}
            onClick={() => setMuted(line.key, !prefs.muted[line.key])}
          >
            <svg width="18" height="6" aria-hidden="true">
              <line x1="1" x2="17" y1="3" y2="3" stroke={line.color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={line.dash || undefined} />
            </svg>
            <span>{line.name}</span>
            <b>{num(line.current)}%</b>
          </button>
        ))}
        {!lines.length && <span className="legend-empty">{t('history.noLines')}</span>}
        {planAvailable && (
          <button
            type="button"
            className="legend-item legend-plan"
            aria-pressed={prefs.showPlan}
            title={t('history.planLegendHint')}
            onClick={() => setPrefs({showPlan: !prefs.showPlan})}
          >
            <svg width="18" height="6" aria-hidden="true">
              <line x1="1" x2="17" y1="3" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="1 4" />
            </svg>
            <span>{t('history.planLegend')}</span>
          </button>
        )}
      </div>

      {history ? <Chart lines={visible} plans={plans} markers={markers} from={from} now={measuredTo} to={to} cellMs={history.cellMs} /> : <div className="chart chart-loading">{t('history.loading')}</div>}
      {history && history.since < history.historyStart && (
        <p className="footnote">{t('history.since', {date: day(history.historyStart)})}</p>
      )}
    </section>
  );
}
