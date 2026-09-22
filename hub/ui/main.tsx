import {useCallback, useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';
import {useHistory, useNow, useOverview} from './lib/api';
import {usePrefs} from './lib/prefs';
import {useResets} from './lib/resets';
import {sourceLabel, titled} from './lib/quota';
import {usePath} from './lib/router';
import {boardTitle, rememberBoard, useBoard, useSession, type Board, type Session, type User} from './lib/session';
import {arranged, cardId, HISTORY, reordered, useView, withHidden} from './lib/view';
import {t, useLocale} from './i18n';
import {Header} from './components/Header';
import {SERVICE} from './components/Kit';
import {SourceCard} from './components/SourceCard';
import {History} from './components/History';
import {Widgets, WidgetsMenu, type Widget} from './components/Widgets';
import {AccountPanel} from './components/Account';
import {AuthScreen} from './components/AuthScreen';
import {DevicePage} from './components/DevicePage';
import {InvitePage} from './components/InvitePage';
import {BoardAdmin, type AdminTab} from './components/BoardAdmin';

function Dashboard({user, boards, refresh, onSignedOut}: {user: User; boards: Board[]; refresh: () => Promise<void>; onSignedOut: () => void}) {
  const now = useNow();
  const [board, selectBoard] = useBoard(boards);
  const boardId = board?.id ?? '';
  const {data, lastOk, reload} = useOverview(boardId);
  const arrange = useView(data, reload);
  const prefs = usePrefs();
  const {history, loading: historyLoading} = useHistory(boardId, prefs.range, data ? data.revision : null);
  const {resets, past, health} = useResets(prefs.showResets);
  const [admin, setAdmin] = useState<AdminTab | null>(null);
  const [account, setAccount] = useState(false);
  const closeAdmin = useCallback(() => setAdmin(null), []);

  // Sources are named from the whole board: owners appear only when they tell sources apart.
  const overview = useMemo(() => (data ? {...data, sources: titled(data.sources)} : null), [data]);
  const sources = overview?.sources ?? [];
  const empty = !!overview && sources.length === 0;

  useEffect(() => {
    document.title = board?.name ? `${boardTitle(board)} · ${SERVICE}` : SERVICE;
  }, [board]);

  // Every widget of the board in its order: a card per source, and the history chart.
  const cards = new Map<string, Widget>(
    sources.map(source => [
      cardId(source.id),
      {
        id: cardId(source.id),
        name: sourceLabel(source),
        content: (
          <SourceCard
            source={source}
            now={now}
            resets={source.provider === 'claude' || source.provider === 'codex' ? resets[source.provider] : undefined}
            arrange={arrange}
          />
        ),
      },
    ]),
  );
  const widgets = arranged(arrange.view, [...cards.keys(), HISTORY]).map(
    (id): Widget =>
      cards.get(id) ?? {
        id,
        name: t('widgets.history'),
        wide: true,
        content: <History history={history} loading={historyLoading} overview={overview} resets={resets} past={past} now={now} arrange={arrange} />,
      },
  );
  const shown = widgets.filter(widget => !arrange.view.hidden.includes(widget.id));

  return (
    <>
      <Header
        lastOk={lastOk}
        now={now}
        boards={boards}
        board={board}
        onBoard={selectBoard}
        onBoardsChanged={refresh}
        widgets={
          arrange.owner && overview && !empty ? (
            <WidgetsMenu
              widgets={widgets}
              hidden={arrange.view.hidden}
              shared={!board?.personal}
              onShow={(id, on) => arrange.update(view => withHidden(view, id, !on))}
            />
          ) : null
        }
        onDevices={() => setAdmin('devices')}
        user={user}
        onAccount={() => setAccount(true)}
      />
      <main>
        {!overview ? (
          <div className="widgets" aria-hidden="true">
            {[0, 1, 2].map(i => (
              <div key={i} className="card is-loading" />
            ))}
          </div>
        ) : empty ? (
          <section className="panel onboarding">
            <h2>{t('onboarding.title')}</h2>
            <p>{t('onboarding.text')}</p>
            <button type="button" className="button primary" onClick={() => setAdmin('connect')}>
              {t('onboarding.connect')}
            </button>
          </section>
        ) : shown.length ? (
          <Widgets widgets={shown} movable={arrange.owner} onMove={order => arrange.update(view => reordered(view, order))} />
        ) : (
          <section className="panel onboarding">
            <h2>{t('widgets.allHidden')}</h2>
            {arrange.owner && (
              <button type="button" className="button" onClick={() => arrange.update(view => ({...view, hidden: []}))}>
                {t('widgets.showAll')}
              </button>
            )}
          </section>
        )}
      </main>
      {admin && board && <BoardAdmin board={board} tab={admin} onTab={setAdmin} onClose={closeAdmin} now={now} />}
      {account && <AccountPanel user={user} trackers={health} onChanged={refresh} onSignedOut={onSignedOut} onClose={() => setAccount(false)} />}
    </>
  );
}

function App() {
  // Everything below reads the language while rendering: a change re-renders the page.
  useLocale();
  const {session, failed, refresh, setSession} = useSession();
  const path = usePath();

  if (!session) return <div className="splash">{failed ? t('app.reconnecting') : ''}</div>;
  const signedIn = (next: Session) => setSession(next);

  if (path === '/device') return <DevicePage session={session} onSession={signedIn} />;
  const invite = path.match(/^\/invite\/([\w-]+)$/);
  if (invite) return <InvitePage secret={invite[1]} session={session} onSession={signedIn} onJoined={id => (rememberBoard(id), void refresh())} />;
  if (!session.user) return <AuthScreen session={session} onSignedIn={signedIn} />;
  return <Dashboard user={session.user} boards={session.boards} refresh={refresh} onSignedOut={() => void refresh()} />;
}

createRoot(document.getElementById('root')!).render(<App />);
