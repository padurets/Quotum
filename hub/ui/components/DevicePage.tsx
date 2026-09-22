import React, {useEffect, useState} from 'react';
import {call, messageOf, navigate, type Board, type Session} from '../lib/session';
import {AuthScreen} from './AuthScreen';
import {Brand, ErrorLine, Field} from './Kit';

type Pending = {userCode: string; machine: {name: string; os: string; arch: string; agent: string}; expiresAt: number; boards: Board[]};

const OS: Record<string, string> = {linux: 'Linux', macos: 'macOS', windows: 'Windows'};

/**
 * Where a person confirms a code shown by `agent-limits connect`: the machine is
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

  if (!session.user) return <AuthScreen session={session} onSignedIn={onSession} note="Войдите, чтобы подключить устройство." />;

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

  const boardName = pending?.boards.find(b => b.id === board)?.name;
  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        {done === 'approved' ? (
          <>
            <h1>Устройство подключено</h1>
            <p className="auth-note">
              {pending!.machine.name} присылает лимиты на доску «{boardName}». Первые данные появятся через минуту; в терминале можно
              закрыть окно подтверждения.
            </p>
            <button className="button primary" onClick={() => navigate('/')}>
              Открыть доску
            </button>
          </>
        ) : done === 'denied' ? (
          <>
            <h1>Подключение отклонено</h1>
            <p className="auth-note">Устройство не получит доступ. Код больше не действует.</p>
            <button className="button" onClick={() => navigate('/')}>
              На главную
            </button>
          </>
        ) : pending ? (
          <>
            <h1>Подключить устройство?</h1>
            <dl className="device-facts">
              <dt>Устройство</dt>
              <dd>{pending.machine.name}</dd>
              <dt>Система</dt>
              <dd>
                {OS[pending.machine.os] ?? pending.machine.os} · {pending.machine.arch}
              </dd>
              <dt>Агент</dt>
              <dd className="mono">{pending.machine.agent}</dd>
              <dt>Код</dt>
              <dd className="mono">{pending.userCode}</dd>
            </dl>
            <label className="field">
              <span>Доска</span>
              <select value={board} onChange={e => setBoard(e.target.value)}>
                {pending.boards.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <small>Устройство будет присылать лимиты от вашего имени.</small>
            </label>
            <p className="auth-note">Подключайте, только если код показала команда, которую вы запустили сами.</p>
            <ErrorLine message={error} />
            <div className="button-row">
              <button className="button" disabled={busy} onClick={() => decide(false)}>
                Отклонить
              </button>
              <button className="button primary" disabled={busy || !board} onClick={() => decide(true)}>
                Подключить
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
            <h1>Подключение устройства</h1>
            <p className="auth-note">Введите код, который показала команда <code>agent-limits connect</code>.</p>
            <Field label="Код" value={code} onChange={e => setCode(e.target.value)} placeholder="XXXX-XXXX" autoFocus autoComplete="off" spellCheck={false} className="code-input" />
            <ErrorLine message={error} />
            <button className="button primary" disabled={busy || !code.trim()}>
              Продолжить
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
