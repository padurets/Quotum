import {useState, type FormEvent, type ReactNode} from 'react';
import {call} from '../lib/http';
import {boardTitle, type Board, type User} from '../lib/session';
import {page, useConnection} from '../lib/board';
import {useClock} from '../lib/clock';
import {Brand, ErrorLine, Field, Modal} from './Kit';
import {Popover} from './Popover';
import {LockIcon} from './Widgets';
import {t} from '../i18n';

/** The connection lost this long (by the hub's clock) is said in the header. */
const OFFLINE_AFTER = 45_000;

const ChevronIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M4.5 6.5L8 10l3.5-3.5" />
  </svg>
);

const GearIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M5.65 3.93L6.63 3.51L6.74 1.52L9.26 1.52L9.37 3.51L10.35 3.93L11.21 4.56L12.98 3.67L14.24 5.85L12.58 6.94L12.70 8.00L12.58 9.06L14.24 10.15L12.98 12.33L11.21 11.44L10.35 12.07L9.37 12.49L9.26 14.48L6.74 14.48L6.63 12.49L5.65 12.07L4.79 11.44L3.02 12.33L1.76 10.15L3.42 9.06L3.30 8.00L3.42 6.94L1.76 5.85L3.02 3.67L4.79 4.56Z" strokeLinejoin="round" />
    <circle cx="8" cy="8" r="1.9" />
  </svg>
);

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
          <ChevronIcon />
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
      {local ? <button className="icon-button" aria-label={t('header.settings')} onClick={onAccount}><GearIcon /></button> :
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
export function BoardActions({board, refresh, owner, locked, onLock, add, onSettings}: {
  board: Board | null; refresh: ReactNode; owner: boolean; locked: boolean;
  onLock: () => void; add: ReactNode; onSettings: ((section: 'general' | 'members') => void) | null;
}) {
  const [open, setOpen] = useState(false);
  return <div className="board-actions" role="group" aria-label={board ? boardTitle(board) : undefined}><Offline />{refresh}
      {add}
      {owner && <button className="icon-button" aria-pressed={locked} aria-label={t(locked ? 'widgets.unlock' : 'widgets.lock')} title={t(locked ? 'widgets.unlock' : 'widgets.lock')} onClick={onLock}><LockIcon open={!locked} /></button>}
      {onSettings && <Popover label={t('boardSettings.title')} icon={<GearIcon />} open={open} onOpenChange={setOpen}>
        <button className="popover-row" onClick={() => {setOpen(false); onSettings('general');}}><span>{t('boardSettings.title')}</span></button>
        {!board?.personal && <button className="popover-row" onClick={() => {setOpen(false); onSettings('members');}}><span>{t('admin.members')}</span></button>}
      </Popover>}
  </div>;
}
