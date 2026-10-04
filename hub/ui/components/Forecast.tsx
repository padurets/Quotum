import {Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {num, rateText} from '../lib/format';
import {level} from '../lib/quota';
import {
  FORECAST_WIDTHS,
  LIVE_COLUMNS,
  RANGE_COLUMNS,
  announcedOf,
  cellChangesAt,
  forecastLayout,
  outlook,
  outlookText,
  planCell,
  planEndOf,
  spentOf,
  type Context,
  type ForecastColumn,
  type Spent,
} from '../lib/forecast';
import {planChangesAt} from '../lib/plan';
import {lineWork, workLeftChangesAt, workText, type WorkColumn} from '../lib/work';
import {FORECAST, chosenPlanOf, columnShown, planOf, withColumn, withHidden, type Arrange} from '../lib/view';
import {linesOf, type Line} from '../lib/lines';
import {usePrefs,usePref} from '../lib/prefs';
import {MoneyTable} from './MoneyAnalytics';
import {answeredRangeLabel, ofTimeRange} from '../lib/timeRange';
import {useForecastsOf, useLineup, useNamed, useResetNews} from '../lib/board';
import {hubNow, useClock} from '../lib/clock';
import {useHistory} from '../lib/history';
import {t, useLocale, type Key} from '../i18n';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';

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
  agenthours: {title: 'table.agentHours', hint: 'table.agentHoursHint'},
  work: {title: 'table.work', hint: 'table.workHint'},
  perwork: {title: 'table.perWork', hint: 'table.perWorkHint'},
  during: {title: 'table.during', hint: 'table.duringHint'},
  forecast: {title: 'table.forecast', hint: 'table.forecastHint'},
  workleft: {title: 'table.workLeft', hint: 'table.workLeftHint'},
};

const heading = (column: ForecastColumn, range: boolean) => t((range && HEADINGS[column].range) || HEADINGS[column].title);

type Cell = {content: ReactNode; title?: string; className?: string};

/**
 * A cell that reads otherwise as time passes (the plan, where the pace leads, the hours of
 * work left): worked out at the hub's time, again at `changesAt`, and marked with what it
 * shows (`time`, as `npm run bench` counts it).
 */
type TimedCell = {time: string; changesAt: (now: number) => number | null; at: (now: number) => Cell};

/** A cell that changes with time, as a part of its own: rendered when it reads otherwise, not the table. */
function Timed({cell, render}: {cell: TimedCell; render: (cell: Cell, time: string) => ReactNode}) {
  const now = useClock(cell.changesAt);
  return render(cell.at(now), cell.time);
}

/** A cell of either kind, drawn by `render`: one that changes with time as a part of its own. */
const shown = (key: string, cell: Cell | TimedCell, render: (cell: Cell, time?: string) => ReactNode) =>
  'at' in cell ? <Timed key={key} cell={cell} render={render} /> : <Fragment key={key}>{render(cell)}</Fragment>;

/**
 * The windows of one kind, from what is left to where it leads: what is left and what the
 * plan expects; what the period spent, how long agents worked on each window's
 * subscription meanwhile, what an hour of their work spent and how much of the spending
 * fell into their work; then two forecasts, by the time on the clock (a weekly window's as
 * the hub foresees it from how its subscription spends, a five-hour window's at its own
 * pace since it started; neither by the period) and by work (how many hours agents can go
 * on at what an hour of their work spent). Its period and window type are the analytics',
 * as the chart's. Over a time range selected on the chart, which is in the past, it shows
 * that range instead: what was left at its start and its end, what it spent in all and per
 * hour, and its agents' work. The board's owner chooses the columns; where they do not fit
 * the widget, each window is a row of a list. It reads the history on screen, the board's
 * cards, the hub's forecasts and its news of resets, not the cards' agents or pace; what in
 * it changes with time (the plan, where the forecast leads, the hours of work left) are
 * parts of their own.
 */
const WindowForecast = memo(function WindowForecast({arrange}: {arrange: Arrange}) {
  const {history, loading} = useHistory();
  const sources = useNamed(arrange.view.names);
  const lineup = useLineup();
  const forecasts = useForecastsOf(lineup);
  const news = useResetNews();
  const {view} = arrange;
  const {kind} = usePrefs();
  const selected = ofTimeRange(history);
  const range = !!selected;
  // Window names are text: they are rebuilt when the language changes.
  const locale = useLocale();
  const lines = useMemo(() => linesOf(history, sources, view, kind), [history, sources, view.windows, view.hidden, view.colors, kind, locale]);
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
  const cellsOf = (line: Line): Record<ForecastColumn, Cell | TimedCell> => {
    const source = sources.find(s => s.id === line.sourceId);
    const live = source?.windows.find(w => w.id === line.windowId);
    const measuredAt = source?.successAt ?? null;
    const resetAt = live?.resetAt ?? null;
    const edge = (value: number | null): Cell => (value === null ? {content: '—'} : {content: `${num(value)}%`, className: `v-${level(value)}`});
    // Of the cells about work, only the hours left move with time (below); the rest read the same at any moment.
    const work = lineWork(line, range, resetAt, hubNow());
    const perWork = work && 'value' in work.perwork ? work.perwork.value : null;
    const workCell = (column: WorkColumn, now: number): Cell => {
      const cells = column === 'workleft' ? lineWork(line, range, resetAt, now) : work;
      return cells && line.work ? workText(column, cells[column], line.work, history!.since, resetAt, perWork) : {content: '—'};
    };
    const workCells: Record<WorkColumn, Cell | TimedCell> = {
      work: workCell('work', 0),
      agenthours: workCell('agenthours', 0),
      perwork: workCell('perwork', 0),
      during: workCell('during', 0),
      workleft: range ? workCell('workleft', 0) : {time: 'workleft', changesAt: now => workLeftChangesAt(line, resetAt, now), at: now => workCell('workleft', now)},
    };
    if (range) {
      return {
        ...workCells,
        start: edge(line.remainingAtStart),
        end: edge(line.remainingAtEnd),
        spent: {content: spentText(spentOf(line))},
        pace: {content: line.coveredMs >= PACE_FROM ? t('table.perHour', {value: rateText(line.consumed / (line.coveredMs / 3_600_000))}) : '—'},
      } as Record<ForecastColumn, Cell>;
    }
    const weekly = planOf(view, line.sourceId);
    // A weekly window as the hub foresees it; a five-hour one the table foresees itself.
    const ahead = live?.kind === 'weekly' ? (forecasts[lineup.indexOf(line.sourceId)]?.[line.windowId] ?? null) : null;
    const context: Context = {windows: source?.windows ?? [], freeResets: source?.resets?.available ?? 0, announced: announcedOf(news, line.provider, measuredAt)};
    // The plan's line in the tooltip is for a plan the owner chose: the default plan is none.
    const chosen = chosenPlanOf(view, line.sourceId);
    return {
      ...workCells,
      now: {content: `${num(line.current)}%`, className: `v-${level(line.current)}`},
      plan: {
        time: 'plan',
        changesAt: now => (live ? planChangesAt(live, measuredAt, now, weekly) : null),
        at: now => {
          const plan = planCell(live, measuredAt, now, weekly);
          return {
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
          };
        },
      },
      spent: {content: spentText(spentOf(line))},
      forecast: {
        time: 'forecast',
        changesAt: now => cellChangesAt(live, measuredAt, now, ahead, context, chosen),
        at: now => {
          const said = outlook(live, measuredAt, now, ahead, context);
          const text = outlookText(said, live, ahead, context, planEndOf(live, measuredAt, now, chosen, ahead));
          // A burst beside the words, never instead of them, and never louder than they are. It has
          // no tooltip of its own: pointed at, it shows the cell's, which tells how fast.
          const content = text.burst ? (
            <>
              {text.text}
              <span className="forecast-burst" role="img" aria-label={t('forecast.burstMark')}>
                ↑
              </span>
            </>
          ) : (
            text.text
          );
          return {content, title: text.title.join('\n') || undefined, className: said.tone};
        },
      },
    } as Record<ForecastColumn, Cell | TimedCell>;
  };

  // In the list, what is left leads each row; the rest follows under the name, each value with its heading.
  const lead: ForecastColumn = range ? 'end' : 'now';
  const details = columns.filter(column => column !== lead);

  return (
    <section ref={panel} className={`panel forecast ${loading ? 'is-loading' : ''}`} aria-label={t('forecast.title')} aria-busy={loading} data-history-range={history?.range}>
      <div className="panel-head">
        <div><h2>{t('forecast.title')}</h2>{history && <span className="answered-range">{t('history.answeredRange', {range: answeredRangeLabel(history)})}</span>}</div>
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
                  {columns.includes(lead) &&
                    shown(lead, cells[lead], (cell, time) => (
                      <span data-time={time} className={cell.className} title={cell.title}>
                        <span className="sr-only">{heading(lead, range)}: </span>
                        {cell.content}
                      </span>
                    ))}
                </div>
                {details.length > 0 && (
                  <div className="forecast-compact-details">
                    {details.map(column =>
                      shown(column, cells[column], (cell, time) => (
                        <span data-time={time} title={cell.title}>
                          {heading(column, range)} <span className={cell.className}>{cell.content}</span>
                        </span>
                      )),
                    )}
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
                    {columns.map(column =>
                      shown(column, cells[column], (cell, time) => (
                        <td data-time={time} className={cell.className} title={cell.title}>
                          {cell.content}
                        </td>
                      )),
                    )}
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

export const Forecast=memo(function Forecast({arrange}:{arrange:Arrange}) {
  const money=usePref('money');return money.unit?<MoneyTable arrange={arrange}/>:<WindowForecast arrange={arrange}/>;
});
