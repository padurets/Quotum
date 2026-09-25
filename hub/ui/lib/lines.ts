import type {History, HistorySeries, Kind, Overview, SourceEvent, View} from './types';
import type {PastResets} from './resets';
import {windowKey} from './types';
import {seriesName} from './quota';
import {DASHES} from './providers';
import {cardId, colorOf} from './view';

/** A series of the history as the chart and the table show it: named, coloured, with its value now. */
export type Line = HistorySeries & {key: string; name: string; color: string; dash: string; current: number};

/**
 * The board's series of one kind of window that have data in the period. Only what the
 * cards show: a window the source no longer reports (its history outlives it), one
 * hidden on the board, or any of a card hidden on the board is left out. A source's windows share its colour and differ by
 * dash.
 */
export function linesOf(history: History | null, overview: Overview | null, view: View, kind: Kind): Line[] {
  if (!history || !overview) return [];
  const perSource: Record<string, number> = {};
  const hidden = new Set([...view.windows, ...view.hidden]);
  return history.series.flatMap(entry => {
    const source = hidden.has(cardId(entry.sourceId)) ? undefined : overview.sources.find(s => s.id === entry.sourceId);
    const live = source?.windows.find(w => w.id === entry.windowId);
    if (!source || !live || entry.kind !== kind || !entry.points.length || hidden.has(windowKey(entry.sourceId, entry.windowId))) return [];
    const index = (perSource[entry.sourceId] = (perSource[entry.sourceId] ?? -1) + 1);
    return [
      {
        ...entry,
        key: windowKey(entry.sourceId, entry.windowId),
        name: seriesName(source, entry),
        color: colorOf(view, entry.sourceId, entry.provider),
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

/** Where the chart begins: its period, or later where history starts. */
export const chartFrom = (history: History | null, now: number) => (history ? Math.max(history.since, history.historyStart) : now - 86_400_000);

/**
 * What happened to sources that the chart marks: from `from` on, where it draws a line of
 * the source (limits back early, on a window that came back); with those lines.
 */
export function chartEvents(events: SourceEvent[], lines: Line[], from: number) {
  return events.flatMap(event => {
    const on = lines.filter(line => line.sourceId === event.sourceId && (event.kind !== 'early_reset' || event.windows.includes(line.windowId)));
    return event.at < from || !on.length ? [] : [{event, lines: on}];
  });
}

/** The resets for everyone that the chart marks: from `from` to `to`, of a provider it draws a line of; with that line. */
export function chartResets(past: PastResets, lines: Line[], from: number, to: number) {
  return (Object.keys(past) as (keyof PastResets)[]).flatMap(provider => {
    const line = lines.find(l => l.provider === provider);
    return line ? (past[provider] ?? []).filter(reset => reset.at >= from && reset.at <= to).map(reset => ({provider, reset, line})) : [];
  });
}
