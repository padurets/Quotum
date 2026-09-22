import React, {useState} from 'react';
import {call, messageOf, type Board, type Session, type User} from '../lib/session';
import {Brand, ErrorLine, Field, Tabs} from './Kit';

type Mode = 'login' | 'signup';

/**
 * Signing in or up. The very first person to sign up on a hub becomes its admin and
 * takes over the data collected so far; after that, sign-up needs an invite unless the
 * hub is open.
 */
export function AuthScreen({
  session,
  onSignedIn,
  invite,
  note,
}: {
  session: Session;
  onSignedIn: (session: Session) => void;
  invite?: {secret: string; board: string};
  note?: string;
}) {
  const canSignUp = session.signup.open || !!invite;
  const [mode, setMode] = useState<Mode>(session.signup.first || (invite && canSignUp) ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'signup' ? {email, name, password, invite: invite?.secret} : {email, password};
      const result = await call<{user: User; boards: Board[]}>('POST', `/api/auth/${mode}`, body);
      onSignedIn({...session, ...result});
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const heading = session.signup.first ? 'Создайте первый аккаунт' : mode === 'signup' ? 'Регистрация' : 'Вход';
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <Brand />
        <h1>{heading}</h1>
        {invite && <p className="auth-note">Вас пригласили на доску «{invite.board}».</p>}
        {note && <p className="auth-note">{note}</p>}
        {session.signup.first && <p className="auth-note">Он станет администратором и получит уже собранные данные.</p>}
        {canSignUp && !session.signup.first && (
          <Tabs
            label="Вход или регистрация"
            value={mode}
            onChange={next => {
              setMode(next);
              setError(null);
            }}
            tabs={[
              ['login', 'Вход'],
              ['signup', 'Регистрация'],
            ]}
          />
        )}
        <Field label="Почта" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} autoFocus />
        {mode === 'signup' && <Field label="Имя" autoComplete="name" required maxLength={80} value={name} onChange={e => setName(e.target.value)} hint="Так вас увидят на общих досках" />}
        <Field
          label="Пароль"
          type="password"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          required
          minLength={mode === 'signup' ? 8 : undefined}
          value={password}
          onChange={e => setPassword(e.target.value)}
          hint={mode === 'signup' ? 'Не короче 8 символов' : undefined}
        />
        <ErrorLine message={error} />
        <button className="button primary" disabled={busy}>
          {busy ? '…' : mode === 'signup' ? 'Создать аккаунт' : 'Войти'}
        </button>
        {!canSignUp && <p className="auth-foot">Нет аккаунта? Попросите приглашение у владельца доски.</p>}
      </form>
    </div>
  );
}
