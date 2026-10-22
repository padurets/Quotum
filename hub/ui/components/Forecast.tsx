import {AnalyticsPanel} from './AnalyticsPanel';
import {AnalyticsTable, TableSettings, type AnalyticsRow, type AnalyticsColumn, type Cell, type TimedCell} from './AnalyticsTable';
import {memo, useCallback, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type RefObject} from 'react';
import {num, rateText} from '../lib/format';
import {level} from '../lib/quota';
import {
  FORECAST_WIDTHS,
  LIVE_COLUMNS,
  RANGE_COLUMNS,
  announcedOf,
  cellChangesAt,
  outlook,
  outlookChangesAt,
  outlookText,
  planCell,
  planEndOf,
  spentOf,
  type Context,
  type ForecastColumn,
  type Spent,
} from '../lib/forecast';
import {planChangesAt,planOrderAt} from '../lib/plan';
import {lineWork, workLeftChangesAt, workText, type WorkColumn} from '../lib/work';
import {QUOTA_TABLE, QUOTA_SESSION_TABLE, chosenPlanOf, columnShown, planOf, type Arrange} from '../lib/view';
type QuotaKind='session'|'weekly';
import {type Line} from '../lib/lines';
import {subscriptionLinesOf,subscriptionOverflow} from '../lib/subscription';
import {usePref,setPrefs} from '../lib/prefs';
import {clock,hubNow} from '../lib/clock';
import {crossingAt,forecastComparator,nextForecastSort,sortValue,visibleForecastSort,type SortColumn,type SortRow} from '../lib/forecastSort';
import {ofTimeRange} from '../lib/timeRange';
import {useForecastsOf, useLineup, useNamed, useResetNews} from '../lib/board';
import {quotaHistory, useHistory} from '../lib/history';
import {boardPeriod} from '../lib/period';
import {useQuotaPresentation} from '../lib/dataFilters';
import {observationDeadline} from '../../server/domain/resources';
import {formatLocale, t, useLocale, type Key} from '../i18n';
import {TableSurface,useTableWidget, WidgetPages, TableMeasure, TableSortMenu} from './TableWidget';

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

/** Clock-only order changes publish retained row descriptors only after a permutation. */
const SortedForecast=memo(function SortedForecast({rows,models,columns,fixed,rangeKey,panel,kind='weekly',children,structure,...panelProps}:{rows:AnalyticsRow<ForecastColumn>[];models:SortRow[];columns:AnalyticsColumn<ForecastColumn>[];fixed:boolean;rangeKey:string;panel:RefObject<HTMLElement|null>;kind?:QuotaKind;structure?:readonly number[]} & Omit<ComponentProps<typeof AnalyticsPanel>,'ref'|'controls'>) {
  const sortKey=kind==='session'?'sessionSort':'forecastSort',saved=usePref(sortKey),locale=useLocale();
  const active=useMemo(()=>visibleForecastSort(saved,columns.map(c=>c.id)),[saved,columns]);
  const current=useRef({rows,models,active,fixed,rangeKey,locale});current.current={rows,models,active,fixed,rangeKey,locale};
  const [watch]=useState(()=>clock.watch()),cached=useRef<AnalyticsRow<ForecastColumn>[]>([]);
  const evaluate=useCallback(()=>{
    const {rows,models,active,fixed,rangeKey,locale}=current.current,now=hubNow();
    const values=models.map(model=>sortValue(model,fixed||model.line.capCells||!active||active.column==='name'?model.line:boardPeriod.quotaAt(model.line,now,rangeKey),now,fixed,active?.column??'name')).sort(forecastComparator(active,fixed,locale));
    let next=Infinity;
    const linear:{value:number;slope:number}[]=[];
    if(!fixed)for(const value of values){
      const row=value.row,names=!active||active.column==='name',work=names?{slope:0,next:outlookChangesAt(row.live,row.measuredAt,now,row.ahead,row.context)??Infinity}:boardPeriod.quotaOrderAt(row.line,now,rangeKey,active?.column!=='agenthours');
      next=Math.min(next,work.next,row.validUntil!==undefined&&row.validUntil>now?row.validUntil:Infinity,row.live?.resetAt!=null&&row.live.resetAt>now?row.live.resetAt:Infinity, value.said.key==='runsOut'?Math.ceil(value.said.at):Infinity,names?Infinity:workLeftChangesAt(row.line,row.live?.resetAt??null,now)??Infinity);
      const key=active?.column&&active.column!=='name'?value.keys[active.column]:null;
      if(active?.column==='plan'){
        const plan=planOrderAt(row.live,row.measuredAt,now,row.plan);next=Math.min(next,plan.next);
        if(key)linear.push({value:key[0],slope:plan.slope});
      }else if(active?.column==='work'||active?.column==='agenthours'){
        if(key)linear.push({value:key[1],slope:work.slope});
      }
    }
    clock.due(watch,fixed?null:crossingAt(linear,now,next),now);
    const byKey=new Map(rows.map(row=>[row.key,row])),ordered=values.map(v=>byKey.get(v.row.line.key)!);
    if(ordered.length!==cached.current.length||ordered.some((row,i)=>row!==cached.current[i]))cached.current=ordered;
    return cached.current;
  },[watch]);
  const subscribe=useCallback((listener:()=>void)=>clock.subscribe(watch,listener),[watch]);
  const ordered=useSyncExternalStore(subscribe,evaluate,evaluate);
  const onSort=useCallback((column:SortColumn|null,cycle?:boolean)=>setPrefs({[sortKey]:nextForecastSort(active,column,cycle)}),[active,sortKey]);
  const sorting={active,onSort,headers:[{id:'name' as const,title:t('table.limit')},...columns],label:t('table.sort'),defaultLabel:t('table.defaultOrder')};
  const widget=useTableWidget(panel,columns.map(column=>column.width),FORECAST_WIDTHS.limit,ordered.map(row=>row.key),JSON.stringify([rangeKey,active]),undefined,structure);
  return <AnalyticsPanel {...panelProps} ref={panel} controls={widget.layout==='list'&&<TableSortMenu {...sorting}/>}>
    <TableSurface table={widget}>{children}<AnalyticsTable columns={columns} rows={ordered.slice(widget.from,widget.to)} name={t('table.limit')} lead={fixed?'end':'now'} sorting={sorting} layout={widget.layout} body={widget.live}/>
      </TableSurface><WidgetPages table={widget} count={ordered.length}/>
      <TableMeasure table={widget}><AnalyticsTable columns={columns} rows={ordered.slice(widget.measureFrom,widget.measureTo)} name={t('table.limit')} lead={fixed?'end':'now'} sorting={sorting} layout={widget.layout} body={widget.measured} still/></TableMeasure>
  </AnalyticsPanel>;
});

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
const WindowForecast = memo(function WindowForecast({arrange,kind='weekly'}: {arrange: Arrange;kind?:QuotaKind}) {
  const selection=useQuotaPresentation();
  const widget=kind==='session'?QUOTA_SESSION_TABLE:QUOTA_TABLE;
  const {history, loading,error} = useHistory();
  const sources = useNamed(arrange.view.names,'quota');
  const lineup = useLineup();
  const forecasts = useForecastsOf(lineup);
  const news = useResetNews();
  const {view} = arrange;
  const omitted=subscriptionOverflow(sources,view);
  const selected = ofTimeRange(history);
  const range = !!selected;
  // Window names are text: they are rebuilt when the language changes.
  const locale = useLocale();
  const lines = useMemo(() => subscriptionLinesOf(history, sources, view, kind), [history, sources, view.windows, view.hidden, view.colors, kind, locale,selection]);
  const modeColumns = range ? RANGE_COLUMNS : LIVE_COLUMNS;
  const columns = useMemo(() => modeColumns.filter(column => columnShown(view, widget, column)), [modeColumns, view, widget]);
  const panel = useRef<HTMLElement>(null);
  const definitions = modeColumns.map(id => ({id, title: heading(id, range), width: FORECAST_WIDTHS[id], hint: HEADINGS[id].hint ? t(HEADINGS[id].hint!) : undefined}));
  const visible = definitions.filter(column => columns.includes(column.id));
  const structure=useMemo(()=>{
    const modes=[LIVE_COLUMNS,RANGE_COLUMNS].map(mode=>mode.filter(id=>columnShown(view,widget,id)).map(id=>FORECAST_WIDTHS[id]));
    return Array.from({length:Math.max(...modes.map(columns=>columns.length))},(_,i)=>Math.max(...modes.map(columns=>columns[i]??0)));
  },[view.columns,view.shownColumns,widget]);
  /** Every cell of a line, by column. */
  const cellsOf = (line: Line): Record<ForecastColumn, Cell | TimedCell> => {
    const source = sources.find(s => s.id === line.sourceId);
    const live = source?.windows.find(w => w.id === line.windowId);
    const measuredAt = source?.successAt ?? null;
    const resetAt = live?.resetAt ?? null;
    const edge = (value: number | null): Cell => (value === null ? {content: '—'} : {content: `${num(value)}%`, className: `v-${level(value)}`});
    if(line.capCells) {
      const cells=Object.fromEntries(Object.keys(HEADINGS).map(key=>[key,{content:'—'}])) as Record<ForecastColumn,Cell|TimedCell>;
      const meter=source?.meters?.find(m=>m.id===line.windowId),until=meter?Math.min(observationDeadline(meter),meter.resetAt??Infinity):Infinity;
      cells.now=range?edge(line.current):{time:'now',changesAt:now=>until>now&&Number.isFinite(until)?until:null,at:now=>edge(now<until?line.current:null)};cells.start=edge(line.remainingAtStart);cells.end=edge(line.remainingAtEnd);
      return cells;
    }
    // A rolling left edge changes credited work locally. Only the affected cell
    // reads its exact summary; its table and the other lines remain asleep.
    const lineAt=(now:number)=>range?line:boardPeriod.quotaAt(line,now,history!.range);
    const spentAt=(now:number)=>range?line:boardPeriod.quotaSpendingAt(line,now,history!.range);
    const rangeCells=range?lineWork(line,true,resetAt,0):null;
    const workCell = (column: WorkColumn, now: number): Cell => {
      const value=lineAt(now),cells=range?rangeCells:lineWork(value,range,resetAt,now),perWork=cells&&'value' in cells.perwork?cells.perwork.value:null;
      const since=range?history!.since:boardPeriod.rangeAt('quota',now,history!.range)?.from??history!.since;
      if(!cells)return {content:'—'};
      const text=workText(column,cells[column],value.work,since,resetAt,perWork,value.selectedWork);
      return column==='work'||column==='agenthours'?text:{...text,title:[text.title,t('filters.sourceWide')].filter(Boolean).join('\n')};
    };
    const timed=(column:WorkColumn):Cell|TimedCell=>{
      if(range)return workCell(column,0);
      // Reuse the displayed value once, while its accounting and locale still match.
      let stamp:{now:number;cell:Cell;locale:string;basis:WeakRef<object>}|undefined;
      return {time:column,
        changesAt:(now:number,shown?:Cell)=>{
          const captured=stamp;stamp=undefined;
          const basis=captured?.basis.deref();
          const initial=captured&&basis!==undefined&&captured.now===now&&captured.cell===shown&&captured.locale===formatLocale()&&basis===boardPeriod.cellBasis('quota')?JSON.stringify(shown):undefined;
          // Direct work totals do not change when a quota observation leaves the period.
          return boardPeriod.cellChangesAt('quota',now,at=>JSON.stringify(workCell(column,at)),column==='workleft'?at=>workLeftChangesAt(lineAt(at),resetAt,at):undefined,line.sourceId,history!.range,line.windowId,initial,column==='work'||column==='agenthours'?'selectedWork':'all');
        },
        at:(now:number)=>{const cell=workCell(column,now),basis=boardPeriod.cellBasis('quota');stamp=basis&&typeof WeakRef==='function'?{now,cell,locale:formatLocale(),basis:new WeakRef(basis)}:undefined;return cell;}
      };
    };
    if (range) {
      // Hidden range columns do not need their values formatted.
      const cells: Partial<Record<ForecastColumn, Cell>> = {};
      for (const column of columns) {
        switch (column) {
          case 'start': cells.start = edge(line.remainingAtStart); break;
          case 'end': cells.end = edge(line.remainingAtEnd); break;
          case 'spent': cells.spent = {content: spentText(spentOf(line))}; break;
          case 'pace': cells.pace = {content: line.coveredMs >= PACE_FROM ? t('table.perHour', {value: rateText(line.consumed / (line.coveredMs / 3_600_000))}) : '—'}; break;
          case 'work': case 'agenthours': case 'perwork': case 'during': case 'workleft':
            cells[column] = workCell(column, 0); break;
        }
      }
      return cells as Record<ForecastColumn, Cell>;
    }
    const workCells:Record<WorkColumn,Cell|TimedCell>={work:timed('work'),agenthours:timed('agenthours'),perwork:timed('perwork'),during:timed('during'),workleft:timed('workleft')};
    const weekly = planOf(view, line.sourceId);
    // A weekly window as the hub foresees it; a five-hour one the table foresees itself.
    const ahead = live?.kind === 'weekly' ? (forecasts[lineup.indexOf(line.sourceId)]?.[line.windowId] ?? null) : null;
    const context: Context = {windows: source?.windows ?? [], freeResets: source?.resets?.available ?? 0, announced: announcedOf(news, line.provider, measuredAt)};
    // The plan's line in the tooltip is for a plan the owner chose: the default plan is none.
    const chosen = chosenPlanOf(view, line.sourceId);
    return {
      ...workCells,
      now: {time:'now',changesAt:now=>resetAt!==null&&resetAt>now?resetAt:null,at:now=>edge(resetAt!==null&&resetAt<=now?null:line.current)},
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
      spent: {time:'spent',changesAt:now=>boardPeriod.cellChangesAt('quota',now,at=>spentText(spentOf(spentAt(at))),undefined,line.sourceId,history!.range,line.windowId,undefined,'spending'),at:now=>({content:spentText(spentOf(spentAt(now)))})},
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

  // A pan phase changes the panel's presentation, not its retained rows. Reusing
  // the table also keeps every clock cell from replanning its deadline on input.
  const data=useMemo(()=>({rows:lines.map(line=>({key:line.key,name:line.name,color:line.color,cells:cellsOf(line)})),
    models:lines.map(line=>{const source=sources.find(s=>s.id===line.sourceId);const meter=source?.meters?.find(m=>m.id===line.windowId);return {line,validUntil:line.capCells&&meter?Math.min(observationDeadline(meter),meter.resetAt??Infinity):undefined,live:source?.windows.find(w=>w.id===line.windowId),measuredAt:source?.successAt??null,ahead:forecasts[lineup.indexOf(line.sourceId)]?.[line.windowId]??null,context:{windows:source?.windows??[],freeResets:source?.resets?.available??0,announced:announcedOf(news,line.provider,source?.successAt??null)},plan:planOf(view,line.sourceId)};})}),[lines,columns,range,sources,forecasts,news,history,view,locale]);
  return <SortedForecast {...data} kind={kind} columns={visible} fixed={range} rangeKey={history?.range??''} panel={panel} structure={structure}
    className="forecast" title={t(kind==='session'?'forecast.sessionTitle':'forecast.title')} history={history} loading={loading} error={error} retry={quotaHistory.retry} details={omitted>0?t('history.quotaOverflow',{count:omitted}):null}
    settings={<TableSettings arrange={arrange} widget={widget} columns={definitions} visible={columns}/>}
  >

    {!history?null:!lines.length?<p className="panel-empty">{t('forecast.empty')}</p>:null}
  </SortedForecast>;
});

export const Forecast = WindowForecast;
