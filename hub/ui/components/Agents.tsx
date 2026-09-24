import type {LiveSession} from '../lib/types';
import {duration} from '../lib/format';
import {t} from '../i18n';

/** More sessions than this on one machine are counted instead of drawn one by one. */
const DRAWN = 6;

/** One session: filled with the card's colour while it works, outlined while idle. */
function Mark({working, quiet, label}: {working: boolean; quiet?: boolean; label?: string}) {
  return <i className={`agent ${working ? 'is-working' : ''} ${quiet ? 'is-quiet' : ''}`} title={label} aria-label={label} role={label ? 'img' : undefined} />;
}

/** How a session reads in its tooltip: project, where it runs, working or idle, for how long. */
function describe(session: LiveSession, now: number) {
  return [
    session.project,
    t(`agents.${session.origin}`),
    t(session.working ? 'agents.working' : 'agents.idle'),
    t('agents.for', {time: duration(now - session.startedAt, true)}),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The coding agents running on a subscription right now, by machine (named even when
 * alone: a mark needs a word beside it). A window of an
 * editor or the app that is only open, not working, is drawn fainter: it is a window,
 * not a forgotten session. The row is there only while something runs.
 */
export function Agents({sessions, now}: {sessions: LiveSession[]; now: number}) {
  if (!sessions.length) return null;
  const machines: {id: string; name: string; sessions: LiveSession[]}[] = [];
  for (const session of sessions) {
    const machine = machines.find(m => m.id === session.device.id);
    if (machine) machine.sessions.push(session);
    else machines.push({...session.device, sessions: [session]});
  }
  const working = sessions.filter(s => s.working).length;
  return (
    <div className="agents" role="group" aria-label={t('agents.summary', {count: sessions.length, working})}>
      {machines.map(machine => {
        const busy = machine.sessions.filter(s => s.working).length;
        return (
          <span className="agents-machine" key={machine.id}>
            <span className="agents-name">{machine.name}</span>
            {machine.sessions.length > DRAWN ? (
              <span className="agents-count" title={t('agents.summary', {count: machine.sessions.length, working: busy})}>
                {busy > 0 && (
                  <>
                    <Mark working /> ×{busy}
                  </>
                )}
                {machine.sessions.length > busy && (
                  <>
                    <Mark working={false} /> ×{machine.sessions.length - busy}
                  </>
                )}
              </span>
            ) : (
              machine.sessions.map((session, i) => (
                <Mark key={i} working={session.working} quiet={!session.working && session.origin !== 'terminal'} label={describe(session, now)} />
              ))
            )}
          </span>
        );
      })}
    </div>
  );
}
