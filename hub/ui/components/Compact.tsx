import {useDataFilters} from '../lib/dataFilters';
import {followDataFilters} from '../lib/filterSession';
import {matchesWork} from '../../server/domain/dataFilters';
import {budgetVisible, subscriptionFundsVisible} from '../lib/money';
import {memo, useEffect, useInsertionEffect, useLayoutEffect, useRef} from 'react';
import {useBoard} from '../lib/session';
import {useApp, useBoardId, useCard, useConnection, useVisibleLimits, useServerView, useSessions, useTitle} from '../lib/board';
import {app, inApp} from '../lib/app';
import {cardId, isHidden, isWindowHidden} from '../lib/view';
import {ordered} from '../lib/grid';
import {windowName} from '../lib/quota';
import {t, useLocale} from '../i18n';
import {CardMark, ResetLine} from './SourceCard';
import {PercentLimit} from './Meter';
import {MoneyCard,QuotaCard,BalanceMark} from './MoneyCard';
import {FreeResets} from './ResetMarks';
import {providerOf} from '../../server/domain/providers';
import {hasSubscriptionCaps} from '../lib/providers';
import {quotaPeriods} from '../lib/subscription';
import type {startLive} from '../lib/live';

const Row = memo(function Row({id}: {id: string}) {
  useLocale();
  const card = useCard(id);
  const board=useBoardId();
  const title = useTitle(id);
  const liveSessions = useSessions(id),filters=useDataFilters().current;
  const sessions=filters?liveSessions.filter(row=>matchesWork(filters,{...row,source:id,device:row.device.id})):[];
  const view = useServerView();
  if (!card || !view) return null;
  const windows = card.windows.filter(w => !isWindowHidden(view, id, w.id));
  const periods=quotaPeriods(card),shownPeriods=periods.filter(w=>!isWindowHidden(view,id,w.id));
  const funds=budgetVisible(card)&&providerOf(card.provider)?.funding==='subscription';
  if (periods.length && !shownPeriods.length && !budgetVisible(card)) return null;
  const working = t('desktop.working', {count: sessions.filter(s => s.working).length});
  return <section className="card compact-card">
    <div className="card-head">
      <CardMark source={card} compact/>{!funds&&<BalanceMark source={card}/>}<div className="card-heading"><h2 title={title}>{title}</h2>
        {(card.meters||providerOf(card.provider))&&<small className="resource-type">{t(providerOf(card.provider)?.funding==='wallet'?'resource.budget':'resource.subscription')}</small>}
      </div>
      {sessions.length > 0 && <small className="compact-agents" title={t('desktop.total', {count: sessions.length})}>{working}</small>}
    </div>
    {hasSubscriptionCaps(card.provider)?<QuotaCard source={card} ids={shownPeriods.map(w=>w.id)} compact/>:!budgetVisible(card)&&!windows.length&&<p className="compact-quality">{t('desktop.unavailable')}</p>}
    {windows.map(w => <PercentLimit key={w.id} name={windowName(w)} remaining={w.remaining} reset={<ResetLine w={w} short/>} compact/>)}
    {budgetVisible(card)&&!funds&&<MoneyCard source={card} board={board??''} view={view} compact/>}
    {(providerOf(card.provider)?.funding==='subscription'||subscriptionFundsVisible(card)||!!card.resets?.available)&&<footer className="card-foot">
      {subscriptionFundsVisible(card)&&<MoneyCard source={card} board={board??''} view={view} tray/>}
      {!!card.resets?.available&&<FreeResets resets={card.resets} observation={card.resources?.resets}/>}
    </footer>}
  </section>;
});

export function Compact({live,user}: {live: ReturnType<typeof startLive>;user:string}) {
  const native = inApp();
  useInsertionEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-compact');
    root.setAttribute('data-compact', native ? 'native' : 'web');
    return () => {
      if (previous === null) root.removeAttribute('data-compact');
      else root.setAttribute('data-compact', previous);
    };
  }, [native]);
  useLocale();
  const [board] = useBoard();
  useLayoutEffect(()=>board?followDataFilters(user,board.id,true):undefined,[user,board?.id]);
  const filters=useDataFilters();
  const lineup = useVisibleLimits(filters.current);
  const view = useServerView();
  const state = useApp();
  const connection = useConnection();
  const root = useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const open=()=>inApp()?void app.openMain():location.assign('/');
    window.addEventListener('quotum:open-filters',open);
    return()=>window.removeEventListener('quotum:open-filters',open);
  },[]);
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
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  const ids = view ? ordered(view.layout,lineup.map(cardId)).map(w => w.id).filter(id => !isHidden(view, id)).map(id => id.slice(7)) : [];
  return <div className={`compact glass${native ? " is-native" : ""}`} ref={root}>
    <header>
      <h1>{t('desktop.limits')}</h1>
      <button className="icon-button" title={t('desktop.open')} aria-label={t('desktop.open')} onClick={() => inApp() ? void app.openMain() : location.assign('/')}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9 2h5v5M14 2L7 9M6 3H2v11h11v-4" /></svg>
      </button>
      {inApp() && <button className="icon-button" title={t('common.close')} onClick={() => void app.closePanel()} aria-label={t('common.close')}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>}
    </header>
    {!['live', 'polling'].includes(connection.status) && <p className="compact-quality">{t('desktop.disconnected')}</p>}
    {!ids.length && <p>{t('desktop.empty')}</p>}
    {ids.map(id => <Row key={id} id={id} />)}
  </div>;
}
