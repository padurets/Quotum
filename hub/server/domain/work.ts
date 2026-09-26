import type {Origin} from './ingest.js';

/**
 * A stretch of time a coding agent worked, as the hub keeps it (server/sessions.ts), cut
 * to the period asked for: its subscription, machine and person, where it runs, since when
 * (on its agent's clock), and its project and folder, the project named as its person
 * corrected it.
 */
export type Stretch = {
  source: string;
  device: string;
  user: string;
  origin: Origin;
  project: string | null;
  folder: string | null;
  startedAt: number;
  from: number;
  to: number;
};

/** Agent time by group: the stretches' lengths added up, so two agents at once count twice. */
export function agentTime(stretches: Stretch[], group: (stretch: Stretch) => string): Map<string, number> {
  const time = new Map<string, number>();
  for (const stretch of stretches) {
    const key = group(stretch);
    time.set(key, (time.get(key) ?? 0) + stretch.to - stretch.from);
  }
  return time;
}

/** How long any of the stretches ran: their union, overlaps counted once. */
export function workTime(stretches: Stretch[]): number {
  let total = 0;
  let end = -Infinity;
  for (const {from, to} of [...stretches].sort((a, b) => a.from - b.from)) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}
