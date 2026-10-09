import {earlyReset} from './attention.js';
import {cellStart, encodeCells, tileEnd, tileOf, type Chunk, type DecodedCell, type HistoryMeta} from './history.js';
import {edge} from './quota.js';
import {overlap, union, workTime, type Stretch} from './work.js';

/** A window read once through a run of missing tiles, including its preceding sample. */
export type CellSamples = {source: string; window: string; samples: {at: number; used: number; resetAt: number | null; staleAfterMs: number; validUntil?: number}[]};

/** The earliest proven incoming step needs work before the first cell too. */
export function workFrom(groups: CellSamples[], from: number): number {
  let start = from;
  for (const {samples} of groups) {
    if (samples.length > 1 && samples[0].at < from && edge(samples[0], samples[1]).valid) start = Math.min(start, samples[0].at);
  }
  return start;
}

/** One pass through samples and stretches; chunks stop at tile edges, never sample edges. */
export function cellsOf(groups: CellSamples[], stretches: Stretch[], devices: Record<string, string>, cell: number, from: number, to: number, known: HistoryMeta['known']): Chunk<number>[] {
  const chunks: Chunk<number>[] = [];
  for (let at = from; at < to;) {
    const end = Math.min(to, tileEnd(tileOf(at, cell), cell));
    chunks.push({from: at, to: end, series: [], activity: {sessions: [], devices: {}, cells: []}, resets: [], grants: []});
    at = end;
  }
  const firstTile = tileOf(from, cell);
  const chunkOf = (at: number) => chunks[tileOf(at, cell) - firstTile];
  const bySource = new Map<string, Stretch[]>();
  for (const stretch of stretches) {
    if (!bySource.has(stretch.source)) bySource.set(stretch.source, []);
    bySource.get(stretch.source)!.push(stretch);
  }
  const worked = new Map([...bySource].map(([source, spans]) => [source, union(spans)]));
  for (const group of groups) {
    const since = Math.max(known.work, known.sources[group.source] ?? Infinity);
    const values = chunks.map(() => [] as DecodedCell[]);
    let current: DecodedCell | undefined;
    for (let n = 0; n < group.samples.length; n++) {
      const b = group.samples[n];
      if (b.at < from || b.at >= to) continue;
      const a = group.samples[n - 1];
      const step = a ? edge(a, b) : null;
      const at = cellStart(b.at, cell);
      if (!current || current.at !== at) {
        const open = a && step?.reason !== 'gap' && (step?.reason !== 'reset' || (a.resetAt !== null && a.resetAt > at)) ? 100 - a.used : null;
        current = {at, low: 100 - b.used, first: 100 - b.used, last: 100 - b.used, open, gap: !!a && (b.at >= (a.validUntil ?? Infinity) || at - cellStart(a.at, cell) > Math.max(cell, a.staleAfterMs)), hold: b.staleAfterMs, spent: 0, covered: 0, work: [0, 0, 0]};
        values[tileOf(at, cell) - firstTile].push(current);
      }
      current.low = Math.min(current.low, 100 - b.used);
      current.last = 100 - b.used;
      current.hold = b.staleAfterMs;
      // Recovery cannot fill the unavailable beginning of its coarse cell, even
      // when the preceding numerical sample belongs to an earlier cell.
      const interrupted = !!a && b.at >= (a.validUntil ?? Infinity) && b.at > at;
      current.gap ||= interrupted;
      // The original TTL is inclusive; the packed bound is exclusive and cannot
      // inherit a later sample's cadence. Natural TTL gaps keep their cell semantics.
      const until = b.validUntil === undefined ? undefined : Math.min(b.validUntil,b.at+b.staleAfterMs+1);
      current.validUntil = interrupted || (current.validUntil !== undefined && current.validUntil <= at) ? at : until;
      if (a && step?.valid) {
        current.spent += step.delta;
        current.covered += b.at - a.at;
        if (a.at >= since) {
          const covered = overlap(worked.get(group.source) ?? [], a.at, b.at);
          current.work[0] += step.delta;
          current.work[1] += covered;
          if (covered > 0) current.work[2] += step.delta;
        }
      }
      if (a && b.at < (a.validUntil ?? Infinity) && earlyReset(a, b)) chunkOf(b.at).resets.push([group.source, group.window, b.at]);
    }
    values.forEach((list, i) => {if (list.length) chunks[i].series.push(encodeCells(group.source, group.window, chunks[i].from, cell, since, list));});
  }
  // Work is already selected and cut to the board's known thresholds. Its part before
  // `from` proves incoming steps but does not belong to activity in these chunks.
  const activity = new Map<number, Stretch[]>();
  for (const s of stretches) for (let at = cellStart(Math.max(s.from, from), cell); at < Math.min(s.to, to); at += cell) {
    const part = {...s, from: Math.max(s.from, at, from), to: Math.min(s.to, at + cell, to)};
    if (part.to <= part.from) continue;
    if (!activity.has(at)) activity.set(at, []);
    activity.get(at)!.push(part);
  }
  const sessionIndexes = chunks.map(() => new Map<number, number>());
  for (const [at, spans] of [...activity].sort((a, b) => a[0] - b[0])) {
    const chunk = chunkOf(at);
    const indexes = sessionIndexes[tileOf(at, cell) - firstTile];
    const sessions = new Map<number, {ms: number; s: Stretch}>();
    for (const s of spans) {
      if (!indexes.has(s.session)) {
        indexes.set(s.session, chunk.activity.sessions.length);
        chunk.activity.sessions.push([s.session, s.source, s.project, s.device]);
        chunk.activity.devices[s.device] = devices[s.device];
      }
      const session = sessions.get(s.session) ?? {ms: 0, s};
      session.ms += s.to - s.from;
      sessions.set(s.session, session);
    }
    const active = workTime(spans);
    const row: (typeof chunk.activity.cells)[number] = [(at - chunk.from) / cell, active, [...sessions].map(([id, {ms}]) => ms === active ? indexes.get(id)! : [indexes.get(id)!, ms]), []];
    const dimensions = ['s', 'p', 'd'] as const;
    for (const dim of dimensions) {
      const keyOf = (s: Stretch) => dim === 's' ? s.source : dim === 'p' ? JSON.stringify(s.project) : s.device;
      const grouped = new Map<string, Stretch[]>();
      for (const s of spans) {
        const key = keyOf(s);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(s);
      }
      for (const [key, members] of grouped) {
        const ms = workTime(members);
        const defaultMs = Math.max(...[...sessions.values()].filter(v => keyOf(v.s) === key).map(v => v.ms));
        if (ms !== defaultMs) row[3].push([dim, key, ms]);
      }
    }
    chunk.activity.cells.push(row);
  }
  return chunks;
}
