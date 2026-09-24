import type {LiveSession} from '../lib/types';
import {duration} from '../lib/format';
import {t} from '../i18n';
import {Popover} from './Popover';

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
 * the panel it opens, upwards, names them.
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
      <div className="popover-title agents-title">
        <span>{t('agents.title')}</span>
        <span className="agents-legend">
          <i className="agent is-working" aria-hidden="true" /> {t('agents.working')}
          <i className="agent" aria-hidden="true" /> {t('agents.idle')}
        </span>
      </div>
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
                <span className="agents-project">{session.project ?? t('agents.noProject')}</span>
                <span className="agents-origin">{t(`agents.${session.origin}`)}</span>
                <span className="agents-age">{since(now - session.startedAt)}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Popover>
  );
}
