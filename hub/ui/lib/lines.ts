import type {History, HistorySeries, Kind, Overview, View} from './types';
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
 * a short period, and a value holds until the next one.
 */
export function valueIn(points: Line['points'], cell: number, now: number): number | undefined {
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
  return at === cell || !next || next[2] === segment ? value : undefined;
}
