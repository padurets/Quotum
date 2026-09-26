import {useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import type {LiveSession} from '../lib/types';
import {DRAWN} from '../lib/agents';
import {Agents} from './Agents';

/** Whether a tray, as it is laid out now, has room for its agents' marks. */
function hasRoom(tray: HTMLElement) {
  const marks = tray.querySelector<HTMLElement>('.agents-marks');
  if (!marks) return true;
  const style = getComputedStyle(tray);
  const room = tray.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const items = [...tray.children];
  let need = (items.length - 1) * (parseFloat(style.columnGap) || 0);
  for (const item of items) need += item.getBoundingClientRect().width;
  // Marks that are out still have their width: what they would take back is compared, never
  // what the tray shows, so leaving never makes room for coming back.
  if (marks.classList.contains('is-out')) need += marks.getBoundingClientRect().width + (parseFloat(getComputedStyle(marks.parentElement!).columnGap) || 0);
  return need <= room + 0.5;
}

/**
 * The card's tray, always there so the card never changes height: news on the left (a
 * reset announced, possible or just done), what the card has now on the right (free
 * resets, then the agents running on it). Nothing in it shrinks or wraps; when there is no
 * room, the agents' marks go, all at once, and their count stays. That is settled again
 * when anything in the tray changes size (the window, a font, the language, a mark's text)
 * or the agents change, not as time passes.
 */
export function Tray({news, current, sessions, now}: {news: ReactNode; current: ReactNode; sessions: LiveSession[]; now: number}) {
  const tray = useRef<HTMLElement>(null);
  const [roomy, setRoomy] = useState(true);
  // What adds or removes something to watch; a change of size within is caught by the observer.
  const layout = `${!!news}/${!!current}/${Math.min(sessions.length, DRAWN + 1)}`;

  useLayoutEffect(() => {
    const element = tray.current;
    if (!element) return;
    const settle = () => setRoomy(hasRoom(element));
    settle();
    const observer = new ResizeObserver(settle);
    observer.observe(element);
    for (const item of element.querySelectorAll('.picker, .agents-marks')) observer.observe(item);
    return () => observer.disconnect();
  }, [layout]);

  return (
    <footer className="card-foot" ref={tray}>
      {news && <div className="tray-news">{news}</div>}
      {current}
      <Agents sessions={sessions} now={now} roomy={roomy} />
    </footer>
  );
}
