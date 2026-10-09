import {cellStart, resetEventsPrepared, type Chunk, type HistoryMeta, type SourceEvent, type SeriesCells, type Target} from '../../server/domain/history';
import {barOf} from '../../server/domain/work';
import type {ActivityDimension} from './types';
import type {PlotBlock, PlotSeries} from './lines';

import {drain, type Preparation} from './prepare';
import {ordered} from '../../server/domain/prepare';

// Weak keys release decoded rows with the store's bounded current/replacing strip.
const decoded = new WeakMap<SeriesCells, {from: number; cell: number; full: PlotBlock; cuts: Map<string, PlotBlock>}>();
const linePoints = new WeakMap<PlotBlock, Map<number, PlotSeries['points']>>();
function* pointsOf(block: PlotBlock, offset: number): Preparation<PlotSeries['points']> {
  let offsets = linePoints.get(block);
  if (!offsets) {offsets = new Map(); linePoints.set(block, offsets);}
  let points = offsets.get(offset);
  if (!points) {
    points = [];
    for (const [at, low, segment, , validUntil] of block.points) {points.push(validUntil === undefined ? [at, low, segment + offset] : [at, low, segment + offset, validUntil]); yield;}
    offsets.set(offset, points);
    if (offsets.size > 2) offsets.delete(offsets.keys().next().value!);
  }
  return points;
}
function* blockOf(values: SeriesCells, chunk: Chunk, cell: number, from: number, to: number): Preparation<PlotBlock> {
  let saved = decoded.get(values);
  if (!saved || saved.from !== chunk.from || saved.cell !== cell) {
    let segment = 1;
    const points: PlotBlock['points'][number][] = [];
    for (let index = 0; index < values.cells.length; index++) {
      const [i, low, , , extra] = values.cells[index];
      if (index && extra?.g) segment++;
      const at = chunk.from + i * cell, hold = extra?.h ?? values.hold;
      points.push(extra?.u === undefined ? [at, low, segment, hold] : [at, low, segment, hold, extra.u]); yield;
    }
    saved = {from: chunk.from, cell, full: {from: chunk.from, to: chunk.to, gap: !!values.cells[0]?.[4]?.g, points}, cuts: new Map()};
    decoded.set(values, saved);
  }
  if (from <= chunk.from && to >= chunk.to) return saved.full;
  const key = `${from}:${to}`;
  let cut = saved.cuts.get(key);
  if (!cut) {
    const points: PlotBlock['points'][number][] = [];
    for (const point of saved.full.points) {if (point[0] >= from && point[0] < to) points.push(point); yield;}
    cut = {...saved.full, from: Math.max(chunk.from, from), to: Math.min(chunk.to, to), points};
    saved.cuts.set(key, cut);
    if (saved.cuts.size > 2) saved.cuts.delete(saved.cuts.keys().next().value!);
  }
  return cut;
}

export type Coverage = readonly (readonly [number, number])[];
export type PlotGroup = {key: string; name: string | null; cells: [number, number][]};
export type PlotBar = {at: number; activeMs: number; agentMs: number; refs: ReadonlySet<string>; parts: Record<ActivityDimension, Map<string, {ms: number; name: string | null}>>};
export type PlotBuffer = {
  token: number; epoch: number; version: number;
  from: number; to: number; cell: number; length: number;
  coverage: Coverage;
  series: PlotSeries[];
  /** Money keeps drawing data separate from the visible period used for spending. */
  meterChunks?: readonly Chunk[];
  meterFrame?: {from:number;to:number};
  events: SourceEvent[];
  /** Decoded cells are held only for this bounded strip, for exact edge replacements. */
  activityCells: Map<number, PlotBar>;
  barMs: number;
  knownFrom: number;
};

const activityDecoded = new WeakMap<Chunk['activity'], {from: number; cell: number; rows: Map<number, PlotBar>}>();
function* activityOf(chunk: Chunk, cell: number): Preparation<Map<number, PlotBar>> {
  const activity = chunk.activity;
  const saved = activityDecoded.get(activity);
  if (saved && saved.from === chunk.from && saved.cell === cell) return saved.rows;
  const sessions: {ref: string; keys: Record<ActivityDimension, string>; names: Record<ActivityDimension, string | null>}[] = [];
  for (const [ref, source, project, device] of activity.sessions) {
    sessions.push({ref, keys: {source: source ?? 'unknown', project: JSON.stringify(project), device}, names: {source: null, project, device: activity.devices[device] ?? null}}); yield;
  }
  const rows = new Map<number, PlotBar>();
  for (const [i, active, members] of activity.cells) {
    const at = chunk.from + i * cell;
    const refs = new Set<string>();
    let agentMs = 0;
    const parts: PlotBar['parts'] = {source: new Map(), project: new Map(), device: new Map()};
    for (const member of members) {
      const [index, ms] = typeof member === 'number' ? [member, active] : member;
      const {ref, keys, names} = sessions[index];
      refs.add(ref); agentMs += ms;
      for (const by of ['source', 'project', 'device'] as const) {
        const old = parts[by].get(keys[by]);
        parts[by].set(keys[by], {ms: (old?.ms ?? 0) + ms, name: names[by]}); yield;
      }
    }
    rows.set(at, {at, activeMs: active, agentMs, refs, parts}); yield;
  }
  activityDecoded.set(activity, {from: chunk.from, cell, rows});
  return rows;
}

export function covered(coverage: Coverage, from: number, to: number): boolean {
  for (const [a, b] of coverage) {
    if (a > from) return false;
    if (b > from) from = b;
    if (from >= to) return true;
  }
  return from >= to;
}

/** Decodes plot data without computing frame totals, ranks or sets for every dimension. */
export function* plotPrepared(chunks: readonly Chunk[], meta: HistoryMeta, target: Target, coverage: Coverage, windows: ReadonlySet<string>, token: number, epoch: number, version: number): Preparation<PlotBuffer> {
  const from = target.k0 * target.cell, to = (target.k1 + 1) * target.cell;
  const series = new Map<string, {line: PlotSeries; parts: PlotSeries['points'][]; last: number; lastUntil?: number; segment: number}>();
  const activityCells = new Map<number, PlotBar>();
  const events: SourceEvent[] = yield* resetEventsPrepared(chunks, windows, from, to);
  for (const chunk of chunks) {
    for (const values of chunk.series) {
      const key = `${values.source} ${values.window}`;
      if (!windows.has(key)) continue;
      let row = series.get(key);
      const block = yield* blockOf(values, chunk, target.cell, from, to);
      const first = block.points[0];
      if (!first) continue;
      const join = !!row && !block.gap && first[0] < (row.lastUntil ?? Infinity) && covered(coverage, row.last, first[0] + target.cell);
      if (!row) {row = {line: {sourceId: values.source, windowId: values.window, points: [], staleAfterMs: first[3], blocks: []}, parts: [], last: first[0], segment: 1}; series.set(key, row);}
      else if (!join) row.segment++;
      row.line.blocks!.push({block, join});
      const offset = row.segment - first[2];
      row.parts.push(yield* pointsOf(block, offset));
      const last = block.points.at(-1)!;
      row.line.staleAfterMs = last[3];
      row.last = last[0];
      row.lastUntil = last[4];
      row.segment = last[2] + offset;
    }
    for (const [at, row] of yield* activityOf(chunk, target.cell)) {
      if (at < from || at >= to) continue;
      activityCells.set(at, row); yield;
    }
    for (const [sourceId, at, count] of chunk.grants) {if (at >= from && at < to) events.push({sourceId, at, kind: 'resets_granted', count}); yield;}
  }
  const lines: PlotSeries[] = [];
  for (const row of series.values()) {
    const points: PlotSeries['points'] = [];
    for (const part of row.parts) for (const point of part) {points.push(point); yield;}
    lines.push({...row.line, points});
  }
  return {token, epoch, version, from, to, cell: target.cell, length: target.length, coverage, series: lines,
    ...(chunks.some(c=>c.meterSeries!==undefined)?{meterChunks:chunks}:{}),
    events: yield* ordered(events, (a, b) => a.at - b.at), activityCells, barMs: barOf(target.cell, target.length), knownFrom: Math.max(meta.known.work, ...(Object.keys(meta.known.sources).length ? [Math.min(...Object.values(meta.known.sources))] : []))};
}

/** A bar is all of its contributing whole cells, or unknown; never a partial stack. */
export function plotBar(buffer: PlotBuffer, at: number, target: Pick<Target, 'k0' | 'k1'>, by: ActivityDimension): {groups: Map<string, {ms: number; name: string | null}>; agentMs: number; activeMs: number; agents: number} | null {
  const from = Math.max(at, target.k0 * buffer.cell);
  const to = Math.min(at + buffer.barMs, (target.k1 + 1) * buffer.cell);
  if (from >= to || !covered(buffer.coverage, from, to)) return null;
  const groups = new Map<string, {ms: number; name: string | null}>();
  let agentMs = 0;
  let activeMs = 0;
  const refs = new Set<string>();
  for (let cell = from; cell < to; cell += buffer.cell) {
    const row = buffer.activityCells.get(cell);
    if (!row) continue;
    agentMs += row.agentMs;
    activeMs += row.activeMs;
    for (const ref of row.refs) refs.add(ref);
    for (const [key, part] of row.parts[by]) groups.set(key, {ms: (groups.get(key)?.ms ?? 0) + part.ms, name: part.name});
  }
  return {groups, agentMs, activeMs, agents: refs.size};
}

export function* plotGroupsPrepared(buffer: PlotBuffer, target: Pick<Target, 'k0' | 'k1'>, by: ActivityDimension): Preparation<PlotGroup[]> {
  const groups = new Map<string, PlotGroup>();
  const from = cellStart(target.k0 * buffer.cell, buffer.barMs), to = (target.k1 + 1) * buffer.cell;
  for (let at = from; at < to; at += buffer.barMs) {
    const a = Math.max(at, target.k0 * buffer.cell), b = Math.min(at + buffer.barMs, to);
    if (a >= b || !covered(buffer.coverage, a, b)) continue;
    // The strip needs group heights, not a set of every agent in each bar.
    // Detailed metrics are computed only for an edge or a readout by plotBar.
    for (let cell = a; cell < b; cell += buffer.cell) {
      const row = buffer.activityCells.get(cell);
      if (!row) continue;
      for (const [key, part] of row.parts[by]) {
        yield;
        let group = groups.get(key);
        if (!group) {group = {key, name: part.name, cells: []}; groups.set(key, group);}
        const last = group.cells.at(-1);
        if (last?.[0] === at) last[1] += part.ms;
        else group.cells.push([at, 0 + part.ms]);
        if (group.cells.length === 1) group.name = part.name;
      }
    }
  }
  return [...groups.values()];
}

export function plotOf(...args: Parameters<typeof plotPrepared>): PlotBuffer {return drain(plotPrepared(...args));}
export function plotGroups(...args: Parameters<typeof plotGroupsPrepared>): PlotGroup[] {return drain(plotGroupsPrepared(...args));}
