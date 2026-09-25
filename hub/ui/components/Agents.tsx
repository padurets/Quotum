import {memo, type CSSProperties, type ReactNode} from 'react';
import {useNow} from '../lib/api';
import type {LiveSession, SourceState} from '../lib/types';
import {duration} from '../lib/format';
import {sourceLabel} from '../lib/quota';
import {AGENTS, colorOf, columnShown, withColumn, withHidden, type Arrange} from '../lib/view';
import {agentRows, drawn, type AgentRow} from '../lib/agents';
import {t, useLocale, type Key} from '../i18n';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';

type Machine = {id: string; name: string; sessions: LiveSession[]};

function byMachine(sessions: LiveSession[]): Machine[] {
  const machines: Machine[] = [];
  for (const session of sessions) {
    const machine = machines.find(m => m.id === session.device.id);
    if (machine) machine.sessions.push(session);
    else machines.push({...session.device, sessions: [session]});
  }
  return machines;
}

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

/**
 * The coding agents running on a subscription right now, in the card's tray; not there
 * while none runs. The marks tell at a glance how many run and work on which machine;
 * the panel it opens, upwards where there is room, names them.
 */
export function Agents({sessions, now}: {sessions: LiveSession[]; now: number}) {
  if (!sessions.length) return null;
  const machines = byMachine(sessions);
  const working = sessions.filter(s => s.working).length;
  const summary = t('agents.summary', {count: sessions.length, working});
  return (
    <Popover
      label={summary}
      triggerClass="agents-pill"
      up
      trigger={
        <>
          <TerminalIcon />
          <span className="agents-count">
            <b>{working}</b>/{sessions.length}
          </span>
          {drawn(sessions) && (
            <span className="agents-marks">
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
                <span className="agents-project">
                  {session.project ?? t('agents.noProject')}
                  <span className="sr-only">, {stateOf(session)}</span>
                </span>
                <span className="agents-origin">{t(`agents.${session.origin}`)}</span>
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

/** The table's columns after the project, each one the owner can hide to make the widget narrow. */
const COLUMNS: {id: string; title: Key; cell: (row: AgentRow, now: number) => ReactNode}[] = [
  {id: 'state', title: 'agents.state', cell: ({session}) => stateOf(session)},
  {id: 'subscription', title: 'agents.subscription', cell: ({source}) => sourceLabel(source)},
  {id: 'machine', title: 'agents.machine', cell: ({session}) => session.device.name},
  {id: 'origin', title: 'agents.origin', cell: ({session}) => t(`agents.${session.origin}`)},
  {id: 'running', title: 'agents.running', cell: ({session}, now) => since(now - session.startedAt)},
];

/**
 * Every coding agent running on the board's subscriptions, as one table: a widget of the
 * current state, off until the board's owner turns it on (the cards show the same).
 */
export const AgentsPanel = memo(function AgentsPanel({sources, arrange}: {sources: SourceState[]; arrange: Arrange}) {
  useLocale();
  const now = useNow();
  // Only what the board shows: a subscription whose card is hidden is left out here too.
  const {rows, empty} = agentRows(sources, arrange.view);
  const working = rows.filter(row => row.session.working).length;
  const columns = COLUMNS.filter(column => columnShown(arrange.view, AGENTS, column.id));
  return (
    <section className="panel agents-panel" aria-label={t('agents.title')}>
      <div className="panel-head">
        <h2>{t('agents.title')}</h2>
        {rows.length > 0 && <span className="panel-note">{t('agents.machineSummary', {working, count: rows.length})}</span>}
        {arrange.owner && (
          <Popover label={t('agents.settings')} icon={<SlidersIcon />}>
            <div className="popover-title">{t('agents.columns')}</div>
            {COLUMNS.map(column => (
              <SwitchRow key={column.id} on={columnShown(arrange.view, AGENTS, column.id)} onChange={on => arrange.update(view => withColumn(view, AGENTS, column.id, on))}>
                {t(column.title)}
              </SwitchRow>
            ))}
            <HideRow onHide={() => arrange.update(view => withHidden(view, AGENTS, true))}>{t('widget.hide')}</HideRow>
          </Popover>
        )}
      </div>
      {empty ? (
        <p className="panel-empty">{t(`agents.${empty}`)}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('agents.project')}</th>
                {columns.map(column => (
                  <th key={column.id}>{t(column.title)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className={row.session.working ? 'is-working' : ''} style={{'--card-color': colorOf(arrange.view, row.source.id, row.source.provider)} as CSSProperties}>
                  <td title={row.session.project ?? undefined}>
                    <Mark session={row.session} />
                    {row.session.project ?? t('agents.noProject')}
                    {!columns.some(column => column.id === 'state') && <span className="sr-only">, {stateOf(row.session)}</span>}
                  </td>
                  {columns.map(column => (
                    <td key={column.id}>{column.cell(row, now)}</td>
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
