import type {Origin} from './ingest.js';
import {edge, type Sample} from './quota.js';

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
 * part; `coveredMs`, how long they worked during those steps, which the pace per hour of
 * work is taken over (spending in a gap between samples is not counted, so neither is the
 * work there); `duringWork`, what those of the steps that agents worked in spent: a step
 * that work touches counts whole, so it is an upper bound.
 */
export type SeriesWork = {from: number; ms: number | null; consumed: number; coveredMs: number; duringWork: number};

/** A window's `SeriesWork` from its samples, the union of its subscription's stretches (`union`) and the known part of the period. */
export function seriesWork(samples: Sample[], worked: [number, number][], known: Span): SeriesWork {
  if (known.to <= known.from) return {from: known.from, ms: null, consumed: 0, coveredMs: 0, duringWork: 0};
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
  return {from: known.from, ms: overlap(worked, known.from, known.to), consumed, coveredMs, duringWork};
}

/** Projects and machines beyond this many, by how long they worked, are shown together as one. */
export const ACTIVITY_GROUPS = 7;

export type Dimension = 'source' | 'project' | 'device';

/**
 * A subscription, project or machine agents worked on: how long any of its agents worked
 * (`ms`, overlaps counted once) and its part of each cell's work (only cells it has a part
 * in). `other` stands for the groups beyond the first few, `count` of them. `key` is the
 * subscription's or the machine's id, or the project's name as JSON: `null` for none,
 * which no name can be. `name` is the project's or the machine's, null for a subscription
 * (the dashboard names it) and for work outside any project.
 */
export type ActivityGroup = {key: string; name: string | null; other?: true; count?: number; ms: number; cells: [number, number][]};

/**
 * How agents worked over a period, cell by cell on its grid: how long any of them worked
 * (`workMs`) and how long all of them together did (`agentMs`, two at once counting twice),
 * in all and in each cell with work (`cells`: its start, work, agent time), and split by
 * subscription, project and machine.
 */
export type Activity = {workMs: number; agentMs: number; cells: [number, number, number][]; by: Record<Dimension, ActivityGroup[]>};

const DIMENSIONS: Dimension[] = ['source', 'project', 'device'];

/**
 * Agents' work over the known part of a period on a grid of `cellMs` (cells aligned as
 * the chart's are, `onGrid`). Each moment is split evenly among the agents working then,
 * so the parts of a cell add up to its work, whichever way it is split; each group also
 * keeps how long its own agents worked, which is more than its parts when other agents
 * worked alongside. Machines are named by `deviceNames`.
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

  // Where the number of agents working changes (`times`), how many work from there on
  // (`counts`), and how much of the time up to there one agent has, each moment split
  // evenly among those working then (`shares`). An end comes before a start at the same
  // moment: stretches that only touch never overlap.
  const starts = Float64Array.from(within, s => s.from);
  const ends = Float64Array.from(within, s => s.to).sort();
  const times: number[] = [];
  const counts: number[] = [];
  const shares: number[] = [];
  let working = 0;
  let share = 0;
  for (let s = 0, e = 0; s < starts.length || e < ends.length; ) {
    const time = s < starts.length && starts[s] < ends[e] ? starts[s] : ends[e];
    if (working) share += (time - times.at(-1)!) / working;
    while (e < ends.length && ends[e] === time) (working--, e++);
    while (s < starts.length && starts[s] === time) (working++, s++);
    times.push(time);
    counts.push(working);
    shares.push(share);
  }
  /** How much of the time up to `time` one agent working all along has. */
  const shareAt = (time: number) => {
    let low = 0;
    let high = times.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (times[middle] <= time) low = middle;
      else high = middle - 1;
    }
    return shares[low] + (counts[low] ? (time - times[low]) / counts[low] : 0);
  };

  // A stretch's part of a cell is what one agent has of the time it worked there.
  const agents = new Float64Array(cellCount);
  within.forEach((s, i) => {
    for (let cell = cellOf(s.from); cell <= cellOf(s.to - 1); cell++) {
      const from = Math.max(s.from, cellStart(cell));
      const to = Math.min(s.to, cellStart(cell + 1));
      const part = shareAt(to) - shareAt(from);
      agents[cell] += to - from;
      for (const dimension of DIMENSIONS) groups[dimension].parts[groups[dimension].of[i] * cellCount + cell] += part;
    }
  });
  const worked = union(within);
  const work = new Float64Array(cellCount);
  for (const [from, to] of worked) {
    for (let cell = cellOf(from); cell <= cellOf(to - 1); cell++) work[cell] += Math.min(to, cellStart(cell + 1)) - Math.max(from, cellStart(cell));
  }
  const cells: [number, number, number][] = [];
  for (let cell = 0; cell < cellCount; cell++) if (work[cell] > 0) cells.push([cellStart(cell), work[cell], agents[cell]]);

  const by = {} as Record<Dimension, ActivityGroup[]>;
  for (const dimension of DIMENSIONS) {
    const {keys, of, parts} = groups[dimension];
    // In time order, as `within` is: their unions need no sorting.
    const members = keys.map(() => [] as Stretch[]);
    within.forEach((s, i) => members[of[i]].push(s));
    const partsOf = (indexes: number[]) => {
      const shown: [number, number][] = [];
      for (let cell = 0; cell < cellCount; cell++) {
        const part = Math.round(indexes.reduce((sum, g) => sum + parts[g * cellCount + cell], 0));
        if (part > 0) shown.push([cellStart(cell), part]);
      }
      return shown;
    };
    const ranked = keys
      .map((key, g) => ({
        g,
        key,
        name: dimension === 'source' ? null : dimension === 'project' ? members[g][0].project : (deviceNames.get(key) ?? null),
        ms: workTime(members[g]),
      }))
      .sort((a, b) => b.ms - a.ms || compare(a.name ?? '', b.name ?? '') || compare(a.key, b.key));
    // Every subscription keeps its own row: its hours are the table's, and it has its card's colour.
    const kept = dimension === 'source' ? ranked : ranked.slice(0, ACTIVITY_GROUPS);
    const rest = ranked.slice(kept.length);
    by[dimension] = kept.map(({g, key, name, ms}): ActivityGroup => ({key, name, ms, cells: partsOf([g])}));
    if (rest.length) {
      by[dimension].push({
        key: 'other',
        name: null,
        other: true,
        count: rest.length,
        ms: workTime(rest.flatMap(r => members[r.g])),
        cells: partsOf(rest.map(r => r.g)),
      });
    }
  }
  return {workMs: worked.reduce((sum, [from, to]) => sum + to - from, 0), agentMs: within.reduce((sum, s) => sum + s.to - s.from, 0), cells, by};
}

/** The same order in any locale. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
