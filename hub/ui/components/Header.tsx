import {useState, type FormEvent} from 'react';
import type {Overview} from '../lib/types';
import {ago, clock} from '../lib/format';
import {problemOf, sourceLabel} from '../lib/quota';
import {GearIcon, Popover, SwitchRow} from './Popover';
import {setPrefs, usePrefs} from '../lib/prefs';
import type {TrackerHealth} from '../lib/resets';
import {call} from '../lib/http';
import {boardTitle, type Board, type User} from '../lib/session';
import {Brand, ErrorLine, LanguageSelect} from './Kit';
import {known, rich, t} from '../i18n';

/** Dashboard-wide settings, stored in this browser. */
function Settings({trackers}: {trackers: TrackerHealth[]}) {
  const prefs = usePrefs();
  return (
    <Popover label={t('settings.title')} icon={<GearIcon />}>
      <div className="popover-title">{t('settings.title')}</div>
      <SwitchRow on={prefs.showResets} onChange={on => setPrefs({showResets: on})}>
        {t('settings.resets')}
      </SwitchRow>
      {prefs.showResets && (
        <div className="trackers">
          {trackers.map(tracker => (
            <div key={tracker.name} className="tracker" title={tracker.at ? t('settings.checkedAt', {time: clock(tracker.at)}) : ''}>
              <i className={`dot ${tracker.ok === true ? 'dot-ok' : tracker.ok === false ? 'dot-warn' : 'dot-idle'}`} />
              <a href={tracker.url} target="_blank" rel="noopener noreferrer">
                {tracker.name}
              </a>
              <span>{trackerDetail(tracker.detail)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="popover-note">
        {rich('settings.resetsNote', {
          claude: (
            <a href="https://claude-resets.com/" target="_blank" rel="noopener noreferrer">
              claude-resets.com
            </a>
          ),
          codex: (
            <a href="https://codex-resets.com/" target="_blank" rel="noopener noreferrer">
              Codex Resets
            </a>
          ),
        })}
      </div>
      <div className="popover-title popover-section">{t('common.language')}</div>
      <div className="popover-pad">
        <LanguageSelect />
      </div>
    </Popover>
  );
}

/** The hub reports tracker health as codes; an HTTP status is shown as is. */
function trackerDetail(detail: string) {
  const key = `tracker.${detail}`;
  return known(key) ? t(key) : detail;
}

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

/** Which board is on screen; a new board is created right here. */
function BoardSwitcher({boards, board, onSelect, onCreated}: {boards: Board[]; board: Board | null; onSelect: (id: string) => void; onCreated: () => Promise<void>}) {
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
      await onCreated();
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
        <button key={b.id} type="button" className="popover-row board-row" aria-current={b.id === board?.id} onClick={() => (onSelect(b.id), setOpen(false))}>
          <i className={`check ${b.id === board?.id ? 'on' : ''}`} />
          <span>{boardTitle(b)}</span>
          <b>{t(b.personal ? 'boards.personal' : 'boards.shared')}</b>
        </button>
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

function Account({user, onSignedOut}: {user: User; onSignedOut: () => void}) {
  const signOut = async () => {
    await call('POST', '/api/auth/logout').catch(() => {});
    onSignedOut();
  };
  return (
    <Popover label={t('account.title')} icon={<span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>}>
      <div className="popover-title">{t('account.title')}</div>
      <div className="account-card">
        <b>{user.name}</b>
        <span>{user.email}</span>
      </div>
      <button type="button" className="popover-row" onClick={signOut}>
        <span>{t('account.signOut')}</span>
      </button>
    </Popover>
  );
}

/**
 * One compact, non-jumping strip: brand and board, how many sources are fresh (and
 * whether the hub answers), devices, settings and account.
 */
export function Header({
  data,
  lastOk,
  now,
  trackers,
  boards,
  board,
  onBoard,
  onBoardsChanged,
  onDevices,
  user,
  onSignedOut,
}: {
  data: Overview | null;
  lastOk: number;
  now: number;
  trackers: TrackerHealth[];
  boards: Board[];
  board: Board | null;
  onBoard: (id: string) => void;
  onBoardsChanged: () => Promise<void>;
  onDevices: () => void;
  user: User;
  onSignedOut: () => void;
}) {
  const offline = !!lastOk && now - lastOk > OFFLINE_AFTER;
  const sources = data?.sources ?? [];
  const fresh = sources.filter(source => !source.stale && !source.error).length;

  const sourcesTitle = sources
    .map(source => `${sourceLabel(source)}: ${problemOf(source) ?? t('source.measured', {ago: ago(source.successAt, now)})}`)
    .join('\n');

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Brand href="/" />
        <BoardSwitcher boards={boards} board={board} onSelect={onBoard} onCreated={onBoardsChanged} />
        <div className="status">
          <span
            className={`sources ${offline || (data && fresh < sources.length) ? 'is-warn' : ''}`}
            title={offline ? t('common.offline') : sourcesTitle}
            aria-label={offline ? t('common.offline') : sourcesTitle}
            role="status"
          >
            <i className={`dot dot-${offline || (data && fresh < sources.length) ? 'warn' : 'ok'}`} />
            <b>{data ? `${fresh}/${sources.length}` : '—'}</b>
          </span>
          <button type="button" className="icon-button" aria-label={t('header.devices')} title={t('header.devices')} onClick={onDevices}>
            <DevicesIcon />
          </button>
          <Settings trackers={trackers} />
          <Account user={user} onSignedOut={onSignedOut} />
        </div>
      </div>
    </header>
  );
}
