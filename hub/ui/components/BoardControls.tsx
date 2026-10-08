import {useEffect, useId, useRef, useState} from 'react';
import {t, useLocale} from '../i18n';
import {page, useCanRefreshSources, useCard, useConnection, useRefresh, useTitle} from '../lib/board';
import {
  refreshErrorText,
  requestRefresh,
  requestRefreshAll,
  startRefreshRows,
  observeRefreshRows,
  answerRefreshRow,
  refreshRowPending,
  type RefreshRow,
} from '../lib/refresh';
import {hubNow, useClock} from '../lib/clock';
import {ago, agoChangesAt, stamp} from '../lib/format';
import {problemOf} from '../lib/quota';
import {Check, CircleAlert, LockKeyhole, LockKeyholeOpen, SlidersHorizontal, Settings, Users} from 'lucide-react';
import {RefreshIcon} from './RefreshAction';
import {Popover, PopoverHeading} from './Popover';
import {logoOf} from './logos';

/** The receipt stays with this attempt, also while the reader closes its popup. */
export function BoardControls({
  board,
  ids,
  owner,
  locked,
  onLock,
  onSettings,
  personal,
}: {
  board: string;
  ids: string[];
  owner: boolean;
  locked: boolean;
  onLock: () => void;
  onSettings: ((section: 'general' | 'members') => void) | null;
  personal: boolean;
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
    return () => {
      alive.current = false;
      stop();
    };
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
    const allowed = ids.filter(id => state.board?.refresh[id]?.by !== 'hub' || state.board.sourceAccess?.[id]?.canRefresh === true);
    const next = startRefreshRows(allowed, state.board?.refresh ?? {});
    setRows(next);
    const current = () => alive.current && page.get().board?.id === board;
    const answered = (id: string, error: unknown = null) => {
      if (!current()) return;
      const at = hubNow();
      setRows(previous => previous.map(row => (row.id === id ? answerRefreshRow(row, page.get().board?.refresh[id], error, at) : row)));
    };
    try {
      await requestRefreshAll(
        board,
        next.filter(row => row.status === 'sending').map(row => row.id),
        async (board, id) => {
          try {
            await requestRefresh(board, id);
            answered(id);
          } catch (error) {
            answered(id, error);
            throw error;
          }
        },
        current,
      );
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  return (
    <Popover
      label={t('boardControls.title')}
      icon={<SlidersHorizontal size={16} aria-hidden="true" />}
      open={open}
      onOpenChange={setOpen}
      width={660}
    >
      {open && (
        <div className="widget-manager">
          <PopoverHeading onClose={() => setOpen(false)}>{t('boardControls.title')}</PopoverHeading>
          <div className="manage-layout">
            <div className="manage-sources">
              <div className="popover-title is-group">{t('boardControls.measurements')}</div>
              <div className="manage-list popover-scroll">
                {ids.length ? (
                  ids.map(id => <MeasurementItem key={id} id={id} row={rows.find(row => row.id === id)} attempt={attempt} />)
                ) : (
                  <p className="popover-note dialog-text">{t('boardControls.empty')}</p>
                )}
              </div>
            </div>
            <div className="manage-actions">
              <RefreshButton ids={ids} disabled={pending || sending || !connected} sending={sending || pending} send={() => void send()} />
              {(pending || sending) && (
                <p className="popover-note dialog-text" role="status">
                  {t('refresh.summary', {done: rows.filter(row => !refreshRowPending(row)).length, total: rows.length})}
                </p>
              )}
              {offline && !connected && (
                <p className="popover-note dialog-text" role="status">
                  {t('refresh.offline')}
                </p>
              )}
              {owner && (
                <button
                  type="button"
                  className="popover-row manage-action"
                  aria-pressed={!locked}
                  aria-label={t(locked ? 'widgets.unlock' : 'widgets.lock')}
                  onClick={onLock}
                >
                  {locked ? <LockKeyhole size={19} aria-hidden="true" /> : <LockKeyholeOpen size={19} aria-hidden="true" />}
                  <span>{t(locked ? 'widgets.layoutLocked' : 'widgets.layoutFree')}</span>
                </button>
              )}
              {onSettings && (
                <>
                  <button
                    type="button"
                    className="popover-row manage-action"
                    onClick={() => {
                      setOpen(false);
                      onSettings('general');
                    }}
                  >
                    <Settings size={18} aria-hidden="true" />
                    <span>{t('boardSettings.title')}</span>
                  </button>
                  {!personal && (
                    <button
                      type="button"
                      className="popover-row manage-action"
                      onClick={() => {
                        setOpen(false);
                        onSettings('members');
                      }}
                    >
                      <Users size={18} aria-hidden="true" />
                      <span>{t('admin.members')}</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Popover>
  );
}

function RefreshButton({ids, disabled, sending, send}: {ids: string[]; disabled: boolean; sending: boolean; send: () => void}) {
  const allowed = useCanRefreshSources(ids);
  return (
    <button type="button" className="popover-row manage-action manage-refresh" disabled={disabled || !allowed} onClick={send}>
      {sending ? <i className="spinner" aria-hidden="true" /> : <RefreshIcon />}
      <span>{t('refresh.all')}</span>
    </button>
  );
}

function MeasurementItem({id, row, attempt}: {id: string; row?: RefreshRow; attempt: number}) {
  const title = useTitle(id),
    source = useCard(id),
    refresh = useRefresh(id);
  const [open, setOpen] = useState(false);
  const details = useId();
  useEffect(() => setOpen(false), [attempt]);
  if (!source) return null;
  const problem =
    problemOf(source) ??
    (source.stale && source.successAt !== null
      ? t('widgets.stale')
      : source.inventory?.complete === false
        ? t('money.inventoryPartial')
        : null);
  const trouble = !!row && !refreshRowPending(row) && row.status !== 'updated';
  const message = problem ?? (trouble ? refreshMessage(row!) : null);
  const measured = source.successAt !== null ? t('widgets.measuredAt', {time: stamp(source.successAt)}) : t('widgets.notMeasured');
  const content = (
    <>
      <img src={logoOf(source.provider)} alt="" />
      <span className="manage-widget-name" title={title}>
        {title}
      </span>
      {problem ? (
        <span className="manage-widget-state manage-error">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{t('widgets.error')}</span>
        </span>
      ) : row ? (
        <RefreshState row={row} />
      ) : refresh?.request && ['queued', 'waiting'].includes(refresh.request.status) ? (
        <span className="manage-widget-state">
          <i className="spinner" aria-hidden="true" />
          <span>{t(`refresh.row.${refresh.request.status}`)}</span>
        </span>
      ) : (
        <MeasuredAt at={source.successAt} />
      )}
    </>
  );
  return (
    <div className="manage-entry" data-source-status={id}>
      {message ? (
        <button
          type="button"
          className="popover-row manage-widget"
          title={measured + '\n' + message}
          aria-expanded={open}
          aria-controls={details}
          onClick={() => setOpen(value => !value)}
        >
          {content}
        </button>
      ) : (
        <div className="popover-row manage-widget" title={measured}>
          {content}
        </div>
      )}
      {message && open && (
        <p id={details} className="manage-details" role="status">
          {message}
          <br />
          {measured}
        </p>
      )}
    </div>
  );
}

function MeasuredAt({at}: {at: number | null}) {
  const now = useClock(now => agoChangesAt(at, now));
  return (
    <span
      className="manage-widget-state"
      data-time="widget-measurement"
      title={at !== null ? t('widgets.measuredAt', {time: stamp(at)}) : t('widgets.notMeasured')}
    >
      {ago(at, now)}
    </span>
  );
}

function refreshMessage(row: RefreshRow) {
  return row.error !== null
    ? refreshErrorText(row.error, row.state ? {...row.state, retryAt: null, availableAt: null} : null, hubNow())
    : t(row.status === 'unknown' ? 'refresh.uncertain' : row.status === 'refused' ? 'refresh.failed' : `refresh.${row.status}`);
}

function RefreshState({row}: {row: RefreshRow}) {
  const pending = refreshRowPending(row);
  const updated = row.status === 'updated';
  const label = t(`refresh.row.${row.status}`);
  const Icon = updated ? Check : CircleAlert;
  const icon = pending ? (
    <i className="spinner" aria-hidden="true" />
  ) : (
    <Icon className={`row-icon ${updated ? 'v-ok' : 'v-warn'}`} size={14} aria-hidden="true" />
  );
  const content = (
    <>
      {icon}
      <span>{label}</span>
    </>
  );
  return (
    <span className="manage-widget-state" data-refresh-row={row.id} data-refresh-status={row.status}>
      {content}
    </span>
  );
}
