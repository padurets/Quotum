import {useRef, useState} from 'react';
import {t, useLocale} from '../i18n';
import {page, useConnection, useTitle} from '../lib/board';
import {useSelect} from '../lib/store';
import {refreshErrorText, refreshPending, requestRefreshAll, type RefreshBatch} from '../lib/refresh';
import {hubNow} from '../lib/clock';
import {RefreshIcon} from './RefreshAction';
import {Popover} from './Popover';

export type RefreshReport = {board: string; result: RefreshBatch | 'offline'};

/** The same requests as each card, bounded so a large board does not flood the hub. */
export function RefreshAll({board, ids, onReport}: {board: string; ids: string[]; onReport: (report: RefreshReport | null) => void}) {
  useLocale();
  const connection = useConnection();
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const pending = useSelect(page, state => state.board?.id === board && ids.some(id => refreshPending(state.board!.refresh[id] ?? null)));
  const send = async () => {
    if (busy.current) return;
    if (connection.status !== 'live' && connection.status !== 'polling') {
      onReport({board, result: 'offline'});
      return;
    }
    busy.current = true;
    setSending(true);
    onReport(null);
    const current = () => !!button.current && page.get().board?.id === board;
    try {
      const result = await requestRefreshAll(board, ids, undefined, current);
      if (current()) onReport({board, result});
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  if (!ids.length) return null;
  return (
    <button ref={button} type="button" className="icon-button" aria-label={t('refresh.all')} title={t('refresh.all')} aria-busy={sending || pending} onClick={() => void send()}>
      {sending || pending ? <i className="spinner" aria-hidden="true" /> : <RefreshIcon />}
    </button>
  );
}

function RefusedCard({id, error}: {id: string; error: unknown}) {
  const title = useTitle(id);
  // A receipt of this attempt, without a countdown that would outlive the reply.
  const state = page.get().board?.refresh[id] ?? null;
  const message = refreshErrorText(error, state ? {...state, retryAt: null, availableAt: null} : null, hubNow());
  return (
    <div className="popover-section">
      <div className="popover-title">{title}</div>
      <div className="popover-note">{message}</div>
    </div>
  );
}

/** A receipt below the toolbar, never a popup or a claim that measurements finished. */
export function RefreshResult({report, onClose}: {report: RefreshReport; onClose: () => void}) {
  useLocale();
  const result = report.result;
  return (
    <div className="button-row is-start">
      <div>
        <p className="dialog-text" role="status">
          {result === 'offline' ? t('refresh.offline') : t('refresh.requestedAll', {accepted: result.accepted, total: result.total})}
        </p>
        {result !== 'offline' && result.failures.length > 0 && (
          <Popover label={t('refresh.refusedAll', {count: result.failures.length})} trigger={t('refresh.refusedAll', {count: result.failures.length})} align="left">
            {result.failures.map(({id, error}) => <RefusedCard key={id} id={id} error={error} />)}
          </Popover>
        )}
      </div>
      <button type="button" className="icon-button" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </div>
  );
}
