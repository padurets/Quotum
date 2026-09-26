import {useCallback, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';
import {setPrefs, usePrefs} from './lib/prefs';
import {showBoard} from './lib/timeRange';
import {usePath} from './lib/router';
import {boardTitle, rememberBoard, rereadSession, useBoard, useSession, type Board, type Session, type User} from './lib/session';
import {AGENTS, arranged, boardState, cardId, FORECAST, HISTORY, isHidden, reordered, spanOf, useView, withHidden, withSpan} from './lib/view';
import {page, useBoardId, useBoardMeta, useBoards, useLineup, useRole, useServerView, useTitles} from './lib/board';
import {heardHub, hubNow, wakeDue} from './lib/clock';
import {startLive} from './lib/live';
import {UNAUTHORIZED} from './lib/http';
import {t, useLocale} from './i18n';
import {Header} from './components/Header';
import {SERVICE} from './components/Kit';
import {SourceCard} from './components/SourceCard';
import {AgentsPanel} from './components/Agents';
import {History} from './components/History';
import {Forecast} from './components/Forecast';
import {AnalyticsHead} from './components/Analytics';
import {Widgets, WidgetsMenu, type Widget} from './components/Widgets';
import {AccountPanel} from './components/Account';
import {AuthScreen} from './components/AuthScreen';
import {DevicePage} from './components/DevicePage';
import {InvitePage} from './components/InvitePage';
import {MachinesDialog, type MachinesTab} from './components/Machines';
import {BoardDialog, type BoardTab} from './components/BoardDialog';
import {AgentBanner, LocalOnboarding, OpenInApp, QuitButton, TakeOver} from './components/Desktop';
import {inApp, useAppState} from './lib/app';

/** The page's own entry script, as the hub's `index.html` names it: a page of another build is loaded anew. */
function entryScript() {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src');
  return src?.startsWith('/') ? src : null;
}

/** The page's one connection to the hub's events: whatever the board on screen is, it comes this way. */
const live = startLive({
  dispatch: page.dispatch,
  unauthorized: () => window.dispatchEvent(new Event(UNAUTHORIZED)),
  gone: rereadSession,
  script: entryScript(),
  hubNow,
  heard: (now, at) => {
    heardHub(now, at);
    // The hub answering may follow a sleep: whatever came due meanwhile shows at once.
    wakeDue();
  },
});

const NO_BOARDS: Board[] = [];

function Dashboard({
  user,
  local,
  refresh,
  onSignedOut,
}: {
  user: User;
  /** The desktop app's hub: one person, one board, the app's own settings. */
  local: boolean;
  refresh: () => Promise<void>;
  onSignedOut: () => void;
}) {
  // In the app's window: its agent and settings (null in a browser).
  const {state: appState, set: setAppState} = useAppState();
  const boards = useBoards() ?? NO_BOARDS;
  const [board, selectBoard] = useBoard();
  const boardId = board?.id ?? '';
  useEffect(() => {
    if (boardId) live.open(boardId);
  }, [boardId]);
  useEffect(() => () => live.close(), []);

  // The board as the hub told it: nothing of it until its snapshot came. Each widget reads
  // its own part; the board itself renders only when its sources, view or names change.
  const meta = useBoardMeta();
  const role = useRole();
  const arrange = useView(useBoardId() ?? '', useServerView(), role === 'owner');
  const lineup = useLineup();
  const titles = useTitles();
  const prefs = usePrefs();
  const [machines, setMachines] = useState<MachinesTab | null>(null);
  const [people, setPeople] = useState<BoardTab | null>(null);
  const [account, setAccount] = useState(false);
  const closeMachines = useCallback(() => setMachines(null), []);

  const state = meta ? boardState(lineup.map(id => ({id})), arrange.view) : null;
  const empty = state === 'onboarding';
  const personal = meta?.personal ?? true;

  useEffect(() => {
    document.title = board?.name ? `${boardTitle(board)} · ${SERVICE}` : SERVICE;
  }, [board]);
  useEffect(() => showBoard(boardId), [boardId]);

  // Every widget of the board in its order: a card per source, the chart and the table.
  const cards = new Map<string, Widget>(
    lineup.map(id => [
      cardId(id),
      {
        id: cardId(id),
        name: titles[id]?.title ?? '',
        span: spanOf(arrange.view, cardId(id)),
        content: <SourceCard id={id} arrange={arrange} boardId={boardId} personal={personal} />,
      },
    ]),
  );
  // The list of every running agent is about now too: it goes with the cards.
  cards.set(AGENTS, {
    id: AGENTS,
    name: t('agents.title'),
    span: spanOf(arrange.view, AGENTS),
    content: <AgentsPanel arrange={arrange} />,
  });
  const panels = new Map<string, Widget>([
    [
      HISTORY,
      {
        id: HISTORY,
        name: t('widgets.history'),
        span: spanOf(arrange.view, HISTORY),
        content: <History arrange={arrange} />,
      },
    ],
    [
      FORECAST,
      {
        id: FORECAST,
        name: t('forecast.title'),
        span: spanOf(arrange.view, FORECAST),
        content: <Forecast arrange={arrange} />,
      },
    ],
  ]);
  const widgets = arranged(arrange.view, [...cards.keys(), ...panels.keys()]).map(id => (cards.get(id) ?? panels.get(id))!);
  const shown = widgets.filter(widget => !isHidden(arrange.view, widget.id));
  // The cards are about now; the chart and the table below them, with their filters, are the analytics.
  // Each area is arranged on its own grid.
  const shownCards = shown.filter(widget => cards.has(widget.id));
  const shownPanels = shown.filter(widget => panels.has(widget.id));
  const ids = (list: Widget[]) => list.map(widget => widget.id);
  const grid = (list: Widget[], onMove: (order: string[]) => void) => (
    <Widgets
      widgets={list}
      movable={arrange.owner && !prefs.locked}
      onMove={onMove}
      onResize={(id, span) => arrange.update(view => withSpan(view, id, span))}
    />
  );

  return (
    <>
      <Header
        boards={boards}
        board={board}
        onBoard={selectBoard}
        widgets={
          arrange.owner && meta && !empty ? (
            <WidgetsMenu
              groups={[
                {title: t('widgets.groupCards'), widgets: widgets.filter(widget => widget.id !== AGENTS && cards.has(widget.id))},
                {title: t('widgets.groupNow'), widgets: widgets.filter(widget => widget.id === AGENTS)},
                {title: t('analytics.title'), widgets: widgets.filter(widget => panels.has(widget.id))},
              ]}
              hidden={widgets.filter(widget => isHidden(arrange.view, widget.id)).map(widget => widget.id)}
              locked={prefs.locked}
              onShow={(id, on) => arrange.update(view => withHidden(view, id, !on))}
              onLock={locked => setPrefs({locked})}
            />
          ) : null
        }
        onDevices={() => setMachines('devices')}
        onPeople={!local && board && !board.personal ? () => setPeople('shares') : null}
        user={user}
        onAccount={() => setAccount(true)}
        local={local}
      />
      <main>
        {local && <AgentBanner state={appState} />}
        {!meta ? (
          <div className="widgets" aria-hidden="true">
            {[0, 1, 2].map(i => (
              <div key={i} className="card is-loading" />
            ))}
          </div>
        ) : empty && local ? (
          <LocalOnboarding agent={appState?.agent} onSettings={() => setAccount(true)} />
        ) : empty && board?.personal ? (
          <section className="panel onboarding">
            <h2>{t('onboarding.title')}</h2>
            <p>{t('onboarding.text')}</p>
            <button type="button" className="button primary" onClick={() => setMachines('connect')}>
              {t('onboarding.connect')}
            </button>
          </section>
        ) : empty ? (
          <section className="panel onboarding">
            <h2>{t('onboarding.sharedTitle')}</h2>
            <p>{t('onboarding.sharedText')}</p>
            <div className="button-row is-start">
              <button type="button" className="button primary" onClick={() => setPeople('shares')}>
                {t('onboarding.share')}
              </button>
              {board?.role === 'owner' && (
                <button type="button" className="button" onClick={() => setPeople('members')}>
                  {t('onboarding.invite')}
                </button>
              )}
            </div>
          </section>
        ) : state === 'widgets' ? (
          <>
            {shownCards.length > 0 && grid(shownCards, order => arrange.update(view => reordered(view, [...order, ...ids(shownPanels)])))}
            {shownPanels.length > 0 && (
              <section className="analytics" aria-label={t('analytics.title')}>
                <AnalyticsHead />
                {grid(shownPanels, order => arrange.update(view => reordered(view, [...ids(shownCards), ...order])))}
              </section>
            )}
          </>
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
      {machines && <MachinesDialog tab={machines} onTab={setMachines} onClose={closeMachines} local={local} />}
      {people && board && !board.personal && (
        <BoardDialog board={board} userId={user.id} tab={people} onTab={setPeople} onClose={() => setPeople(null)} />
      )}
      {account && (
        <AccountPanel
          user={user}
          onChanged={refresh}
          onSignedOut={onSignedOut}
          onClose={() => setAccount(false)}
          local={local}
          app={{state: appState, onState: setAppState}}
        />
      )}
      {local && <TakeOver agent={appState?.agent} onState={setAppState} />}
    </>
  );
}

function App() {
  // Everything below reads the language while rendering: a change re-renders the page.
  useLocale();
  const {session, failed, refresh, setSession} = useSession();
  const path = usePath();

  if (!session) {
    return (
      <div className="splash">
        {failed && (
          <div className="splash-text">
            {t('app.reconnecting')}
            {/* The app's window can always be quit, even with its hub gone. */}
            {inApp() && <QuitButton />}
          </div>
        )}
      </div>
    );
  }
  const signedIn = (next: Session) => setSession(next);

  if (session.local) {
    if (!session.user) return <OpenInApp />;
    return <Dashboard user={session.user} local refresh={refresh} onSignedOut={() => void refresh()} />;
  }
  if (path === '/device') return <DevicePage session={session} onSession={signedIn} />;
  const invite = path.match(/^\/invite\/([\w-]+)$/);
  if (invite) return <InvitePage secret={invite[1]} session={session} onSession={signedIn} onJoined={id => (rememberBoard(id), void refresh())} />;
  if (!session.user) return <AuthScreen session={session} onSignedIn={signedIn} />;
  return <Dashboard user={session.user} local={false} refresh={refresh} onSignedOut={() => void refresh()} />;
}

createRoot(document.getElementById('root')!).render(<App />);
