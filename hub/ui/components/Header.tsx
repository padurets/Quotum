import React, {useState} from 'react';
import type {Overview} from '../lib/types';
import {ago} from '../lib/format';
import {problemOf, sourceLabel} from '../lib/quota';
import {TimerRing} from './TimerRing';
import {GearIcon, Popover, SwitchRow} from './Popover';
import {setPrefs, usePrefs} from '../lib/prefs';
import type {TrackerHealth} from '../lib/resets';
import {clock} from '../lib/format';
import {call, messageOf, type Board, type User} from '../lib/session';
import {ErrorLine} from './Kit';

/** Dashboard-wide settings, stored in this browser. */
function Settings({trackers}: {trackers: TrackerHealth[]}) {
  const prefs = usePrefs();
  return (
    <Popover label="Настройки" icon={<GearIcon />}>
      <div className="popover-title">Настройки</div>
      <SwitchRow on={prefs.showResets} onChange={on => setPrefs({showResets: on})}>
        Уведомления о сбросах лимитов
      </SwitchRow>
      {prefs.showResets && (
        <div className="trackers">
          {trackers.map(tracker => (
            <div key={tracker.name} className="tracker" title={tracker.at ? `Проверено в ${clock(tracker.at)}` : ''}>
              <i className={`dot ${tracker.ok === true ? 'dot-ok' : tracker.ok === false ? 'dot-warn' : 'dot-idle'}`} />
              <a href={tracker.url} target="_blank" rel="noopener noreferrer">
                {tracker.name}
              </a>
              <span>{tracker.detail}</span>
            </div>
          ))}
        </div>
      )}
      <div className="popover-note">
        Внеплановые сбросы Claude и Codex по данным{' '}
        <a href="https://claude-resets.com/" target="_blank" rel="noopener noreferrer">
          claude-resets.com
        </a>{' '}
        и{' '}
        <a href="https://codex-resets.com/" target="_blank" rel="noopener noreferrer">
          Codex Resets
        </a>
        . Настройки хранятся в этом браузере.
      </div>
    </Popover>
  );
}

const OFFLINE_AFTER = 45_000;
export const SERVICE = 'Agent Limits';

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" className="logo-bg" />
      <rect x="8" y="17" width="4" height="8" rx="2" className="logo-bar a" />
      <rect x="14" y="12" width="4" height="13" rx="2" className="logo-bar b" />
      <rect x="20" y="7" width="4" height="18" rx="2" className="logo-bar c" />
    </svg>
  );
}

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
  const [error, setError] = useState<string | null>(null);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const created = await call<Board>('POST', '/api/boards', {name: name.trim()});
      setName('');
      setOpen(false);
      await onCreated();
      onSelect(created.id);
    } catch (failure) {
      setError(messageOf(failure));
    }
  };
  return (
    <Popover
      label="Доски"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <span className="board-name">
          {board?.name ?? '—'}
          <ChevronIcon />
        </span>
      }
      align="left"
    >
      <div className="popover-title">Доски</div>
      {boards.map(b => (
        <button key={b.id} className="popover-row board-row" role="menuitemradio" aria-checked={b.id === board?.id} onClick={() => (onSelect(b.id), setOpen(false))}>
          <i className={`check ${b.id === board?.id ? 'on' : ''}`} />
          <span>{b.name}</span>
          <b>{b.personal ? 'личная' : 'общая'}</b>
        </button>
      ))}
      <form className="popover-section popover-form" onSubmit={create}>
        <input placeholder="Новая общая доска" value={name} maxLength={80} onChange={e => setName(e.target.value)} aria-label="Название новой доски" />
        <button className="button" disabled={!name.trim()}>
          Создать
        </button>
      </form>
      <ErrorLine message={error} />
    </Popover>
  );
}

function Account({user, onSignedOut}: {user: User; onSignedOut: () => void}) {
  const signOut = async () => {
    await call('POST', '/api/auth/logout').catch(() => {});
    onSignedOut();
  };
  return (
    <Popover label="Аккаунт" icon={<span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>}>
      <div className="popover-title">Аккаунт</div>
      <div className="account-card">
        <b>{user.name}</b>
        <span>{user.email}</span>
      </div>
      <button className="popover-row" onClick={signOut}>
        <span>Выйти</span>
      </button>
    </Popover>
  );
}

/**
 * One compact, non-jumping strip: brand and board, how many sources are fresh, a ring
 * that fills toward the next measurement, devices, settings and account.
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
    .map(source => `${sourceLabel(source)}: ${problemOf(source) ?? `измерено ${ago(source.successAt, now)}`}`)
    .join('\n');

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="/" aria-label={SERVICE}>
          <Logo />
          <span>{SERVICE}</span>
        </a>
        <BoardSwitcher boards={boards} board={board} onSelect={onBoard} onCreated={onBoardsChanged} />
        <div className="status" data-testid="connection">
          <span className={`sources ${offline || (data && fresh < sources.length) ? 'is-warn' : ''}`} title={offline ? 'Нет связи с сервисом' : sourcesTitle}>
            <i className={`dot dot-${offline || (data && fresh < sources.length) ? 'warn' : 'ok'}`} />
            <b>{data ? `${fresh}/${sources.length}` : '—'}</b>
          </span>
          <TimerRing data={data} now={now} offline={offline} />
          <button className="icon-button" aria-label="Устройства и подключение" title="Устройства и подключение" onClick={onDevices}>
            <DevicesIcon />
          </button>
          <Settings trackers={trackers} />
          <Account user={user} onSignedOut={onSignedOut} />
        </div>
      </div>
    </header>
  );
}
