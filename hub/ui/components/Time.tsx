import {since, sinceChangesAt} from '../lib/agents';
import {useClock} from '../lib/clock';
import {ago, agoChangesAt, recentActivity, recentActivityChangesAt, stamp} from '../lib/format';

/*
 * Labels that show time. Each is a part of its own, woken by the page's clock
 * (lib/clock.ts) only at the moment it reads otherwise; whatever holds it never renders
 * for the time. Each has an element of its own, marked `data-time`, even when it shows
 * nothing, so what renders or changes with time is told apart from what the data changes
 * (hub/bench counts them apart).
 */

/** "5m ago". */
export function Ago({at, className}: {at: number | null; className?: string}) {
  const now = useClock(now => agoChangesAt(at, now));
  return (
    <span data-time="ago" className={className}>
      {ago(at, now)}
    </span>
  );
}

/** The last observed work, with its exact time available on hover. */
export function RecentActivity({at}: {at: number}) {
  const now = useClock(now => recentActivityChangesAt(at, now));
  return <span data-time="activity" title={stamp(at)}>{recentActivity(at, now)}</span>;
}

/** How long something has run: "31m". */
export function Since({from, className}: {from: number; className?: string}) {
  const now = useClock(now => sinceChangesAt(from, now));
  return (
    <span data-time="since" className={className}>
      {since(now - from)}
    </span>
  );
}
