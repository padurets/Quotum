import {memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import {useNow} from '../lib/api';
import type {LiveSession, SourceState} from '../lib/types';
import {duration} from '../lib/format';
import {sourceLabel} from '../lib/quota';
import {AGENTS, colorOf, columnShown, withColumn, withHidden, type Arrange} from '../lib/view';
import {AGENT_WIDTHS, agentRows, agentsLayout, drawn, folderOf, machinesOf, nextAgentsSort, sortedRows, visibleAgentsSort, type AgentColumn, type AgentRow} from '../lib/agents';
import {setPrefs, usePrefs} from '../lib/prefs';
import {t, useLocale, type Key} from '../i18n';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';

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

/** How long a session has run, short: a fresh one is "just now". */
const since = (ms: number) => (ms < 60_000 ? t('agents.justNow') : duration(ms, true));

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
export function Agents({sessions, now, roomy = true}: {sessions: LiveSession[]; now: number; roomy?: boolean}) {
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
                <span className="agents-project">
                  <span>{session.project ?? t('agents.noProject')}</span>
                  {folderOf(session) && <small>{folderOf(session)}</small>}
                  <span className="sr-only">, {stateOf(session)}</span>
                </span>
                <span className="agents-age">{since(now - session.startedAt)}</span>
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

/** A cut name in full on hover: the project, and the folder on a line of its own. */
const placeOf = (session: LiveSession) => [session.project, folderOf(session)].filter(Boolean).join('\n') || undefined;

/** The table's columns after the project, each one the owner can hide to make the widget narrow. */
const COLUMNS: {id: AgentColumn; title: Key; cell: (row: AgentRow, now: number) => ReactNode}[] = [
  {id: 'state', title: 'agents.state', cell: ({session}) => stateOf(session)},
  {id: 'subscription', title: 'agents.subscription', cell: ({source}) => sourceLabel(source)},
  {id: 'machine', title: 'agents.machine', cell: ({session}) => session.device.name},
  {id: 'origin', title: 'agents.origin', cell: ({session}) => <Origin origin={session.origin} />},
  {id: 'running', title: 'agents.running', cell: ({session}, now) => since(now - session.startedAt)},
];

const SortIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M4 3v10M1.5 10.5 4 13l2.5-2.5M9 4h5M9 8h3.5M9 12h2" />
  </svg>
);

/** Running agents as a table where the chosen columns fit, otherwise a compact list. */
export const AgentsPanel = memo(function AgentsPanel({sources, arrange}: {sources: SourceState[]; arrange: Arrange}) {
  useLocale();
  const now = useNow();
  const {agentsSort} = usePrefs();
  const panel = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<'table' | 'list'>('list');
  // Only what the board shows: a subscription whose card is hidden is left out here too.
  const {rows, empty} = agentRows(sources, arrange.view);
  const working = rows.filter(row => row.session.working).length;
  const columns = useMemo(() => COLUMNS.filter(column => columnShown(arrange.view, AGENTS, column.id)), [arrange.view]);
  const shown = useMemo(() => ['project' as const, ...columns.map(column => column.id)], [columns]);
  const active = visibleAgentsSort(agentsSort, shown);
  const ordered = sortedRows(rows, active, shown);
  const headers = [{id: 'project' as const, title: 'agents.project' as const}, ...columns];
  const has = (id: AgentColumn) => shown.includes(id);
  const color = (row: AgentRow) => ({'--card-color': colorOf(arrange.view, row.source.id, row.source.provider)} as CSSProperties);
  const sortBy = (column: AgentColumn, cycle = true) => setPrefs({agentsSort: nextAgentsSort(active, column, cycle)});
  const direction = active?.descending ? 'descending' : 'ascending';

  useEffect(() => {
    const element = panel.current!;
    const fit = () => {
      const next = agentsLayout(shown, element.clientWidth);
      setLayout(before => before === next ? before : next);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => observer.disconnect();
  }, [shown]);

  return (
    <section ref={panel} className="panel agents-panel" aria-label={t('agents.title')}>
      <div className="panel-head">
        <h2>{t('agents.title')}</h2>
        {rows.length > 0 && <span className="panel-note">{t('agents.machineSummary', {working, count: rows.length})}</span>}
        <div className="agents-controls">
          {layout === 'list' && (
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
          )}
          {arrange.owner && (
            <Popover label={t('agents.settings')} icon={<SlidersIcon />}>
              <div className="popover-title">{t('agents.columns')}</div>
              {COLUMNS.map(column => (
                <SwitchRow key={column.id} on={has(column.id)} onChange={on => arrange.update(view => withColumn(view, AGENTS, column.id, on))}>
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
      ) : layout === 'list' ? (
        <ul className="agents-compact">
          {ordered.map((row, i) => (
            <li key={i} className={row.session.working ? 'is-working' : ''} style={color(row)}>
              <div className="agents-compact-main">
                <Mark session={row.session} />
                {has('origin') && <Origin origin={row.session.origin} />}
                <span className="agents-project" title={placeOf(row.session)}>
                  <span>{row.session.project ?? t('agents.noProject')}</span>
                  {folderOf(row.session) && <small>{folderOf(row.session)}</small>}
                  {!has('state') && <span className="sr-only">, {stateOf(row.session)}</span>}
                </span>
                {has('running') && <span className="agents-age">{since(now - row.session.startedAt)}</span>}
              </div>
              {columns.some(column => ['machine', 'subscription', 'state'].includes(column.id)) && (
                <div className="agents-compact-details">
                  {columns.filter(column => ['machine', 'subscription', 'state'].includes(column.id)).map(column => (
                    <span key={column.id}><span className="sr-only">{t(column.title)}: </span>{column.cell(row, now)}</span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="table-wrap">
          <table>
            <colgroup><col />{columns.map(column => <col key={column.id} style={{width: AGENT_WIDTHS[column.id]}} />)}</colgroup>
            <thead>
              <tr>
                {headers.map(column => (
                  <th scope="col" key={column.id} aria-sort={active?.column === column.id ? direction : undefined}>
                    <button type="button" onClick={() => sortBy(column.id)}>
                      {t(column.title)}<span className="agents-sort-arrow" aria-hidden="true">{active?.column === column.id ? active.descending ? '↓' : '↑' : ''}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordered.map((row, i) => (
                <tr key={i} className={row.session.working ? 'is-working' : ''} style={color(row)}>
                  <td title={placeOf(row.session)}>
                    <Mark session={row.session} />
                    {row.session.project ?? t('agents.noProject')}
                    {folderOf(row.session) && <small className="agents-folder">{folderOf(row.session)}</small>}
                    {!has('state') && <span className="sr-only">, {stateOf(row.session)}</span>}
                  </td>
                  {columns.map(column => (
                    <td key={column.id} title={column.id === 'machine' ? row.session.device.name : column.id === 'subscription' ? sourceLabel(row.source) : undefined}>{column.cell(row, now)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});
