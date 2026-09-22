import React, {useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';
import {useHistory, useNow, useOverview} from './lib/api';
import {usePrefs} from './lib/prefs';
import {useResets} from './lib/resets';
import {titled} from './lib/quota';
import {useBoard, usePath, useSession, type Board, type Session, type User} from './lib/session';
import {Header, SERVICE} from './components/Header';
import {SourceCard} from './components/SourceCard';
import {History} from './components/History';
import {AuthScreen} from './components/AuthScreen';
import {DevicePage} from './components/DevicePage';
import {InvitePage} from './components/InvitePage';
import {BoardAdmin, type AdminTab} from './components/BoardAdmin';

function Dashboard({user, boards, refresh, onSignedOut}: {user: User; boards: Board[]; refresh: () => Promise<void>; onSignedOut: () => void}) {
  const now = useNow();
  const [board, selectBoard] = useBoard(boards);
  const boardId = board?.id ?? '';
  const {data, lastOk} = useOverview(boardId);
  const prefs = usePrefs();
  const history = useHistory(boardId, prefs.range, data && !data.collecting ? String(data.cycle) : 'wait');
  const {resets, health} = useResets(prefs.showResets);
  const [admin, setAdmin] = useState<AdminTab | null>(null);

  // Sources are named from the whole board: owners appear only when they tell sources apart.
  const overview = useMemo(() => (data ? {...data, sources: titled(data.sources)} : null), [data]);
  const sources = overview?.sources ?? [];
  const empty = !!overview && sources.length === 0;

  useEffect(() => {
    document.title = board && !board.personal ? `${board.name} · ${SERVICE}` : SERVICE;
  }, [board]);

  return (
    <>
      <Header
        data={overview}
        lastOk={lastOk}
        now={now}
        trackers={health}
        boards={boards}
        board={board}
        onBoard={selectBoard}
        onBoardsChanged={refresh}
        onDevices={() => setAdmin('devices')}
        user={user}
        onSignedOut={onSignedOut}
      />
      <main>
        {empty ? (
          <section className="panel onboarding">
            <h2>На доске пока нет данных</h2>
            <p>
              Подключите машину, где работают Claude Code, Codex или Antigravity: агент измерит лимиты через их собственные клиенты и начнёт присылать
              их сюда через минуту. Токены провайдеров не покидают машину.
            </p>
            <button className="button primary" onClick={() => setAdmin('connect')}>
              Подключить устройство
            </button>
          </section>
        ) : (
          <>
            <section className="cards" aria-label="Текущие лимиты">
              {overview
                ? sources.map(source => (
                    <SourceCard key={source.id} source={source} now={now} resets={source.provider === 'claude' || source.provider === 'codex' ? resets[source.provider] : undefined} />
                  ))
                : [0, 1, 2].map(i => <div key={i} className="card is-loading" aria-hidden="true" />)}
            </section>
            <History history={history} overview={overview} resets={resets} now={now} />
          </>
        )}
      </main>
      {admin && board && <BoardAdmin board={board} tab={admin} onTab={setAdmin} onClose={() => setAdmin(null)} now={now} />}
    </>
  );
}

function App() {
  const {session, failed, refresh, setSession} = useSession();
  const path = usePath();
  const [, remember] = useBoard(session?.boards ?? []);

  if (!session) return <div className="splash">{failed ? 'Нет связи с сервисом — пробуем снова…' : ''}</div>;
  const signedIn = (next: Session) => setSession(next);

  if (path === '/device') return <DevicePage session={session} onSession={signedIn} />;
  const invite = path.match(/^\/invite\/([\w-]+)$/);
  if (invite) return <InvitePage secret={invite[1]} session={session} onSession={signedIn} onJoined={id => (remember(id), void refresh())} />;
  if (!session.user) return <AuthScreen session={session} onSignedIn={signedIn} />;
  return <Dashboard user={session.user} boards={session.boards} refresh={refresh} onSignedOut={() => void refresh()} />;
}

createRoot(document.getElementById('root')!).render(<App />);
