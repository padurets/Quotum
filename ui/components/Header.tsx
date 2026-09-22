import React from 'react';
import type {Overview} from '../lib/types';
import {ago} from '../lib/format';
import {problemOf, sourceLabel} from '../lib/quota';
import {TimerRing} from './TimerRing';
import {GearIcon, Popover, SwitchRow} from './Popover';
import {setPrefs, usePrefs} from '../lib/prefs';
import type {TrackerHealth} from '../lib/resets';
import {clock} from '../lib/format';

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

/**
 * One compact, non-jumping strip: brand, how many sources are fresh, and a ring that
 * fills toward the next collection. Low limits are already coloured in the cards;
 * per-source detail lives in the tooltip, not in header prose.
 */
export function Header({data, lastOk, now, trackers}: {data: Overview | null; lastOk: number; now: number; trackers: TrackerHealth[]}) {
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
        <div className="status" data-testid="connection">
          <span className={`sources ${offline || (data && fresh < sources.length) ? 'is-warn' : ''}`} title={offline ? 'Нет связи с сервисом' : sourcesTitle}>
            <i className={`dot dot-${offline || (data && fresh < sources.length) ? 'warn' : 'ok'}`} />
            <b>{data ? `${fresh}/${sources.length}` : '—'}</b>
          </span>
          <TimerRing data={data} now={now} offline={offline} />
          <Settings trackers={trackers} />
        </div>
      </div>
    </header>
  );
}

