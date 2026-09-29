import {memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject} from 'react';
import type {LiveSession} from '../lib/types';
import {sourceLabel} from '../lib/quota';
import {AGENTS, colorOf, columnShown, withColumn, withHidden, type Arrange} from '../lib/view';
import {
  AGENT_WIDTHS,
  agentRows,
  agentsFit,
  agentsLayout,
  drawn,
  folderOf,
  machinesOf,
  nextAgentsSort,
  since,
  sortedRows,
  visibleAgentsSort,
  type AgentColumn,
  type AgentRow,
  type AgentSource,
  type AgentsSort,
} from '../lib/agents';
import {useLineup, useSessionsOf, useTitles} from '../lib/board';
import {setPrefs, usePrefs} from '../lib/prefs';
import {hubNow} from '../lib/clock';
import {t, useLocale, type Key} from '../i18n';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';
import {Since} from './Time';
import {Modal} from './Kit';
import {fillOf, pixels, useSizing} from './sizing';

/**
 * One session: filled with the card's colour while it works, outlined while idle; a
 * window of an editor or the app that is only open is outlined with a dash, so it does
 * not read as a forgotten session.
 */
function Mark({session}: {session: LiveSession}) {
  const quiet = !session.working && session.origin !== 'terminal';
  return <i className={`agent ${session.working ? 'is-working' : ''} ${quiet ? 'is-quiet' : ''}`} aria-hidden="true" />;
}

/** What a session is doing, as the legend names its mark. */
const stateOf = (session: LiveSession) =>
  t(session.working ? 'agents.working' : session.origin === 'terminal' ? 'agents.idle' : 'agents.window');

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
  if (!sessions.length) return null;
  const machines = machinesOf(sessions);
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
      <div className="popover-title">{t('agents.title')}</div>
      <div className="agents-list">
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
                <Since className="agents-age" from={session.startedAt} />
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

/** A running time laid out only to be measured: as wide as it reads now, and never moving on. */
const stillSince = (from: number, className?: string) => <span className={className}>{since(hubNow() - from)}</span>;

/** The table's columns after the project, each one the owner can hide to make the widget narrow. */
const COLUMNS: {id: AgentColumn; title: Key; cell: (row: AgentRow, still?: boolean) => ReactNode}[] = [
  {id: 'state', title: 'agents.state', cell: ({session}) => stateOf(session)},
  {id: 'subscription', title: 'agents.subscription', cell: ({source}) => sourceLabel(source)},
  {id: 'machine', title: 'agents.machine', cell: ({session}) => session.device.name},
  {id: 'origin', title: 'agents.origin', cell: ({session}) => <Origin origin={session.origin} />},
  {id: 'running', title: 'agents.running', cell: ({session}, still) => (still ? stillSince(session.startedAt) : <Since from={session.startedAt} />)},
];
type Column = (typeof COLUMNS)[number];

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
 * fit the width of the widget or the dialog they are in (`box` is inside it), decided
 * before they are first drawn, and again as it is resized.
 */
function useAgentsLayout(box: RefObject<HTMLElement | null>, shown: readonly AgentColumn[]) {
  const [layout, setLayout] = useState<'table' | 'list'>('list');
  useLayoutEffect(() => {
    // The table runs edge to edge of the widget or the dialog: as wide as it is inside its border.
    const element = box.current!.closest<HTMLElement>('.dialog, .panel')!;
    const fit = () => {
      const next = agentsLayout(shown, element.clientWidth);
      setLayout(before => (before === next ? before : next));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => observer.disconnect();
  }, [box, shown]);
  return layout;
}

/**
 * Agents as a table or a compact list, in the order given, with the columns given: in the
 * widget, all of them in its dialog, and, unseen, laid out to be measured (`still`: no
 * running time that moves on, nothing to press or find). `more`, when some are left out,
 * is a last row that says how many and opens the rest (`onMore`). `body` is the list's or
 * the table's rows, that last one included.
 */
function AgentsRows({
  rows,
  columns,
  layout,
  color,
  sorting,
  more = 0,
  onMore,
  still = false,
  body,
}: {
  rows: AgentRow[];
  columns: Column[];
  layout: 'table' | 'list';
  color: (row: AgentRow) => CSSProperties;
  /** The table's headers, which sort it; the rows measured have none. */
  sorting?: Sorting;
  more?: number;
  onMore?: () => void;
  still?: boolean;
  body?: RefObject<HTMLElement | null>;
}) {
  const has = (id: AgentColumn) => id === 'project' || columns.some(column => column.id === id);
  const rest = more > 0 && (
    <button type="button" className="agents-more-button" data-agents-more={still ? undefined : ''} tabIndex={still ? -1 : undefined} onClick={onMore}>
      {t('agents.more', {count: more})}
    </button>
  );
  if (layout === 'list')
    return (
      <ul className="agents-compact agents-rows" ref={body as RefObject<HTMLUListElement | null>}>
        {rows.map((row, i) => (
          <li key={i} className={row.session.working ? 'is-working' : ''} style={color(row)}>
            <div className="agents-compact-main">
              <Mark session={row.session} />
              {has('origin') && <Origin origin={row.session.origin} />}
              <span className="agents-project" title={placeOf(row.session)}>
                <span>{row.session.project ?? t('agents.noProject')}</span>
                {folderOf(row.session) && <small>{folderOf(row.session)}</small>}
                {!has('state') && <span className="sr-only">, {stateOf(row.session)}</span>}
              </span>
              {has('running') && (still ? stillSince(row.session.startedAt, 'agents-age') : <Since className="agents-age" from={row.session.startedAt} />)}
            </div>
            {columns.some(column => ['machine', 'subscription', 'state'].includes(column.id)) && (
              <div className="agents-compact-details">
                {columns.filter(column => ['machine', 'subscription', 'state'].includes(column.id)).map(column => (
                  <span key={column.id}><span className="sr-only">{t(column.title)}: </span>{column.cell(row, still)}</span>
                ))}
              </div>
            )}
          </li>
        ))}
        {rest && <li key="more" className="agents-more">{rest}</li>}
      </ul>
    );
  const direction = sorting?.active?.descending ? 'descending' : 'ascending';
  return (
    <div className="table-wrap agents-rows">
      <table>
        <colgroup><col />{columns.map(column => <col key={column.id} style={{width: AGENT_WIDTHS[column.id]}} />)}</colgroup>
        {sorting && (
          <thead>
            <tr>
              {sorting.headers.map(column => (
                <th scope="col" key={column.id} aria-sort={sorting.active?.column === column.id ? direction : undefined}>
                  <button type="button" onClick={() => sorting.sortBy(column.id)}>
                    {t(column.title)}<span className="agents-sort-arrow" aria-hidden="true">{sorting.active?.column === column.id ? sorting.active.descending ? '↓' : '↑' : ''}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody ref={body as RefObject<HTMLTableSectionElement | null>}>
          {rows.map((row, i) => (
            <tr key={i} className={row.session.working ? 'is-working' : ''} style={color(row)}>
              <td title={placeOf(row.session)}>
                <Mark session={row.session} />
                {row.session.project ?? t('agents.noProject')}
                {folderOf(row.session) && <small className="agents-folder">{folderOf(row.session)}</small>}
                {!has('state') && <span className="sr-only">, {stateOf(row.session)}</span>}
              </td>
              {columns.map(column => (
                <td key={column.id} title={column.id === 'machine' ? row.session.device.name : column.id === 'subscription' ? sourceLabel(row.source) : undefined}>{column.cell(row, still)}</td>
              ))}
            </tr>
          ))}
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

/**
 * All the agents of the widget in a dialog: the rows it reads, in its order and with its
 * columns, as they change. A table where they fit its width, otherwise a list with the
 * sorting in a menu, as the widget has.
 */
function AgentsDialog({
  rows,
  columns,
  shown,
  sorting,
  color,
  empty,
  onClose,
  restore,
}: {
  rows: AgentRow[];
  columns: Column[];
  shown: readonly AgentColumn[];
  sorting: Sorting;
  color: (row: AgentRow) => CSSProperties;
  empty: 'none' | 'noneShown' | null;
  onClose: () => void;
  restore: () => HTMLElement | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const layout = useAgentsLayout(box, shown);
  const working = rows.filter(row => row.session.working).length;
  // A control that goes (a sort with its column or its form, or with the last agent) leaves the focus in the dialog, after any render.
  useLayoutEffect(() => {
    if (document.activeElement === document.body) box.current?.closest<HTMLElement>('.dialog')?.focus();
  });
  return (
    <Modal title={t('agents.title')} wide onClose={onClose} restore={restore}>
      <div className="agents-dialog" ref={box}>
        <div className="agents-dialog-head">
          {rows.length > 0 && <span className="panel-note">{t('agents.machineSummary', {working, count: rows.length})}</span>}
          {layout === 'list' && rows.length > 0 && <SortMenu {...sorting} />}
        </div>
        {empty ? <p className="panel-empty">{t(`agents.${empty}`)}</p> : <AgentsRows rows={rows} columns={columns} layout={layout} color={color} sorting={sorting} />}
      </div>
    </Modal>
  );
}

/**
 * Running agents as a table where the chosen columns fit, otherwise a compact list. It
 * reads the agents of every source of the board and their names, not their cards: a new
 * measurement does not render it. How long each has run is a part of its own. In a widget
 * made shorter than its agents it shows the first of them that fit whole and a last row
 * saying how many more, which opens them all in a dialog; it tells the board what it needs
 * (`useSizing`), measuring all its rows unseen beside the ones it shows.
 */
export const AgentsPanel = memo(function AgentsPanel({arrange}: {arrange: Arrange}) {
  useLocale();
  const lineup = useLineup();
  const sessions = useSessionsOf(lineup);
  const titles = useTitles(arrange.view.names);
  const sources = useMemo(
    () => lineup.flatMap((id, i): AgentSource[] => (titles[id] ? [{id, provider: titles[id].provider, title: titles[id].title, sessions: sessions[i]}] : [])),
    [lineup, sessions, titles],
  );
  const {agentsSort} = usePrefs();
  const sizing = useSizing();
  const manual = sizing?.manual ?? false;
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const live = useRef<HTMLElement>(null);
  const unseen = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  /** How many of the agents fit a height chosen for the widget, as last measured. */
  const [fit, setFit] = useState<number | null>(null);
  // Only what the board shows: a subscription whose card is hidden is left out here too.
  const {rows, empty} = agentRows(sources, arrange.view);
  const working = rows.filter(row => row.session.working).length;
  const columns = useMemo(() => COLUMNS.filter(column => columnShown(arrange.view, AGENTS, column.id)), [arrange.view]);
  const shown = useMemo(() => ['project' as const, ...columns.map(column => column.id)], [columns]);
  const layout = useAgentsLayout(panel, shown);
  const active = visibleAgentsSort(agentsSort, shown);
  const ordered = sortedRows(rows, active, shown);
  const headers = [{id: 'project' as const, title: 'agents.project' as const}, ...columns];
  const color = (row: AgentRow) => ({'--card-color': colorOf(arrange.view, row.source.id, row.source.provider)} as CSSProperties);
  const sortBy = (column: AgentColumn, cycle = true) => setPrefs({agentsSort: nextAgentsSort(active, column, cycle)});
  const sorting = {active, headers, sortBy};
  // With two agents or more a row may say how many more there are: it is measured unseen, and in a chosen height every row with it.
  const measured = ordered.length >= 2;
  const count = manual && measured ? Math.min(fit ?? ordered.length, ordered.length) : ordered.length;

  const measure = useRef(() => {});
  measure.current = () => {
    const root = panel.current;
    if (!sizing || !root) return;
    const outer = root.getBoundingClientRect().height - fillOf(root);
    const items = [...(live.current?.children ?? [])] as HTMLElement[];
    const layer = [...(unseen.current?.children ?? [])] as HTMLElement[];
    if (!measured || !items.length || !layer.length) {
      sizing.report({min: pixels(outer), natural: pixels(outer)});
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
    sizing.report({min: pixels(result.min), natural: pixels(result.natural)});
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
  const close = useCallback(() => setOpen(false), []);
  // The row that opened the dialog may be gone when it closes, or drawn anew as a list or a table: then the one there is now, or the title.
  const restore = useCallback(() => panel.current?.querySelector<HTMLElement>('[data-agents-more]') ?? heading.current, []);

  return (
    <section ref={panel} className="panel agents-panel" aria-label={t('agents.title')}>
      <div className="panel-head">
        <h2 ref={heading} tabIndex={-1}>{t('agents.title')}</h2>
        {rows.length > 0 && <span className="panel-note">{t('agents.machineSummary', {working, count: rows.length})}</span>}
        <div className="agents-controls">
          {layout === 'list' && <SortMenu {...sorting} />}
          {arrange.owner && (
            <Popover label={t('agents.settings')} icon={<SlidersIcon />}>
              <div className="popover-title">{t('agents.columns')}</div>
              {COLUMNS.map(column => (
                <SwitchRow key={column.id} on={shown.includes(column.id)} onChange={on => arrange.update(view => withColumn(view, AGENTS, column.id, on))}>
                  {t(column.title)}
                </SwitchRow>
              ))}
              <HideRow onHide={() => arrange.update(view => withHidden(view, AGENTS, true))}>{t('widget.hide')}</HideRow>
            </Popover>
          )}
        </div>
      </div>
      {empty ? (
        <p className="panel-empty">{t(`agents.${empty}`)}</p>
      ) : (
        <AgentsRows rows={ordered.slice(0, count)} columns={columns} layout={layout} color={color} sorting={sorting} more={ordered.length - count} onMore={() => setOpen(true)} body={live} />
      )}
      {measured && (
        <div className="agents-measure" aria-hidden="true" inert>
          <AgentsRows rows={manual ? ordered : []} columns={columns} layout={layout} color={color} more={ordered.length - 1} still body={unseen} />
        </div>
      )}
      {open && <AgentsDialog rows={ordered} columns={columns} shown={shown} sorting={sorting} color={color} empty={empty} onClose={close} restore={restore} />}
    </section>
  );
});
