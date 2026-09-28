import {useEffect, useRef, useState} from 'react';
import {t, useLocale} from '../i18n';
import {page, useConnection, useTitle} from '../lib/board';
import {shallowEqual, useSelect} from '../lib/store';
import {refreshErrorText, refreshPending, requestRefreshAll, type RefreshBatch} from '../lib/refresh';
import {hubNow} from '../lib/clock';
import {RefreshIcon} from './RefreshAction';
import {Popover} from './Popover';

/** The action and its receipt stay in the toolbar; nothing moves the board below it. */
export function RefreshAll({board, ids}: {board: string; ids: string[]}) {
  useLocale();
  const connection = useConnection();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<RefreshBatch | 'offline' | null>(null);
  const [requested, setRequested] = useState<string[]>([]);
  const busy = useRef(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const pending = useSelect(page, state => state.board?.id === board && requested.some(id => refreshPending(state.board!.refresh[id] ?? null)));
  const send = async () => {
    const state = page.get();
    if (busy.current || pending || requested.some(id => refreshPending(state.board?.refresh[id] ?? null))) return;
    if (connection.status !== 'live' && connection.status !== 'polling') {
      setResult('offline');
      return;
    }
    busy.current = true;
    setSending(true);
    setResult(null);
    setRequested(ids);
    // A request already in progress, including one from another tab, needs no POST.
    const waiting = ids.filter(id => refreshPending(state.board?.refresh[id] ?? null));
    const current = () => alive.current && page.get().board?.id === board;
    try {
      const answer = await requestRefreshAll(board, ids.filter(id => !waiting.includes(id)), undefined, current);
      if (current()) setResult({...answer, total: ids.length, accepted: answer.accepted + waiting.length});
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  if (!ids.length) return null;
  const accepted = result && result !== 'offline' ? requested.filter(id => !result.failures.some(failure => failure.id === id)) : [];
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
      <div className="popover-title">{t('refresh.all')}</div>
      <div className="popover-note dialog-text" role="status">
        {sending ? t('refresh.sending') : result === 'offline' ? t('refresh.offline') : result ? t('refresh.requestedAll', {accepted: result.accepted, total: result.total}) : null}
      </div>
      {accepted.length > 0 && <RefreshProgress ids={accepted} />}
      {result && result !== 'offline' && result.failures.map(({id, error}) => <RefusedCard key={id} id={id} error={error} />)}
    </Popover>
  );
}

function RefreshProgress({ids}: {ids: string[]}) {
  const counts = useSelect(page, state => {
    const counts = {pending: 0, updated: 0, failed: 0};
    for (const id of ids) {
      const refresh = state.board?.refresh[id] ?? null;
      if (refreshPending(refresh)) counts.pending++;
      else if (refresh?.request?.status === 'updated') counts.updated++;
      else if (refresh?.request) counts.failed++;
    }
    return counts;
  }, shallowEqual);
  return <div className="popover-note dialog-text" role="status">{t('refresh.progress', counts)}</div>;
}

function RefusedCard({id, error}: {id: string; error: unknown}) {
  const title = useTitle(id);
  // A receipt of this attempt, without a countdown that would outlive the reply.
  const state = page.get().board?.refresh[id] ?? null;
  const message = refreshErrorText(error, state ? {...state, retryAt: null, availableAt: null} : null, hubNow());
  return (
    <div className="popover-section">
      <div className="popover-title">{title}</div>
      <div className="popover-note dialog-text">{message}</div>
    </div>
  );
}
