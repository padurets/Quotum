import {useState, type FormEvent, type ReactNode} from 'react';
import {call} from '../lib/http';
import {boardTitle, type Board, type User} from '../lib/session';
import {page, useConnection} from '../lib/board';
import {useClock} from '../lib/clock';
import {Brand, ErrorLine, Field, Modal} from './Kit';
import {Popover} from './Popover';
import {ChevronDown, Settings as SettingsIcon} from 'lucide-react';
import {t} from '../i18n';

/** The connection lost this long (by the hub's clock) is said in the header. */
const OFFLINE_AFTER = 45_000;

/** Deleting a shared board: its name typed out, since nothing of it can come back. */
export function DeleteBoard({board, onClose}: {board: Board; onClose: () => void}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const remove = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call('DELETE', `/api/boards/${encodeURIComponent(board.id)}`);
      onClose();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('boards.deleteTitle', {board: board.name})} onClose={onClose}>
      <form className="dialog-form" onSubmit={remove}>
        <p className="dialog-text">{t('boards.deleteText')}</p>
        <Field label={t('boards.deleteConfirm', {board: board.name})} value={typed} autoComplete="off" autoFocus onChange={e => setTyped(e.target.value)} />
        <ErrorLine error={error} />
        <div className="button-row">
          <button type="button" className="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="button danger" disabled={typed.trim() !== board.name || busy}>
            {t('boards.deleteButton')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Which board is on screen; boards are created and renamed right here. What changes the
 * list comes as the hub's news of it, but for a board just created: it is opened at once.
 */
function BoardSwitcher({boards, board, onSelect}: {boards: Board[]; board: Board | null; onSelect: (id: string) => void}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await call<Board>('POST', '/api/boards', {name: name.trim()});
      setName('');
      setOpen(false);
      page.dispatch({type: 'board-created', board: created});
      onSelect(created.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
    <Popover
      label={t('boards.title')}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <span className="board-name">
          <span className="board-name-text">{board ? boardTitle(board) : '—'}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </span>
      }
      align="left"
    >
      <div className="popover-title">{t('boards.title')}</div>
      {boards.map(b => (
        <button key={b.id} type="button" className="popover-row board-row" aria-current={b.id === board?.id} onClick={() => {onSelect(b.id); setOpen(false);}}>
          <i className={`check ${b.id === board?.id ? 'on' : ''}`} />
          <span>{boardTitle(b)}</span><b>{t(b.personal ? 'boards.personal' : 'boards.shared')}</b>
        </button>
      ))}
      <form className="popover-section popover-form" onSubmit={create}>
        <input placeholder={t('boards.newPlaceholder')} value={name} maxLength={80} onChange={e => setName(e.target.value)} aria-label={t('boards.newLabel')} />
        <button className="button" disabled={busy || !name.trim()}>
          {t('boards.create')}
        </button>
      </form>
      <ErrorLine error={error} />
    </Popover>
    </>
  );
}

/**
 * A word when the hub cannot be reached: the connection lost a while ago (lib/live.ts), not
 * a tab put to sleep. It renders when that comes or goes; its slot is there all the time.
 */
function Offline() {
  const {status, lostAt} = useConnection();
  const since = status === 'paused' ? null : lostAt;
  const now = useClock(now => (since !== null && now < since + OFFLINE_AFTER ? since + OFFLINE_AFTER : null));
  return (
    <span className="time-slot" data-time="offline">
      {since !== null && now >= since + OFFLINE_AFTER && (
        <span className="offline" role="status" title={t('common.offline')}>
          <i className="dot dot-warn" />
          <span>{t('common.offline')}</span>
        </span>
      )}
    </span>
  );
}

/** Global navigation and the person's menu stay available on settings pages too. */
export function Header({boards, board, onBoard, user, onAccount, onSignedOut, local, actions}: {
  boards: Board[]; board: Board | null; onBoard: (id: string) => void;
  user: User; onAccount: () => void; onSignedOut: () => void; local: boolean; actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const signOut = async () => {
    try { await call('POST', '/api/auth/logout'); onSignedOut(); }
    catch (failure) { setError(failure); }
  };
  return <header className="topbar"><div className="topbar-inner">
    <Brand href="/" />
    {!local && <BoardSwitcher boards={boards} board={board} onSelect={onBoard} />}
    <div className="status">
      {actions}
      {local ? <button className="icon-button" aria-label={t('header.settings')} onClick={onAccount}><SettingsIcon size={16} aria-hidden="true" /></button> :
        <Popover label={t('account.open')} triggerClass="avatar-button" trigger={<span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>} open={open} onOpenChange={setOpen}>
          <div className="popover-title">{user.name}<small className="account-email">{user.email}</small></div>
          <button className="popover-row" onClick={() => {setOpen(false); onAccount();}}><span>{t('header.settings')}</span></button>
          <button className="popover-row" onClick={() => void signOut()}><span>{t('account.signOut')}</span></button>
          <ErrorLine error={error} />
        </Popover>}
    </div>
  </div></header>;
}

/** These actions always name the current board; personal management has its own pages. */
export function BoardActions({board, add, manage}: {
  board: Board | null; add: ReactNode; manage: ReactNode;
}) {
  return <div className="board-actions" role="group" aria-label={board ? boardTitle(board) : undefined}><Offline />
      {add}{manage}
  </div>;
}
