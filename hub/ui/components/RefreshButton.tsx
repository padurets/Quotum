import {useRef, useState} from 'react';
import {t, useLocale} from '../i18n';
import {useConnection, useRefresh} from '../lib/board';
import {useClock} from '../lib/clock';
import {ApiError, call, messageOf} from '../lib/http';
import {refreshChangesAt, refreshPending, refreshText} from '../lib/refresh';
import {Popover} from './Popover';

/** The POST only asks; snapshots and events alone tell what happened. */
export function RefreshButton({id, board}: {id: string; board: string}) {
  useLocale();
  const state = useRefresh(id);
  const connection = useConnection();
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const [previous, setPrevious] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const now = useClock(now => (state ? refreshChangesAt(state, now) : null));
  const connected = connection.status === 'live' || connection.status === 'polling';
  const pending = refreshPending(state);
  const outcome = state?.request?.status;
  const failed = outcome === 'failed' || outcome === 'unavailable' || outcome === 'no_result';
  const blocked = !connected || !state || pending || state.unavailable !== null || state.retryAt !== null || sending;
  const text = !connected ? t('refresh.offline') : state ? refreshText(state, now) : t('refresh.no_device');
  const send = async () => {
    if (blocked || busy.current) return;
    busy.current = true;
    setSending(true);
    setError(null);
    setPrevious(state?.request?.requestedAt ?? null);
    try {
      await call('POST', `/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(id)}/refresh`);
    } catch (error) {
      setError(error);
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  return (
    <div className="card-refresh" data-time="refresh" data-refresh={state?.request?.status ?? state?.unavailable ?? 'ready'}>
      <Popover
        ariaDisabled={blocked}
        label={`${t('refresh.action')}\n${text}`}
        open={open}
        onOpenChange={next => {
          setOpen(next);
          if (next) void send();
        }}
        icon={
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            {pending ? (
              <>
                <circle cx="10" cy="10" r="7" />
                <path d="M10 5v5l3 2" />
              </>
            ) : outcome === 'updated' ? (
              <path d="m4 10 4 4 8-8" />
            ) : failed ? (
              <>
                <circle cx="10" cy="10" r="7" />
                <path d="M10 5v6m0 2v2" />
              </>
            ) : (
              <path d="M16 8a6 6 0 1 0 0 5M16 3v5h-5" />
            )}
          </svg>
        }
      >
        <div className="popover-note refresh-note" role="status">
          {sending ? t('refresh.sending') : text}
        </div>
        {error !== null && (state?.request?.requestedAt ?? null) === previous && (
          <div className="popover-note" role="alert">
            {error instanceof ApiError ? messageOf(error) : t('refresh.uncertain')}
          </div>
        )}
        <button className="popover-row" aria-disabled={blocked} onClick={() => void send()}>
          {t('refresh.action')}
        </button>
      </Popover>
    </div>
  );
}
