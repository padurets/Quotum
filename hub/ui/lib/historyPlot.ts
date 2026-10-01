import {cellStart, type Chunk, type HistoryMeta, type SourceEvent, type SeriesCells, type Target} from '../../server/domain/history';
import {barOf} from '../../server/domain/work';
import type {ActivityDimension} from './types';
import type {PlotBlock, PlotSeries} from './lines';

// Weak keys release decoded rows with the store's bounded current/replacing strip.
const decoded = new WeakMap<SeriesCells, {from: number; cell: number; full: PlotBlock; cuts: Map<string, PlotBlock>}>();
function blockOf(values: SeriesCells, chunk: Chunk, cell: number, from: number, to: number): PlotBlock {
  let saved = decoded.get(values);
  if (!saved || saved.from !== chunk.from || saved.cell !== cell) {
    let segment = 1;
    const points = values.cells.map(([i, low, , , extra], index): [number, number, number, number] => {
      if (index && extra?.g) segment++;
      return [chunk.from + i * cell, low, segment, extra?.h ?? values.hold];
    });
    saved = {from: chunk.from, cell, full: {from: chunk.from, to: chunk.to, gap: !!values.cells[0]?.[4]?.g, points}, cuts: new Map()};
    decoded.set(values, saved);
  }
  if (from <= chunk.from && to >= chunk.to) return saved.full;
  const key = `${from}:${to}`;
  let cut = saved.cuts.get(key);
  if (!cut) {
    cut = {...saved.full, from: Math.max(chunk.from, from), to: Math.min(chunk.to, to), points: saved.full.points.filter(([at]) => at >= from && at < to)};
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
  events: SourceEvent[];
  /** Decoded cells are held only for this bounded strip, for exact edge replacements. */
  activityCells: Map<number, PlotBar>;
  barMs: number;
  knownFrom: number;
};

export function covered(coverage: Coverage, from: number, to: number): boolean {
  for (const [a, b] of coverage) {
    if (a > from) return false;
    if (b > from) from = b;
    if (from >= to) return true;
  }
  return from >= to;
}

/** Decodes plot data without computing frame totals, ranks or sets for every dimension. */
export function plotOf(chunks: readonly Chunk[], meta: HistoryMeta, target: Target, coverage: Coverage, windows: ReadonlySet<string>, token: number, epoch: number, version: number): PlotBuffer {
  const from = target.k0 * target.cell, to = (target.k1 + 1) * target.cell;
  const series = new Map<string, {line: PlotSeries; last: number; segment: number}>();
  const activityCells = new Map<number, PlotBar>();
  const events: SourceEvent[] = [];
  for (const chunk of chunks) {
    for (const values of chunk.series) {
      const key = `${values.source} ${values.window}`;
      if (!windows.has(key)) continue;
      let row = series.get(key);
      const block = blockOf(values, chunk, target.cell, from, to);
      const first = block.points[0];
      if (!first) continue;
      const join = !!row && !block.gap && covered(coverage, row.last, first[0] + target.cell);
      if (!row) {row = {line: {sourceId: values.source, windowId: values.window, points: [], staleAfterMs: first[3], blocks: []}, last: first[0], segment: 1}; series.set(key, row);}
      else if (!join) row.segment++;
      row.line.blocks!.push({block, join});
      const offset = row.segment - first[2];
      for (const [at, low, segment, hold] of block.points) {
        row.line.points.push([at, low, segment + offset]);
        row.line.staleAfterMs = hold;
        row.last = at;
        row.segment = segment + offset;
      }
    }
    for (const [i, active, members] of chunk.activity.cells) {
      const at = chunk.from + i * target.cell;
      if (at < from || at >= to) continue;
      const parts: PlotBar['parts'] = {source: new Map(), project: new Map(), device: new Map()};
      const refs = new Set<string>();
      let agentMs = 0;
      for (const member of members) {
        const [index, ms] = typeof member === 'number' ? [member, active] : member;
        const [ref, source, project, device] = chunk.activity.sessions[index];
        refs.add(ref); agentMs += ms;
        const keys = {source, project: JSON.stringify(project), device};
        const names = {source: null, project, device: chunk.activity.devices[device] ?? null};
        for (const by of ['source', 'project', 'device'] as const) {
          const old = parts[by].get(keys[by]);
          parts[by].set(keys[by], {ms: (old?.ms ?? 0) + ms, name: names[by]});
        }
      }
      activityCells.set(at, {at, activeMs: active, agentMs, refs, parts});
    }
    for (const [sourceId, window, at] of chunk.resets) {
      if (at < from || at >= to || !windows.has(`${sourceId} ${window}`)) continue;
      const previous = events.find(e => e.kind === 'early_reset' && e.sourceId === sourceId && Math.abs(e.at - at) <= 15 * 60_000);
      if (previous?.kind === 'early_reset') {if (!previous.windows.includes(window)) previous.windows.push(window);}
      else events.push({sourceId, at, kind: 'early_reset', windows: [window]});
    }
    for (const [sourceId, at, count] of chunk.grants) if (at >= from && at < to) events.push({sourceId, at, kind: 'resets_granted', count});
  }
  return {token, epoch, version, from, to, cell: target.cell, length: target.length, coverage, series: [...series.values()].map(r => r.line), events: events.sort((a, b) => a.at - b.at), activityCells, barMs: barOf(target.cell, target.length), knownFrom: Math.max(meta.known.work, ...(Object.keys(meta.known.sources).length ? [Math.min(...Object.values(meta.known.sources))] : []))};
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

export function plotGroups(buffer: PlotBuffer, target: Pick<Target, 'k0' | 'k1'>, by: ActivityDimension): PlotGroup[] {
  const groups = new Map<string, PlotGroup>();
  const from = cellStart(target.k0 * buffer.cell, buffer.barMs), to = (target.k1 + 1) * buffer.cell;
  for (let at = from; at < to; at += buffer.barMs) {
    const bar = plotBar(buffer, at, target, by);
    if (!bar) continue;
    for (const [key, part] of bar.groups) {
      let group = groups.get(key);
      if (!group) {group = {key, name: part.name, cells: []}; groups.set(key, group);}
      group.cells.push([at, part.ms]);
    }
  }
  return [...groups.values()];
}
