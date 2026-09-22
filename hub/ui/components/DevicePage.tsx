import {useEffect, useId, useState} from 'react';
import {call} from '../lib/http';
import {navigate} from '../lib/router';
import {boardTitle, type Board, type Session} from '../lib/session';
import {AuthScreen} from './AuthScreen';
import {Brand, ErrorLine, Field} from './Kit';
import {rich, t} from '../i18n';

type Pending = {userCode: string; machine: {name: string; os: string; arch: string; agent: string}; expiresAt: number; boards: Board[]};

const OS: Record<string, string> = {linux: 'Linux', macos: 'macOS', windows: 'Windows'};

/**
 * Where a person confirms a code shown by `quotum connect`: the machine is
 * described, a board is chosen, and the agent receives its own token.
 */
export function DevicePage({session, onSession}: {session: Session; onSession: (session: Session) => void}) {
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code') ?? '');
  const [pending, setPending] = useState<Pending | null>(null);
  const [board, setBoard] = useState('');
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const id = useId();

  const look = async (value = code) => {
    setBusy(true);
    setError(null);
    try {
      const found = await call<Pending>('GET', `/api/device?code=${encodeURIComponent(value)}`);
      setPending(found);
      setBoard(found.boards[0]?.id ?? '');
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
      await call('POST', approve ? '/api/device/approve' : '/api/device/deny', {code: pending!.userCode, board});
      setDone(approve ? 'approved' : 'denied');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const chosen = pending?.boards.find(b => b.id === board);
  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        {done === 'approved' ? (
          <>
            <h1>{t('device.connected')}</h1>
            <p className="auth-note">{t('device.connectedText', {machine: pending!.machine.name, board: chosen ? boardTitle(chosen) : ''})}</p>
            <button type="button" className="button primary" onClick={() => navigate('/')}>
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
            <div className="field">
              <label htmlFor={`${id}-board`}>{t('device.board')}</label>
              <select id={`${id}-board`} aria-describedby={`${id}-as-you`} value={board} onChange={e => setBoard(e.target.value)}>
                {pending.boards.map(b => (
                  <option key={b.id} value={b.id}>
                    {boardTitle(b)}
                  </option>
                ))}
              </select>
              <small id={`${id}-as-you`}>{t('device.asYou')}</small>
            </div>
            <p className="auth-note">{t('device.warning')}</p>
            <ErrorLine error={error} />
            <div className="button-row">
              <button type="button" className="button" disabled={busy} onClick={() => decide(false)}>
                {t('device.decline')}
              </button>
              <button type="button" className="button primary" disabled={busy || !board} onClick={() => decide(true)}>
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
