import {boardPeriod,usePeriodSessions,type SessionOrder,type SessionPeriod} from '../lib/period';
import {PeriodStatus} from './PeriodStatus';
import {ReadState} from './ReadState';
import {TablePreview} from './TablePreview';
import {TableSurface} from './TableWidget';
import {WarningIcon} from './StatusMark';
import {timeRangeLabel,timeRangeKey,useTimeRange} from '../lib/timeRange';
import {memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject} from 'react';
import type {LiveSession} from '../lib/types';
import {clientName} from '../../server/domain/clients';
import {agentCount,agentSourceLabel,distinctAgents} from '../lib/agents';
import {AGENTS, colorOf, columnShown, withColumn, withHidden, type Arrange} from '../lib/view';
import {
  AGENT_WIDTHS,
  NAME_WIDTH,
  AGENTS_BY,
  activityDimension,
  agentActivityValue,
  DIMENSIONS,
  agentRows,
  byActivity,
  columnsOf,
  drawn,
  folderOf,
  groupsOf,
  machinesOf,
  nextAgentsSort,
  runningFrom,
  runningChangesAt,
  sessionPresent,
  since,
  sortedGroups,
  visibleAgentsSort,
  type AgentColumn,
  type AgentGroup,
  type AgentRow,
  type AgentsBy,
  type AgentSource,
  type AgentsSort,
  type Dimension,
} from '../lib/agents';
import {num, recentActivity, stamp, workHours} from '../lib/format';
import {activityCoverage} from '../lib/activity';
import {useLineup, useTitles} from '../lib/board';
import {setPrefs, usePref} from '../lib/prefs';
import {hubNow,useClock} from '../lib/clock';
import {t, useLocale, type Key} from '../i18n';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';
import {RecentActivity} from './Time';
import {Modal} from './Kit';
import {useTableWidget,useTableLayout,TableSortMenu,TableHeading,TablePages,WidgetPages,TableMeasure,TableGrouping,type TableMetric} from './TableWidget';
import {tableCell, type Cell, type TimedCell} from './TableCell';
export {SortIcon} from './TableWidget';

/**
 * One session: filled with the card's colour while it works, outlined while idle; a
 * window of an editor or the app that is only open is outlined with a dash, so it does
 * not read as a forgotten session. Among marks of several cards, each has its own (`style`).
 */
function Mark({session, style}: {session: LiveSession; style?: CSSProperties}) {
  const quiet = !session.working && session.origin !== 'terminal';
  return <i className={`agent ${session.working ? 'is-working' : ''} ${quiet ? 'is-quiet' : ''}`} style={style} aria-hidden="true" />;
}

/** What a session is doing, as the legend names its mark. */
const stateOf = (session: LiveSession,now=hubNow()) =>
  t(!sessionPresent(session,now) ? 'agents.retained' : session.working ? 'agents.working' : session.origin === 'terminal' ? 'agents.idle' : 'agents.window');

function SessionState({session}:{session:LiveSession}){
  return <span className="sr-only">, {stateOf(session)}</span>;
}

/** A cut name in full on hover: the project, and the folder on a line of its own. */
const placeOf = (session: LiveSession) => [session.clientId ? clientName(session.clientId) : null, session.project, folderOf(session)].filter(Boolean).join('\n') || undefined;

const TerminalIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M4.5 6.25 6.75 8 4.5 9.75M8.5 10h3" />
  </svg>
);

/** An editor (VS Code, Cursor and the like), with the client in one of its windows. */
const EditorIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M5.75 4.75 2.5 8l3.25 3.25M10.25 4.75 13.5 8l-3.25 3.25" />
  </svg>
);

/** The provider's own app. */
const AppIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M1.75 5.75h12.5" />
  </svg>
);

const ORIGIN_ICONS = {terminal: TerminalIcon, editor: EditorIcon, app: AppIcon};

/** Where a session runs: an icon, which a word on every row would only repeat; named on hover and for screen readers. */
function Origin({origin}: {origin: LiveSession['origin']}) {
  const Icon = ORIGIN_ICONS[origin];
  const name = t(`agents.${origin}`);
  return (
    <span className="agents-origin" title={name}>
      <Icon />
      <span className="sr-only">{name}</span>
    </span>
  );
}

/**
 * The subscription's sessions in the viewing period, in the card's tray. The marks
 * tell at a glance how many still work and on which machine;
 * the panel it opens, upwards where there is room, names them. When the tray has no room
 * for the marks (`roomy` false), they all go and the count stays; they are still laid out,
 * unseen, so the tray can tell when they fit again.
 */
export function Agents({sessions, roomy = true, period}: {sessions: LiveSession[]; roomy?: boolean; period?: SessionPeriod}) {
  const [page,setPage]=useState(0);
  const pending=!!period?.loading || !!period?.error;
  if (!sessions.length && !pending) return null;
  const currentPage=Math.min(page,Math.max(0,Math.ceil(sessions.length/50)-1));
  let offset=0;
  const machines=machinesOf(sessions).flatMap(machine=>{
    const count=machine.sessions.length,from=Math.max(0,currentPage*50-offset),to=Math.min(count,(currentPage+1)*50-offset);
    offset+=count;
    return to>from?[{...machine,count,working:machine.sessions.filter(session=>session.working).length,sessions:machine.sessions.slice(from,to)}]:[];
  });
  const working = sessions.filter(s => s.working).length;
  const summary = sessions.length?t('agents.summary', {count: sessions.length, working}):t('agents.title');
  const status=period?.error?t(period.error==='filters_limit'?'api.filters_limit':period.error==='history_limit'?'period.limit':'period.failed'):period?.loading?t('period.loading'):'';
  const label=[summary,status,pending&&period?.basis?t('analytics.retainedRange',{range:timeRangeLabel(period.basis.range)}):null].filter(Boolean).join('\n');
  return (
    <Popover
      label={label}
      triggerClass={`tray-pill agents-pill${period?.error?' is-warn':''}`}
      up
      trigger={
        <>
          {period?.error?<WarningIcon/>:period?.loading?<i className="spinner" aria-hidden="true"/>:<TerminalIcon />}
          {sessions.length>0&&<span className="agents-count">
            <b>{working}</b>/{sessions.length}
          </span>}
          {sessions.length>0&&drawn(sessions) && (
            <span className={`agents-marks ${roomy ? '' : 'is-out'}`}>
              {machines.map(machine => (
                <span className="agents-group" key={machine.id}>
                  {machine.sessions.map((session, i) => (
                    <Mark key={i} session={session} />
                  ))}
                </span>
              ))}
            </span>
          )}
        </>
      }
    >
      {pending&&period&&<div className="popover-pad"><PeriodStatus {...period}/></div>}
      <AgentPages page={currentPage} count={sessions.length} onPage={setPage}/>
      <div className="popover-title agents-list-head">
        <span>{t('agents.title')}</span>
        <span title={t('agents.workedHint')}>{t('agents.worked')}</span>
      </div>
      <div className="agents-list popover-scroll">
        {machines.map(machine => (
          <section key={machine.id} className="agents-machine">
            <h3 title={machine.name}>
              <span>{machine.name}</span>
              <small>{t('agents.machineSummary', {working: machine.working, count: machine.count})}</small>
            </h3>
            {machine.sessions.map((session, i) => (
              <div className={`agents-row ${session.working ? 'is-working' : ''}`} key={i} title={stateOf(session)}>
                <Mark session={session} />
                <Origin origin={session.origin} />
                <span className="agents-project" title={placeOf(session)}>
                  <span>{session.project ?? t('agents.noProject')}</span>
                  {folderOf(session) && <small>{folderOf(session)}</small>}
                  <span className="sr-only">, {stateOf(session)}</span>
                </span>
                <span className="agents-age" title={t('agents.workedHint')}>
                  <span className="sr-only">{t('agents.worked')}: </span>
                  <WorkTime ms={session.workedMs} refs={session.ref?[session.ref]:[]} />
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="agents-legend" aria-hidden="true">
        <span>
          <i className="agent is-working" /> {t('agents.working')}
        </span>
        <span>
          <i className="agent" /> {t('agents.idle')}
        </span>
        <span>
          <i className="agent is-quiet" /> {t('agents.window')}
        </span>
      </div>
    </Popover>
  );
}

/** A project as the list names it: agents of none are a group of their own. */
const projectName = (project: string | null) => project ?? t('agents.noProject');

/** How a row is drawn: laid out unseen to be measured (`still`: nothing that moves on, nothing to press), its marks each in its card's colour. */
type Context = {still: boolean; color: (source: AgentSource | null) => CSSProperties; by: Dimension};

const activityText = (by: Dimension, column: 'active' | 'concurrency', now: number, key?: string) => {
  const value = agentActivityValue(boardPeriod.activitySummaryAt(activityDimension(by), now, key), by, column, key);
  return value === null ? '—' : column === 'active' ? workHours(value) : num(value, 1);
};

function withCoverage(now: number, next: number | null) {
  const coverage = boardPeriod.activityCoverageChangesAt(now);
  return next === null ? coverage : coverage === null ? next : Math.min(next, coverage);
}

function activityCell(by: Dimension, column: 'active' | 'concurrency', key?: string): TimedCell {
  const read = (now: number) => activityText(by, column, now, key);
  return {time:'session-activity',changesAt:now=>withCoverage(now,boardPeriod.activitySummaryChangesAt(activityDimension(by),now,read,key)),at:now=>({content:read(now),title:t(column==='active'?'activity.activeHint':'activity.atOnceHint')})};
}

const metricCell = (cell: Cell, time?: string) => <span data-time={time} title={cell.title}>{cell.content}</span>;

function SessionCoverage({by,empty,showEmpty}: {by: Dimension; empty: 'none' | 'noneShown' | null; showEmpty: boolean}) {
  const now = useClock(now => boardPeriod.activityCoverageChangesAt(now)), range = boardPeriod.activityRangeAt(now);
  const summary = boardPeriod.activitySummaryAt(activityDimension(by), now);
  const coverage = range ? activityCoverage(summary, range.from) : null;
  const text = coverage ?? (showEmpty && empty && summary?.known && !summary.agents ? t(`agents.${empty}`) : null);
  return text ? <p className={coverage?'analytics-note':'panel-empty'} data-time="activity-coverage">{text}</p> : null;
}

/** Credited time is unknown without a reliable producer identity. */
function WorkTime({ms,refs=[],still=false,labeled=false}: {ms:number|null;refs?:string[];still?:boolean;labeled?:boolean}) {
  const read=(now:number)=>{const value=boardPeriod.workedAt(refs,ms,now);return value===null?'—':workHours(value);};
  const now=useClock(now=>still?null:boardPeriod.workedChangesAt(refs,now,read));
  if (ms === null) return <span title={t('agents.workedUnknown')} aria-label={t('agents.workedUnknown')}>—</span>;
  const time = still?workHours(ms):read(now);
  return <span data-time="worked">{labeled ? t('agents.workedValue', {time}) : time}</span>;
}

/** A presence deadline changes this label, not the retained roster around it. */
function RunningTime({group,still}:{group:AgentGroup;still:boolean}){
  const now=useClock(now=>still?null:runningChangesAt(group.rows,now)),from=runningFrom(group.rows,now);
  return <span data-time="since">{Number.isFinite(from)?since(now-from):'—'}</span>;
}

/** How many of a group's agents work, of how many, as a card's tray counts them, and a mark for each while they are few. */
function Tally({group, color}: {group: AgentGroup; color: Context['color']}) {
  const agents=distinctAgents(group.rows);
  return (
    <span className="agents-tally">
      <span className="agents-count" aria-hidden="true">
        <b>{group.working}</b>/{agentCount(group.rows)}
      </span>
      {drawn(agents) && (
        <span className="agents-marks" aria-hidden="true">
          {agents.map((row, i) => (
            <Mark key={i} session={row.session} style={color(row.source)} />
          ))}
        </span>
      )}
      <span className="sr-only">{t('agents.machineSummary', {working: group.working, count:agentCount(group.rows)})}</span>
    </span>
  );
}

/** Last observed work; the unseen sizing copy never subscribes to the page clock. */
function LastActivity({group, still}: {group: AgentGroup; still: boolean}) {
  if (group.working) return <>{t('time.now')}</>;
  if (group.lastWorkedAt === null)
    return (
      <span title={t('agents.activityUnknown')}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t('agents.activityUnknown')}</span>
      </span>
    );
  return still ? <span title={stamp(group.lastWorkedAt)}>{recentActivity(group.lastWorkedAt, hubNow())}</span> : <RecentActivity at={group.lastWorkedAt} />;
}

/** A dimension shown in a row: shared by the group, or belonging to its one agent. */
const dimensionName = ({rows: [row]}: AgentGroup, column: Dimension) =>
  column === 'project' ? projectName(row.session.project) : column === 'machine' ? row.session.device.name : agentSourceLabel(row.source,row.session.sourceStatus,true);

const isDimension = (column: AgentColumn): column is Dimension => (DIMENSIONS as readonly AgentColumn[]).includes(column);

/** Every column of the list: its heading, its hint where the heading needs one, and what it says of a group (an agent's row being a group of one). */
const COLUMNS: Record<AgentColumn, {title: Key; hint?: Key; cell: (group: AgentGroup, context: Context) => ReactNode}> = {
  client:{title:'agents.client',cell:({rows:[row]})=>row.session.clientId?clientName(row.session.clientId):'—'},
  project: {title: 'agents.project', cell: group => dimensionName(group, 'project')},
  machine: {title: 'agents.machine', cell: group => dimensionName(group, 'machine')},
  subscription: {title: 'agents.subscription', cell: group => dimensionName(group, 'subscription')},
  agents: {title: 'activity.agents', hint: 'activity.agentsHint', cell: (group, {color}) => <Tally group={group} color={color} />},
  worked: {title: 'agents.worked', hint: 'agents.workedHint', cell: (group,{still}) => <WorkTime ms={group.workedMs} refs={group.rows.flatMap(row=>row.session.ref?[row.session.ref]:[])} still={still}/>},
  active: {title: 'activity.active', hint: 'activity.activeHint', cell: (group,{by,still}) => tableCell('active',activityCell(by,'active',group.key),metricCell,still)},
  concurrency: {title: 'agents.concurrency', hint: 'activity.atOnceHint', cell: (group,{by,still}) => tableCell('concurrency',activityCell(by,'concurrency',group.key),metricCell,still)},
  activity: {title: 'agents.lastActivity', hint: 'agents.lastActivityHint', cell: (group, {still}) => <LastActivity group={group} still={still} />},
  running: {title: 'agents.running', cell: (group, {still}) => <RunningTime group={group} still={still}/>},
};

/** A cut name in full on hover. */
const fullOf = (group: AgentGroup, column: AgentColumn) => (isDimension(column) ? dimensionName(group, column) : undefined);

/** Headers and the narrow menu share the same nullable column selection. */
type Sorting = {active: AgentsSort; headers: {id: AgentColumn; title: Key}[]; sortBy: (column: AgentColumn|null, cycle?: boolean) => void};
function SortMenu({active,headers,sortBy}:Sorting){
  return <TableSortMenu active={active} headers={headers.map(column=>({...column,title:t(column.title)}))} onSort={sortBy} label={t('agents.sort')} defaultLabel={t('agents.activity')}/>;
}

/**
 * Whether the agents read as a table or a compact list: a table where the chosen columns
 * after the name fit the width of the widget or the dialog they are in (`box` is inside
 * it), decided before they are first drawn, and again as it is resized: before that paints
 * too where the board gives the widget another width (`width`, its key of the board's sizing).
 */
function useAgentsLayout(box:RefObject<HTMLElement|null>,columns:readonly AgentColumn[]){
  return useTableLayout(box,columns.map(column=>AGENT_WIDTHS[column]),NAME_WIDTH,0).layout;
}

/**
 * Rows of the list as a table or a compact list, in the order given, with the columns
 * given after the name (`name`, the dimension it shows): a group's name opens its agents
 * (`onOpen`), and a row of one agent (`single`) shows its mark, where it runs, its project
 * and its folder instead. The widget and dialog share these cells; the unseen sizing
 * copy (`still`) subscribes to no clocks. `body` contains only data rows.
 */
function AgentsRows({
  groups,
  name,
  columns,
  single,
  layout,
  color,
  sorting,
  onOpen,
  still = false,
  body,
}: {
  groups: AgentGroup[];
  name: Dimension;
  columns: AgentColumn[];
  single: boolean;
  layout: 'table' | 'list';
  color: Context['color'];
  /** The table's headers, which sort it; the rows measured have none. */
  sorting?: Sorting;
  onOpen?: (key: string) => void;
  still?: boolean;
  body?: RefObject<HTMLElement | null>;
}) {
  const context: Context = {still, color, by: name};
  const open = (group: AgentGroup) => (single || still || !onOpen ? undefined : () => onOpen(group.key));
  const activate=(group:AgentGroup,target:EventTarget)=>{
    const element=target as Element,button=element.closest('button');
    if(element.closest('.popover')||button&&!button.classList.contains('agents-open'))return;
    open(group)?.();
  };
  const rowClass = (group: AgentGroup) => `${group.working ? 'is-working' : ''} ${single || still || !onOpen ? '' : 'is-group'}`;
  // A row of one agent takes its card's colour, for its mark; a group's marks each take their own.
  const rowStyle = (group: AgentGroup) => (single ? color(group.rows[0].source) : undefined);
  const groupName = (group: AgentGroup) => (name === 'project' ? projectName(group.name) : (group.name ?? ''));
  const opener = (group: AgentGroup) => (
    <button
      type="button"
      className="agents-open"
      onClick={event=>{event.stopPropagation();open(group)?.();}}
      data-agents-group={still ? undefined : group.key}
      tabIndex={still || !onOpen ? -1 : undefined}
      title={`${groupName(group)}\n${t('agents.openGroup')}`}
    >
      {groupName(group)}
    </button>
  );

  if (layout === 'list') {
    // What a row tells on its first line beside its name: a group, how many of its agents work; an agent, when it last worked.
    const lead: AgentColumn = single ? 'activity' : 'agents';
    const details = columns.filter(column => column!=='client'&&column !== lead && column !== 'active' && column !== 'concurrency');
    return (
      <ul className={`agents-compact agents-rows ${single ? '' : 'is-grouped'}`} ref={body as RefObject<HTMLUListElement | null>}>
        {groups.map(group => {
          const session = group.rows[0].session;
          return (
            <li key={group.key} className={rowClass(group)} style={rowStyle(group)} onClick={event=>activate(group,event.target)}><TablePreview label={groupName(group)} still={still}>
              <div className="agents-compact-main">
                {single ? (
                  <>
                    <Mark session={session} />
                    <Origin origin={session.origin} />
                    <span className="agents-project" title={placeOf(session)}>
                      <span>{projectName(session.project)}{columns.includes('client')&&<small className="agents-client">{session.clientId?clientName(session.clientId):'—'}</small>}</span>
                      {folderOf(session) && <small>{folderOf(session)}</small>}
                      <SessionState session={session}/>
                    </span>
                  </>
                ) : (
                  <span className="agents-project">{opener(group)}</span>
                )}
                {columns.includes(lead) && <span className="agents-age">{COLUMNS[lead].cell(group, context)}</span>}
              </div>
              {details.length > 0 && (
                <div className="agents-compact-details">
                  {details.map(column => (
                    <span key={column} title={fullOf(group, column)}>
                      <span className="sr-only">{t(COLUMNS[column].title)}: </span>
                      {column === 'worked' ? <WorkTime ms={group.workedMs} refs={group.rows.flatMap(row=>row.session.ref?[row.session.ref]:[])} still={still} labeled /> : COLUMNS[column].cell(group, context)}
                    </span>
                  ))}
                </div>
              )}
            </TablePreview></li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="table-wrap agents-rows">
      <table>
        <colgroup><col />{columns.map(column => <col key={column} style={{width: AGENT_WIDTHS[column]}} />)}</colgroup>
        {sorting && (
          <thead>
            <tr>
              {sorting.headers.map(column => (
                <TableHeading key={column.id} id={column.id} title={t(column.title)} hint={COLUMNS[column.id].hint&&t(COLUMNS[column.id].hint!)} sorting={{active:sorting.active,onSort:sorting.sortBy}}/>
              ))}
            </tr>
          </thead>
        )}
        <tbody ref={body as RefObject<HTMLTableSectionElement | null>}>
          {groups.map(group => {
            const session = group.rows[0].session;
            return (
              <tr key={group.key} className={rowClass(group)} style={rowStyle(group)} onClick={event=>activate(group,event.target)}>
                {single ? (
                  <td title={placeOf(session)}><TablePreview label={placeOf(session)??projectName(session.project)} still={still}>
                    <Mark session={session} />
                    <Origin origin={session.origin} />
                    {projectName(session.project)}
                    {folderOf(session) && <small className="agents-folder">{folderOf(session)}</small>}
                    <SessionState session={session}/>
                  </TablePreview></td>
                ) : (
                  <td><TablePreview label={groupName(group)} still={still}>{opener(group)}</TablePreview></td>
                )}
                {columns.map(column => (
                  <td key={column} title={fullOf(group, column)}><TablePreview label={t(COLUMNS[column].title)} still={still}>{COLUMNS[column].cell(group, context)}</TablePreview></td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The columns the list shows, gathered as it is (`inGroup`: the agents of one of its groups): the name, and those after it the owner has not hidden. */
type Arrangement = (inGroup: boolean) => {name: Dimension; columns: AgentColumn[]};

/**
 * The list in a dialog, as it changes: all its groups, in the widget's order and with its
 * columns, or the agents of one of them (`initial`, else one chosen here), with a way
 * back to all where it came from them. A table where they fit its width, otherwise a list
 * with the sorting in a menu, as the widget has.
 */
export function AgentsDialog({
  groups,
  by,
  arrangement,
  agentsSort,
  sortBy,
  color,
  empty,
  period,
  initial,
  onClose,
  restore,
  keepChosen=false,
  chosenTitle,
}: {
  groups: AgentGroup[];
  by: AgentsBy;
  arrangement: Arrangement;
  agentsSort: AgentsSort;
  sortBy: (active: AgentsSort, column: AgentColumn|null, cycle?: boolean) => void;
  color: Context['color'];
  empty: 'none' | 'noneShown' | null;
  period: SessionPeriod;
  initial: string | null;
  onClose: () => void;
  restore: () => HTMLElement | null;
  keepChosen?:boolean;
  chosenTitle?:string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState(initial);
  const [page,setPage]=useState(0);
  // A group whose agents have all gone leaves its dialog with all the others.
  const missing=keepChosen&&chosen!==null&&!groups.some(g=>g.key===chosen);
  const group = by === 'none' || chosen === null ? null : (groups.find(g => g.key === chosen) ?? null);
  const {name, columns} = arrangement(group !== null);
  const layout = useAgentsLayout(box, columns);
  const shown = [name, ...columns];
  const active = visibleAgentsSort(agentsSort, shown);
  const ordered = sortedGroups(missing?[]:group ? groupsOf(group.rows, 'none') : groups, active, shown);
  const sorting: Sorting = {active, headers: shown.map(id => ({id, title: COLUMNS[id].title})), sortBy: (column, cycle) => {setPage(0);sortBy(active, column, cycle);}};
  const currentPage=Math.min(page,Math.max(0,Math.ceil(ordered.length/50)-1));
  const back = group !== null && initial === null;
  const sortMenu = layout === 'list' && ordered.length > 0;
  const title = chosenTitle??(group ? (by === 'project' ? projectName(group.name) : (group.name ?? '')) : t('agents.title'));
  // A control that goes (a sort with its column or its form, a group left, or with the last agent) leaves the focus in the dialog, after any render.
  useLayoutEffect(() => {
    if (document.activeElement === document.body) box.current?.closest<HTMLElement>('.dialog')?.focus();
  });
  return (
    <Modal title={title} wide onClose={onClose} restore={restore}>
      <div className="agents-dialog" ref={box}>
        <PeriodStatus {...period}/>
        {(back || sortMenu) && (
          <div className="agents-dialog-head">
            {back && (
              <button type="button" className="text-button agents-back" onClick={() => setChosen(null)}>
                <span aria-hidden="true">←</span> {t('agents.allGroups')}
              </button>
            )}
            {sortMenu && <SortMenu {...sorting} />}
          </div>
        )}
        {empty||missing ? (
          !period.loading&&!period.error&&period.basis&&<p className="panel-empty">{t(`agents.${empty??'none'}`)}</p>
        ) : (
          <AgentsRows groups={ordered.slice(currentPage*50,currentPage*50+50)} name={name} columns={columns} single={group !== null || by === 'none'} layout={layout} color={color} sorting={sorting} onOpen={key=>{setChosen(key);setPage(0);}} />
        )}
        <AgentPages page={currentPage} count={ordered.length} onPage={setPage}/>
      </div>
    </Modal>
  );
}

/**
 * Period sessions gathered by project (or machine, subscription, or not at all: each
 * viewer's choice), as a table where the chosen columns fit, otherwise a compact list: a
 * group tells how many of its agents work, how long they have worked and when one last did,
 * and opens its agents in a dialog. It reads the agents of every source of the board and
 * their names, not their cards: a new measurement does not render it. What shows time is
 * a part of its own. In a widget made shorter than its rows it shows the first of them that
 * fit whole in a page, with the shared pager at the bottom right. Layout, fitting and
 * measurement belong to the common table widget; a group still opens its own sessions.
 */
export const AgentsPanel = memo(function AgentsPanel({arrange}: {arrange: Arrange}) {
  useLocale();
  const lineup = useLineup();
  const titles = useTitles(arrange.view.names);
  const agentsSort=usePref('agentsSort'),agentsBy=usePref('agentsBy'),range=usePref('range');
  const selected=useTimeRange();
  const view = arrange.view;
  /** The dialog, open on all the groups or on one; and the group whose row opened it, to go back to. */
  const [open, setOpen] = useState<{group: string | null} | null>(null);
  const arrangement = useCallback<Arrangement>(
    inGroup => {
      const {name, rest} = columnsOf(agentsBy, inGroup);
      return {name, columns: rest.filter(column => columnShown(view, AGENTS, column))};
    },
    [agentsBy, view],
  );
  const period=usePeriodSessions(rows=>{
    // Duration and presence labels have their own clock. Only their visible
    // sorts can reorder the panel or its open detail dialog as time passes.
    if(!agentsSort||!['worked','running','active','concurrency'].includes(agentsSort.column))return null;
    const entries=rows.flatMap((session):AgentRow[]=>session.source===null?[{session,source:null}]:titles[session.source]?[{session,source:{id:session.source,...titles[session.source],sessions:[]}}]:[]).sort((a,b)=>byActivity(a.session,b.session)||(a.source?.id??'').localeCompare(b.source?.id??''));
    const worked:string[][][]=[];
    let activity:SessionOrder['activity'];
    const order=(rows:AgentRow[],by:AgentsBy,inGroup:boolean)=>{
      const {name,columns}=arrangement(inGroup),shown=[name,...columns];
      const sort=visibleAgentsSort(agentsSort,shown);if(!sort)return null;
      const groups=sortedGroups(groupsOf(rows,by,by!=='none'&&(sort.column==='active'||sort.column==='concurrency')?boardPeriod.activitySummaryAt(activityDimension(by)):undefined),sort,shown);
      if(sort.column==='worked')worked.push(groups.filter(group=>group.workedMs!==null).map(group=>group.rows.flatMap(row=>row.session.ref?[row.session.ref]:[])));
      if(by!=='none'&&(sort.column==='active'||sort.column==='concurrency'))activity={by:activityDimension(by),column:sort.column,keys:groups.map(group=>group.key)};
      return groups.map(group=>group.key);
    };
    const key=[order(entries,agentsBy,false),open&&agentsBy!=='none'?groupsOf(entries,agentsBy).map(group=>[group.key,order(group.rows,'none',true)]):null];
    return {key,worked,...(activity?{activity}:{})};
  });
  const sources = useMemo(
    () => {const bySource=new Map<string,LiveSession[]>();for(const row of period.rows){if(row.source===null)continue;let rows=bySource.get(row.source);if(!rows)bySource.set(row.source,rows=[]);rows.push(row);}return lineup.flatMap((id):AgentSource[]=>titles[id]?[{id,provider:titles[id].provider,title:titles[id].title,sessions:bySource.get(id)??[]}]:[]);},
    [lineup, period.rows, titles],
  );
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<string | null>(null);
  // All admitted contexts remain in the table, independently of card placement.
  const {rows, empty} = agentRows(sources, arrange.view,period.rows.filter(row=>row.source===null));
  const working = rows.filter(row => row.session.working).length;
  const by = agentsBy === 'none' ? 'project' : agentsBy;
  const summary = boardPeriod.activitySummaryAt(activityDimension(by));
  const groups = groupsOf(rows, agentsBy, agentsBy === 'none' ? undefined : summary);
  const {name, columns} = arrangement(false);
  const shown = [name, ...columns];
  const active = visibleAgentsSort(agentsSort, shown);
  const ordered = sortedGroups(groups, active, shown);
  const color = useCallback((source: AgentSource | null) => ({'--card-color': source ? colorOf(view, source.id, source.provider) : 'var(--other)'}) as CSSProperties, [view]);
  const sortBy = useCallback((from: AgentsSort, column: AgentColumn|null, cycle = true) => setPrefs({agentsSort: nextAgentsSort(from, column, cycle)}), []);
  const sorting: Sorting = {active, headers: shown.map(id => ({id, title: COLUMNS[id].title})), sortBy: (column, cycle) => sortBy(active, column, cycle)};
  const single = agentsBy === 'none';
  const structural=AGENTS_BY.map(by=>columnsOf(by).rest.filter(column=>columnShown(view,AGENTS,column)));
  const structure=Array.from({length:Math.max(...structural.map(columns=>columns.length))},(_,i)=>Math.max(...structural.map(columns=>AGENT_WIDTHS[columns[i]]??0)));
  const summaryColumns=(['agents','worked','active','concurrency'] as const).filter(column=>columnShown(view,AGENTS,column));
  const footerMetrics=summaryColumns.length;
  const table=useTableWidget(panel,columns.map(column=>AGENT_WIDTHS[column]),NAME_WIDTH,ordered.map(group=>group.key),JSON.stringify([agentsBy,active,selected?timeRangeKey(selected):range]),0,structure,footerMetrics);
  const layout=table.layout;
  const refs=rows.flatMap(row=>row.session.ref?[row.session.ref]:[]);
  const worked=rows.some(row=>row.session.workedMs===null)?null:rows.reduce((sum,row)=>sum+row.session.workedMs!,0);
  const workedText=(now:number)=>!boardPeriod.activitySummaryAt(activityDimension(by),now)?.known||worked===null?'—':workHours(boardPeriod.workedAt(refs,worked,now)!);
  const metrics:TableMetric[]=[
    ...(summaryColumns.includes('agents')?[{id:'sessions',column:'agents',label:t('activity.agents'),cell:{time:'session-count',changesAt:(now:number)=>boardPeriod.activityCoverageChangesAt(now),at:(now:number)=>({content:boardPeriod.activitySummaryAt(activityDimension(by),now)?.known?agentCount(rows):'—',title:t('activity.agentsHint')})}}]:[]),
    ...(summaryColumns.includes('worked')?[{id:'worked',label:t('agents.worked'),cell:{time:'worked',changesAt:(now:number)=>withCoverage(now,worked===null?null:boardPeriod.workedChangesAt(refs,now,workedText)),at:(now:number)=>({content:workedText(now),title:t('agents.workedHint')})}}]:[]),
    ...(['active','concurrency'] as const).filter(column=>summaryColumns.includes(column)).map(column=>({id:column,label:t(COLUMNS[column].title),compactLabel:column==='concurrency'?t('activity.atOnce'):undefined,cell:activityCell(by,column)})),
  ];
  const workingSummary:TimedCell={time:'working-count',changesAt:now=>boardPeriod.activityCoverageChangesAt(now),at:now=>{
    const known=boardPeriod.activitySummaryAt(activityDimension(by),now)?.known;
    return {content:t('agents.machineSummary',{working:known?working:'—',count:known?agentCount(rows):'—'})};
  }};
  // Who may change what: every viewer how the list gathers, the owner its columns and whether it shows.
  const toggles = columnsOf(agentsBy).rest;
  const detailToggles = single ? [] : columnsOf(agentsBy, true).rest.filter(column => !toggles.includes(column));

  const close = useCallback(() => setOpen(null), []);
  const openGroup = useCallback((key: string) => {
    opener.current = key;
    setOpen({group: key});
  }, []);
  // The row that opened the dialog may be gone when it closes, or drawn anew as a list or a table: then the one there is now, or the title.
  const restore = useCallback(() => {
    const root = panel.current;
    const row = opener.current === null ? null : root?.querySelector<HTMLElement>(`[data-agents-group="${CSS.escape(opener.current)}"]`);
    return row ?? heading.current;
  }, []);

  return (
    <section ref={panel} className={`panel agents-panel${period.loading?' is-loading':''}`} aria-label={t('agents.title')} aria-busy={period.loading}
      data-history-range={period.loading||period.error?undefined:selected&&period.basis?timeRangeKey(period.basis.range):range}>
      <div className="panel-head">
        <div className="panel-heading"><h2 ref={heading} tabIndex={-1}>{t('agents.title')}</h2>
          {tableCell('working',workingSummary,(cell,time)=><p className="analytics-note" data-time={time}>{cell.content}</p>)}
        </div>
        <div className="panel-controls">
          <ReadState loading={period.loading&&!!selected} error={period.error} range={period.basis?.range} retry={boardPeriod.retry}/>
          {layout === 'list' && <SortMenu {...sorting} />}
          <Popover label={t('agents.settings')} icon={<SlidersIcon />}>
            <div className="popover-pad"><SessionCoverage by={by} empty={empty} showEmpty={!period.loading&&!period.error}/></div>
            <TableGrouping value={agentsBy} options={AGENTS_BY.map(by=>[by,t(by==='none'?'agents.byNone':COLUMNS[by].title)])} onChange={agentsBy=>setPrefs({agentsBy})}/>
            {arrange.owner && (
              <>
                <div className="popover-section">
                  <div className="popover-title">{t('agents.columns')}</div>
                  {toggles.map(column => (
                    <SwitchRow key={column} on={columnShown(view, AGENTS, column)} onChange={on => arrange.update(view => withColumn(view, AGENTS, column, on))}>
                      {t(COLUMNS[column].title)}
                    </SwitchRow>
                  ))}
                </div>
                {detailToggles.length > 0 && (
                  <div className="popover-section">
                    <div className="popover-title">{t('agents.detailsColumns')}</div>
                    {detailToggles.map(column => (
                      <SwitchRow key={column} on={columnShown(view, AGENTS, column)} onChange={on => arrange.update(view => withColumn(view, AGENTS, column, on))}>
                        {t(COLUMNS[column].title)}
                      </SwitchRow>
                    ))}
                  </div>
                )}
                <HideRow onHide={() => arrange.update(view => withHidden(view, AGENTS, true))}>{t('widget.hide')}</HideRow>
              </>
            )}
          </Popover>
        </div>
      </div>
      <TableSurface table={table}>
      {empty&&<SessionCoverage by={by} empty={empty} showEmpty={!period.loading&&!period.error}/>}
      {!empty && (
        <AgentsRows
          groups={ordered.slice(table.from,table.to)}
          name={name}
          columns={columns}
          single={single}
          layout={layout}
          color={color}
          sorting={sorting}
          onOpen={openGroup}
          body={table.live}
        />
      )}
      </TableSurface>
      <WidgetPages table={table} count={ordered.length} metrics={metrics} columns={[name,...columns]}/>
      <TableMeasure table={table} metrics={metrics} columns={[name,...columns]}><AgentsRows groups={ordered.slice(table.measureFrom,table.measureTo)} name={name} columns={columns} single={single} layout={layout} color={color} still body={table.measured}/></TableMeasure>
      {open && (
        <AgentsDialog
          groups={ordered}
          by={agentsBy}
          arrangement={arrangement}
          agentsSort={agentsSort}
          sortBy={sortBy}
          color={color}
          empty={empty}
          period={period}
          initial={open.group}
          onClose={close}
          restore={restore}
        />
      )}
    </section>
  );
});

export function AgentPages({page,count,onPage}:{page:number;count:number;onPage:(page:number)=>void}) {
  return <TablePages page={page} pages={Math.max(1,Math.ceil(count/50))} onPage={onPage} range={`${page*50+1}–${Math.min(count,page*50+50)} / ${count}`}/>;
}
