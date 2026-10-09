import {AnalyticsPanel, AnalyticsNote, SeriesLegendItem} from './AnalyticsPanel';
import {memo, useLayoutEffect, useRef} from 'react';
import {earliest, num} from '../lib/format';
import {sourceLabel} from '../lib/quota';
import {planAt, started, weeklyPlanLinePrepared} from '../lib/plan';
import {announcedOf, forecastLinePrepared, type Context} from '../lib/forecast';
import {PROVIDERS} from '../lib/providers';
import {setMuted, setPrefs, usePrefs} from '../lib/prefs';
import {setTimeRange, timeRangeKey, useTimeRange} from '../lib/timeRange';
import {frameChangesAt, frameOf, measuredTo} from '../lib/periods';
import {QUOTA_HISTORY, planOf, withHidden, type Arrange} from '../lib/view';
import {chartEventsPrepared, chartResetsPrepared, type PlotLine} from '../lib/lines';
import {subscriptionLinesPrepared,subscriptionPlotLinesPrepared,subscriptionOverflow} from '../lib/subscription';
import {lineRegistry} from '../lib/plotRegistry';
import {Chart, type Marker} from './Chart';
import {chartMoments, type ForecastLine, type PlanLine} from '../lib/readout';
import {useBoardId, useForecastsOf, useLineup, useNamed, usePastResets, useResetNews, useResetsFor} from '../lib/board';
import {useClock} from '../lib/clock';
import {quotaHistory, useHistory, useHistoryBegins, useHistoryPlot} from '../lib/history';
import {t, useLocale} from '../i18n';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';
import {usePlot} from './sizing';
import {pan, usePanning} from '../lib/pan';
import {usePrepared} from './prepared';
import {axisNavigation, navigationKey} from '../lib/axisNavigation';
import {historyProjection, type ProjectionHints} from '../lib/historyProjection';

/**
 * The chart's own settings: whether it draws the plan and the forecast (where either has
 * something to draw), how far it looks ahead, and (for the board's owner) hiding it.
 * Its note says the look ahead needs the plan or the forecast, where a period ending now
 * has neither; a range in the past has no future at all.
 */
function HistorySettings({arrange, planAvailable, forecastAvailable}: {arrange: Arrange; planAvailable: boolean; forecastAvailable: boolean}) {
  const {showPlan, showForecast} = usePrefs();
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
      {arrange.owner && <HideRow onHide={() => arrange.update(view => withHidden(view, QUOTA_HISTORY, true))}>{t('widget.hide')}</HideRow>}
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
const WindowHistory = memo(function WindowHistory({arrange}: {arrange: Arrange}) {
  const {history, loading,error} = useHistory();
  const strip = useHistoryPlot();
  const registry = useRef<{token: number; seed: PlotLine[]; lines: PlotLine[]} | null>(null);
  const panel = useRef<HTMLElement>(null);
  // Made taller by its owner, the widget gives the room to the plot, not to empty space under the legend.
  const {plot, onBase} = usePlot(panel);
  const sources = useNamed(arrange.view.names,'quota');
  const lineup = useLineup();
  const hubForecasts = useForecastsOf(lineup);
  const news = useResetNews();
  const prefs = usePrefs();
  const {view} = arrange;
  const omitted=subscriptionOverflow(sources,view);
  // Series names and markers are text: they are rebuilt when the language changes.
  const locale = useLocale();
  // The chart moves to the period asked for at once, drawing the answer it has until the
  // next one comes. A time range is in the past: the chart shows just it, without the future.
  const selected = useTimeRange();
  const answered = history?.range === (selected ? timeRangeKey(selected) : prefs.range);
  const board = useBoardId();
  const navigation = axisNavigation(board, selected, prefs);
  // On with the next cell, when what the chart points at past its right edge comes due (drawn
  // within it then), or when a forecast is drawn no more.
  const codex = useResetsFor('codex');
  const past = usePastResets();
  const clockNow = useClock(now => earliest(frameChangesAt(selected, history?.cellMs ?? 60_000, now), ...moments.filter(at => at > now)), [history, strip, sources, hubForecasts, lineup, news, prefs, selected, view, locale, codex, past]);
  const panning = usePanning();
  const captured = useRef<{token: number; now: number; lookAhead: number; sources: typeof sources; forecasts: typeof hubForecasts; lineup: typeof lineup; news: typeof news; codex: typeof codex; view: typeof view} | null>(null);
  if (panning === null) captured.current = null;
  else if (captured.current?.token !== panning) captured.current = {token: panning, now: Math.max(clockNow, pan.get()?.originEnd ?? clockNow), lookAhead: pan.get()?.lookAhead ?? 0, sources, forecasts: hubForecasts, lineup, news, codex, view};
  const context = panning !== null ? captured.current : null;
  const now = context?.now ?? clockNow;
  const futureSources = context?.sources ?? sources;
  const futureForecasts = context?.forecasts ?? hubForecasts;
  const futureLineup = context?.lineup ?? lineup;
  const futureNews = context?.news ?? news;
  const futureCodex = context?.codex ?? codex;
  const futureView = context?.view ?? view;

  const historyStart = useHistoryBegins();
  const frame = frameOf(selected, prefs, now, historyStart);
  const from = frame.from;
  const measured = measuredTo(frame, history, selected, prefs.range);
  const prepared = usePrepared(function* () {
    const answered = yield* subscriptionLinesPrepared(history, sources, view, prefs.kind);
    let lines: PlotLine[] = answered;
    let nextRegistry: typeof registry.current = null;
    if (strip) {
      const previous = registry.current?.token === strip.token ? registry.current : {token: strip.token, seed: answered, lines: answered};
      const eligibleSeed = previous.seed.filter(line => answered.some(current => current.key === line.key));
      lines = lineRegistry(eligibleSeed, previous.lines, yield* subscriptionPlotLinesPrepared(strip, sources, view, prefs.kind));
      nextRegistry = {token: strip.token, seed: previous.seed, lines};
    }
    const visible: PlotLine[] = [];
    for (const line of lines) {if (!prefs.muted[line.key]) visible.push(line); yield;}
    const scheduled = visible.some(line => line.provider === 'codex') ? (futureCodex?.scheduled?.scheduledFor ?? null) : null;
    const announced = frame.live ? scheduled : null;
    const planAvailable = prefs.kind === 'weekly' && visible.some(line => !line.capCells&&planOf(view, line.sourceId) !== null);
    const planShown = planAvailable && prefs.showPlan;
    const ahead: {line: PlotLine; drawn: NonNullable<ReturnType<typeof forecastLinePrepared> extends Generator<void, infer R, void> ? R : never>}[] = [];
    for (const line of visible) {
      const source = futureSources.find(s => s.id === line.sourceId);
      const live = source?.windows.find(w => w.id === line.windowId);
      const measuredAt = source?.successAt ?? null;
      const forecast = live?.kind === 'weekly' ? (futureForecasts[futureLineup.indexOf(line.sourceId)]?.[line.windowId] ?? null) : null;
      const context: Context = {windows: source?.windows ?? [], freeResets: source?.resets?.available ?? 0, announced: announcedOf(futureNews, line.provider, measuredAt)};
      const drawn = yield* forecastLinePrepared(live, measuredAt, now, forecast, context, -Infinity, Infinity);
      if (drawn) ahead.push({line, drawn}); yield;
    }
    const forecastAvailable = frame.live && ahead.length > 0;
    const forecastShown = forecastAvailable && prefs.showForecast;
    const hints: ProjectionHints = {plan: planAvailable, forecast: ahead.length > 0, announced: scheduled, zeros: ahead.map(a => a.drawn.zero)};
    const to = historyProjection(frame, measured, prefs, hints, context?.lookAhead);
    const markers: Marker[] = [];
    if (announced && announced > from) markers.push({key: 'announced-codex', at: announced, label: t('chart.announcedCodex'), color: 'var(--accent)', strong: true});
    const seen = new Set<string>();
    for (const line of visible) {
      yield;
      const source = sources.find(s => s.id === line.sourceId), live = source?.windows.find(w => w.id === line.windowId);
      const resetAt=line.capCells?source?.meters?.find(m=>m.id===line.windowId)?.resetAt:live?.resetAt;
      if (!resetAt || resetAt <= measured || !line.capCells&&(!live||!started(live,source?.successAt??null))) continue;
      const key = `${line.sourceId}@${Math.round(resetAt / 60_000)}`;
      if (seen.has(key)) continue;
      seen.add(key); markers.push({key, at: resetAt, until: resetAt, label: t('chart.reset', {source: source ? sourceLabel(source) : line.provider}), color: line.color});
    }
    for (const {event, lines: shown} of yield* chartEventsPrepared(strip?.events ?? history?.events ?? [], visible, strip?.from ?? from)) {
      const source = sources.find(s => s.id === event.sourceId), name = source ? sourceLabel(source) : shown[0].provider;
      markers.push({key: `${event.kind}-${event.sourceId}-${event.at}`, at: event.at, label: event.kind === 'early_reset' ? t('chart.earlyReset', {source: name}) : t('chart.resetsGranted', {count: event.count, source: name}), color: shown[0].color, past: true}); yield;
    }
    for (const {provider, reset, line} of yield* chartResetsPrepared(past, visible, strip?.from ?? from, strip?.to ?? measured)) {
      markers.push({key: `announced-${provider}-${reset.at}`, at: reset.at, label: t('chart.resetForAll', {source: PROVIDERS[provider]?.name ?? provider}), detail: reset.text, color: line.color, past: true}); yield;
    }
    const plans = new Map<string, PlanLine>();
    if (planShown) for (const line of visible) {
      yield;
      const source = futureSources.find(s => s.id === line.sourceId), live = source?.windows.find(w => w.id === line.windowId), plan = planOf(futureView, line.sourceId);
      if (!plan || !live?.resetAt || live.minutes !== 10080 || !planAt(live, source?.successAt ?? null, now, plan)) continue;
      const key = `${line.sourceId}@${Math.round(live.resetAt / 3_600_000)}`, shared = plans.get(key);
      if (shared) {shared.lines.push(line.key); continue;}
      plans.set(key, {key, lines: [line.key], color: line.color, until: live.resetAt, runs: yield* weeklyPlanLinePrepared(live.resetAt, live.resetAt - 7 * 86_400_000, live.resetAt + 4 * 7 * 86_400_000, plan)});
    }
    const forecasts: ForecastLine[] = [];
    if (forecastShown) for (const {line, drawn} of ahead) {
      const points = drawn.points;
      if (points.length) forecasts.push({key: line.key, name: line.name, color: line.color, dash: line.dash, points, zero: drawn.zero, at: drawn.at, until: drawn.until}); yield;
    }
    return {futureFacts: ahead.map(a => ({zero: a.drawn.zero, until: a.drawn.until})), hints, lines, visible, markers, plans: [...plans.values()], forecasts, to, from, measured, now: strip ? now : measured, cellMs: strip?.cell ?? history?.cellMs ?? 60_000, strip, frame, planAvailable, forecastAvailable, planShown, forecastShown, moments: [...chartMoments(markers, ahead.map(a => a.drawn), to), ...[...plans.values()].map(plan => plan.until!)], registry: nextRegistry};
  }, [history, strip, sources, view, prefs, locale, futureSources, futureForecasts, futureLineup, futureNews, futureCodex, futureView, navigationKey(navigation)], `${history?.board}:${prefs.kind}`);
  const model = prepared.value;
  useLayoutEffect(() => {if (model) registry.current = model.registry;}, [model]);
  const lines = model?.lines ?? [];
  const moments = model?.moments ?? [];
  const currentHints = model ? {...model.hints, forecast: model.futureFacts.some(forecast => now < forecast.until), zeros: model.futureFacts.filter(forecast => now < forecast.until).map(forecast => forecast.zero)} : null;
  const wantedTo = historyProjection(frame, measured, prefs, currentHints, context?.lookAhead);

  return (
    <AnalyticsPanel ref={panel} className="history" title={t('history.title')} chart history={history} loading={loading} error={error} retry={quotaHistory.retry}
      settings={<HistorySettings arrange={arrange} planAvailable={model?.planAvailable ?? false} forecastAvailable={frame.live && (currentHints?.forecast ?? false)}/>}
    >
      {omitted > 0 && <AnalyticsNote>{t('history.quotaOverflow', {count: omitted})}</AnalyticsNote>}
      <Chart
          lines={model?.visible ?? []}
          plans={model?.plans}
          forecasts={model?.forecasts}
          markers={model?.markers}
          from={from}
          now={strip ? now : measured}
          to={wantedTo}
          navigation={navigation}
          live={frame.live}
          clock={now}
          cellMs={model?.cellMs ?? history?.cellMs ?? 60_000}
          strip={model?.strip ?? null}
          prepared={prepared.ready && (panning !== null || answered || !!error)}
          modelContext={`${history?.board}:${prefs.kind}`}
          empty={error ? null : !history ? t('history.loading') : lines.length ? t('analytics.allMuted') : t('history.noLines')}
          onSelect={setTimeRange}
          plot={plot}
          onBase={onBase}
        />

      <div className="legend">
        {lines.map(line => (
          <SeriesLegendItem key={line.key} name={line.name} color={line.color} dash={line.dash} muted={!!prefs.muted[line.key]} onToggle={() => setMuted(line.key, !prefs.muted[line.key])}>
            <b>{line.current === null ? '—' : `${num(line.current)}%`}</b>
          </SeriesLegendItem>
        ))}
        {!!history && !lines.length && !error && <span className="legend-empty">{t('history.noLines')}</span>}
      </div>
    </AnalyticsPanel>
  );
});

export const History = WindowHistory;
