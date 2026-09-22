import {useMemo} from 'react';
import type {History as HistoryData, Kind, Overview, Win} from '../lib/types';
import {windowKey} from '../lib/types';
import {day, duration, num} from '../lib/format';
import {level, seriesName, sourceLabel} from '../lib/quota';
import {PLAN_TOLERANCE, planAt, weeklyPlanLine, type WeeklyPlan} from '../lib/plan';
import {DASHES, PROVIDERS} from '../lib/providers';
import {HORIZONS, setMuted, setPrefs, usePrefs, type Horizon} from '../lib/prefs';
import {HISTORY, planOf, withHidden, type Arrange} from '../lib/view';
import type {View} from '../lib/types';
import {Chart, type Line, type Marker, type PlanLine} from './Chart';
import type {Resets} from '../lib/resets';
import {t, useLocale} from '../i18n';
import {Segmented} from './Kit';
import {EyeOffIcon, Popover, SlidersIcon} from './Popover';

const DAY = 86_400_000;
/** How much future the chart keeps on its right when its horizon is `auto`, per range. */
const FUTURE: Record<string, number> = {'24h': 4 * 3_600_000, '7d': DAY, '30d': 3 * DAY};
const HORIZON: Record<Exclude<Horizon, 'auto'>, number> = {'1d': DAY, '3d': 3 * DAY, '7d': 7 * DAY};

type Forecast = {text: string; tone: string; title: string};

/**
 * Where the current average pace leads. Weekly windows are judged against the end of
 * their plan (everything should be spent by then); other windows against their reset.
 */
function forecast(line: Line, live: Win | undefined, now: number, weekly: WeeklyPlan): Forecast {
  const none = {text: '—', tone: '', title: ''};
  const plan = live ? planAt(live, now, weekly) : null;
  if (!live?.resetAt || live.resetAt <= now) return none;
  if (plan?.done) return {text: t('forecast.planDone'), tone: 'muted', title: t('forecast.planDoneHint')};

  const hours = line.coveredMs / 3_600_000;
  if (hours < 0.5) return {...none, title: t('forecast.needData')};
  const rate = line.consumed / hours;
  const title = t('forecast.rate', {rate: rate < 0.05 ? '≈ 0' : num(rate, 1)});
  const deadline = plan?.deadline ?? live.resetAt;

  if (rate > 0.01) {
    const untilEmpty = (live.remaining / rate) * 3_600_000;
    const untilDeadline = deadline - now;
    if (untilEmpty < untilDeadline) {
      return {text: t('forecast.runsOut', {time: duration(untilEmpty, true)}), tone: untilEmpty < untilDeadline / 2 ? 'v-crit' : 'v-warn', title};
    }
  }
  const left = Math.max(0, live.remaining - (rate * (deadline - now)) / 3_600_000);
  if (left < 5) return {text: t(plan?.weekly ? 'forecast.onPacePlan' : 'forecast.onPaceReset'), tone: '', title};
  return {text: t(plan?.weekly ? 'forecast.leftPlan' : 'forecast.leftReset', {value: num(left)}), tone: plan?.weekly ? 'muted' : '', title};
}

function SeriesTable({lines, overview, now, view}: {lines: Line[]; overview: Overview | null; now: number; view: View}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t('table.limit')}</th>
            <th>{t('table.now')}</th>
            <th title={t('table.planHint')}>{t('table.plan')}</th>
            <th>{t('table.spent')}</th>
            <th>{t('table.forecast')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(line => {
            const live = overview?.sources.find(s => s.id === line.sourceId)?.windows.find(w => w.id === line.windowId);
            const weekly = planOf(view, line.sourceId);
            const plan = live ? planAt(live, now, weekly) : null;
            const delta = plan && live ? live.remaining - plan.remaining : 0;
            const notable = Math.abs(delta) >= PLAN_TOLERANCE;
            const outlook = forecast(line, live, now, weekly);
            return (
              <tr key={line.key}>
                <td>
                  <span className="swatch" style={{background: line.color}} />
                  {line.name}
                </td>
                <td className={`v-${level(line.current)}`}>{num(line.current)}%</td>
                <td title={plan && notable ? t(delta >= 0 ? 'table.behindBy' : 'table.aheadBy', {value: num(Math.abs(delta))}) : ''}>
                  {plan ? (
                    <>
                      {num(plan.remaining)}%
                      {notable && (
                        <small className={delta < 0 ? 'v-warn' : 'muted'}>
                          {' '}
                          {delta > 0 ? '+' : '−'}
                          {num(Math.abs(delta))}
                        </small>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{line.consumed > 0 ? t('table.points', {value: num(line.consumed, 1)}) : line.coveredMs ? t('table.unused') : '—'}</td>
                <td className={outlook.tone} title={outlook.title}>
                  {outlook.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

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
      {arrange.owner && (
        <div className="popover-section">
          <button type="button" className="popover-row" onClick={() => arrange.update(view => withHidden(view, HISTORY, true))}>
            <EyeOffIcon />
            <span>{t('history.hide')}</span>
          </button>
        </div>
      )}
    </Popover>
  );
}

/** Combined history of every selected window, with its own legend and table view. */
export function History({
  history,
  overview,
  resets,
  now,
  arrange,
}: {
  history: HistoryData | null;
  overview: Overview | null;
  resets: Resets;
  now: number;
  arrange: Arrange;
}) {
  const prefs = usePrefs();
  const {view} = arrange;
  // Series names and markers are text: they are rebuilt when the language changes.
  const locale = useLocale();

  const lines: Line[] = useMemo(() => {
    if (!history) return [];
    const perSource: Record<string, number> = {};
    const hidden = new Set(view.windows);
    return history.series
      .filter(entry => entry.kind === prefs.kind && entry.points.length && !hidden.has(windowKey(entry.sourceId, entry.windowId)))
      .map(entry => {
        const index = (perSource[entry.sourceId] = (perSource[entry.sourceId] ?? -1) + 1);
        const source = overview?.sources.find(s => s.id === entry.sourceId);
        const live = source?.windows.find(w => w.id === entry.windowId);
        return {
          ...entry,
          key: windowKey(entry.sourceId, entry.windowId),
          name: seriesName(source ?? {provider: entry.provider}, entry),
          color: PROVIDERS[entry.provider]?.color ?? '#8b90b5',
          dash: DASHES[index % DASHES.length],
          current: live ? live.remaining : entry.points.at(-1)![1],
        };
      });
  }, [history, overview, prefs.kind, view.windows, locale]);

  const visible = useMemo(() => lines.filter(line => !prefs.muted[line.key]), [lines, prefs.muted]);
  const from = history ? Math.max(history.since, history.historyStart) : now - 86_400_000;
  const measuredTo = history?.now ?? now;
  const announced = resets.codex?.scheduled?.scheduledFor ?? null;
  // On `auto` some future stays on the right, stretched to include an announced reset
  // when close: it may take up to ~40% of the width, a reset further out is pointed at
  // from the right edge instead. A chosen horizon is kept as is.
  const future = prefs.horizon === 'auto' ? (FUTURE[prefs.range] ?? FUTURE['24h']) : HORIZON[prefs.horizon];
  const reach = measuredTo + (measuredTo - from) * 0.75;
  const to =
    prefs.horizon === 'auto' && announced && announced > measuredTo && announced + future * 0.25 > measuredTo + future
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
    return list;
  }, [announced, visible, overview, history, from, to, measuredTo, view, locale]);

  // One plan line per distinct weekly window; windows of a source that share a reset
  // (e.g. Claude weekly and Fable) share one plan.
  const planAvailable = prefs.kind === 'weekly' && visible.length > 0;
  const plans: PlanLine[] = useMemo(() => {
    if (!planAvailable || !prefs.showPlan) return [];
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
  }, [visible, overview, from, to, now, planAvailable, prefs.showPlan, view, locale]);

  return (
    <section className="panel history" aria-label={t('history.label')}>
      <div className="panel-head">
        <h2>{t('history.title')}</h2>
        <div className="controls">
          <Segmented
            value={prefs.kind}
            onChange={value => setPrefs({kind: value as Kind})}
            options={[
              ['weekly', t('history.weekly')],
              ['session', t('history.session')],
            ]}
            label={t('history.kind')}
          />
          <Segmented
            value={prefs.range}
            onChange={value => setPrefs({range: value})}
            options={[
              ['24h', t('history.hours', {count: 24})],
              ['7d', t('history.days', {count: 7})],
              ['30d', t('history.days', {count: 30})],
            ]}
            label={t('history.range')}
          />
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
      {history && <SeriesTable lines={lines} overview={overview} now={now} view={view} />}
      {history && history.since < history.historyStart && (
        <p className="footnote">{t('history.since', {date: day(history.historyStart)})}</p>
      )}
    </section>
  );
}
