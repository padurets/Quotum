import React, {useEffect, useState} from 'react';
import {call, messageOf, navigate, type Board, type Session} from '../lib/session';
import {AuthScreen} from './AuthScreen';
import {Brand, ErrorLine} from './Kit';
import {t} from '../i18n';

/** An invite link: sign up or in, then join the board. */
export function InvitePage({secret, session, onSession, onJoined}: {secret: string; session: Session; onSession: (s: Session) => void; onJoined: (board: string) => void}) {
  const [board, setBoard] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<{board: {name: string}}>('GET', `/api/invites/${encodeURIComponent(secret)}`)
      .then(found => setBoard(found.board.name))
      .catch(failure => setError(messageOf(failure)));
  }, [secret]);

  const join = async () => {
    setBusy(true);
    try {
      const {board: joined} = await call<{board: Board}>('POST', `/api/invites/${encodeURIComponent(secret)}/accept`);
      onJoined(joined.id);
      navigate('/');
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  if (board && !session.user) {
    // Signing up with the invite joins the board at once.
    return (
      <AuthScreen
        session={session}
        invite={{secret, board}}
        onSignedIn={next => {
          const joined = next.boards.find(b => b.name === board && !b.personal);
          if (joined) onJoined(joined.id);
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
        <ErrorLine message={error} />
        {board && session.user && (
          <button className="button primary" disabled={busy} onClick={join}>
            {t('invite.join', {name: session.user.name})}
          </button>
        )}
        {error && (
          <button className="button" onClick={() => navigate('/')}>
            {t('common.backHome')}
          </button>
        )}
      </div>
    </div>
  );
}
