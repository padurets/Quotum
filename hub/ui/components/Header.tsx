import {useState, type FormEvent, type ReactNode} from 'react';
import {call} from '../lib/http';
import {boardTitle, type Board, type User} from '../lib/session';
import {Brand, ErrorLine} from './Kit';
import {Popover} from './Popover';
import {t} from '../i18n';

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

const PencilIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M10.5 3.5l2 2M3 13l.6-2.6L11 3a1.4 1.4 0 0 1 2 2l-7.4 7.4z" />
  </svg>
);

/** A board in the list; its owner renames it in place. A personal board left empty takes its default name. */
function BoardItem({board, current, onSelect, onRenamed}: {board: Board; current: boolean; onSelect: () => void; onRenamed: () => Promise<void>}) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await call('POST', `/api/boards/${encodeURIComponent(board.id)}`, {name: name!.trim()});
      await onRenamed();
      setName(null);
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
      {board.role === 'owner' && (
        <button type="button" className="icon-button" aria-label={t('boards.rename', {board: boardTitle(board)})} title={t('boards.rename', {board: boardTitle(board)})} onClick={() => setName(board.name)}>
          <PencilIcon />
        </button>
      )}
    </div>
  );
}

/** Which board is on screen; boards are created and renamed right here. */
function BoardSwitcher({boards, board, onSelect, onChanged}: {boards: Board[]; board: Board | null; onSelect: (id: string) => void; onChanged: () => Promise<void>}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const created = await call<Board>('POST', '/api/boards', {name: name.trim()});
      setName('');
      setOpen(false);
      await onChanged();
      onSelect(created.id);
    } catch (failure) {
      setError(failure);
    }
  };
  return (
    <Popover
      label={t('boards.title')}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <span className="board-name">
          {board ? boardTitle(board) : '—'}
          <ChevronIcon />
        </span>
      }
      align="left"
    >
      <div className="popover-title">{t('boards.title')}</div>
      {boards.map(b => (
        <BoardItem key={b.id} board={b} current={b.id === board?.id} onSelect={() => (onSelect(b.id), setOpen(false))} onRenamed={onChanged} />
      ))}
      <form className="popover-section popover-form" onSubmit={create}>
        <input placeholder={t('boards.newPlaceholder')} value={name} maxLength={80} onChange={e => setName(e.target.value)} aria-label={t('boards.newLabel')} />
        <button className="button" disabled={!name.trim()}>
          {t('boards.create')}
        </button>
      </form>
      <ErrorLine error={error} />
    </Popover>
  );
}

/**
 * One compact strip: brand and board on the left; on the right a word when the hub
 * cannot be reached, the board's widgets (for its owner), devices, and the person's
 * own panel behind the avatar.
 */
export function Header({
  lastOk,
  now,
  boards,
  board,
  onBoard,
  onBoardsChanged,
  widgets,
  onDevices,
  user,
  onAccount,
}: {
  lastOk: number;
  now: number;
  boards: Board[];
  board: Board | null;
  onBoard: (id: string) => void;
  onBoardsChanged: () => Promise<void>;
  widgets: ReactNode;
  onDevices: () => void;
  user: User;
  onAccount: () => void;
}) {
  const offline = !!lastOk && now - lastOk > OFFLINE_AFTER;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Brand href="/" />
        <BoardSwitcher boards={boards} board={board} onSelect={onBoard} onChanged={onBoardsChanged} />
        <div className="status">
          {offline && (
            <span className="offline" role="status" title={t('common.offline')}>
              <i className="dot dot-warn" />
              <span>{t('common.offline')}</span>
            </span>
          )}
          {widgets}
          <button type="button" className="icon-button" aria-label={t('header.devices')} title={t('header.devices')} onClick={onDevices}>
            <DevicesIcon />
          </button>
          <button type="button" className="avatar-button" aria-label={t('account.open')} title={`${user.name} · ${user.email}`} onClick={onAccount}>
            <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
