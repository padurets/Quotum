import {useRef, useState} from 'react';
import {t, useLocale} from '../i18n';
import {useConnection, useRefresh} from '../lib/board';
import {useClock} from '../lib/clock';
import {ApiError, call, messageOf} from '../lib/http';
import {refreshChangesAt, refreshPending, refreshText} from '../lib/refresh';

/** An action in the card's existing menu. Only events tell the card what happened. */
export function RefreshAction({id, board, onAccepted}: {id: string; board: string; onAccepted: () => void}) {
  useLocale();
  const state = useRefresh(id);
  const connection = useConnection();
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const action = useRef<HTMLButtonElement>(null);
  const [previous, setPrevious] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const now = useClock(now => (state ? refreshChangesAt(state, now) : null));
  const connected = connection.status === 'live' || connection.status === 'polling';
  const blocked = !connected || !state || refreshPending(state) || state.unavailable !== null || state.retryAt !== null || sending;
  const text = !connected ? t('refresh.offline') : state ? refreshText(state, now) : t('refresh.no_device');
  const send = async () => {
    if (blocked || busy.current) return;
    busy.current = true;
    setSending(true);
    setError(null);
    setPrevious(state?.request?.requestedAt ?? null);
    try {
      await call('POST', `/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(id)}/refresh`);
      // A late reply must not close a menu opened again in the meantime.
      if (action.current) onAccepted();
    } catch (error) {
      setError(error);
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  return (
    <div data-time="refresh">
      <button ref={action} type="button" className="popover-row" aria-disabled={blocked} onClick={() => void send()}>
        <svg className="row-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M13 6.5a5 5 0 1 0 0 4M13 2.5v4H9" />
        </svg>
        <span>{t(sending ? 'refresh.sending' : 'refresh.action')}</span>
      </button>
      {(blocked || state?.request) && (
        <div className="popover-note" role="status">
          {text.split('\n').map(line => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
      {error !== null && (state?.request?.requestedAt ?? null) === previous && (
        <div className="popover-note" role="alert">
          {error instanceof ApiError ? messageOf(error) : t('refresh.uncertain')}
        </div>
      )}
    </div>
  );
}
