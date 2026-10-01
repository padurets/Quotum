import type {Origin} from './ingest.js';

/**
 * A stretch of time a coding agent worked, as the hub keeps it (server/sessions.ts), cut
 * to the period asked for: its agent (`session`), subscription, machine and person, where
 * it runs, since when (on its agent's clock), and its project and folder, the project
 * named as its person corrected it.
 */
export type Stretch = {
  session: number;
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

/** A span of time, from its start up to its end. */
export type Span = {from: number; to: number};

/** The moments any of the spans covers: in time order, neither overlapping nor touching. */
export function union(spans: readonly Span[]): [number, number][] {
  const merged: [number, number][] = [];
  for (const {from, to} of [...spans].sort((a, b) => a.from - b.from)) {
    if (to <= from) continue;
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

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
export function workTime(stretches: readonly Span[]): number {
  return union(stretches).reduce((total, [from, to]) => total + to - from, 0);
}

/** How much of the span from `from` to `to` a union (see `union`) covers. */
export function overlap(worked: [number, number][], from: number, to: number): number {
  // The first interval that ends after `from`: the ones before it are sorted by end too.
  let low = 0;
  let high = worked.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (worked[middle][1] <= from) low = middle + 1;
    else high = middle;
  }
  let covered = 0;
  for (let i = low; i < worked.length && worked[i][0] < to; i++) covered += Math.min(to, worked[i][1]) - Math.max(from, worked[i][0]);
  return covered;
}

/**
 * How agents worked on a window's subscription over a period, and what the window spent
 * meanwhile, all within the part of the period that is known (`from`): `ms`, how long any
 * of them worked (null when nothing of the period is known); `consumed`, what the window
 * spent over the steps between samples that `edge` proves and that begin in the known
 * part; `agentMs`, the time of each agent added up; `coveredMs`, how long they worked
 * during those steps, which the pace per active hour is taken over (spending in a gap
 * between samples is not counted, so neither is the activity there); `duringWork`, what those of the steps that agents worked in spent: a step
 * that work touches counts whole, so it is an upper bound.
 */
export type SeriesWork = {from: number; ms: number | null; agentMs: number; consumed: number; coveredMs: number; duringWork: number};

export type Dimension = 'source' | 'project' | 'device';

/**
 * A subscription, project or machine: its agent time (each agent counts), active time
 * (overlaps counted once), distinct agents and agent time in each bar it worked in.
 * `key` is a subscription or machine id, or a project name as JSON (`null` for none).
 * `name` is null for subscriptions (the dashboard names them) and outside any project.
 */
export type ActivityGroup = {key: string; name: string | null; agentMs: number; activeMs: number; agents: number; cells: [number, number][]};

/**
 * Agents' work bar by bar: active time, agent time and distinct agents in all and in
 * each bar with work (`cells`: start, active time, agent time, agents), split by
 * subscription, project and machine. Group parts add up to each bar's agent time.
 */
export type Activity = {barMs: number; activeMs: number; agentMs: number; agents: number; cells: [number, number, number, number][]; by: Record<Dimension, ActivityGroup[]>};

/**
 * How long each bar of a period `spanMs` long drawn on cells `cellMs` long is: the
 * period's cells gathered into bars of up to an hour, the longest that keep at least
 * `MIN_BARS` of them, so a bar's height reads as the time worked in a stretch worth
 * telling (an hour of a day) rather than minutes of a five-minute cell. Cells of an hour
 * or longer are bars as they are. Every bar length here is a whole number of any shorter
 * cell (config `history.cells`), and both start at whole multiples of their length.
 */
const BAR_STEPS = [60, 30, 15, 5, 1].map(minutes => minutes * 60_000);
const MIN_BARS = 20;

export function barOf(cellMs: number, spanMs: number): number {
  if (cellMs >= BAR_STEPS[0]) return cellMs;
  return BAR_STEPS.find(bar => bar >= cellMs && bar % cellMs === 0 && spanMs / bar >= MIN_BARS) ?? cellMs;
}
