import {memo, useEffect, useRef} from 'react';
import {useBoard} from '../lib/session';
import {useApp, useCard, useConnection, useVisibleLimits, useServerView, useSessions, useTitle} from '../lib/board';
import {app, inApp} from '../lib/app';
import {cardId, isHidden, isWindowHidden} from '../lib/view';
import {ordered} from '../lib/grid';
import {level, windowName} from '../lib/quota';
import {num} from '../lib/format';
import {t, useLocale} from '../i18n';
import {CardMark, LimitMeter, ResetLine} from './SourceCard';
import type {startLive} from '../lib/live';

const Row = memo(function Row({id}: {id: string}) {
  useLocale();
  const card = useCard(id);
  const title = useTitle(id);
  const sessions = useSessions(id);
  const view = useServerView();
  if (!card || !view) return null;
  const windows = card.windows.filter(w => !isWindowHidden(view, id, w.id));
  if (card.windows.length && !windows.length) return null;
  const working = t('desktop.working', {count: sessions.filter(s => s.working).length});
  return <section className="card compact-card">
    <div className="card-head">
      <CardMark source={card} /><h2 title={title}>{title}</h2>
      {sessions.length > 0 && <small className="compact-agents" title={t('desktop.total', {count: sessions.length})}>{working}</small>}
    </div>
    {!windows.length && <p className="compact-quality">{t('desktop.unavailable')}</p>}
    {windows.map(w => <div className="compact-limit" key={w.id}>
      <div className="compact-window-name">
        <span title={windowName(w).replaceAll(' · ', '\n')}>{windowName(w).split(' · ').map((part, i) => <span key={i}>{part}</span>)}</span>
      </div>
      <LimitMeter w={w} />
      <strong className={`v-${level(w.remaining)}`}>{num(w.remaining)}%</strong>
      <small className="compact-reset"><ResetLine w={w} short /></small>
    </div>)}
  </section>;
});

export function Compact({live}: {live: ReturnType<typeof startLive>}) {
  useLocale();
  const [board] = useBoard();
  const lineup = useVisibleLimits();
  const view = useServerView();
  const state = useApp();
  const connection = useConnection();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (board) live.open(board.id); return () => live.close(); }, [board?.id, live]);
  useEffect(() => {
    if (state?.agent.state === 'held' || state?.agent.state === 'taking_over') void app.openMain();
  }, [state?.agent.state]);
  useEffect(() => {
    if (!inApp() || !root.current) return;
    const element = root.current;
    let last = 0;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = Math.ceil(element.getBoundingClientRect().height);
        if (height > 0 && height !== last) { last = height; void app.reportPanelHeight(height).catch(() => {}); }
      });
    });
    observer.observe(element);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') void app.closePanel(); };
    document.addEventListener('keydown', key);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); document.removeEventListener('keydown', key); };
  }, []);
  const ids = view ? ordered(view.layout, lineup.map(cardId)).map(w => w.id).filter(id => !isHidden(view, id)).map(id => id.slice(7)) : [];
  return <div className="compact glass" ref={root}>
    <header><h1>{t('desktop.limits')}</h1><button className="button" onClick={() => inApp() ? void app.openMain() : location.assign('/')}>{t('desktop.open')}</button>{inApp() && <button className="icon-button" onClick={() => void app.closePanel()} aria-label={t('common.close')}>×</button>}</header>
    {!['live', 'polling'].includes(connection.status) && <p className="compact-quality">{t('desktop.disconnected')}</p>}
    {!ids.length && <p>{t('desktop.empty')}</p>}
    {ids.map(id => <Row key={id} id={id} />)}
  </div>;
}
