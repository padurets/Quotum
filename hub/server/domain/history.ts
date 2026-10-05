import {drain, ordered, type Preparation} from './prepare.js';
import {barOf, type Activity, type ActivityGroup, type Dimension, type SeriesWork} from './work.js';
import {composeMetersPrepared, type MeterHistory, type MeterSeriesCells} from './meterHistory.js';
import {composeReportsPrepared,type ReportHistory,type ReportSeries} from './reports.js';

/** The shared grid, from the finest cell that keeps a frame within its budget. */
export const CELLS = [1, 5, 15, 30, 60, 120, 360, 720].map(minutes => minutes * 60_000);
export const MAX_CELLS = 360;
export const TILE_CELLS = 60;
export const MAX_READ_TILES = 8;
export const CLOCK_TOLERANCE_MS = 30_000;
export const cellOf = (span: number) => CELLS.find(cell => span / cell <= MAX_CELLS * 1.05) ?? CELLS.at(-1)!;
export const READ_CELLS = CELLS.filter(cell => cell <= cellOf(31 * 86_400_000));
export const cellStart = (at: number, cell: number) => Math.floor(at / cell) * cell;
export const tileOf = (at: number, cell: number) => Math.floor(at / (cell * TILE_CELLS));
export const tileStart = (tile: number, cell: number) => tile * cell * TILE_CELLS;
export const tileEnd = (tile: number, cell: number) => tileStart(tile + 1, cell);

export type Target = {cell: number; k0: number; k1: number; length: number; live: boolean; key: string; now: number};

/** Cell edges are independent of retention; the last cell also admits fast agent clocks. */
export function targetOf(length: number, now: number, key: string, selected?: {from: number; to: number} | null): Target {
  const cell = cellOf(length);
  return {
    cell,
    k0: Math.floor((selected?.from ?? now - length) / cell),
    k1: Math.min(selected ? Math.ceil(selected.to / cell) - 1 : Infinity, Math.floor((now + CLOCK_TOLERANCE_MS) / cell)),
    length,
    live: !selected,
    key,
    now,
  };
}

export type CellExtra = {f?: number; l?: number; o?: number | null; g?: 1; h?: number; w?: [number, number, number]};
export type SeriesCell = [index: number, low: number, spent: number, covered: number, extra?: CellExtra];
export type SeriesCells = {source: string; window: string; hold: number; open: number | null; cells: SeriesCell[]};
export type SessionCell = number | [number, number];
export type GroupCell = [dimension: 's' | 'p' | 'd', key: string, activeMs: number];
export type ActivityCells<Ref = string> = {
  sessions: [ref: Ref, source: string, project: string | null, device: string][];
  devices: Record<string, string>;
  cells: [index: number, active: number, sessions: SessionCell[], groups: GroupCell[]][];
};
export type Chunk<Ref = string> = {
  from: number;
  to: number;
  series: SeriesCells[];
  meterSeries?: MeterSeriesCells[];
  reportSeries?:ReportSeries[];
  activity: ActivityCells<Ref>;
  resets: [string, string, number][];
  grants: [string, number, number][];
};
export type HistoryMeta = {now: number; historyStart: number; known: {work: number; sources: Record<string, number>}; meta?: string};
export type HistoryAnswer = HistoryMeta & {run: string; chunks: Chunk[]};
export type HistoryBasis = HistoryMeta & {run: string};
export type HistoryReply = HistoryAnswer | {now: number; run: string; meta: string; chunks: Chunk[]};

/** A compact reply can borrow only the metadata captured by its own request. */
export function expandHistory(reply: HistoryReply, prior?: HistoryBasis): HistoryAnswer {
  if ('known' in reply) return reply;
  if (!prior?.meta || reply.meta !== prior.meta || reply.run !== prior.run) throw new Error('history metadata mismatch');
  return {...reply, historyStart: prior.historyStart, known: prior.known};
}
export type SourceEvent =
  | {sourceId: string; at: number; kind: 'early_reset'; windows: string[]}
  | {sourceId: string; at: number; kind: 'resets_granted'; count: number};
export type HistorySeries = {
  sourceId: string;
  windowId: string;
  consumed: number;
  coveredMs: number;
  remainingAtStart: number | null;
  remainingAtEnd: number | null;
  staleAfterMs: number;
  points: [cellStart: number, remaining: number, segment: number][];
  work: SeriesWork | null;
};
export type History = {
  board?: string;
  range: string;
  live: boolean;
  since: number;
  to: number;
  cellMs: number;
  historyStart: number;
  series: HistorySeries[];
  meterSeries?: MeterHistory[];
  reportSeries?:ReportHistory[];
  events: SourceEvent[];
  activity: Activity & {since: number; known: {from: number; to: number} | null};
};

export type DecodedCell = {
  at: number; low: number; first: number; last: number; open: number | null; gap: boolean; hold: number;
  spent: number; covered: number; work: [number, number, number];
};
export const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const roundOpen = (value: number | null) => value === null ? null : round4(value);

/** Defaults compare at the precision the reader sees, including its rounded low. */
export function* encodeCellsPrepared(source: string, window: string, from: number, cell: number, since: number, cells: DecodedCell[]): Preparation<SeriesCells> {
  const holds = new Map<number, number>();
  for (const v of cells) {holds.set(v.hold, (holds.get(v.hold) ?? 0) + 1); yield;}
  // The most common hold keeps cadence changes from repeating an override in every cell.
  const hold = (yield* ordered(holds, (a, b) => b[1] - a[1]))[0][0];
  const open = roundOpen(cells[0].open);
  let previous = open;
  const encoded: SeriesCell[] = [];
  for (const v of cells) {
    const low = Math.round(v.low * 100) / 100;
    const spent = round4(v.spent);
    const extra: CellExtra = {};
    const start = roundOpen(v.open);
    if (start !== previous) extra.o = start;
    if (start === null && round4(v.first) !== low) extra.f = round4(v.first);
    if (round4(v.last) !== low) extra.l = round4(v.last);
    if (v.gap) extra.g = 1;
    if (v.hold !== hold) extra.h = v.hold;
    const work: [number, number, number] = [round4(v.work[0]), v.work[1], round4(v.work[2])];
    const base = v.at >= since ? spent : 0;
    if (work[0] !== base || work[1] !== 0 || work[2] !== 0) extra.w = work;
    previous = extra.l ?? low;
    const row: SeriesCell = [(v.at - from) / cell, low, spent, v.covered];
    if (Object.keys(extra).length) row.push(extra);
    encoded.push(row); yield;
  }
  return {source, window, hold, open, cells: encoded};
}

export function* decodeCellsPrepared(series: SeriesCells, from: number, cell: number, since: number): Preparation<DecodedCell[]> {
  let previous = series.open;
  const cells: DecodedCell[] = [];
  for (const [i, low, spent, covered, extra = {}] of series.cells) {
    const at = from + i * cell;
    const open = 'o' in extra ? extra.o! : previous;
    const last = extra.l ?? low;
    previous = last;
    cells.push({at, low, spent, covered, open, first: extra.f ?? low, last, gap: !!extra.g, hold: extra.h ?? series.hold, work: extra.w ?? [at >= since ? spent : 0, 0, 0]}); yield;
  }
  return cells;
}

const DIMENSIONS: Dimension[] = ['source', 'project', 'device'];
const dimensionOf = {s: 'source', p: 'project', d: 'device'} as const;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
type Group = {key: string; name: string | null; activeMs: number; agentMs: number; refs: Set<string>; bars: Map<number, number>};

/** Reset markers use the earliest time and stable window order, including filled tile heads. */
export function* resetEventsPrepared(chunks: readonly Chunk[], windows: ReadonlySet<string>, from: number, to: number): Preparation<(SourceEvent & {kind: 'early_reset'})[]> {
  const events: (SourceEvent & {kind: 'early_reset'})[] = [];
  const matching: Chunk['resets'] = [];
  for (const chunk of chunks) for (const row of chunk.resets) {if (windows.has(`${row[0]} ${row[1]}`) && row[2] >= from && row[2] < to) matching.push(row); yield;}
  const found = yield* ordered(matching, (a, b) => a[2] - b[2]);
  for (const [sourceId, window, at] of found) {
    let same: (SourceEvent & {kind: 'early_reset'}) | undefined;
    for (const event of events) {yield; if (event.sourceId === sourceId && at - event.at <= 15 * 60_000) {same = event; break;}}
    if (same) {if (!same.windows.includes(window)) same.windows.push(window);}
    else events.push({sourceId, at, kind: 'early_reset', windows: [window]});
  }
  for (const event of events) event.windows = yield* ordered(event.windows, compare);
  return events;
}

/** A frame is an additive record of whole cells; only session identity needs a set. */
export function* composePrepared(chunks: readonly Chunk[], meta: HistoryMeta, target: Target, windows: ReadonlySet<string>): Preparation<History> {
  const {cell, k0, k1} = target;
  const since = k0 * cell;
  const to = Math.min((k1 + 1) * cell, Math.max(target.now, meta.now));
  const inFrame = (at: number) => at >= since && at < (k1 + 1) * cell;
  const S = (source: string) => Math.max(meta.known.work, meta.known.sources[source] ?? Infinity);
  const chunksInOrder = yield* ordered(chunks, (a, b) => a.from - b.from);
  const barMs = barOf(cell, target.length);
  const bars = new Map<number, {active: number; agent: number; refs: Set<string>}>();
  const by: Record<Dimension, Map<string, Group>> = {source: new Map(), project: new Map(), device: new Map()};
  const refs = new Set<string>();
  let activeMs = 0;
  let agentMs = 0;
  for (const chunk of chunksInOrder) {
    for (const [i, active, members, overrides] of chunk.activity.cells) {
      const at = chunk.from + i * cell;
      if (!inFrame(at)) continue;
      const bar = cellStart(at, barMs);
      if (!bars.has(bar)) bars.set(bar, {active: 0, agent: 0, refs: new Set()});
      const total = bars.get(bar)!;
      total.active += active;
      activeMs += active;
      const parts: Record<Dimension, Map<string, {ms: number; max: number; name: string | null; refs: string[]}>> = {source: new Map(), project: new Map(), device: new Map()};
      for (const member of members) {
        yield;
        const [n, ms] = typeof member === 'number' ? [member, active] : member;
        const [ref, source, project, device] = chunk.activity.sessions[n];
        refs.add(ref);
        total.refs.add(ref);
        total.agent += ms;
        agentMs += ms;
        const keys = {source, project: JSON.stringify(project), device};
        const names = {source: null, project, device: chunk.activity.devices[device] ?? null};
        for (const dim of DIMENSIONS) {
          yield;
          const key = keys[dim];
          const part = parts[dim].get(key) ?? {ms: 0, max: 0, name: names[dim], refs: []};
          part.ms += ms;
          part.max = Math.max(part.max, ms);
          part.refs.push(ref);
          parts[dim].set(key, part);
        }
      }
      const values: Record<Dimension, Map<string, number>> = {source: new Map(), project: new Map(), device: new Map()};
      for (const [dim, key, ms] of overrides) {values[dimensionOf[dim]].set(key, ms); yield;}
      for (const dim of DIMENSIONS) for (const [key, part] of parts[dim]) {
        yield;
        const group = by[dim].get(key) ?? {key, name: part.name, activeMs: 0, agentMs: 0, refs: new Set(), bars: new Map()};
        group.name = part.name;
        group.activeMs += values[dim].get(key) ?? part.max;
        group.agentMs += part.ms;
        for (const ref of part.refs) {group.refs.add(ref); yield;}
        group.bars.set(bar, (group.bars.get(bar) ?? 0) + part.ms);
        by[dim].set(key, group);
      }
    }
  }
  const holes: [number, number][] = [];
  let readTo = chunksInOrder[0]?.to ?? 0;
  for (const chunk of chunksInOrder.slice(1)) {
    if (chunk.from > readTo) holes.push([readTo, chunk.from]);
    readTo = Math.max(readTo, chunk.to);
  }
  const series = new Map<string, {line: HistorySeries; last: number; segment: number}>();
  for (const chunk of chunksInOrder) for (const values of chunk.series) {
    const key = `${values.source} ${values.window}`;
    if (!windows.has(key)) continue;
    let row = series.get(key);
    for (const v of yield* decodeCellsPrepared(values, chunk.from, cell, S(values.source))) {
      yield;
      if (!inFrame(v.at)) continue;
      if (!row) {
        const from = Math.max(since, S(values.source));
        const work: SeriesWork | null = values.source in meta.known.sources ? {from, ms: from >= to ? null : by.source.get(values.source)?.activeMs ?? 0, agentMs: 0, consumed: 0, coveredMs: 0, duringWork: 0} : null;
        if (work && from < to) work.agentMs = by.source.get(values.source)?.agentMs ?? 0;
        row = {line: {sourceId: values.source, windowId: values.window, consumed: 0, coveredMs: 0, remainingAtStart: v.open ?? v.first, remainingAtEnd: null, staleAfterMs: v.hold, points: [], work}, last: v.at, segment: 1};
        series.set(key, row);
      } else if (v.gap || holes.some(([a, b]) => a > row!.last && b <= v.at)) row.segment++;
      row.last = v.at;
      const line = row.line;
      line.points.push([v.at, v.low, row.segment]);
      line.consumed += v.spent;
      line.coveredMs += v.covered;
      line.remainingAtEnd = v.last;
      line.staleAfterMs = v.hold;
      if (line.work && line.work.ms !== null) {
        line.work.consumed += v.work[0];
        line.work.coveredMs += v.work[1];
        line.work.duringWork += v.work[2];
      }
    }
  }
  const resets = yield* resetEventsPrepared(chunksInOrder, windows, since, (k1 + 1) * cell);
  const grants: SourceEvent[] = [];
  for (const chunk of chunksInOrder) for (const [sourceId, at, count] of chunk.grants) {if (inFrame(at)) grants.push({sourceId, at, kind: 'resets_granted', count}); yield;}
  const activitySince = Math.max(meta.known.work, ...(Object.keys(meta.known.sources).length ? [Math.min(...Object.values(meta.known.sources))] : []));
  const knownFrom = Math.max(since, activitySince);
  const groups = {} as Record<Dimension, ActivityGroup[]>;
  for (const dim of DIMENSIONS) {
    groups[dim] = [];
    for (const g of yield* ordered(by[dim].values(), (a, b) => b.agentMs - a.agentMs || b.activeMs - a.activeMs || compare(a.name ?? '', b.name ?? '') || compare(a.key, b.key))) {
      groups[dim].push({key: g.key, name: g.name, activeMs: g.activeMs, agentMs: g.agentMs, agents: g.refs.size, cells: yield* ordered(g.bars, (a, b) => a[0] - b[0])}); yield;
    }
  }
  const lines: HistorySeries[] = [];
  for (const row of series.values()) {lines.push(row.line); yield;}
  const activityCells: Activity['cells'] = [];
  for (const [at, b] of yield* ordered(bars, (a, b) => a[0] - b[0])) {activityCells.push([at, b.active, b.agent, b.refs.size]); yield;}
  return {
    range: target.key, live: target.live, since, to, cellMs: cell, historyStart: meta.historyStart,
    ...(chunksInOrder.some(c => c.meterSeries !== undefined) ? {meterSeries: yield* composeMetersPrepared(chunksInOrder,cell,since,to)} : {}),
    ...(chunksInOrder.some(c=>c.reportSeries!==undefined)?{reportSeries:yield* composeReportsPrepared(chunksInOrder,since,to)}:{}),
    series: yield* ordered(lines, (a, b) => compare(a.sourceId, b.sourceId) || compare(a.windowId, b.windowId)),
    events: yield* ordered([...resets, ...grants], (a, b) => a.at - b.at),
    activity: {since: activitySince, known: knownFrom < to ? {from: knownFrom, to} : null, barMs, activeMs, agentMs, agents: refs.size, cells: activityCells, by: groups},
  };
}

export function encodeCells(...args: Parameters<typeof encodeCellsPrepared>): SeriesCells {return drain(encodeCellsPrepared(...args));}
export function decodeCells(...args: Parameters<typeof decodeCellsPrepared>): DecodedCell[] {return drain(decodeCellsPrepared(...args));}
export function resetEvents(...args: Parameters<typeof resetEventsPrepared>): (SourceEvent & {kind: 'early_reset'})[] {return drain(resetEventsPrepared(...args));}
export function compose(...args: Parameters<typeof composePrepared>): History {return drain(composePrepared(...args));}
