import {AnalyticsPanel, AnalyticsNote} from './AnalyticsPanel';
import {AnalyticsTable, TableSettings, type Cell, type TimedCell} from './AnalyticsTable';
import {memo, useMemo, useRef} from 'react';
import {num, rateText} from '../lib/format';
import {level} from '../lib/quota';
import {
  FORECAST_WIDTHS,
  LIVE_COLUMNS,
  RANGE_COLUMNS,
  announcedOf,
  cellChangesAt,
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
import {QUOTA_TABLE, chosenPlanOf, columnShown, planOf, type Arrange} from '../lib/view';
import {type Line} from '../lib/lines';
import {subscriptionLinesOf,subscriptionOverflow} from '../lib/subscription';
import {usePrefs} from '../lib/prefs';
import {ofTimeRange} from '../lib/timeRange';
import {useForecastsOf, useLineup, useNamed, useResetNews} from '../lib/board';
import {hubNow} from '../lib/clock';
import {quotaHistory, useHistory} from '../lib/history';
import {t, useLocale, type Key} from '../i18n';

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
  const {history, loading,error} = useHistory();
  const sources = useNamed(arrange.view.names,'quota');
  const lineup = useLineup();
  const forecasts = useForecastsOf(lineup);
  const news = useResetNews();
  const {view} = arrange;
  const omitted=subscriptionOverflow(sources,view);
  const {kind} = usePrefs();
  const selected = ofTimeRange(history);
  const range = !!selected;
  // Window names are text: they are rebuilt when the language changes.
  const locale = useLocale();
  const lines = useMemo(() => subscriptionLinesOf(history, sources, view, kind), [history, sources, view.windows, view.hidden, view.colors, kind, locale]);
  const modeColumns = range ? RANGE_COLUMNS : LIVE_COLUMNS;
  const columns = useMemo(() => modeColumns.filter(column => columnShown(view, QUOTA_TABLE, column)), [modeColumns, view]);
  const panel = useRef<HTMLElement>(null);
  /** Every cell of a line, by column. */
  const cellsOf = (line: Line): Record<ForecastColumn, Cell | TimedCell> => {
    const source = sources.find(s => s.id === line.sourceId);
    const live = source?.windows.find(w => w.id === line.windowId);
    const measuredAt = source?.successAt ?? null;
    const resetAt = live?.resetAt ?? null;
    const edge = (value: number | null): Cell => (value === null ? {content: '—'} : {content: `${num(value)}%`, className: `v-${level(value)}`});
    if(line.capCells) {
      const cells=Object.fromEntries(Object.keys(HEADINGS).map(key=>[key,{content:'—'}])) as Record<ForecastColumn,Cell>;
      cells.now=edge(line.current);cells.start=edge(line.remainingAtStart);cells.end=edge(line.remainingAtEnd);
      return cells;
    }
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
      now: edge(line.current),
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

  const definitions = modeColumns.map(id => ({id, title: heading(id, range), width: FORECAST_WIDTHS[id], hint: HEADINGS[id].hint ? t(HEADINGS[id].hint!) : undefined}));
  return (
    <AnalyticsPanel ref={panel} className="forecast" title={t('forecast.title')} history={history} loading={loading} error={error} retry={quotaHistory.retry}
      settings={<TableSettings arrange={arrange} widget={QUOTA_TABLE} columns={definitions} visible={columns}/>}
    >
      {omitted > 0 && <AnalyticsNote>{t('history.quotaOverflow', {count: omitted})}</AnalyticsNote>}
      {!history ? error ? null : <div className="panel-loading">{t('history.loading')}</div>
        : !lines.length ? <p className="panel-empty">{t('forecast.empty')}</p>
        : <AnalyticsTable columns={definitions.filter(column => columns.includes(column.id))}
            rows={lines.map(line => ({key: line.key, name: line.name, color: line.color, cells: cellsOf(line)}))}
            name={t('table.limit')} nameWidth={FORECAST_WIDTHS.limit} lead={range ? 'end' : 'now'}/>
      }
    </AnalyticsPanel>
  );
});

export const Forecast = WindowForecast;
