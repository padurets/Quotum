import type {Origin} from './ingest.js';
import {edge, type Sample} from './quota.js';

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

/** A subscription's active spans and agent time, cut to its known part of the period. */
export function subscriptionWork(stretches: readonly Span[], known: Span): {worked: [number, number][]; agentMs: number} {
  const within = stretches.map(s => ({from: Math.max(s.from, known.from), to: Math.min(s.to, known.to)})).filter(s => s.to > s.from);
  return {worked: union(within), agentMs: within.reduce((sum, s) => sum + s.to - s.from, 0)};
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

/** A window's work from its samples, the subscription's active spans and agent time, and the known period. */
export function seriesWork(samples: Sample[], worked: [number, number][], agentMs: number, known: Span): SeriesWork {
  if (known.to <= known.from) return {from: known.from, ms: null, agentMs: 0, consumed: 0, coveredMs: 0, duringWork: 0};
  let consumed = 0;
  let coveredMs = 0;
  let duringWork = 0;
  for (let i = 1; i < samples.length; i++) {
    const [a, b] = [samples[i - 1], samples[i]];
    // A step that begins before the known part is not counted whole or in part: whether agents worked in it is not known.
    if (a.at < known.from) continue;
    const step = edge(a, b);
    if (!step.valid) continue;
    const covered = overlap(worked, a.at, b.at);
    consumed += step.delta;
    coveredMs += covered;
    if (covered > 0) duringWork += step.delta;
  }
  return {from: known.from, ms: overlap(worked, known.from, known.to), agentMs, consumed, coveredMs, duringWork};
}

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

const DIMENSIONS: Dimension[] = ['source', 'project', 'device'];

/**
 * Agent-hours over the known period, in aligned bars: every stretch counts separately.
 * Active time is the union; machines are named by `deviceNames`.
 */
export function activity(stretches: Stretch[], known: Span, cellMs: number, deviceNames: Map<string, string>): Activity {
  const within = stretches
    .filter(s => s.to > known.from && s.from < known.to)
    .map(s => (s.from >= known.from && s.to <= known.to ? s : {...s, from: Math.max(s.from, known.from), to: Math.min(s.to, known.to)}))
    .sort((a, b) => a.from - b.from);
  const first = Math.floor(known.from / cellMs) * cellMs;
  const cellCount = within.length ? Math.floor((known.to - 1) / cellMs) - first / cellMs + 1 : 0;
  const cellOf = (time: number) => Math.floor((time - first) / cellMs);
  const cellStart = (cell: number) => first + cell * cellMs;

  // Each stretch's group in each dimension, by index.
  const projectKeys = new Map<string | null, string>();
  const keyOf: Record<Dimension, (s: Stretch) => string> = {
    source: s => s.source,
    project: s => projectKeys.get(s.project) ?? projectKeys.set(s.project, JSON.stringify(s.project)).get(s.project)!,
    device: s => s.device,
  };
  const groups = {} as Record<Dimension, {keys: string[]; of: Int32Array; parts: Float64Array}>;
  for (const dimension of DIMENSIONS) {
    const index = new Map<string, number>();
    const of = new Int32Array(within.length);
    within.forEach((s, i) => {
      const key = keyOf[dimension](s);
      if (!index.has(key)) index.set(key, index.size);
      of[i] = index.get(key)!;
    });
    groups[dimension] = {keys: [...index.keys()], of, parts: new Float64Array(index.size * cellCount)};
  }

  // Each agent counts once in a bar however many of its stretches lie there: its
  // stretches never overlap, so in time order they reach its bars in order.
  const agentTime = new Float64Array(cellCount);
  const agents = new Uint32Array(cellCount);
  const counted = new Map<number, number>();
  within.forEach((s, i) => {
    for (let cell = cellOf(s.from); cell <= cellOf(s.to - 1); cell++) {
      const from = Math.max(s.from, cellStart(cell));
      const to = Math.min(s.to, cellStart(cell + 1));
      agentTime[cell] += to - from;
      if ((counted.get(s.session) ?? -1) < cell) (counted.set(s.session, cell), agents[cell]++);
      for (const dimension of DIMENSIONS) groups[dimension].parts[groups[dimension].of[i] * cellCount + cell] += to - from;
    }
  });
  const worked = union(within);
  const work = new Float64Array(cellCount);
  for (const [from, to] of worked) {
    for (let cell = cellOf(from); cell <= cellOf(to - 1); cell++) work[cell] += Math.min(to, cellStart(cell + 1)) - Math.max(from, cellStart(cell));
  }
  const cells: [number, number, number, number][] = [];
  for (let cell = 0; cell < cellCount; cell++) if (work[cell] > 0) cells.push([cellStart(cell), work[cell], agentTime[cell], agents[cell]]);

  const by = {} as Record<Dimension, ActivityGroup[]>;
  for (const dimension of DIMENSIONS) {
    const {keys, of, parts} = groups[dimension];
    // In time order, as `within` is: their unions need no sorting.
    const members = keys.map(() => [] as Stretch[]);
    within.forEach((s, i) => members[of[i]].push(s));
    const partsOf = (g: number) => {
      const shown: [number, number][] = [];
      for (let cell = 0; cell < cellCount; cell++) {
        const part = parts[g * cellCount + cell];
        if (part > 0) shown.push([cellStart(cell), part]);
      }
      return shown;
    };
    // Every group keeps its own row, however small: a project worked on for minutes is
    // named in the tooltip and switched off and on in the legend as a big one is.
    by[dimension] = keys
      .map((key, g) => ({
        g,
        key,
        name: dimension === 'source' ? null : dimension === 'project' ? members[g][0].project : (deviceNames.get(key) ?? null),
        agentMs: members[g].reduce((sum, s) => sum + s.to - s.from, 0),
        activeMs: workTime(members[g]),
        agents: new Set(members[g].map(s => s.session)).size,
      }))
      .sort((a, b) => b.agentMs - a.agentMs || b.activeMs - a.activeMs || compare(a.name ?? '', b.name ?? '') || compare(a.key, b.key))
      .map(({g, ...group}): ActivityGroup => ({...group, cells: partsOf(g)}));
  }
  return {
    barMs: cellMs,
    activeMs: worked.reduce((sum, [from, to]) => sum + to - from, 0),
    agentMs: within.reduce((sum, s) => sum + s.to - s.from, 0),
    agents: counted.size,
    cells,
    by,
  };
}

/** The same order in any locale. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
