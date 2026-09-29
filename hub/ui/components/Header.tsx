import {useState, type FormEvent, type ReactNode} from 'react';
import {call} from '../lib/http';
import {boardTitle, type Board, type User} from '../lib/session';
import {page, useConnection} from '../lib/board';
import {useClock} from '../lib/clock';
import {Brand, ErrorLine, Field, Modal} from './Kit';
import {Popover} from './Popover';
import {t} from '../i18n';

/** The connection lost this long (by the hub's clock) is said in the header. */
const OFFLINE_AFTER = 45_000;

const ChevronIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M4.5 6.5L8 10l3.5-3.5" />
  </svg>
);

const DevicesIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <rect x="2" y="3" width="12" height="8" rx="1.5" />
    <path d="M5.5 13.5h5M8 11v2.5" />
  </svg>
);

const PeopleIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <circle cx="6" cy="5.5" r="2.3" />
    <path d="M1.8 13.2c.5-2.3 2.2-3.6 4.2-3.6s3.7 1.3 4.2 3.6M10.6 3.4a2.2 2.2 0 0 1 0 4.2M11.8 9.8c1.3.4 2.1 1.6 2.4 3.4" />
  </svg>
);

const GearIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M5.65 3.93L6.63 3.51L6.74 1.52L9.26 1.52L9.37 3.51L10.35 3.93L11.21 4.56L12.98 3.67L14.24 5.85L12.58 6.94L12.70 8.00L12.58 9.06L14.24 10.15L12.98 12.33L11.21 11.44L10.35 12.07L9.37 12.49L9.26 14.48L6.74 14.48L6.63 12.49L5.65 12.07L4.79 11.44L3.02 12.33L1.76 10.15L3.42 9.06L3.30 8.00L3.42 6.94L1.76 5.85L3.02 3.67L4.79 4.56Z" strokeLinejoin="round" />
    <circle cx="8" cy="8" r="1.9" />
  </svg>
);

const PencilIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M10.5 3.5l2 2M3 13l.6-2.6L11 3a1.4 1.4 0 0 1 2 2l-7.4 7.4z" />
  </svg>
);

const LeaveIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11l3-3-3-3M13.5 8H6" />
  </svg>
);

/**
 * A board in the list. Its owner renames it in place (a personal board left empty, or
 * with its default name, keeps the default in every language) and deletes a shared one;
 * a member leaves a shared one.
 */
function BoardItem({
  board,
  current,
  onSelect,
  onDelete,
}: {
  board: Board;
  current: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const owner = board.role === 'owner';

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const typed = name!.trim();
    try {
      // The list of boards changes when the hub tells so.
      await call('POST', `/api/boards/${encodeURIComponent(board.id)}`, {name: board.personal && typed === t('boards.personalName') ? '' : typed});
      setName(null);
    } catch (failure) {
      setError(failure);
    }
  };

  const leave = async () => {
    if (!confirm(t('boards.confirmLeave', {board: boardTitle(board)}))) return;
    setError(null);
    try {
      await call('POST', `/api/boards/${encodeURIComponent(board.id)}/leave`);
    } catch (failure) {
      setError(failure);
    }
  };

  if (name !== null) {
    return (
      <form className="board-rename" onSubmit={rename}>
        <input
          autoFocus
          value={name}
          maxLength={80}
          placeholder={board.personal ? t('boards.personalName') : ''}
          aria-label={t('boards.renameLabel')}
          onChange={event => setName(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            setName(null);
          }}
        />
        <button className="button" disabled={!board.personal && !name.trim()}>
          {t('boards.save')}
        </button>
        {!board.personal && (
          <button type="button" className="link-button danger" onClick={onDelete}>
            {t('boards.delete')}
          </button>
        )}
        <ErrorLine error={error} />
      </form>
    );
  }
  return (
    <div className="board-item">
      <button type="button" className="popover-row board-row" aria-current={current} onClick={onSelect}>
        <i className={`check ${current ? 'on' : ''}`} />
        <span>{boardTitle(board)}</span>
        <b>{t(board.personal ? 'boards.personal' : 'boards.shared')}</b>
      </button>
      {owner ? (
        <button type="button" className="icon-button" aria-label={t('boards.edit', {board: boardTitle(board)})} title={t('boards.edit', {board: boardTitle(board)})} onClick={() => setName(boardTitle(board))}>
          <PencilIcon />
        </button>
      ) : (
        !board.personal && (
          <button type="button" className="icon-button" aria-label={t('boards.leave', {board: boardTitle(board)})} title={t('boards.leave', {board: boardTitle(board)})} onClick={leave}>
            <LeaveIcon />
          </button>
        )
      )}
      <ErrorLine error={error} />
    </div>
  );
}

/** Deleting a shared board: its name typed out, since nothing of it can come back. */
function DeleteBoard({board, onClose}: {board: Board; onClose: () => void}) {
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
  const [deleting, setDeleting] = useState<Board | null>(null);
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
        <BoardItem
          key={b.id}
          board={b}
          current={b.id === board?.id}
          onSelect={() => (onSelect(b.id), setOpen(false))}
          onDelete={() => (setOpen(false), setDeleting(b))}
        />
      ))}
      <form className="popover-section popover-form" onSubmit={create}>
        <input placeholder={t('boards.newPlaceholder')} value={name} maxLength={80} onChange={e => setName(e.target.value)} aria-label={t('boards.newLabel')} />
        <button className="button" disabled={busy || !name.trim()}>
          {t('boards.create')}
        </button>
      </form>
      <ErrorLine error={error} />
    </Popover>
    {deleting && <DeleteBoard board={deleting} onClose={() => setDeleting(null)} />}
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

/**
 * One compact strip: brand and board on the left; on the right a word when the hub
 * cannot be reached, the board's widgets (for its owner), devices, and the person's
 * own panel behind the avatar.
 */
export function Header({
  boards,
  board,
  onBoard,
  widgets,
  refresh,
  onDevices,
  onPeople,
  user,
  onAccount,
  local,
}: {
  boards: Board[];
  board: Board | null;
  onBoard: (id: string) => void;
  widgets: ReactNode;
  refresh: ReactNode;
  onDevices: () => void;
  /** A shared board's people and what they share; null on a personal board. */
  onPeople: (() => void) | null;
  user: User;
  onAccount: () => void;
  /** The desktop app's board: one board, nobody to share with, settings instead of an account. */
  local: boolean;
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Brand href="/" />
        {!local && <BoardSwitcher boards={boards} board={board} onSelect={onBoard} />}
        <div className="status">
          <Offline />
          {refresh}
          {widgets}
          {onPeople && (
            <button type="button" className="icon-button" aria-label={t('header.people')} title={t('header.people')} onClick={onPeople}>
              <PeopleIcon />
            </button>
          )}
          <button type="button" className="icon-button" aria-label={t('header.devices')} title={t('header.devices')} onClick={onDevices}>
            <DevicesIcon />
          </button>
          {local ? (
            <button type="button" className="icon-button" aria-label={t('header.settings')} title={t('header.settings')} onClick={onAccount}>
              <GearIcon />
            </button>
          ) : (
            <button type="button" className="avatar-button" aria-label={t('account.open')} title={`${user.name} · ${user.email}`} onClick={onAccount}>
              <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
