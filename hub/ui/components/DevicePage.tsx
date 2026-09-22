import React, {useEffect, useState} from 'react';
import {boardTitle, call, messageOf, navigate, type Board, type Session} from '../lib/session';
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
  const [error, setError] = useState<string | null>(null);

  const look = async (value = code) => {
    setBusy(true);
    setError(null);
    try {
      const found = await call<Pending>('GET', `/api/device?code=${encodeURIComponent(value)}`);
      setPending(found);
      setBoard(found.boards[0]?.id ?? '');
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (session.user && code) void look();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.user]);

  if (!session.user) return <AuthScreen session={session} onSignedIn={onSession} note={t('device.signIn')} />;

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', approve ? '/api/device/approve' : '/api/device/deny', {code: pending!.userCode, board});
      setDone(approve ? 'approved' : 'denied');
    } catch (failure) {
      setError(messageOf(failure));
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
            <button className="button primary" onClick={() => navigate('/')}>
              {t('device.openBoard')}
            </button>
          </>
        ) : done === 'denied' ? (
          <>
            <h1>{t('device.denied')}</h1>
            <p className="auth-note">{t('device.deniedText')}</p>
            <button className="button" onClick={() => navigate('/')}>
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
            <label className="field">
              <span>{t('device.board')}</span>
              <select value={board} onChange={e => setBoard(e.target.value)}>
                {pending.boards.map(b => (
                  <option key={b.id} value={b.id}>
                    {boardTitle(b)}
                  </option>
                ))}
              </select>
              <small>{t('device.asYou')}</small>
            </label>
            <p className="auth-note">{t('device.warning')}</p>
            <ErrorLine message={error} />
            <div className="button-row">
              <button className="button" disabled={busy} onClick={() => decide(false)}>
                {t('device.decline')}
              </button>
              <button className="button primary" disabled={busy || !board} onClick={() => decide(true)}>
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
            <ErrorLine message={error} />
            <button className="button primary" disabled={busy || !code.trim()}>
              {t('device.continue')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
