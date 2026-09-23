import {useEffect, useState} from 'react';
import {call} from '../lib/http';
import {navigate} from '../lib/router';
import {rememberBoard, type Session} from '../lib/session';
import {AuthScreen} from './AuthScreen';
import {Brand, ErrorLine, Field} from './Kit';
import {rich, t} from '../i18n';

type Pending = {userCode: string; machine: {name: string; os: string; arch: string; agent: string}; expiresAt: number};

const OS: Record<string, string> = {linux: 'Linux', macos: 'macOS', windows: 'Windows'};

/**
 * Where a person confirms a code shown by `quotum connect`: the machine is described,
 * it becomes theirs, and the agent receives its own token. What it measures shows on
 * the person's own board, from where they share it with others.
 */
export function DevicePage({session, onSession}: {session: Session; onSession: (session: Session) => void}) {
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code') ?? '');
  const [pending, setPending] = useState<Pending | null>(null);
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const look = async (value = code) => {
    setBusy(true);
    setError(null);
    try {
      const found = await call<Pending>('GET', `/api/device?code=${encodeURIComponent(value)}`);
      setPending(found);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (session.user && code) void look();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.user]);

  if (!session.user) return <AuthScreen session={session} onSignedIn={next => onSession(next)} note={t('device.signIn')} />;

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', approve ? '/api/device/approve' : '/api/device/deny', {code: pending!.userCode});
      setDone(approve ? 'approved' : 'denied');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  // The personal board, where the machine's data shows first.
  const home = () => {
    const personal = session.boards.find(b => b.personal);
    if (personal) rememberBoard(personal.id);
    navigate('/');
  };
  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        {done === 'approved' ? (
          <>
            <h1>{t('device.connected')}</h1>
            <p className="auth-note">{t('device.connectedText', {machine: pending!.machine.name})}</p>
            <button type="button" className="button primary" onClick={home}>
              {t('device.openBoard')}
            </button>
          </>
        ) : done === 'denied' ? (
          <>
            <h1>{t('device.denied')}</h1>
            <p className="auth-note">{t('device.deniedText')}</p>
            <button type="button" className="button" onClick={() => navigate('/')}>
              {t('common.backHome')}
            </button>
          </>
        ) : pending ? (
          <>
            <h1>{t('device.confirm')}</h1>
            <dl className="device-facts">
              <dt>{t('device.device')}</dt>
              <dd>{pending.machine.name}</dd>
              <dt>{t('device.system')}</dt>
              <dd>
                {OS[pending.machine.os] ?? pending.machine.os} · {pending.machine.arch}
              </dd>
              <dt>{t('device.agent')}</dt>
              <dd className="mono">{pending.machine.agent}</dd>
              <dt>{t('device.code')}</dt>
              <dd className="mono">{pending.userCode}</dd>
            </dl>
            <p className="auth-note">{t('device.asYou')}</p>
            <p className="auth-note">{t('device.warning')}</p>
            <ErrorLine error={error} />
            <div className="button-row">
              <button type="button" className="button" disabled={busy} onClick={() => decide(false)}>
                {t('device.decline')}
              </button>
              <button type="button" className="button primary" disabled={busy} onClick={() => decide(true)}>
                {t('device.connect')}
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={event => {
              event.preventDefault();
              void look();
            }}
          >
            <h1>{t('device.title')}</h1>
            <p className="auth-note">{rich('device.enterCode', {command: <code>quotum connect</code>})}</p>
            <Field label={t('device.code')} value={code} onChange={e => setCode(e.target.value)} placeholder="XXXX-XXXX" autoFocus autoComplete="off" spellCheck={false} className="code-input" />
            <ErrorLine error={error} />
            <button type="submit" className="button primary" disabled={busy || !code.trim()}>
              {t('device.continue')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
