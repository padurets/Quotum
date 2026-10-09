import {boardPeriod,usePeriodSessions} from '../lib/period';
import {PeriodStatus} from './PeriodStatus';
import {memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject} from 'react';
import type {LiveSession} from '../lib/types';
import {sourceLabel} from '../lib/quota';
import {AGENTS, colorOf, columnShown, withColumn, withHidden, type Arrange} from '../lib/view';
import {
  AGENT_WIDTHS,
  AGENTS_BY,
  DIMENSIONS,
  agentRows,
  agentsFit,
  agentsLayout,
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
  sessionPresenceChangesAt,
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
import {recentActivity, stamp, workHours} from '../lib/format';
import {useLineup, useTitles} from '../lib/board';
import {setPrefs, usePrefs} from '../lib/prefs';
import {hubNow,useClock} from '../lib/clock';
import {t, useLocale, type Key} from '../i18n';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';
import {RecentActivity} from './Time';
import {Modal} from './Kit';
import {fillOf, pixels, useSizing} from './sizing';

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

function SessionState({session,still=false}:{session:LiveSession;still?:boolean}){
  const now=useClock(now=>still?null:sessionPresenceChangesAt(session,now));
  return <span className="sr-only" data-time="presence">, {stateOf(session,now)}</span>;
}

/** A cut name in full on hover: the project, and the folder on a line of its own. */
const placeOf = (session: LiveSession) => [session.project, folderOf(session)].filter(Boolean).join('\n') || undefined;

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
 * The coding agents running on a subscription right now, in the card's tray; not there
 * while none runs. The marks tell at a glance how many run and work on which machine;
 * the panel it opens, upwards where there is room, names them. When the tray has no room
 * for the marks (`roomy` false), they all go and the count stays; they are still laid out,
 * unseen, so the tray can tell when they fit again.
 */
export function Agents({sessions, roomy = true}: {sessions: LiveSession[]; roomy?: boolean}) {
  const [page,setPage]=useState(0);
  if (!sessions.length) return null;
  const currentPage=Math.min(page,Math.max(0,Math.ceil(sessions.length/50)-1));
  const machines = machinesOf(sessions.slice(currentPage*50,currentPage*50+50));
  const working = sessions.filter(s => s.working).length;
  const summary = t('agents.summary', {count: sessions.length, working});
  return (
    <Popover
      label={summary}
      triggerClass="tray-pill agents-pill"
      up
      trigger={
        <>
          <TerminalIcon />
          <span className="agents-count">
            <b>{working}</b>/{sessions.length}
          </span>
          {drawn(sessions) && (
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
              <small>{t('agents.machineSummary', {working: machine.sessions.filter(s => s.working).length, count: machine.sessions.length})}</small>
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
type Context = {still: boolean; color: (source: AgentSource) => CSSProperties};

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
  return (
    <span className="agents-tally">
      <span className="agents-count" aria-hidden="true">
        <b>{group.working}</b>/{group.rows.length}
      </span>
      {drawn(group.rows) && (
        <span className="agents-marks" aria-hidden="true">
          {group.rows.map((row, i) => (
            <Mark key={i} session={row.session} style={color(row.source)} />
          ))}
        </span>
      )}
      <span className="sr-only">{t('agents.machineSummary', {working: group.working, count: group.rows.length})}</span>
    </span>
  );
}

/** Last observed work; the unseen sizing copy never subscribes to the page clock. */
function LastActivity({group, still}: {group: AgentGroup; still: boolean}) {
  if(group.rows[0]?.session.ref&&group.lastWorkedAt!==null)return <span>{stamp(group.lastWorkedAt)}</span>;
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
  column === 'project' ? projectName(row.session.project) : column === 'machine' ? row.session.device.name : sourceLabel(row.source);

const isDimension = (column: AgentColumn): column is Dimension => (DIMENSIONS as readonly AgentColumn[]).includes(column);

/** Every column of the list: its heading, its hint where the heading needs one, and what it says of a group (an agent's row being a group of one). */
const COLUMNS: Record<AgentColumn, {title: Key; hint?: Key; cell: (group: AgentGroup, context: Context) => ReactNode}> = {
  project: {title: 'agents.project', cell: group => dimensionName(group, 'project')},
  machine: {title: 'agents.machine', cell: group => dimensionName(group, 'machine')},
  subscription: {title: 'agents.subscription', cell: group => dimensionName(group, 'subscription')},
  agents: {title: 'agents.agents', cell: (group, {color}) => <Tally group={group} color={color} />},
  worked: {title: 'agents.worked', hint: 'agents.workedHint', cell: (group,{still}) => <WorkTime ms={group.workedMs} refs={group.rows.flatMap(row=>row.session.ref?[row.session.ref]:[])} still={still}/>},
  activity: {title: 'agents.lastActivity', hint: 'agents.lastActivityHint', cell: (group, {still}) => <LastActivity group={group} still={still} />},
  running: {title: 'agents.running', cell: (group, {still}) => <RunningTime group={group} still={still}/>},
};

/** A cut name in full on hover. */
const fullOf = (group: AgentGroup, column: AgentColumn) => (isDimension(column) ? dimensionName(group, column) : undefined);

const SortIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M4 3v10M1.5 10.5 4 13l2.5-2.5M9 4h5M9 8h3.5M9 12h2" />
  </svg>
);

/** How the reader sorts the agents, in this browser: by a column's header, or in a menu where the list has none. */
type Sorting = {active: AgentsSort; headers: {id: AgentColumn; title: Key}[]; sortBy: (column: AgentColumn, cycle?: boolean) => void};

function SortMenu({active, headers, sortBy}: Sorting) {
  const direction = active?.descending ? 'descending' : 'ascending';
  return (
    <Popover label={t('agents.sort')} icon={<SortIcon />}>
      <div className="popover-title">{t('agents.sort')}</div>
      <button type="button" className="popover-row" aria-pressed={!active} onClick={() => setPrefs({agentsSort: null})}>
        <span>{t('agents.activity')}</span><b aria-hidden="true">{!active ? '✓' : ''}</b>
      </button>
      {headers.map(column => (
        <button type="button" className="popover-row" key={column.id} aria-pressed={active?.column === column.id} onClick={() => sortBy(column.id, false)}>
          <span>{t(column.title)}</span>
          {active?.column === column.id && <b><span aria-hidden="true">{active.descending ? '↓' : '↑'}</span><span className="sr-only">{t(`agents.${direction}`)}</span></b>}
        </button>
      ))}
    </Popover>
  );
}

/**
 * Whether the agents read as a table or a compact list: a table where the chosen columns
 * after the name fit the width of the widget or the dialog they are in (`box` is inside
 * it), decided before they are first drawn, and again as it is resized: before that paints
 * too where the board gives the widget another width (`width`, its key of the board's sizing).
 */
function useAgentsLayout(box: RefObject<HTMLElement | null>, columns: readonly AgentColumn[], width?: string) {
  const [layout, setLayout] = useState<'table' | 'list'>('list');
  const key = columns.join();
  useLayoutEffect(() => {
    // The table runs edge to edge of the widget or the dialog: as wide as it is inside its border.
    const element = box.current!.closest<HTMLElement>('.dialog, .panel')!;
    const chosen = key ? (key.split(',') as AgentColumn[]) : [];
    const fit = () => {
      const next = agentsLayout(chosen, element.clientWidth);
      setLayout(before => (before === next ? before : next));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => observer.disconnect();
  }, [box, key, width]);
  return layout;
}

/** The last row of a list made shorter than its rows: how many more there are, of what it gathers. */
const MORE: Record<AgentsBy, Key> = {project: 'agents.moreProjects', machine: 'agents.moreMachines', subscription: 'agents.moreSubscriptions', none: 'agents.more'};

/**
 * Rows of the list as a table or a compact list, in the order given, with the columns
 * given after the name (`name`, the dimension it shows): a group's name opens its agents
 * (`onOpen`), and a row of one agent (`single`) shows its mark, where it runs, its project
 * and its folder instead. In the widget, all of them in its dialog, and, unseen, laid out to
 * be measured (`still`). `more`, when some are left out, is a last row that says how many
 * and opens the rest (`onMore`). `body` is the list's or the table's rows, that last one included.
 */
function AgentsRows({
  groups,
  name,
  columns,
  single,
  by,
  layout,
  color,
  sorting,
  more = 0,
  onMore,
  onOpen,
  still = false,
  body,
}: {
  groups: AgentGroup[];
  name: Dimension;
  columns: AgentColumn[];
  single: boolean;
  /** What the rows gather, as the row saying how many more names it. */
  by: AgentsBy;
  layout: 'table' | 'list';
  color: Context['color'];
  /** The table's headers, which sort it; the rows measured have none. */
  sorting?: Sorting;
  more?: number;
  onMore?: () => void;
  onOpen?: (key: string) => void;
  still?: boolean;
  body?: RefObject<HTMLElement | null>;
}) {
  const context: Context = {still, color};
  const rest = more > 0 && (
    <button type="button" className="agents-more-button" data-agents-more={still ? undefined : ''} tabIndex={still ? -1 : undefined} onClick={onMore}>
      {t(MORE[single ? 'none' : by], {count: more})}
    </button>
  );
  const open = (group: AgentGroup) => (single || still || !onOpen ? undefined : () => onOpen(group.key));
  const rowClass = (group: AgentGroup) => `${group.working ? 'is-working' : ''} ${single || still || !onOpen ? '' : 'is-group'}`;
  // A row of one agent takes its card's colour, for its mark; a group's marks each take their own.
  const rowStyle = (group: AgentGroup) => (single ? color(group.rows[0].source) : undefined);
  const groupName = (group: AgentGroup) => (name === 'project' ? projectName(group.name) : (group.name ?? ''));
  const opener = (group: AgentGroup) => (
    <button
      type="button"
      className="agents-open"
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
    const details = columns.filter(column => column !== lead);
    return (
      <ul className={`agents-compact agents-rows ${single ? '' : 'is-grouped'}`} ref={body as RefObject<HTMLUListElement | null>}>
        {groups.map(group => {
          const session = group.rows[0].session;
          return (
            <li key={group.key} className={rowClass(group)} style={rowStyle(group)} onClick={open(group)}>
              <div className="agents-compact-main">
                {single ? (
                  <>
                    <Mark session={session} />
                    <Origin origin={session.origin} />
                    <span className="agents-project" title={placeOf(session)}>
                      <span>{projectName(session.project)}</span>
                      {folderOf(session) && <small>{folderOf(session)}</small>}
                      <SessionState session={session} still={still}/>
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
            </li>
          );
        })}
        {rest && <li key="more" className="agents-more">{rest}</li>}
      </ul>
    );
  }
  const direction = sorting?.active?.descending ? 'descending' : 'ascending';
  return (
    <div className="table-wrap agents-rows">
      <table>
        <colgroup><col />{columns.map(column => <col key={column} style={{width: AGENT_WIDTHS[column]}} />)}</colgroup>
        {sorting && (
          <thead>
            <tr>
              {sorting.headers.map(column => (
                <th scope="col" key={column.id} aria-sort={sorting.active?.column === column.id ? direction : undefined} title={COLUMNS[column.id].hint && t(COLUMNS[column.id].hint!)}>
                  <button type="button" onClick={() => sorting.sortBy(column.id)}>
                    {t(column.title)}<span className="agents-sort-arrow" aria-hidden="true">{sorting.active?.column === column.id ? sorting.active.descending ? '↓' : '↑' : ''}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody ref={body as RefObject<HTMLTableSectionElement | null>}>
          {groups.map(group => {
            const session = group.rows[0].session;
            return (
              <tr key={group.key} className={rowClass(group)} style={rowStyle(group)} onClick={open(group)}>
                {single ? (
                  <td title={placeOf(session)}>
                    <Mark session={session} />
                    <Origin origin={session.origin} />
                    {projectName(session.project)}
                    {folderOf(session) && <small className="agents-folder">{folderOf(session)}</small>}
                    <SessionState session={session} still={still}/>
                  </td>
                ) : (
                  <td>{opener(group)}</td>
                )}
                {columns.map(column => (
                  <td key={column} title={fullOf(group, column)}>{COLUMNS[column].cell(group, context)}</td>
                ))}
              </tr>
            );
          })}
          {rest && (
            <tr key="more" className="agents-more">
              <td colSpan={columns.length + 1}>{rest}</td>
            </tr>
          )}
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
function AgentsDialog({
  groups,
  by,
  arrangement,
  agentsSort,
  sortBy,
  color,
  empty,
  initial,
  onClose,
  restore,
}: {
  groups: AgentGroup[];
  by: AgentsBy;
  arrangement: Arrangement;
  agentsSort: AgentsSort;
  sortBy: (active: AgentsSort, column: AgentColumn, cycle?: boolean) => void;
  color: Context['color'];
  empty: 'none' | 'noneShown' | null;
  initial: string | null;
  onClose: () => void;
  restore: () => HTMLElement | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState(initial);
  const [page,setPage]=useState(0);
  // A group whose agents have all gone leaves its dialog with all the others.
  const group = by === 'none' || chosen === null ? null : (groups.find(g => g.key === chosen) ?? null);
  const {name, columns} = arrangement(group !== null);
  const layout = useAgentsLayout(box, columns);
  const shown = [name, ...columns];
  const active = visibleAgentsSort(agentsSort, shown);
  const ordered = sortedGroups(group ? groupsOf(group.rows, 'none') : groups, active, shown);
  const sorting: Sorting = {active, headers: shown.map(id => ({id, title: COLUMNS[id].title})), sortBy: (column, cycle) => {setPage(0);sortBy(active, column, cycle);}};
  const currentPage=Math.min(page,Math.max(0,Math.ceil(ordered.length/50)-1));
  const back = group !== null && initial === null;
  const sortMenu = layout === 'list' && ordered.length > 0;
  const title = group ? (by === 'project' ? projectName(group.name) : (group.name ?? '')) : t('agents.title');
  // A control that goes (a sort with its column or its form, a group left, or with the last agent) leaves the focus in the dialog, after any render.
  useLayoutEffect(() => {
    if (document.activeElement === document.body) box.current?.closest<HTMLElement>('.dialog')?.focus();
  });
  return (
    <Modal title={title} wide onClose={onClose} restore={restore}>
      <div className="agents-dialog" ref={box}>
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
        {empty ? (
          <p className="panel-empty">{t(`agents.${empty}`)}</p>
        ) : (
          <AgentsRows groups={ordered.slice(currentPage*50,currentPage*50+50)} name={name} columns={columns} single={group !== null || by === 'none'} by={by} layout={layout} color={color} sorting={sorting} onOpen={key=>{setChosen(key);setPage(0);}} />
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
 * fit whole and a last row saying how many more, which opens them all in a dialog; it tells
 * the board what it needs (`useSizing`), measuring at most fifty rows beside the ones it shows.
 */
export const AgentsPanel = memo(function AgentsPanel({arrange}: {arrange: Arrange}) {
  useLocale();
  const lineup = useLineup();
  const titles = useTitles(arrange.view.names);
  const {agentsSort, agentsBy} = usePrefs();
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
    if(agentsSort?.column!=='worked'&&agentsSort?.column!=='running')return null;
    const entries=rows.flatMap(session=>titles[session.source]&&!view.hidden.includes('source:'+session.source)?[{session,source:{id:session.source,...titles[session.source],sessions:[]}}]:[]).sort((a,b)=>byActivity(a.session,b.session)||a.source.id.localeCompare(b.source.id));
    const order=(rows:AgentRow[],by:AgentsBy,inGroup:boolean)=>{
      const {name,columns}=arrangement(inGroup),shown=[name,...columns];
      return visibleAgentsSort(agentsSort,shown)?sortedGroups(groupsOf(rows,by),agentsSort,shown).map(group=>group.key):null;
    };
    return [order(entries,agentsBy,false),open&&agentsBy!=='none'?groupsOf(entries,agentsBy).map(group=>[group.key,order(group.rows,'none',true)]):null];
  });
  const sources = useMemo(
    () => {const bySource=new Map<string,LiveSession[]>();for(const row of period.rows){let rows=bySource.get(row.source);if(!rows)bySource.set(row.source,rows=[]);rows.push(row);}return lineup.flatMap((id):AgentSource[]=>titles[id]?[{id,provider:titles[id].provider,title:titles[id].title,sessions:bySource.get(id)??[]}]:[]);},
    [lineup, period.rows, titles],
  );
  const sizing = useSizing();
  const manual = sizing?.manual ?? false;
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const live = useRef<HTMLElement>(null);
  const unseen = useRef<HTMLElement>(null);
  const opener = useRef<string | null>(null);
  /** How many of the rows fit a height chosen for the widget, as last measured. */
  const [fit, setFit] = useState<number | null>(null);
  // Only what the board shows: a subscription whose card is hidden is left out here too.
  const {rows, empty} = agentRows(sources, arrange.view);
  const working = rows.filter(row => row.session.working).length;
  const groups = groupsOf(rows, agentsBy);
  const {name, columns} = arrangement(false);
  const layout = useAgentsLayout(panel, columns, sizing?.width);
  const shown = [name, ...columns];
  const active = visibleAgentsSort(agentsSort, shown);
  const ordered = sortedGroups(groups, active, shown);
  const color = useCallback((source: AgentSource) => ({'--card-color': colorOf(view, source.id, source.provider)}) as CSSProperties, [view]);
  const sortBy = useCallback((from: AgentsSort, column: AgentColumn, cycle = true) => setPrefs({agentsSort: nextAgentsSort(from, column, cycle)}), []);
  const sorting: Sorting = {active, headers: shown.map(id => ({id, title: COLUMNS[id].title})), sortBy: (column, cycle) => sortBy(active, column, cycle)};
  const single = agentsBy === 'none';
  // With two rows or more a row may say how many more there are: it is measured unseen, and in a chosen height every row with it.
  const measured = ordered.length >= 2;
  const count = manual && measured ? Math.min(fit ?? 50, ordered.length,50) : Math.min(50,ordered.length);
  // Who may change what: every viewer how the list gathers, the owner its columns and whether it shows.
  const toggles = columnsOf(agentsBy).rest;
  const detailToggles = single ? [] : columnsOf(agentsBy, true).rest.filter(column => !toggles.includes(column));

  const measure = useRef(() => {});
  measure.current = () => {
    const root = panel.current;
    if (!sizing || !root) return;
    const outer = root.getBoundingClientRect().height - fillOf(root);
    const items = [...(live.current?.children ?? [])] as HTMLElement[];
    const layer = [...(unseen.current?.children ?? [])] as HTMLElement[];
    if (!measured || !items.length || !layer.length) {
      sizing.report({min: pixels(outer), natural: pixels(outer), shown: pixels(outer)});
      return setFit(null);
    }
    const tops = (list: HTMLElement[]) => list.map(item => item.getBoundingClientRect().top);
    // All but the rows and the last one: the head, a table's headers, the spacing.
    const shell = outer - (items.at(-1)!.getBoundingClientRect().bottom - items[0].getBoundingClientRect().top);
    const footer = layer.at(-1)!.getBoundingClientRect().height;
    // A table's rows share the border between them, so the last one gives up only its half.
    const border = layout === 'table' ? (parseFloat(getComputedStyle(items[0].firstElementChild!).borderBottomWidth) || 0) / 2 : parseFloat(getComputedStyle(items[0]).borderBottomWidth) || 0;
    let heights: number[];
    if (manual) {
      const at = tops(layer);
      heights = at.slice(0, -1).map((top, i) => at[i + 1] - top);
      // The first row as it shows: under a table's headers it has half of theirs, which the unseen table has not.
      if (items.length > 1) heights[0] = items[1].getBoundingClientRect().top - items[0].getBoundingClientRect().top;
    } else {
      // Following its content the widget shows every row, the last one without its border.
      const at = tops(items);
      heights = items.map((item, i) => (i + 1 < items.length ? at[i + 1] : item.getBoundingClientRect().bottom + border) - at[i]);
    }
    const result = agentsFit({shell, rows: heights, footer, border, budget: manual ? sizing.allocated : Infinity});
    sizing.report({min: pixels(result.min), natural: pixels(result.natural), shown: pixels(outer)});
    if (manual) setFit(was => (was === result.shown ? was : result.shown));
  };
  // After every render, before paint: what it shows and what it needs follow the rows at once.
  useLayoutEffect(() => measure.current());
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(panel.current!);
    return () => observer.disconnect();
  }, []);
  const report = sizing?.report;
  useLayoutEffect(() => () => report?.(null), [report]);
  const close = useCallback(() => setOpen(null), []);
  const openGroup = useCallback((key: string) => {
    opener.current = key;
    setOpen({group: key});
  }, []);
  const openAll = () => {
    opener.current = null;
    setOpen({group: null});
  };
  // The row that opened the dialog may be gone when it closes, or drawn anew as a list or a table: then the one there is now, or the title.
  const restore = useCallback(() => {
    const root = panel.current;
    const row = opener.current === null ? null : root?.querySelector<HTMLElement>(`[data-agents-group="${CSS.escape(opener.current)}"]`);
    return row ?? root?.querySelector<HTMLElement>('[data-agents-more]') ?? heading.current;
  }, []);

  return (
    <section ref={panel} className="panel agents-panel" aria-label={t('agents.title')}>
      <div className="panel-head">
        <h2 ref={heading} tabIndex={-1}>{t('agents.title')}</h2>
        {rows.length > 0 && <span className="panel-note">{t('agents.machineSummary', {working, count: rows.length})}</span>}
        <div className="agents-controls">
          {layout === 'list' && <SortMenu {...sorting} />}
          <Popover label={t('agents.settings')} icon={<SlidersIcon />}>
            <div className="popover-section">
              <div className="popover-title">{t('agents.groupBy')}</div>
              {AGENTS_BY.map(by => (
                <button type="button" className="popover-row" key={by} aria-pressed={agentsBy === by} onClick={() => setPrefs({agentsBy: by})}>
                  <span>{t(by === 'none' ? 'agents.byNone' : COLUMNS[by].title)}</span>
                  <b aria-hidden="true">{agentsBy === by ? '✓' : ''}</b>
                </button>
              ))}
            </div>
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
      <PeriodStatus {...period}/>
      {empty ? (
        !period.loading&&!period.error&&period.basis&&<p className="panel-empty">{t(`agents.${empty}`)}</p>
      ) : (
        <AgentsRows
          groups={ordered.slice(0, count)}
          name={name}
          columns={columns}
          single={single}
          by={agentsBy}
          layout={layout}
          color={color}
          sorting={sorting}
          more={ordered.length - count}
          onMore={openAll}
          onOpen={openGroup}
          body={live}
        />
      )}
      {measured && (
        <div className="agents-measure" aria-hidden="true" inert>
          <AgentsRows groups={manual ? ordered.slice(0,50) : []} name={name} columns={columns} single={single} by={agentsBy} layout={layout} color={color} more={ordered.length - 1} still body={unseen} />
        </div>
      )}
      {open && (
        <AgentsDialog
          groups={ordered}
          by={agentsBy}
          arrangement={arrangement}
          agentsSort={agentsSort}
          sortBy={sortBy}
          color={color}
          empty={empty}
          initial={open.group}
          onClose={close}
          restore={restore}
        />
      )}
    </section>
  );
});

function AgentPages({page,count,onPage}:{page:number;count:number;onPage:(page:number)=>void}) {
  if(count<=50)return null;
  return <div className="period-pages">
    <button type="button" className="button" disabled={page===0} onClick={()=>onPage(page-1)}>{t('period.previous')}</button>
    <span>{page*50+1}–{Math.min(count,page*50+50)} / {count}</span>
    <button type="button" className="button" disabled={(page+1)*50>=count} onClick={()=>onPage(page+1)}>{t('period.next')}</button>
  </div>;
}
