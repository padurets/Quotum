import {useCallback, useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';
import {useHistory, useOverview} from './lib/api';
import {setPrefs, usePrefs} from './lib/prefs';
import {showBoard, useTimeRange} from './lib/timeRange';
import {useResets} from './lib/resets';
import {sourceLabel, titled} from './lib/quota';
import {usePath} from './lib/router';
import {boardTitle, rememberBoard, useBoard, useSession, type Board, type Session, type User} from './lib/session';
import {AGENTS, arranged, boardState, cardId, FORECAST, HISTORY, isHidden, reordered, spanOf, useView, withHidden, withSpan} from './lib/view';
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

function Dashboard({
  user,
  boards,
  local,
  refresh,
  onSignedOut,
}: {
  user: User;
  boards: Board[];
  /** The desktop app's hub: one person, one board, the app's own settings. */
  local: boolean;
  refresh: () => Promise<void>;
  onSignedOut: () => void;
}) {
  // In the app's window: its agent and settings (null in a browser).
  const {state: appState, refresh: refreshApp, set: setAppState} = useAppState();
  const [board, selectBoard] = useBoard(boards);
  const boardId = board?.id ?? '';
  // A board deleted meanwhile, or one the reader was removed from: the list of boards is read again.
  const {data, lastOk, reload: reloadOverview} = useOverview(boardId, refresh);
  const reload = useCallback(() => {
    reloadOverview();
    refreshApp();
  }, [reloadOverview, refreshApp]);
  const arrange = useView(data, reload);
  const prefs = usePrefs();
  const revision = data ? data.revision : null;
  // The chart and the table show one period: a time range selected on the chart, else the chosen one.
  const selected = useTimeRange();
  // A range kept on the page is of the sources the board had: one added since is read again.
  const sourceIds = useMemo(() => (data ? data.sources.map(source => source.id).sort().join(',') : ''), [data]);
  const {history, loading: historyLoading} = useHistory(boardId, selected ?? prefs.range, revision, sourceIds);
  const {resets, past, health} = useResets(prefs.showResets);
  const [machines, setMachines] = useState<MachinesTab | null>(null);
  const [people, setPeople] = useState<BoardTab | null>(null);
  const [account, setAccount] = useState(false);
  const closeMachines = useCallback(() => setMachines(null), []);

  // Sources are named from the whole board (owners appear only when they tell sources
  // apart), or as the board's owner named them.
  const names = arrange.view.names;
  const overview = useMemo(() => (data ? {...data, sources: titled(data.sources, names)} : null), [data, names]);
  const sources = overview?.sources ?? [];
  const state = overview ? boardState(sources, arrange.view) : null;
  const empty = state === 'onboarding';

  useEffect(() => {
    document.title = board?.name ? `${boardTitle(board)} · ${SERVICE}` : SERVICE;
  }, [board]);
  useEffect(() => showBoard(boardId), [boardId]);

  // Every widget of the board in its order: a card per source, the chart and the table.
  const cards = new Map<string, Widget>(
    sources.map(source => [
      cardId(source.id),
      {
        id: cardId(source.id),
        name: sourceLabel(source),
        span: spanOf(arrange.view, cardId(source.id)),
        content: (
          <SourceCard
            source={source}
            resets={source.provider === 'claude' || source.provider === 'codex' ? resets[source.provider] : undefined}
            arrange={arrange}
            board={board}
            onChanged={reload}
          />
        ),
      },
    ]),
  );
  // The list of every running agent is about now too: it goes with the cards.
  cards.set(AGENTS, {
    id: AGENTS,
    name: t('agents.title'),
    span: spanOf(arrange.view, AGENTS),
    content: <AgentsPanel sources={sources} arrange={arrange} />,
  });
  const panels = new Map<string, Widget>([
    [
      HISTORY,
      {
        id: HISTORY,
        name: t('widgets.history'),
        span: spanOf(arrange.view, HISTORY),
        content: <History history={history} loading={historyLoading} overview={overview} resets={resets} past={past} arrange={arrange} />,
      },
    ],
    [
      FORECAST,
      {
        id: FORECAST,
        name: t('forecast.title'),
        span: spanOf(arrange.view, FORECAST),
        content: <Forecast history={history} loading={historyLoading} overview={overview} arrange={arrange} />,
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
        lastOk={lastOk}
        boards={boards}
        board={board}
        onBoard={selectBoard}
        onBoardsChanged={refresh}
        widgets={
          arrange.owner && overview && !empty ? (
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
        {!overview ? (
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
                <AnalyticsHead historyStart={overview?.historyStart ?? 0} />
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
        <BoardDialog
          board={board}
          userId={user.id}
          tab={people}
          titles={new Map(sources.map(source => [source.id, sourceLabel(source)]))}
          onTab={setPeople}
          onClose={() => setPeople(null)}
          onChanged={reload}
        />
      )}
      {account && (
        <AccountPanel
          user={user}
          trackers={health}
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
    return <Dashboard user={session.user} boards={session.boards} local refresh={refresh} onSignedOut={() => void refresh()} />;
  }
  if (path === '/device') return <DevicePage session={session} onSession={signedIn} />;
  const invite = path.match(/^\/invite\/([\w-]+)$/);
  if (invite) return <InvitePage secret={invite[1]} session={session} onSession={signedIn} onJoined={id => (rememberBoard(id), void refresh())} />;
  if (!session.user) return <AuthScreen session={session} onSignedIn={signedIn} />;
  return <Dashboard user={session.user} boards={session.boards} local={false} refresh={refresh} onSignedOut={() => void refresh()} />;
}

createRoot(document.getElementById('root')!).render(<App />);
