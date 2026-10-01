import {memo, useMemo, useRef} from 'react';
import {earliest, num} from '../lib/format';
import {sourceLabel} from '../lib/quota';
import {planAt, started, weeklyPlanLine} from '../lib/plan';
import {announcedOf, clip, forecastLine, type Context} from '../lib/forecast';
import {PROVIDERS} from '../lib/providers';
import {HORIZONS, setMuted, setPrefs, usePrefs} from '../lib/prefs';
import {setTimeRange, useTimeRange} from '../lib/timeRange';
import {frameChangesAt, frameOf, measuredTo} from '../lib/periods';
import {HISTORY, planOf, withHidden, type Arrange} from '../lib/view';
import {chartEvents, chartResets, linesOf, type PlotLine} from '../lib/lines';
import {lineRegistry} from '../lib/plotRegistry';
import {Chart, type Marker} from './Chart';
import {chartMoments, lastRunOut, type ForecastLine, type PlanLine} from '../lib/readout';
import {useForecastsOf, useLineup, useNamed, usePastResets, useResetNews, useResetsFor} from '../lib/board';
import {useClock} from '../lib/clock';
import {useHistory, useHistoryBegins, useHistoryPlot} from '../lib/history';
import {t, useLocale} from '../i18n';
import {Segmented} from './Kit';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';
import {usePlot} from './sizing';

/**
 * The chart's own settings: whether it draws the plan and the forecast (where either has
 * something to draw), how far it looks ahead, and (for the board's owner) hiding it.
 * Its note says the look ahead needs the plan or the forecast, where a period ending now
 * has neither; a range in the past has no future at all.
 */
function HistorySettings({arrange, planAvailable, forecastAvailable, horizonNote}: {arrange: Arrange; planAvailable: boolean; forecastAvailable: boolean; horizonNote: boolean}) {
  const {horizon, showPlan, showForecast} = usePrefs();
  return (
    <Popover label={t('history.settings')} icon={<SlidersIcon />}>
      <div className="popover-note">{t('chart.panHint')}</div>
      {(planAvailable || forecastAvailable) && (
        <div className="popover-section">
          <div className="popover-title">{t('history.show')}</div>
          {planAvailable && (
            <SwitchRow on={showPlan} onChange={on => setPrefs({showPlan: on})}>
              {t('history.plan')}
            </SwitchRow>
          )}
          {forecastAvailable && (
            <SwitchRow on={showForecast} onChange={on => setPrefs({showForecast: on})}>
              {t('history.forecast')}
            </SwitchRow>
          )}
          {planAvailable && <div className="popover-note">{t('history.planHint')}</div>}
        </div>
      )}
      <div className="popover-section">
        <div className="popover-title">{t('history.horizon')}</div>
        <div className="popover-pad">
          <Segmented
            value={horizon}
            onChange={value => setPrefs({horizon: value})}
            options={HORIZONS.map(h => [h, h === 'auto' ? t('history.horizonAuto') : t('history.daysShort', {count: parseInt(h)})])}
            label={t('history.horizon')}
          />
        </div>
        {horizonNote && <div className="popover-note">{t('history.horizonNote')}</div>}
      </div>
      {arrange.owner && <HideRow onHide={() => arrange.update(view => withHidden(view, HISTORY, true))}>{t('widget.hide')}</HideRow>}
    </Popover>
  );
}

/**
 * The remaining share of every window of one kind over the period, with its legend under
 * it. It reads the history on screen (`useHistory`, which another answer replaces while
 * loading) and the board's cards, not their agents or pace; with time it moves on a cell of
 * the history's grid at a time, a label past its right edge counts down on its own, and a
 * forecast's line goes when the table no longer says where its window leads.
 */
export const History = memo(function History({arrange}: {arrange: Arrange}) {
  const {history, loading} = useHistory();
  const strip = useHistoryPlot();
  const registry = useRef<{token: number; seed: PlotLine[]; lines: PlotLine[]} | null>(null);
  const panel = useRef<HTMLElement>(null);
  // Made taller by its owner, the widget gives the room to the plot, not to empty space under the legend.
  const {plot, onBase} = usePlot(panel);
  const sources = useNamed(arrange.view.names);
  const lineup = useLineup();
  const hubForecasts = useForecastsOf(lineup);
  const news = useResetNews();
  const prefs = usePrefs();
  const {view} = arrange;
  // Series names and markers are text: they are rebuilt when the language changes.
  const locale = useLocale();
  // The chart moves to the period asked for at once, drawing the answer it has until the
  // next one comes. A time range is in the past: the chart shows just it, without the future.
  const selected = useTimeRange();
  // On with the next cell, when what the chart points at past its right edge comes due (drawn
  // within it then), or when a forecast is drawn no more.
  const now = useClock(now => earliest(frameChangesAt(selected, history?.cellMs ?? 60_000, now), ...moments.filter(at => at > now)));
  const codex = useResetsFor('codex');
  const past = usePastResets();

  const answered = useMemo(() => linesOf(history, sources, view, prefs.kind), [history, sources, prefs.kind, view.windows, view.hidden, view.colors, locale]);
  const lines = useMemo(() => {
    if (!strip) {registry.current = null; return answered;}
    if (registry.current?.token !== strip.token) registry.current = {token: strip.token, seed: answered, lines: answered};
    const state = registry.current;
    state.lines = lineRegistry(state.seed, state.lines, linesOf(strip, sources, view, prefs.kind));
    return state.lines;
  }, [strip, answered, sources, view, prefs.kind, locale]);

  const visible = useMemo(() => lines.filter(line => !prefs.muted[line.key]), [lines, prefs.muted]);
  const historyStart = useHistoryBegins();
  const frame = frameOf(selected, prefs, now, historyStart);
  const {from, future} = frame;
  const measured = measuredTo(frame, history, selected, prefs.range);
  // An announced Codex reset matters only where Codex is on the chart.
  const announced = frame.live && visible.some(line => line.provider === 'codex') ? (codex?.scheduled?.scheduledFor ?? null) : null;
  // The spending plan applies to weekly windows, when a line on the chart has a plan.
  const planAvailable = prefs.kind === 'weekly' && visible.some(line => planOf(view, line.sourceId) !== null);
  const planShown = planAvailable && prefs.showPlan;
  // Where each window leads, for the lines that have a forecast to draw: a weekly window as
  // the hub foresees it, from the card's last value; a five-hour one by its own pace.
  const ahead = useMemo(
    () =>
      visible.flatMap(line => {
        const source = sources.find(s => s.id === line.sourceId);
        const live = source?.windows.find(w => w.id === line.windowId);
        const measuredAt = source?.successAt ?? null;
        const forecast = live?.kind === 'weekly' ? (hubForecasts[lineup.indexOf(line.sourceId)]?.[line.windowId] ?? null) : null;
        const context: Context = {windows: source?.windows ?? [], freeResets: source?.resets?.available ?? 0, announced: announcedOf(news, line.provider, measuredAt)};
        const drawn = forecastLine(live, measuredAt, now, forecast, context, -Infinity, Infinity);
        return drawn ? [{line, drawn}] : [];
      }),
    [visible, sources, now, hubForecasts, lineup, news],
  );
  // A range in the past has no forecast, so nothing to switch.
  const forecastAvailable = frame.live && ahead.length > 0;
  const forecastShown = forecastAvailable && prefs.showForecast;
  // Without the plan or the forecast the chart ends now (an announced reset is pointed at
  // from the right edge). With either, on `auto` some future stays on the right,
  // stretched to include an announced reset when close, and to the last moment the
  // forecast says a window runs out within reach: it may take up to ~40% of the width,
  // anything further out is pointed at from the edge instead. A chosen horizon is kept as is.
  const reach = measured + (measured - from) * 0.75;
  const runOut = forecastShown ? lastRunOut(ahead.map(a => a.drawn), reach) : 0;
  const to = !(planShown || forecastShown) || !frame.live
    ? measured
    : prefs.horizon === 'auto'
      ? Math.max(
          announced && announced > measured && announced + future * 0.25 > measured + future ? Math.min(reach, announced + future * 0.25) : measured + future,
          runOut,
        )
      : measured + future;

  const markers: Marker[] = useMemo(() => {
    const list: Marker[] = [];
    if (announced && announced > from) {
      list.push({key: 'announced-codex', at: announced, label: t('chart.announcedCodex'), color: 'var(--accent)', strong: true});
    }
    const seen = new Set<string>();
    for (const line of visible) {
      const source = sources.find(s => s.id === line.sourceId);
      const live = source?.windows.find(w => w.id === line.windowId);
      // A reset is marked for a window that has started, whether or not the board plans it.
      if (!live?.resetAt || live.resetAt <= measured || live.resetAt > to || !started(live, source?.successAt ?? null)) continue;
      const key = `${line.sourceId}@${Math.round(live.resetAt / 60_000)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({key, at: live.resetAt, label: t('chart.reset', {source: source ? sourceLabel(source) : line.provider}), color: line.color});
    }
    // What happened to the sources on the chart: their limits came back early, or free resets were granted.
    for (const {event, lines: shown} of chartEvents(strip?.events ?? history?.events ?? [], visible, strip?.from ?? from)) {
      const source = sources.find(s => s.id === event.sourceId);
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
    for (const {provider, reset, line} of chartResets(past, visible, from, measured)) {
      list.push({
        key: `announced-${provider}-${reset.at}`,
        at: reset.at,
        label: t('chart.resetForAll', {source: PROVIDERS[provider]?.name ?? provider}),
        detail: reset.text,
        color: line.color,
        past: true,
      });
    }
    return list;
  }, [announced, visible, sources, history, strip, past, from, to, measured, view, locale]);

  // One plan line per distinct weekly window; windows of a source that share a reset
  // (e.g. Claude weekly and Fable) share one plan.
  const plans: PlanLine[] = useMemo(() => {
    if (!planShown) return [];
    const seen = new Map<string, PlanLine>();
    for (const line of visible) {
      const source = sources.find(s => s.id === line.sourceId);
      const live = source?.windows.find(w => w.id === line.windowId);
      const plan = planOf(view, line.sourceId);
      // Idle rolling windows (reset = now + 7 days) have not started: no plan to show.
      if (!plan || !live?.resetAt || live.minutes !== 10080 || !planAt(live, source?.successAt ?? null, now, plan)) continue;
      const key = `${line.sourceId}@${Math.round(live.resetAt / 3_600_000)}`;
      const shared = seen.get(key);
      if (shared) {
        shared.lines.push(line.key);
        continue;
      }
      seen.set(key, {
        key,
        lines: [line.key],
        color: line.color,
        runs: weeklyPlanLine(live.resetAt, from, to, plan),
      });
    }
    return [...seen.values()];
  }, [visible, sources, from, to, now, planShown, view, locale]);

  const forecasts: ForecastLine[] = useMemo(
    () =>
      !forecastShown
        ? []
        : ahead.flatMap(({line, drawn}) => {
            const points = clip(drawn.points, from, to);
            return points.length ? [{key: line.key, name: line.name, color: line.color, dash: line.dash, points, zero: drawn.zero, at: drawn.at}] : [];
          }),
    [ahead, forecastShown, from, to],
  );
  // When an announced reset the chart points at past its right edge (Chart.tsx) comes due,
  // and when a line it may draw, shown or not, is drawn no more.
  const moments = chartMoments(markers, ahead.map(a => a.drawn), to);

  return (
    <section ref={panel} className={`panel history ${loading ? 'is-loading' : ''}`} data-time="chart" aria-label={t('history.label')} aria-busy={loading}>
      <div className="panel-head">
        <h2>{t('history.title')}</h2>
        <HistorySettings arrange={arrange} planAvailable={planAvailable} forecastAvailable={forecastAvailable} horizonNote={frame.live && !planShown && !forecastShown} />
      </div>

      {history ? (
        <Chart
          lines={visible}
          plans={plans}
          forecasts={forecasts}
          markers={markers}
          from={from}
          now={measured}
          to={to}
          cellMs={history.cellMs}
          strip={strip}
          empty={lines.length ? t('chart.empty') : null}
          onSelect={setTimeRange}
          plot={plot}
          onBase={onBase}
        />
      ) : (
        <div className="chart chart-loading" style={plot === undefined ? undefined : {height: plot}}>
          {t('history.loading')}
        </div>
      )}

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
      </div>
    </section>
  );
});
