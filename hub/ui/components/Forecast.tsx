import {memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {MINUTE, useNow} from '../lib/api';
import type {History as HistoryData, Overview, SeriesWork} from '../lib/types';
import {countdown, duration, num, rateText, shareText, stamp, workHours} from '../lib/format';
import {level} from '../lib/quota';
import {FORECAST_WIDTHS, LIVE_COLUMNS, RANGE_COLUMNS, forecastLayout, forecastRow, spentOf, type ForecastColumn, type Outlook, type Pace, type Spent} from '../lib/forecast';
import {dashOf, lineWork, workNotes, type DashText, type WorkCell, type WorkColumn} from '../lib/work';
import {FORECAST, columnShown, planOf, withColumn, withHidden, type Arrange} from '../lib/view';
import {linesOf, type Line} from '../lib/lines';
import {usePrefs} from '../lib/prefs';
import {ofTimeRange} from '../lib/timeRange';
import {t, useLocale, type Key} from '../i18n';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';

/** How fast the window goes, as the tooltip of its forecast says it. */
const paceText = (pace: Pace) =>
  pace.by === 'plan' ? t('forecast.planPace', {k: num(pace.k, 2)}) : t('forecast.rate', {rate: rateText(pace.rate)});

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

/** How long a line must have been measured without gaps for its pace to mean something. */
const PACE_FROM = 10 * 60_000;

/** A column's heading (over a range where it differs) and what its tooltip explains. */
const HEADINGS: Record<ForecastColumn, {title: Key; range?: Key; hint?: Key}> = {
  now: {title: 'table.now'},
  plan: {title: 'table.plan', hint: 'table.planHint'},
  start: {title: 'table.atStart'},
  end: {title: 'table.atEnd'},
  spent: {title: 'table.spent', range: 'table.spentInRange'},
  pace: {title: 'table.pace', hint: 'table.paceHint'},
  work: {title: 'table.work', hint: 'table.workHint'},
  perwork: {title: 'table.perWork', hint: 'table.perWorkHint'},
  during: {title: 'table.during', hint: 'table.duringHint'},
  forecast: {title: 'table.forecast', hint: 'table.forecastHint'},
  workleft: {title: 'table.workLeft', hint: 'table.workLeftHint'},
};

const heading = (column: ForecastColumn, range: boolean) => t((range && HEADINGS[column].range) || HEADINGS[column].title);

/** Why a cell about agent work is a dash. */
const REASONS: Record<DashText, Key> = {
  none: 'work.none',
  noneSince: 'work.noneSince',
  short: 'work.short',
  nospend: 'work.noSpend',
  nospendSince: 'work.noSpendSince',
  slow: 'work.slow',
  awaiting: 'forecast.awaiting',
};

type Cell = {content: ReactNode; title?: string; className?: string};

/**
 * A cell about agent work, with a tooltip of a part a line: what an hour of work spent
 * for the forecast (`perWork`), how much work that and the share are taken over, that the
 * share is an upper bound, that little of the spending came during work, since when work is
 * known, or why there is no number.
 */
function workCell(column: WorkColumn, cell: WorkCell, work: SeriesWork, periodFrom: number, resetAt: number | null, perWork: number | null): Cell {
  const notes = workNotes(work, periodFrom);
  const known = (at: number | null) => (at !== null ? [t('work.since', {time: stamp(at)})] : []);
  if ('none' in cell) {
    if (cell.none === 'unknown') return {content: '—', title: t('work.unknown', {time: stamp(work.from)})};
    const dash = dashOf(cell.none, notes.since);
    return {content: '—', title: [t(REASONS[dash.text], {time: notes.since === null ? '' : stamp(notes.since)}), ...known(dash.knownFrom)].join('\n')};
  }
  const paced = column === 'perwork' || column === 'workleft';
  const lines = [
    ...(column === 'workleft' && perWork !== null ? [t('work.basis', {value: rateText(perWork)})] : []),
    ...(column !== 'work' && notes.basis !== null ? [t('work.basisMeasured', {time: workHours(notes.basis)})] : []),
    ...(paced && notes.share !== null ? [t('work.lowShare', {value: shareText(notes.share)})] : []),
    ...(column === 'during' ? [t('work.upperBound')] : []),
    ...known(notes.since),
  ];
  // Nothing left, whatever is known of the work: as the forecast by time says it, with nothing to add.
  if ('usedUp' in cell) return {content: t('work.usedUp')};
  if ('untilReset' in cell) return {content: t('work.untilReset'), title: [t('work.untilResetHint', {time: workHours(cell.untilReset), reset: stamp(resetAt!)}), ...lines].join('\n')};
  if ('outlasts' in cell) return {content: t('work.untilReset'), title: [t('work.outlastsHint', {time: workHours(cell.outlasts), window: duration(cell.windowMs)}), ...lines].join('\n')};
  const content =
    column === 'work'
      ? workHours(cell.value)
      : column === 'perwork'
        ? t('table.perHour', {value: rateText(cell.value)})
        : column === 'workleft'
          ? t('work.left', {time: workHours(cell.value)})
          : t('work.during', {value: shareText(cell.value)});
  return {content, title: lines.join('\n') || undefined};
}

/**
 * The windows of one kind, from what is left to where it leads: what is left and what the
 * plan expects; what the period spent, how long agents worked on each window's
 * subscription meanwhile, what an hour of their work spent and how much of the spending
 * fell into their work; then two forecasts, by the time on the clock (where each window's
 * own pace since it started leads, whatever the period) and by work (how many hours agents
 * can go on at what an hour of their work spent). Its period and window type are the
 * analytics', as the chart's. Over a time range selected on the chart, which is in the
 * past, it shows that range instead: what was left at its start and its end, what it spent
 * in all and per hour, and its agents' work. The board's owner chooses the columns; where
 * they do not fit the widget, each window is a row of a list.
 */
export const Forecast = memo(function Forecast({
  history,
  loading,
  overview,
  arrange,
}: {
  history: HistoryData | null;
  /** Another period is loading; `history` is the previous one until it comes. */
  loading: boolean;
  overview: Overview | null;
  arrange: Arrange;
}) {
  const now = useNow(MINUTE);
  const {view} = arrange;
  const {kind} = usePrefs();
  const selected = ofTimeRange(history);
  const range = !!selected;
  // Window names are text: they are rebuilt when the language changes.
  const locale = useLocale();
  const lines = useMemo(() => linesOf(history, overview, view, kind), [history, overview, view.windows, view.hidden, view.colors, kind, locale]);
  const modeColumns = range ? RANGE_COLUMNS : LIVE_COLUMNS;
  const columns = useMemo(() => modeColumns.filter(column => columnShown(view, FORECAST, column)), [modeColumns, view]);
  const panel = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<'table' | 'list'>('table');

  // Before the first paint: the table does not flash on a narrow widget.
  useLayoutEffect(() => {
    const element = panel.current!;
    const fit = () => {
      const next = forecastLayout(columns, element.clientWidth);
      setLayout(before => (before === next ? before : next));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => observer.disconnect();
  }, [columns]);

  /** Every cell of a line, by column. */
  const cellsOf = (line: Line): Record<ForecastColumn, Cell> => {
    const source = overview?.sources.find(s => s.id === line.sourceId);
    const live = source?.windows.find(w => w.id === line.windowId);
    const resetAt = live?.resetAt ?? null;
    const edge = (value: number | null): Cell => (value === null ? {content: '—'} : {content: `${num(value)}%`, className: `v-${level(value)}`});
    const work = lineWork(line, range, resetAt, now);
    const perWork = work && 'value' in work.perwork ? work.perwork.value : null;
    const workCells = Object.fromEntries(
      (['work', 'perwork', 'workleft', 'during'] as const).map(column => [column, work && line.work ? workCell(column, work[column], line.work, history!.since, resetAt, perWork) : {content: '—'}]),
    ) as Record<WorkColumn, Cell>;
    if (range) {
      return {
        ...workCells,
        start: edge(line.remainingAtStart),
        end: edge(line.remainingAtEnd),
        spent: {content: spentText(spentOf(line))},
        pace: {content: line.coveredMs >= PACE_FROM ? t('table.perHour', {value: rateText(line.consumed / (line.coveredMs / 3_600_000))}) : '—'},
      } as Record<ForecastColumn, Cell>;
    }
    const row = forecastRow(line, live, source?.successAt ?? null, now, planOf(view, line.sourceId));
    const {plan} = row;
    const ahead = outlookCell(row.outlook);
    return {
      ...workCells,
      now: {content: `${num(line.current)}%`, className: `v-${level(line.current)}`},
      plan: {
        title: plan?.notable ? t(plan.delta >= 0 ? 'table.behindBy' : 'table.aheadBy', {value: num(Math.abs(plan.delta))}) : undefined,
        content: plan ? (
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
        ),
      },
      spent: {content: spentText(row.spent)},
      forecast: {content: ahead.text, title: ahead.title || undefined, className: row.outlook.tone},
    } as Record<ForecastColumn, Cell>;
  };

  // In the list, what is left leads each row; the rest follows under the name, each value with its heading.
  const lead: ForecastColumn = range ? 'end' : 'now';
  const details = columns.filter(column => column !== lead);

  return (
    <section ref={panel} className={`panel forecast ${loading ? 'is-loading' : ''}`} aria-label={t('forecast.title')} aria-busy={loading}>
      <div className="panel-head">
        <h2>{t('forecast.title')}</h2>
        {arrange.owner && (
          <Popover label={t('forecast.settings')} icon={<SlidersIcon />}>
            <div className="popover-title">{t('table.columns')}</div>
            {modeColumns.map(column => (
              <SwitchRow key={column} on={columns.includes(column)} onChange={on => arrange.update(next => withColumn(next, FORECAST, column, on))}>
                {heading(column, range)}
              </SwitchRow>
            ))}
            <HideRow onHide={() => arrange.update(next => withHidden(next, FORECAST, true))}>{t('widget.hide')}</HideRow>
          </Popover>
        )}
      </div>
      {!history ? (
        <div className="panel-loading">{t('history.loading')}</div>
      ) : !lines.length ? (
        <p className="panel-empty">{t('forecast.empty')}</p>
      ) : layout === 'list' ? (
        <ul className="forecast-compact">
          {lines.map(line => {
            const cells = cellsOf(line);
            return (
              <li key={line.key}>
                <div className="forecast-compact-main">
                  <span className="swatch" style={{background: line.color}} />
                  <span className="forecast-compact-name">{line.name}</span>
                  {columns.includes(lead) && (
                    <span className={cells[lead].className} title={cells[lead].title}>
                      <span className="sr-only">{heading(lead, range)}: </span>
                      {cells[lead].content}
                    </span>
                  )}
                </div>
                {details.length > 0 && (
                  <div className="forecast-compact-details">
                    {details.map(column => (
                      <span key={column} title={cells[column].title}>
                        {heading(column, range)} <span className={cells[column].className}>{cells[column].content}</span>
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="table-wrap">
          <table>
            <colgroup>
              <col />
              {columns.map(column => (
                <col key={column} style={{width: FORECAST_WIDTHS[column]}} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th>{t('table.limit')}</th>
                {columns.map(column => (
                  <th key={column} title={HEADINGS[column].hint ? t(HEADINGS[column].hint!) : undefined}>
                    {heading(column, range)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map(line => {
                const cells = cellsOf(line);
                return (
                  <tr key={line.key}>
                    <td>
                      <span className="forecast-name">
                        <span className="swatch" style={{background: line.color}} />
                        <span>{line.name}</span>
                      </span>
                    </td>
                    {columns.map(column => (
                      <td key={column} className={cells[column].className} title={cells[column].title}>
                        {cells[column].content}
                      </td>
                    ))}
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
