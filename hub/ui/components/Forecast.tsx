import {useMemo} from 'react';
import type {History as HistoryData, Overview, Win} from '../lib/types';
import {duration, num} from '../lib/format';
import {level} from '../lib/quota';
import {PLAN_TOLERANCE, planAt, type WeeklyPlan} from '../lib/plan';
import {FORECAST, planOf, withHidden, type Arrange} from '../lib/view';
import {linesOf, type Line} from '../lib/lines';
import {setPrefs, usePrefs} from '../lib/prefs';
import {t, useLocale} from '../i18n';
import {HideRow, Popover, SlidersIcon} from './Popover';
import {KindSwitch, PeriodSwitch} from './History';

type Outlook = {text: string; tone: string; title: string};

/**
 * Where the average pace over the period leads. Weekly windows are judged against the
 * end of their plan (everything should be spent by then); other windows, and a week past
 * the end of its plan, against their reset.
 */
function outlook(line: Line, live: Win | undefined, measuredAt: number | null, now: number, weekly: WeeklyPlan | null): Outlook {
  const none = {text: '—', tone: '', title: ''};
  const plan = live ? planAt(live, measuredAt, now, weekly) : null;
  if (live && live.remaining <= 0) return {text: t('forecast.usedUp'), tone: 'v-crit', title: ''};
  if (!live?.resetAt || live.resetAt <= now) return none;

  const hours = line.coveredMs / 3_600_000;
  if (hours < 0.5) return {...none, title: t('forecast.needData')};
  const rate = line.consumed / hours;
  const title = t('forecast.rate', {rate: rate < 0.05 ? '≈ 0' : num(rate, 1)});
  // Past the end of its plan a week has only its reset ahead.
  const planned = plan?.weekly && !plan.done;
  const deadline = planned ? plan.deadline : live.resetAt;

  if (rate > 0.01) {
    const untilEmpty = (live.remaining / rate) * 3_600_000;
    const untilDeadline = deadline - now;
    if (untilEmpty < untilDeadline) {
      return {text: t('forecast.runsOut', {time: duration(untilEmpty, true)}), tone: untilEmpty < untilDeadline / 2 ? 'v-crit' : 'v-warn', title};
    }
  }
  const left = Math.max(0, live.remaining - (rate * (deadline - now)) / 3_600_000);
  if (left < 5) return {text: t(planned ? 'forecast.onPacePlan' : 'forecast.onPaceReset'), tone: '', title};
  return {text: t(planned ? 'forecast.leftPlan' : 'forecast.leftReset', {value: num(left)}), tone: planned ? 'muted' : '', title};
}

/**
 * The windows of one kind: what is left, what the plan expects, what the period spent,
 * and where that pace leads. Its period and kind are its own, not the chart's.
 */
export function Forecast({
  history,
  loading,
  overview,
  now,
  arrange,
}: {
  history: HistoryData | null;
  /** Another period is loading; `history` is the previous one until it comes. */
  loading: boolean;
  overview: Overview | null;
  now: number;
  arrange: Arrange;
}) {
  const {view} = arrange;
  const {tableKind: kind, tableRange} = usePrefs();
  // Window names are text: they are rebuilt when the language changes.
  const locale = useLocale();
  const lines = useMemo(() => linesOf(history, overview, view, kind), [history, overview, view.windows, view.hidden, kind, locale]);

  return (
    <section className={`panel forecast ${loading ? 'is-loading' : ''}`} aria-label={t('forecast.title')} aria-busy={loading}>
      <div className="panel-head">
        <h2>{t('forecast.title')}</h2>
        <div className="controls">
          <KindSwitch value={kind} onChange={tableKind => setPrefs({tableKind})} />
          <PeriodSwitch value={tableRange} onChange={next => setPrefs({tableRange: next})} />
          {arrange.owner && (
            <Popover label={t('forecast.settings')} icon={<SlidersIcon />}>
              <HideRow onHide={() => arrange.update(next => withHidden(next, FORECAST, true))}>{t('widget.hide')}</HideRow>
            </Popover>
          )}
        </div>
      </div>
      {!history ? (
        <div className="panel-loading">{t('history.loading')}</div>
      ) : !lines.length ? (
        <p className="panel-empty">{t('forecast.empty')}</p>
      ) : (
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
                const source = overview?.sources.find(s => s.id === line.sourceId);
                const live = source?.windows.find(w => w.id === line.windowId);
                const measuredAt = source?.successAt ?? null;
                const weekly = planOf(view, line.sourceId);
                const plan = live ? planAt(live, measuredAt, now, weekly) : null;
                const delta = plan && live && live.remaining > 0 ? live.remaining - plan.remaining : 0;
                const notable = Math.abs(delta) >= PLAN_TOLERANCE;
                const ahead = outlook(line, live, measuredAt, now, weekly);
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
                    <td className={ahead.tone} title={ahead.title}>
                      {ahead.text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
