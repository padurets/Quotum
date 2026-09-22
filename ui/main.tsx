import React, {useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';
import {useHistory, useNow, useOverview} from './lib/api';
import {usePrefs} from './lib/prefs';
import {useResets} from './lib/resets';
import {KNOWN_PROVIDERS} from './lib/providers';
import type {SourceState} from './lib/types';
import {Header, SERVICE} from './components/Header';
import {SourceCard} from './components/SourceCard';
import {History} from './components/History';

/** Placeholder cards keep the layout stable before the first answer arrives. */
const PENDING: SourceState[] = KNOWN_PROVIDERS.map(provider => ({
  id: provider,
  provider,
  accountKey: 'default',
  plan: '',
  confidence: 'unknown',
  successAt: null,
  attemptAt: 0,
  error: 'waiting',
  stale: true,
  windows: [],
}));

function App() {
  const now = useNow();
  const {data, lastOk} = useOverview();
  const prefs = usePrefs();
  const history = useHistory(prefs.range, data && !data.collecting ? String(data.cycle) : 'wait');
  const sources = data?.sources ?? PENDING;
  const {resets, health} = useResets(prefs.showResets);

  useEffect(() => {
    document.title = SERVICE;
  }, []);

  return (
    <>
      <Header data={data} lastOk={lastOk} now={now} trackers={health} />
      <main>
        <section className="cards" aria-label="Текущие лимиты">
          {sources.map(source => <SourceCard key={source.id} source={source} now={now} resets={source.accountKey === 'default' ? resets[source.provider as 'claude' | 'codex'] : undefined} />)}
        </section>
        <History history={history} overview={data} resets={resets} now={now} />
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
