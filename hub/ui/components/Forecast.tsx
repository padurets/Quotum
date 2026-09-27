import {memo, useMemo} from 'react';
import type {Win} from '../lib/types';
import {countdown, num, stamp} from '../lib/format';
import {level} from '../lib/quota';
import {outlook, outlookChangesAt, planCell, spentOf, type Outlook, type Pace, type Spent} from '../lib/forecast';
import {planChangesAt, type WeeklyPlan} from '../lib/plan';
import {FORECAST, planOf, withHidden, type Arrange} from '../lib/view';
import {linesOf} from '../lib/lines';
import {usePrefs} from '../lib/prefs';
import {ofTimeRange} from '../lib/timeRange';
import {useNamed} from '../lib/board';
import {useClock} from '../lib/clock';
import {useHistory} from '../lib/history';
import {t, useLocale} from '../i18n';
import {HideRow, Popover, SlidersIcon} from './Popover';

/** How fast the window goes, as the tooltip of its forecast says it. */
const paceText = (pace: Pace) =>
  pace.by === 'plan' ? t('forecast.planPace', {k: num(pace.k, 2)}) : t('forecast.rate', {rate: pace.rate < 0.05 ? '≈ 0' : num(pace.rate, 1)});

/** The last column's text and tooltip, a part a line; its colour is the outlook's tone. */
function outlookCell(ahead: Outlook): {text: string; title: string} {
  switch (ahead.key) {
    case 'none':
      return {text: '—', title: ''};
    case 'idle':
    case 'needData':
      return {text: '—', title: t(`forecast.${ahead.key}`)};
    case 'pastZero':
      return {text: '—', title: [t('forecast.pastZero', {time: stamp(ahead.at)}), t('forecast.awaiting')].join('\n')};
    case 'usedUp':
      return {text: t('forecast.usedUp'), title: ''};
  }
  const title = paceText(ahead.pace);
  switch (ahead.key) {
    case 'runsOut':
      return {text: t('forecast.runsOut', {time: countdown(ahead.inMs)}), title: [title, t('forecast.runsOutAt', {time: stamp(ahead.at)})].join('\n')};
    case 'onPacePlan':
    case 'onPaceReset':
      return {text: t(`forecast.${ahead.key}`), title};
    case 'leftPlan':
    case 'leftReset':
      return {text: t(`forecast.${ahead.key}`, {value: num(ahead.left)}), title};
  }
}

const spentText = (spent: Spent) => (spent.key === 'points' ? t('table.points', {value: num(spent.value, 1)}) : spent.key === 'unused' ? t('table.unused') : '—');

/** What a limit's cells need to say what they say now. */
type LimitNow = {live: Win | undefined; measuredAt: number | null; weekly: WeeklyPlan | null};

/**
 * The plan's column of a limit: what the plan expects to be left now, and the gap to it.
 * A part of its own, moved when what it shows changes, as the mark on the card is.
 */
function PlanCell({live, measuredAt, weekly}: LimitNow) {
  const now = useClock(now => (live ? planChangesAt(live, measuredAt, now, weekly) : null));
  const plan = planCell(live, measuredAt, now, weekly);
  return (
    <td data-time="plan" title={plan?.notable ? t(plan.delta >= 0 ? 'table.behindBy' : 'table.aheadBy', {value: num(Math.abs(plan.delta))}) : ''}>
      {plan ? (
        <>
          {num(plan.remaining)}%
          {plan.notable && (
            <small className={plan.delta < 0 ? 'v-warn' : 'muted'}>
              {' '}
              {plan.delta > 0 ? '+' : '−'}
              {num(Math.abs(plan.delta))}
            </small>
          )}
        </>
      ) : (
        '—'
      )}
    </td>
  );
}

/** Where the window's pace leads: a part of its own, rendered when that reads otherwise. */
function OutlookCell({live, measuredAt, weekly}: LimitNow) {
  const now = useClock(now => outlookChangesAt(live, measuredAt, now, weekly));
  const ahead = outlook(live, measuredAt, now, weekly);
  const cell = outlookCell(ahead);
  return (
    <td data-time="forecast" className={ahead.tone} title={cell.title}>
      {cell.text}
    </td>
  );
}

/** How long a line must have been measured without gaps for its pace to mean something. */
const PACE_FROM = 10 * 60_000;

/**
 * The windows of one kind: what is left, what the plan expects, what the period spent,
 * and where each window's own pace leads, whatever the period. Its period and window type are the analytics', as the chart's. Over a
 * time range selected on the chart, which is in the past, it shows that range instead:
 * what was left at its start and its end, what it spent and how fast. What in it changes
 * with time (the plan, where the pace leads) are parts of their own.
 */
export const Forecast = memo(function Forecast({arrange}: {arrange: Arrange}) {
  const {history, loading} = useHistory();
  const sources = useNamed(arrange.view.names);
  const {view} = arrange;
  const {kind} = usePrefs();
  const selected = ofTimeRange(history);
  // Window names are text: they are rebuilt when the language changes.
  const locale = useLocale();
  const lines = useMemo(() => linesOf(history, sources, view, kind), [history, sources, view.windows, view.hidden, view.colors, kind, locale]);

  return (
    <section
      className={`panel forecast ${selected ? 'is-range' : ''} ${loading ? 'is-loading' : ''}`}
      aria-label={t('forecast.title')}
      aria-busy={loading}
    >
      <div className="panel-head">
        <h2>{t('forecast.title')}</h2>
        {arrange.owner && (
          <Popover label={t('forecast.settings')} icon={<SlidersIcon />}>
            <HideRow onHide={() => arrange.update(next => withHidden(next, FORECAST, true))}>{t('widget.hide')}</HideRow>
          </Popover>
        )}
      </div>
      {!history ? (
        <div className="panel-loading">{t('history.loading')}</div>
      ) : !lines.length ? (
        <p className="panel-empty">{t('forecast.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              {selected ? (
                <tr>
                  <th>{t('table.limit')}</th>
                  <th>{t('table.atStart')}</th>
                  <th>{t('table.atEnd')}</th>
                  <th>{t('table.spentInRange')}</th>
                  <th title={t('table.paceHint')}>{t('table.pace')}</th>
                </tr>
              ) : (
                <tr>
                  <th>{t('table.limit')}</th>
                  <th>{t('table.now')}</th>
                  <th title={t('table.planHint')}>{t('table.plan')}</th>
                  <th>{t('table.spent')}</th>
                  <th title={t('table.forecastHint')}>{t('table.forecast')}</th>
                </tr>
              )}
            </thead>
            <tbody>
              {lines.map(line => {
                const name = (
                  <td>
                    <span className="swatch" style={{background: line.color}} />
                    {line.name}
                  </td>
                );
                if (selected) {
                  const spent = <td>{spentText(spentOf(line))}</td>;
                  const edge = (value: number | null) => (value === null ? <td>—</td> : <td className={`v-${level(value)}`}>{num(value)}%</td>);
                  return (
                    <tr key={line.key}>
                      {name}
                      {edge(line.remainingAtStart)}
                      {edge(line.remainingAtEnd)}
                      {spent}
                      <td>{line.coveredMs >= PACE_FROM ? t('table.perHour', {value: num(line.consumed / (line.coveredMs / 3_600_000), 1)}) : '—'}</td>
                    </tr>
                  );
                }
                const source = sources.find(s => s.id === line.sourceId);
                const limit = {live: source?.windows.find(w => w.id === line.windowId), measuredAt: source?.successAt ?? null, weekly: planOf(view, line.sourceId)};
                return (
                  <tr key={line.key}>
                    {name}
                    <td className={`v-${level(line.current)}`}>{num(line.current)}%</td>
                    <PlanCell {...limit} />
                    <td>{spentText(spentOf(line))}</td>
                    <OutlookCell {...limit} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});
