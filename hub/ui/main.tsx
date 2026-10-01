import {useCallback, useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';
import {setPrefs, usePrefs} from './lib/prefs';
import {showBoard} from './lib/timeRange';
import {usePath} from './lib/router';
import {boardTitle, rememberBoard, rereadSession, useBoard, useSession, type Board, type Session, type User} from './lib/session';
import {ACTIVITY, AGENTS, ANALYTICS, boardState, cardId, FORECAST, HISTORY, isHidden, useView, withHidden} from './lib/view';
import {legacyLayout, ordered, withArranged} from './lib/grid';
import {page, useBoardId, useBoardMeta, useBoards, useLineup, useRole, useServerView, useTitles} from './lib/board';
import {heardHub, hubNow, wakeDue} from './lib/clock';
import {startLive} from './lib/live';
import {UNAUTHORIZED} from './lib/http';
import {t, useLocale} from './i18n';
import {Compact} from './components/Compact';
import {Header} from './components/Header';
import {RefreshAll} from './components/RefreshAll';
import {SERVICE} from './components/Kit';
import {SourceCard} from './components/SourceCard';
import {AgentsPanel} from './components/Agents';
import {History} from './components/History';
import {Forecast} from './components/Forecast';
import {Activity} from './components/Activity';
import {AnalyticsHead} from './components/Analytics';
import {Widgets, WidgetsMenu, type Widget} from './components/Widgets';
import {AccountPanel} from './components/Account';
import {AuthScreen} from './components/AuthScreen';
import {DevicePage} from './components/DevicePage';
import {InvitePage} from './components/InvitePage';
import {MachinesDialog, type MachinesTab} from './components/Machines';
import {BoardDialog, type BoardTab} from './components/BoardDialog';
import {AgentBanner, LocalOnboarding, OpenInApp, QuitButton, TakeOver} from './components/Desktop';
import {app, appLocale, followApp, inApp, type AppState} from './lib/app';

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
  epochChanged: rereadSession,
  script: entryScript(),
  hubNow,
  heard: (now, at) => {
    heardHub(now, at);
    // The hub answering may follow a sleep: whatever came due meanwhile shows at once.
    wakeDue();
  },
});

/** The desktop app's state, as it sends it and as its commands answer: into the page's state, the newest kept. */
const setAppState = (state: AppState) => { appLocale(state); page.dispatch({type: 'app', state}); };
if (inApp()) followApp(setAppState);

const NO_BOARDS: Board[] = [];

function Dashboard({
  user,
  trustedKeys,
  local,
  refresh,
  onSignedOut,
}: {
  user: User;
  trustedKeys: Session['trustedKeys'];
  /** The desktop app's hub: one person, one board, the app's own settings. */
  local: boolean;
  refresh: () => Promise<void>;
  onSignedOut: () => void;
}) {
  const boards = useBoards() ?? NO_BOARDS;
  const [board, selectBoard] = useBoard();
  const boardId = board?.id ?? '';
  useEffect(() => {
    if (boardId) live.open(boardId);
  }, [boardId]);
  useEffect(() => () => live.close(), []);

  // The board as the hub told it: nothing of it until its snapshot came. Each widget reads
  // its own part; the board itself renders only when its sources, view or names change.
  const meta = useBoardMeta(boardId);
  const role = useRole();
  const lineup = useLineup();
  const serverView = useServerView();
  const translated = useMemo(() => {
    if (!serverView) return null;
    const areas = {cards: [...lineup.map(cardId), AGENTS], analytics: ANALYTICS};
    return legacyLayout(serverView, areas, [...areas.cards, ...areas.analytics].filter(id => isHidden(serverView, id)));
  }, [serverView, lineup]);
  const arrange = useView(useBoardId() ?? '', translated, role === 'owner');
  const titles = useTitles(arrange.view.names);
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

  // Every widget of the board: a card per source, the list of agents, and the analytics (agent activity, the chart and the table).
  const cards = new Map<string, Widget>(
    lineup.map(id => [
      cardId(id),
      {
        id: cardId(id),
        name: titles[id]?.title ?? '',
        content: <SourceCard id={id} arrange={arrange} boardId={boardId} personal={personal} />,
      },
    ]),
  );
  // The list of every running agent is about now too: it goes with the cards.
  cards.set(AGENTS, {
    id: AGENTS,
    name: t('agents.title'),
    content: <AgentsPanel arrange={arrange} />,
  });
  const panels = new Map<string, Widget>([
    [
      HISTORY,
      {
        id: HISTORY,
        name: t('widgets.history'),
        content: <History arrange={arrange} />,
      },
    ],
    [
      FORECAST,
      {
        id: FORECAST,
        name: t('forecast.title'),
        content: <Forecast arrange={arrange} />,
      },
    ],
    [
      ACTIVITY,
      {
        id: ACTIVITY,
        name: t('activity.title'),
        content: <Activity arrange={arrange} />,
      },
    ],
  ]);
  // The cards are about now; agent activity, the chart and the table below them, with their
  // filters, are the analytics. Each area is arranged on its own grid, and on its own.
  const cardWidgets = [...cards.values()];
  const panelWidgets = ANALYTICS.map(id => panels.get(id)!);
  const menuOrder = (list: Widget[]) => ordered(arrange.view.layout, list.map(w => w.id)).map(item => list.find(w => w.id === item.id)!);
  const widgets = [...menuOrder(cardWidgets), ...menuOrder(panelWidgets)];
  const shownOf = (list: Widget[]) => list.filter(widget => !isHidden(arrange.view, widget.id));
  const shownCards = shownOf(cardWidgets);
  const shownPanels = shownOf(panelWidgets);
  const grid = (list: Widget[], area: string) => (
    <Widgets
      key={`${boardId}/${area}`}
      widgets={list}
      layout={arrange.view.layout}
      movable={arrange.owner && !prefs.locked}
      onPlaces={(places, height) => arrange.update(view => withArranged(view, places, height))}
    />
  );

  return (
    <>
      <Header
        boards={boards}
        board={board}
        onBoard={selectBoard}
        refresh={meta && <RefreshAll key={boardId} board={boardId} ids={lineup.filter(id => !isHidden(arrange.view, cardId(id)))} />}
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
        {local && <AgentBanner />}
        {!meta ? (
          <div className="widgets" aria-hidden="true">
            {[0, 1, 2].map(i => (
              <div key={i} className="card is-loading" />
            ))}
          </div>
        ) : empty && local ? (
          <LocalOnboarding onSettings={() => setAccount(true)} onConnect={()=>setMachines('connect')} />
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
            {shownCards.length > 0 && grid(shownCards, 'cards')}
            {shownPanels.length > 0 && (
              <section className="analytics" aria-label={t('analytics.title')}>
                <AnalyticsHead />
                {grid(shownPanels, 'analytics')}
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
      {machines && <MachinesDialog tab={machines} onTab={setMachines} onClose={closeMachines} local={local} userId={user.id} trustedKeys={trustedKeys} />}
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
          onAppState={setAppState}
        />
      )}
      {local && <TakeOver onState={setAppState} />}
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
            {inApp() && (path === '/compact' ? <button className="button" onClick={() => void app.closePanel()}>{t('common.close')}</button> : <QuitButton />)}
          </div>
        )}
      </div>
    );
  }
  const signedIn = (next: Session) => setSession(next);

  if (session.local) {
    if (!session.user) return <OpenInApp compact={path === '/compact'} />;
    if (path === '/compact') return <Compact live={live} />;
    return <Dashboard user={session.user} trustedKeys={session.trustedKeys} local refresh={refresh} onSignedOut={() => void refresh()} />;
  }
  if (path === '/compact' && session.user) return <Compact live={live} />;
  if (path === '/device') return <DevicePage session={session} onSession={signedIn} />;
  const invite = path.match(/^\/invite\/([\w-]+)$/);
  if (invite) return <InvitePage secret={invite[1]} session={session} onSession={signedIn} onJoined={id => (rememberBoard(id), void refresh())} />;
  if (!session.user) return <AuthScreen session={session} onSignedIn={signedIn} />;
  return <Dashboard user={session.user} trustedKeys={session.trustedKeys} local={false} refresh={refresh} onSignedOut={() => void refresh()} />;
}

createRoot(document.getElementById('root')!).render(<App />);
