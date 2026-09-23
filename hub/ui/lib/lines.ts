import type {History, HistorySeries, Kind, Overview, View} from './types';
import {windowKey} from './types';
import {seriesName} from './quota';
import {DASHES, PROVIDERS} from './providers';
import {cardId} from './view';

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
        color: PROVIDERS[entry.provider]?.color ?? '#8b90b5',
        dash: DASHES[index % DASHES.length],
        current: live.remaining,
      },
    ];
  });
}
