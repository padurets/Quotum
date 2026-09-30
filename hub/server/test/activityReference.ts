import {union, workTime, type Dimension, type Activity, type ActivityGroup, type Span, type Stretch} from '../domain/work.js';

/** Direct computation from stretches, independent of the cell wire representation. */
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
