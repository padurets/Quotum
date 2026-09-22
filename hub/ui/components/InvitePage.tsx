import {useEffect, useState} from 'react';
import {call} from '../lib/http';
import {navigate} from '../lib/router';
import type {Board, Session} from '../lib/session';
import {AuthScreen} from './AuthScreen';
import {Brand, ErrorLine} from './Kit';
import {t} from '../i18n';

/** An invite link: sign up or in, then join the board. */
export function InvitePage({secret, session, onSession, onJoined}: {secret: string; session: Session; onSession: (s: Session) => void; onJoined: (board: string) => void}) {
  const [board, setBoard] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<{board: {name: string}}>('GET', `/api/invites/${encodeURIComponent(secret)}`)
      .then(found => setBoard(found.board.name))
      .catch(setError);
  }, [secret]);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const {board: joined} = await call<{board: Board}>('POST', `/api/invites/${encodeURIComponent(secret)}/accept`);
      onJoined(joined.id);
      navigate('/');
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  if (board && !session.user) {
    // Signing up with the invite joins the board at once.
    return (
      <AuthScreen
        session={session}
        invite={{secret, board}}
        onSignedIn={(next, joined) => {
          if (joined) onJoined(joined);
          onSession(next);
          navigate('/');
        }}
      />
    );
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        <h1>{t('invite.title')}</h1>
        {board ? <p className="auth-note">{t('invite.text', {board})}</p> : !error && <p className="auth-note">{t('invite.checking')}</p>}
        <ErrorLine error={error} />
        {board && session.user && (
          <button type="button" className="button primary" disabled={busy} onClick={join}>
            {t('invite.join', {name: session.user.name})}
          </button>
        )}
        {!!error && (
          <button type="button" className="button" onClick={() => navigate('/')}>
            {t('common.backHome')}
          </button>
        )}
      </div>
    </div>
  );
}
