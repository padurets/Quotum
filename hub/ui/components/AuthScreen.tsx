import {useState, type FormEvent} from 'react';
import {call} from '../lib/http';
import type {Board, Session, User} from '../lib/session';
import {Brand, ErrorLine, Field, LanguageSelect, Segmented} from './Kit';
import {t} from '../i18n';

type Mode = 'login' | 'signup';

/**
 * Signing in or up. The first person on a hub signs up without an invitation; after
 * that, sign-up needs an invite unless the hub is open. With an invite, signing up or in
 * also joins its board (`joined`).
 */
export function AuthScreen({
  session,
  onSignedIn,
  invite,
  note,
}: {
  session: Session;
  onSignedIn: (session: Session, joined: string | null) => void;
  invite?: {secret: string; board: string};
  note?: string;
}) {
  const canSignUp = session.signup.open || !!invite;
  const [mode, setMode] = useState<Mode>(session.signup.first || invite ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'signup' ? {email, name, password, invite: invite?.secret, setupCode} : {email, password, invite: invite?.secret};
      const result = await call<{user: User; boards: Board[]; joined: string | null}>('POST', `/api/auth/${mode}`, body);
      onSignedIn({...session, user: result.user, boards: result.boards}, result.joined);
    } catch (failure) {
      setError(failure);
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
        {canSignUp && !session.signup.first && (
          <Segmented
            label={t('auth.mode')}
            value={mode}
            onChange={next => {
              setMode(next);
              setError(null);
            }}
            options={[
              ['login', t('auth.signIn')],
              ['signup', t('auth.signUp')],
            ]}
          />
        )}
        {session.signup.first && (
          <Field
            label={t('auth.setupCode')}
            required
            autoComplete="off"
            spellCheck={false}
            value={setupCode}
            onChange={e => setSetupCode(e.target.value)}
            hint={t('auth.setupCodeHint')}
            className="code-input"
            autoFocus
          />
        )}
        <Field label={t('auth.email')} type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} autoFocus={!session.signup.first} />
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
        <ErrorLine error={error} />
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? '…' : mode === 'signup' ? t('auth.createAccount') : t('auth.submit')}
        </button>
        {!canSignUp && <p className="auth-foot">{t('auth.noAccount')}</p>}
      </form>
      <LanguageSelect />
    </div>
  );
}
