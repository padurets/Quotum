import {useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';
import {showBoard} from './lib/timeRange';
import {navigate, settingsHref, usePath} from './lib/router';
import {boardTitle, rememberBoard, rereadSession, useBoard, useSession, type Board, type Session, type User} from './lib/session';
import {ACTIVITY, AGENTS, ANALYTICS, boardState, cardId, FORECAST, HISTORY, isHidden, useView} from './lib/view';
import {legacyLayout, withArranged} from './lib/grid';
import {page, useBoardId, useBoardMeta, useBoards, useLineup, useRole, useServerView, useTitles} from './lib/board';
import {heardHub, hubNow, wakeDue} from './lib/clock';
import {startLive} from './lib/live';
import {UNAUTHORIZED} from './lib/http';
import {t, useLocale} from './i18n';
import {Compact} from './components/Compact';
import {Header, BoardActions} from './components/Header';
import {Settings} from './components/Settings';
import {WidgetAdd} from './components/WidgetAdd';
import {RefreshAll} from './components/RefreshAll';
import {SERVICE} from './components/Kit';
import {SourceCard} from './components/SourceCard';
import {AgentsPanel} from './components/Agents';
import {History} from './components/History';
import {Forecast} from './components/Forecast';
import {Activity} from './components/Activity';
import {AnalyticsHead} from './components/Analytics';
import {Widgets, type Widget} from './components/Widgets';
import {AuthScreen} from './components/AuthScreen';
import {DevicePage} from './components/DevicePage';
import {InvitePage} from './components/InvitePage';
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
  const path = usePath();
  const active = path === '/' || path === '/local';
  const boards = useBoards() ?? NO_BOARDS;
  const [board, selectBoard] = useBoard();
  const boardId = board?.id ?? '';
  useEffect(() => {
    if (boardId && active) live.open(boardId);
    else live.close();
  }, [boardId, active]);
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
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [boardId, active]);
  const [adding, setAdding] = useState<Board | null>(null);
  useEffect(() => setAdding(null), [boardId, active]);
  const openSettings = () => navigate(settingsHref('/settings', boardId));

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
  // The prototype's empty-widget marker lives in demo views until the final contract is integrated.
  const shownOf = (list: Widget[]) => list.filter(widget => !isHidden(arrange.view, widget.id) && (lineup.length > 0 || arrange.view.shown.includes('empty:' + widget.id)));
  const shownCards = shownOf(cardWidgets);
  const shownPanels = shownOf(panelWidgets);
  const grid = (list: Widget[], area: string) => (
    <Widgets
      key={`${boardId}/${area}`}
      widgets={list}
      layout={arrange.view.layout}
      movable={arrange.owner && editing}
      onPlaces={(places, height) => arrange.update(view => withArranged(view, places, height))}
    />
  );

  return (
    <>
      <Header boards={boards} board={board} onBoard={selectBoard} user={user} onAccount={openSettings} onSignedOut={onSignedOut} local={local}
        actions={active && <BoardActions board={board} owner={arrange.owner} editing={editing} onEdit={() => setEditing(on => !on)}
        add={board && <WidgetAdd key={boardId} board={board} local={local} trustedKeys={trustedKeys} open={adding?.id === boardId} onOpenChange={open => setAdding(open ? board : null)} />}
        onSettings={local ? null : section => navigate(settingsHref('/boards/' + boardId + '/settings/' + section, boardId))}
        refresh={meta && <RefreshAll key={boardId} board={boardId} ids={lineup.filter(id => !isHidden(arrange.view, cardId(id)))} />} />} />
      {active ? <>
      <main>
        {local && <AgentBanner />}
        {!meta ? (
          <div className="widgets" aria-hidden="true">
            {[0, 1, 2].map(i => (
              <div key={i} className="card is-loading" />
            ))}
          </div>
        ) : empty && !shownCards.length && !shownPanels.length && local ? (
          <LocalOnboarding onSettings={openSettings} onConnect={() => board && setAdding(board)} />
        ) : empty && !shownCards.length && !shownPanels.length && board?.personal ? (
          <section className="panel onboarding">
            <h2>{t('onboarding.title')}</h2>
            <p>{t('onboarding.text')}</p>
            <button type="button" className="button primary" onClick={() => board && setAdding(board)}>
              {t('onboarding.connect')}
            </button>
          </section>
        ) : empty && !shownCards.length && !shownPanels.length ? (
          <section className="panel onboarding">
            <h2>{t('onboarding.sharedTitle')}</h2>
            <p>{t('onboarding.sharedText')}</p>
            <div className="button-row is-start">
              <button type="button" className="button primary" onClick={() => board && setAdding(board)}>
                {t('add.title')}
              </button>
              {board?.role === 'owner' && (
                <button type="button" className="button" onClick={() => navigate(settingsHref('/boards/' + boardId + '/settings/members', boardId))}>
                  {t('onboarding.invite')}
                </button>
              )}
            </div>
          </section>
        ) : state === 'widgets' || shownCards.length > 0 || shownPanels.length > 0 ? (
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
              <button type="button" className="button" onClick={() => board && setAdding(board)}>
                {t('add.title')}
              </button>
            )}
          </section>
        )}
      </main>
      </> : <Settings user={user} board={board} boards={boards} local={local} trustedKeys={trustedKeys} refresh={refresh} onAppState={setAppState} />}
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
    return <Dashboard key={session.user.id} user={session.user} trustedKeys={session.trustedKeys} local refresh={refresh} onSignedOut={() => void refresh()} />;
  }
  if (path === '/compact' && session.user) return <Compact live={live} />;
  if (path === '/device') return <DevicePage session={session} onSession={signedIn} />;
  const invite = path.match(/^\/invite\/([\w-]+)$/);
  if (invite) return <InvitePage secret={invite[1]} session={session} onSession={signedIn} onJoined={id => (rememberBoard(id), void refresh())} />;
  if (!session.user) return <AuthScreen session={session} onSignedIn={signedIn} />;
  return <Dashboard key={session.user.id} user={session.user} trustedKeys={session.trustedKeys} local={false} refresh={refresh} onSignedOut={() => void refresh()} />;
}

createRoot(document.getElementById('root')!).render(<App />);
