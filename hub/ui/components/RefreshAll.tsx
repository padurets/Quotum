import {useEffect, useId, useRef, useState} from 'react';
import {t, useLocale} from '../i18n';
import {page, useConnection, useTitle} from '../lib/board';
import {refreshErrorText, requestRefresh, requestRefreshAll, startRefreshRows, observeRefreshRows, answerRefreshRow, refreshRowPending, type RefreshRow} from '../lib/refresh';
import {hubNow} from '../lib/clock';
import {RefreshIcon} from './RefreshAction';
import {Popover} from './Popover';

/** The receipt stays with this attempt, also while the reader closes its popup. */
export function RefreshAll({board, ids}: {board: string; ids: string[]}) {
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
    const stop = page.listen((event, state) => {
      if (state.board?.id !== board) return;
      const snapshot = event.type === 'hub' && (event.event.type === 'snapshot' || event.event.type === 'lineup');
      setRows(previous => observeRefreshRows(previous, state.board!.refresh, snapshot));
    });
    return () => { alive.current = false; stop(); };
  }, [board]);
  const pending = rows.some(refreshRowPending);
  const send = async () => {
    const state = page.get();
    if (busy.current || pending) return;
    if (connection.status !== 'live' && connection.status !== 'polling') {
      setOffline(true);
      return;
    }
    busy.current = true;
    setSending(true);
    setOffline(false);
    setAttempt(previous => previous + 1);
    const next = startRefreshRows(ids, state.board?.refresh ?? {});
    setRows(next);
    const current = () => alive.current && page.get().board?.id === board;
    const answered = (id: string, error: unknown = null) => {
      if (!current()) return;
      setRows(previous => previous.map(row => row.id === id ? answerRefreshRow(row, page.get().board?.refresh[id], error) : row));
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
  if (!ids.length) return null;
  return (
    <Popover
      label={t('refresh.all')}
      icon={sending || pending ? <i className="spinner" aria-hidden="true" /> : <RefreshIcon />}
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) void send();
      }}
    >
      {offline && <div className="popover-note dialog-text" role="status">{t('refresh.offline')}</div>}
      {rows.length > 0 && (
        <>
          <div className="popover-note dialog-text" role="status">{t('refresh.summary', {done: rows.filter(row => !refreshRowPending(row)).length, total: rows.length})}</div>
          <div className="refresh-list">
            {rows.map(row => <RefreshItem key={`${attempt}/${row.id}`} row={row} />)}
          </div>
        </>
      )}
    </Popover>
  );
}

function RefreshItem({row}: {row: RefreshRow}) {
  const title = useTitle(row.id);
  const [open, setOpen] = useState(false);
  const details = useId();
  const pending = refreshRowPending(row);
  const updated = row.status === 'updated';
  const trouble = !pending && !updated;
  const label = t(`refresh.row.${row.status}`);
  const icon = pending ? <i className="spinner" aria-hidden="true" /> : (
    <svg className={`row-icon ${updated ? 'v-ok' : 'v-warn'}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {updated ? <path d="m3 8 3 3 7-7" /> : <><circle cx="8" cy="8" r="5.5" /><path d="M8 4.5v4M8 11h.01" /></>}
    </svg>
  );
  const content = <>{icon}<span title={title}>{title}</span><b>{label}</b></>;
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
