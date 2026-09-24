import type {CSSProperties} from 'react';
import type {LiveSession, SourceState} from '../lib/types';
import {duration} from '../lib/format';
import {sourceLabel} from '../lib/quota';
import {AGENTS, colorOf, withHidden, type Arrange} from '../lib/view';
import {t} from '../i18n';
import {HideRow, Popover, SlidersIcon} from './Popover';

/** More sessions than this are counted in the header instead of drawn one by one. */
const DRAWN = 10;

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
          {sessions.length <= DRAWN && (
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
              <div className={`agents-row ${session.working ? 'is-working' : ''}`} key={i} title={t(session.working ? 'agents.working' : 'agents.idle')}>
                <Mark session={session} />
                <span className="agents-project">
                  {session.project ?? t('agents.noProject')}
                  <span className="sr-only">, {t(session.working ? 'agents.working' : 'agents.idle')}</span>
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

/**
 * Every coding agent running on the board's subscriptions, as one table: a widget of the
 * current state, off until the board's owner turns it on (the cards show the same).
 */
export function AgentsPanel({sources, now, arrange}: {sources: SourceState[]; now: number; arrange: Arrange}) {
  const rows = sources
    .flatMap(source => source.sessions.map(session => ({source, session})))
    .sort((a, b) => a.session.device.name.localeCompare(b.session.device.name) || a.session.startedAt - b.session.startedAt);
  const working = rows.filter(row => row.session.working).length;
  return (
    <section className="panel agents-panel" aria-label={t('agents.title')}>
      <div className="panel-head">
        <h2>{t('agents.title')}</h2>
        {rows.length > 0 && <span className="panel-note">{t('agents.machineSummary', {working, count: rows.length})}</span>}
        {arrange.owner && (
          <Popover label={t('agents.settings')} icon={<SlidersIcon />}>
            <HideRow onHide={() => arrange.update(view => withHidden(view, AGENTS, true))}>{t('widget.hide')}</HideRow>
          </Popover>
        )}
      </div>
      {!rows.length ? (
        <p className="panel-empty">{t('agents.none')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('agents.project')}</th>
                <th>{t('agents.state')}</th>
                <th>{t('agents.subscription')}</th>
                <th>{t('agents.machine')}</th>
                <th>{t('agents.origin')}</th>
                <th>{t('agents.running')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({source, session}, i) => (
                <tr key={i} className={session.working ? 'is-working' : ''} style={{'--card-color': colorOf(arrange.view, source.id, source.provider)} as CSSProperties}>
                  <td>
                    <Mark session={session} />
                    {session.project ?? t('agents.noProject')}
                  </td>
                  <td>{stateOf(session)}</td>
                  <td>{sourceLabel(source)}</td>
                  <td>{session.device.name}</td>
                  <td>{t(`agents.${session.origin}`)}</td>
                  <td>{since(now - session.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
