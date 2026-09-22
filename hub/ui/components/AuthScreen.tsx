import React, {useState} from 'react';
import {call, messageOf, type Board, type Session, type User} from '../lib/session';
import {Brand, ErrorLine, Field, LanguagePicker, Tabs} from './Kit';
import {t} from '../i18n';

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

  const heading = session.signup.first ? t('auth.first') : mode === 'signup' ? t('auth.signUp') : t('auth.signIn');
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <Brand />
        <h1>{heading}</h1>
        {invite && <p className="auth-note">{t('auth.invited', {board: invite.board})}</p>}
        {note && <p className="auth-note">{note}</p>}
        {session.signup.first && <p className="auth-note">{t('auth.firstNote')}</p>}
        {canSignUp && !session.signup.first && (
          <Tabs
            label={t('auth.mode')}
            value={mode}
            onChange={next => {
              setMode(next);
              setError(null);
            }}
            tabs={[
              ['login', t('auth.signIn')],
              ['signup', t('auth.signUp')],
            ]}
          />
        )}
        <Field label={t('auth.email')} type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} autoFocus />
        {mode === 'signup' && (
          <Field label={t('auth.name')} autoComplete="name" required maxLength={80} value={name} onChange={e => setName(e.target.value)} hint={t('auth.nameHint')} />
        )}
        <Field
          label={t('auth.password')}
          type="password"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          required
          minLength={mode === 'signup' ? 8 : undefined}
          value={password}
          onChange={e => setPassword(e.target.value)}
          hint={mode === 'signup' ? t('auth.passwordHint') : undefined}
        />
        <ErrorLine message={error} />
        <button className="button primary" disabled={busy}>
          {busy ? '…' : mode === 'signup' ? t('auth.createAccount') : t('auth.submit')}
        </button>
        {!canSignUp && <p className="auth-foot">{t('auth.noAccount')}</p>}
      </form>
      <LanguagePicker />
    </div>
  );
}
