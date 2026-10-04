import {drain, type Preparation} from './prepare';
import {ordered} from '../../server/domain/prepare';
import type {HistorySeries, Kind, SourceEvent, View, Win} from './types';
import type {PastResets} from './resets';
import {windowKey} from './types';
import {seriesName} from './quota';
import {DASHES} from './providers';
import {cardId, colorOf} from './view';
import {covered, type Coverage} from './historyPlot';

/** A series of the history as the chart and the table show it: named, coloured, with its value now. */
export type PlotBlock = {from: number; to: number; gap: boolean; points: readonly [at: number, remaining: number, segment: number, hold: number][]};
export type CapCell = {at:number;from:number;to:number;value:number};
export type PlotSeries = Pick<HistorySeries, 'sourceId' | 'windowId' | 'points' | 'staleAfterMs'> & {capCells?: readonly CapCell[];blocks?: {block: PlotBlock; join: boolean}[]};
type LineName = Pick<Win, 'kind' | 'label' | 'minutes'> & {provider: string; key: string; name: string; color: string; dash: string; current: number};
export type PlotLine = PlotSeries & LineName;
export type Line = HistorySeries & LineName & {capCells?: readonly CapCell[]};

/**
 * The board's series of one kind of window that have data in the period. Only what the
 * cards show: a window the source no longer reports (its history outlives it), one
 * hidden on the board, or any of a card hidden on the board is left out. A source's windows share its colour and differ by
 * dash.
 */
export function* linesPrepared<T extends PlotSeries>(history: {series: readonly T[]} | null, sources: {id: string; provider: string; title?: string; windows: Win[]}[] | null, view: View, kind: Kind): Preparation<(T & LineName)[]> {
  if (!history || !sources) return [];
  const perSource: Record<string, number> = {};
  const hidden = new Set([...view.windows, ...view.hidden]);
  const rank = (entry: PlotSeries) => {
    const source = sources.findIndex(s => s.id === entry.sourceId);
    return source * 100 + (sources[source]?.windows.findIndex(w => w.id === entry.windowId) ?? 99);
  };
  const result: (T & LineName)[] = [];
  for (const entry of yield* ordered(history.series, (a, b) => rank(a) - rank(b))) {
    yield;
    const source = hidden.has(cardId(entry.sourceId)) ? undefined : sources.find(s => s.id === entry.sourceId);
    const live = source?.windows.find(w => w.id === entry.windowId);
    if (!source || !live || live.kind !== kind || !entry.points.length || hidden.has(windowKey(entry.sourceId, entry.windowId))) continue;
    const index = (perSource[entry.sourceId] = (perSource[entry.sourceId] ?? -1) + 1);
    result.push(
      {
        ...entry,
        provider: source.provider,
        kind: live.kind,
        label: live.label,
        minutes: live.minutes,
        key: windowKey(entry.sourceId, entry.windowId),
        name: seriesName(source, live),
        color: colorOf(view, entry.sourceId, source.provider),
        dash: DASHES[index % DASHES.length],
        current: live.remaining,
      },
    );
  }
  return result;
}

/**
 * A line's value in the cell that starts at `cell`: its own, or else the last one before
 * it while the line goes on unbroken. Measurements may come less often than the cells of
 * a short period, and a value holds until the next one; the last one, only as long as it
 * is fresh (`holdMs`), as a gap between two would be.
 */
export function valueIn(points: Line['points'], cell: number, now: number, holdMs: number, coverage?: Coverage): number | undefined {
  if (cell > now) return undefined;
  let low = 0;
  let high = points.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (points[middle][0] <= cell) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (found < 0) return undefined;
  const [at, value, segment] = points[found];
  // An unread interval may contain a newer measurement or a break in this line.
  if (coverage && !covered(coverage, at, cell + 1)) return undefined;
  const next = points[found + 1];
  if (at === cell) return value;
  return next ? (next[2] === segment ? value : undefined) : cell - at <= holdMs ? value : undefined;
}

/**
 * What happened to sources that the chart marks: from `from` on, where it draws a line of
 * the source (limits back early, on a window that came back); with those lines.
 */
export function* chartEventsPrepared(events: SourceEvent[], lines: PlotLine[], from: number): Preparation<{event: SourceEvent; lines: PlotLine[]}[]> {
  const result: {event: SourceEvent; lines: PlotLine[]}[] = [];
  for (const event of events) {
    yield;
    if (event.at < from) continue;
    const on: PlotLine[] = [];
    for (const line of lines) {
      yield;
      if (line.sourceId !== event.sourceId) continue;
      if (event.kind === 'early_reset') {
        let matches = false;
        for (const window of event.windows) {yield; if (window === line.windowId) {matches = true; break;}}
        if (!matches) continue;
      }
      on.push(line);
    }
    if (on.length) result.push({event, lines: on});
  }
  return result;
}

/** The resets for everyone that the chart marks, preserving provider and tracker order. */
export function* chartResetsPrepared(past: PastResets, lines: PlotLine[], from: number, to: number): Preparation<{provider: keyof PastResets; reset: NonNullable<PastResets[keyof PastResets]>[number]; line: PlotLine}[]> {
  const result: {provider: keyof PastResets; reset: NonNullable<PastResets[keyof PastResets]>[number]; line: PlotLine}[] = [];
  for (const provider of Object.keys(past) as (keyof PastResets)[]) {
    let line: PlotLine | undefined;
    for (const candidate of lines) {yield; if (candidate.provider === provider) {line = candidate; break;}}
    if (!line) continue;
    for (const reset of past[provider] ?? []) {yield; if (reset.at >= from && reset.at <= to) result.push({provider, reset, line});}
  }
  return result;
}

export function chartEvents(...args: Parameters<typeof chartEventsPrepared>) {return drain(chartEventsPrepared(...args));}
export function chartResets(...args: Parameters<typeof chartResetsPrepared>) {return drain(chartResetsPrepared(...args));}

export function linesOf<T extends PlotSeries>(...args: Parameters<typeof linesPrepared<T>>): (T & LineName)[] {return drain(linesPrepared(...args));}
