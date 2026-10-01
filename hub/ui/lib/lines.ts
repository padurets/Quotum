import type {HistorySeries, Kind, SourceEvent, View, Win} from './types';
import type {PastResets} from './resets';
import {windowKey} from './types';
import {seriesName} from './quota';
import {DASHES} from './providers';
import {cardId, colorOf} from './view';

/** A series of the history as the chart and the table show it: named, coloured, with its value now. */
export type PlotBlock = {from: number; to: number; gap: boolean; points: readonly [at: number, remaining: number, segment: number, hold: number][]};
export type PlotSeries = Pick<HistorySeries, 'sourceId' | 'windowId' | 'points' | 'staleAfterMs'> & {blocks?: {block: PlotBlock; join: boolean}[]};
type LineName = Pick<Win, 'kind' | 'label' | 'minutes'> & {provider: string; key: string; name: string; color: string; dash: string; current: number};
export type PlotLine = PlotSeries & LineName;
export type Line = HistorySeries & LineName;

/**
 * The board's series of one kind of window that have data in the period. Only what the
 * cards show: a window the source no longer reports (its history outlives it), one
 * hidden on the board, or any of a card hidden on the board is left out. A source's windows share its colour and differ by
 * dash.
 */
export function linesOf<T extends PlotSeries>(history: {series: readonly T[]} | null, sources: {id: string; provider: string; title?: string; windows: Win[]}[] | null, view: View, kind: Kind): (T & LineName)[] {
  if (!history || !sources) return [];
  const perSource: Record<string, number> = {};
  const hidden = new Set([...view.windows, ...view.hidden]);
  const rank = (entry: PlotSeries) => {
    const source = sources.findIndex(s => s.id === entry.sourceId);
    return source * 100 + (sources[source]?.windows.findIndex(w => w.id === entry.windowId) ?? 99);
  };
  return [...history.series].sort((a, b) => rank(a) - rank(b)).flatMap(entry => {
    const source = hidden.has(cardId(entry.sourceId)) ? undefined : sources.find(s => s.id === entry.sourceId);
    const live = source?.windows.find(w => w.id === entry.windowId);
    if (!source || !live || live.kind !== kind || !entry.points.length || hidden.has(windowKey(entry.sourceId, entry.windowId))) return [];
    const index = (perSource[entry.sourceId] = (perSource[entry.sourceId] ?? -1) + 1);
    return [
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
    ];
  });
}

/**
 * A line's value in the cell that starts at `cell`: its own, or else the last one before
 * it while the line goes on unbroken. Measurements may come less often than the cells of
 * a short period, and a value holds until the next one; the last one, only as long as it
 * is fresh (`holdMs`), as a gap between two would be.
 */
export function valueIn(points: Line['points'], cell: number, now: number, holdMs: number): number | undefined {
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
  const next = points[found + 1];
  if (at === cell) return value;
  return next ? (next[2] === segment ? value : undefined) : cell - at <= holdMs ? value : undefined;
}

/**
 * What happened to sources that the chart marks: from `from` on, where it draws a line of
 * the source (limits back early, on a window that came back); with those lines.
 */
export function chartEvents(events: SourceEvent[], lines: PlotLine[], from: number) {
  return events.flatMap(event => {
    const on = lines.filter(line => line.sourceId === event.sourceId && (event.kind !== 'early_reset' || event.windows.includes(line.windowId)));
    return event.at < from || !on.length ? [] : [{event, lines: on}];
  });
}

/** The resets for everyone that the chart marks: from `from` to `to`, of a provider it draws a line of; with that line. */
export function chartResets(past: PastResets, lines: PlotLine[], from: number, to: number) {
  return (Object.keys(past) as (keyof PastResets)[]).flatMap(provider => {
    const line = lines.find(l => l.provider === provider);
    return line ? (past[provider] ?? []).filter(reset => reset.at >= from && reset.at <= to).map(reset => ({provider, reset, line})) : [];
  });
}
