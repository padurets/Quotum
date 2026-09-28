import {Fragment, useRef, useState} from 'react';
import {t, useLocale} from '../i18n';
import {useConnection, useRefresh} from '../lib/board';
import {useClock} from '../lib/clock';
import {refreshErrorChangesAt, refreshErrorText, requestRefresh} from '../lib/refresh';

export const RefreshIcon = () => (
  <svg className="row-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M13 6.5a5 5 0 1 0 0 4M13 2.5v4H9" />
  </svg>
);

type Failure = {kind: 'offline'} | {kind: 'request'; error: unknown; previous: number | null};

/** An action in the card's existing menu. Only events tell the card what happened. */
export function RefreshAction({id, board, onAccepted}: {id: string; board: string; onAccepted: () => void}) {
  useLocale();
  const state = useRefresh(id);
  const connection = useConnection();
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const action = useRef<HTMLButtonElement>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const now = useClock(now => (failure?.kind === 'request' ? refreshErrorChangesAt(failure.error, state, now) : null));
  const connected = connection.status === 'live' || connection.status === 'polling';
  const message =
    failure?.kind === 'offline' && !connected
      ? t('refresh.offline')
      : failure?.kind === 'request' && (state?.request?.requestedAt ?? null) === failure.previous
        ? refreshErrorText(failure.error, state, now)
        : null;
  const send = async () => {
    if (busy.current) return;
    setFailure(null);
    if (!connected) {
      setFailure({kind: 'offline'});
      return;
    }
    busy.current = true;
    setSending(true);
    const previous = state?.request?.requestedAt ?? null;
    try {
      await requestRefresh(board, id);
      // A late reply must not close a menu opened again in the meantime.
      if (action.current) onAccepted();
    } catch (error) {
      setFailure({kind: 'request', error, previous});
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  return (
    <div data-time="refresh">
      <button ref={action} type="button" className="popover-row" onClick={() => void send()}>
        <RefreshIcon />
        <span>{t(sending ? 'refresh.sending' : 'refresh.action')}</span>
      </button>
      {message && (
        <p className="form-error" role="alert">
          {message.split('\n').map((line, index) => (
            <Fragment key={index}>
              {index > 0 && <br />}
              {line}
            </Fragment>
          ))}
        </p>
      )}
    </div>
  );
}
