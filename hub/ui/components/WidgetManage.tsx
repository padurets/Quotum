import {useEffect, useId, useRef, useState} from 'react';
import {t, useLocale} from '../i18n';
import {page, useCanRefreshSources, useCard, useConnection, useRefresh, useTitle} from '../lib/board';
import {refreshErrorText, requestRefresh, requestRefreshAll, startRefreshRows, observeRefreshRows, answerRefreshRow, refreshRowPending, type RefreshRow} from '../lib/refresh';
import {hubNow} from '../lib/clock';
import {stamp} from '../lib/format';
import {problemOf} from '../lib/quota';
import {widgetKind} from '../lib/widgetKind';
import {Activity, ChartNoAxesCombined, Check, CircleAlert, List, LockKeyhole, LockKeyholeOpen, PanelsTopLeft, Settings, Table2, Users} from 'lucide-react';
import {RefreshIcon} from './RefreshAction';
import {Popover} from './Popover';
import {logoOf} from './logos';

/** The receipt stays with this attempt, also while the reader closes its popup. */
export function WidgetManage({board, ids, widgets, owner, locked, onLock, onSettings, personal}: {
  board: string; ids: string[]; widgets: {id: string; title: string}[]; owner: boolean; locked: boolean;
  onLock: () => void; onSettings: ((section: 'general' | 'members') => void) | null; personal: boolean;
}) {
  useLocale();
  const connection = useConnection();
  const [open, setOpen] = useState(false);
  const [offline, setOffline] = useState(false);
  const [sending, setSending] = useState(false);
  const [rows, setRows] = useState<RefreshRow[]>([]);
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    const stop = page.listen(event => {
      const snapshot = event.type === 'hub' && (event.event.type === 'snapshot' || event.event.type === 'lineup');
      // The page as it is when the rows update, as for an HTTP reply: a state kept from an
      // earlier event would take a row back to before its own request.
      setRows(previous => {
        const current = page.get().board;
        return current?.id === board ? observeRefreshRows(previous, current.refresh, snapshot) : previous;
      });
    });
    return () => { alive.current = false; stop(); };
  }, [board]);
  const pending = rows.some(refreshRowPending);
  const connected = connection.status === 'live' || connection.status === 'polling';
  // The note answers a click made while disconnected; the connection back, it is moot.
  useEffect(() => {
    if (connected) setOffline(false);
  }, [connected]);
  const send = async () => {
    const state = page.get();
    if (busy.current || pending) return;
    if (!connected) {
      setOffline(true);
      return;
    }
    busy.current = true;
    setSending(true);
    setOffline(false);
    setAttempt(previous => previous + 1);
    const allowed=ids.filter(id=>state.board?.refresh[id]?.by!=='hub'||state.board.sourceAccess?.[id]?.canRefresh===true);
    const next = startRefreshRows(allowed, state.board?.refresh ?? {});
    setRows(next);
    const current = () => alive.current && page.get().board?.id === board;
    const answered = (id: string, error: unknown = null) => {
      if (!current()) return;
      const at = hubNow();
      setRows(previous => previous.map(row => row.id === id ? answerRefreshRow(row, page.get().board?.refresh[id], error, at) : row));
    };
    try {
      await requestRefreshAll(board, next.filter(row => row.status === 'sending').map(row => row.id), async (board, id) => {
        try {
          await requestRefresh(board, id);
          answered(id);
        } catch (error) {
          answered(id, error);
          throw error;
        }
      }, current);
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  return (
    <Popover
      label={t('widgets.manage')}
      trigger={<><PanelsTopLeft size={16} aria-hidden="true" /><span>{t('widgets.title')}</span></>}
      triggerClass="button board-action-button"
      open={open}
      onOpenChange={setOpen}
      width={660}
    >
      {open && <div className="widget-manager">
        <div className="manage-heading"><h3>{t('widgets.manage')}</h3><span>{widgets.length}</span></div>
        <div className="manage-layout">
          <div className="manage-list popover-scroll">
            {widgets.length ? widgets.map(widget => widget.id.startsWith('source:')
              ? <MeasurementItem key={widget.id} id={widget.id.slice(7)} row={rows.find(row => row.id === widget.id.slice(7))} attempt={attempt} />
              : <div className="manage-widget" key={widget.id}><WidgetIcon id={widget.id} /><div className="manage-widget-info"><b>{widget.title}</b><small>{t(widgetKind(widget.id))}</small><span className="manage-measured">{t('widgets.followsData')}</span></div></div>)
              : <p className="popover-note dialog-text">{t('widgets.none')}</p>}
          </div>
          <div className="manage-actions">
            <RefreshButton ids={ids} disabled={pending || sending || !connected} sending={sending || pending} send={() => void send()} />
            {(pending || sending) && <p className="popover-note dialog-text" role="status">{t('refresh.summary', {done: rows.filter(row => !refreshRowPending(row)).length, total: rows.length})}</p>}
            {offline && !connected && <p className="popover-note dialog-text" role="status">{t('refresh.offline')}</p>}
            {owner && <button type="button" className="popover-row manage-action" aria-pressed={!locked} aria-label={t(locked ? 'widgets.unlock' : 'widgets.lock')} onClick={onLock}>
              {locked ? <LockKeyhole size={19} aria-hidden="true" /> : <LockKeyholeOpen size={19} aria-hidden="true" />}
              <span><b>{t('widgets.movement')}</b><small>{t(locked ? 'widgets.layoutLocked' : 'widgets.layoutFree')}</small></span>
            </button>}
            {onSettings && <>
              <button type="button" className="popover-row manage-action" onClick={() => {setOpen(false); onSettings('general');}}><Settings size={18} aria-hidden="true" /><span>{t('boardSettings.title')}</span></button>
              {!personal && <button type="button" className="popover-row manage-action" onClick={() => {setOpen(false); onSettings('members');}}><Users size={18} aria-hidden="true" /><span>{t('admin.members')}</span></button>}
            </>}
          </div>
        </div>
      </div>}
    </Popover>
  );
}

function RefreshButton({ids, disabled, sending, send}: {ids: string[]; disabled: boolean; sending: boolean; send: () => void}) {
  const allowed = useCanRefreshSources(ids);
  return <button type="button" className="button manage-refresh" disabled={disabled || !allowed} onClick={send}>
    {sending ? <i className="spinner" aria-hidden="true" /> : <RefreshIcon />}<span>{t('refresh.all')}</span>
  </button>;
}

function WidgetIcon({id}: {id: string}) {
  const Icon = ({agents: List, activity: Activity, history: ChartNoAxesCombined, forecast: Table2} as Record<string, typeof List>)[id] ?? PanelsTopLeft;
  return <Icon size={20} aria-hidden="true" />;
}

function MeasurementItem({id, row, attempt}: {id: string; row?: RefreshRow; attempt: number}) {
  const title = useTitle(id), source = useCard(id), refresh = useRefresh(id);
  if (!source) return null;
  const problem = problemOf(source);
  return <div className="manage-widget" data-source-status={id}>
    <img src={logoOf(source.provider)} alt="" /><div className="manage-widget-info">
      <b>{title}</b><small>{t(widgetKind('', source.provider))}</small>
      <span className="manage-measured" data-time="widget-measurement">{source.successAt !== null ? t('widgets.measuredAt', {time: stamp(source.successAt)}) : t('widgets.notMeasured')}</span>
      {problem && <span className="manage-error">{problem}</span>}
      {!problem && source.stale && <span className="manage-error">{t('widgets.stale')}</span>}
      {!problem && source.inventory?.complete === false && <span className="manage-error">{t('money.inventoryPartial')}</span>}
      {row ? <RefreshItem key={`${attempt}/${row.id}`} row={row} /> : refresh?.request && <span className="manage-measured">{t(`refresh.row.${refresh.request.status}`)}</span>}
    </div>
  </div>;
}

function RefreshItem({row}: {row: RefreshRow}) {
  const [open, setOpen] = useState(true);
  const details = useId();
  const pending = refreshRowPending(row);
  const updated = row.status === 'updated';
  const trouble = !pending && !updated;
  const label = t(`refresh.row.${row.status}`);
  const Icon = updated ? Check : CircleAlert;
  const icon = pending ? <i className="spinner" aria-hidden="true" /> : <Icon className={`row-icon ${updated ? 'v-ok' : 'v-warn'}`} size={14} aria-hidden="true" />;
  const content = <>{icon}<span>{label}</span></>;
  const message = row.error !== null
    ? refreshErrorText(row.error, row.state ? {...row.state, retryAt: null, availableAt: null} : null, hubNow())
    : trouble ? t(row.status === 'unknown' ? 'refresh.uncertain' : row.status === 'refused' ? 'refresh.failed' : `refresh.${row.status}`) : '';
  return (
    <div data-refresh-row={row.id} data-refresh-status={row.status}>
      {trouble ? (
        <button type="button" className="popover-row" aria-expanded={open} aria-controls={details} onClick={() => setOpen(previous => !previous)}>
          {content}
        </button>
      ) : <div className="popover-row">{content}</div>}
      {trouble && open && <div id={details} className="popover-note dialog-text">{message}</div>}
    </div>
  );
}
