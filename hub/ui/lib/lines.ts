import type {History, HistorySeries, Kind, Overview, View} from './types';
import {windowKey} from './types';
import {seriesName} from './quota';
import {DASHES, PROVIDERS} from './providers';

/** A series of the history as the chart and the table show it: named, coloured, with its value now. */
export type Line = HistorySeries & {key: string; name: string; color: string; dash: string; current: number};

/**
 * The board's series that have data in the period, of one kind of window or of all,
 * leaving out the windows hidden on the board. A source's windows share its colour and
 * differ by dash.
 */
export function linesOf(history: History | null, overview: Overview | null, view: View, kind: Kind | null): Line[] {
  if (!history) return [];
  const perSource: Record<string, number> = {};
  const hidden = new Set(view.windows);
  return history.series
    .filter(entry => (kind === null || entry.kind === kind) && entry.points.length && !hidden.has(windowKey(entry.sourceId, entry.windowId)))
    .map(entry => {
      const index = (perSource[entry.sourceId] = (perSource[entry.sourceId] ?? -1) + 1);
      const source = overview?.sources.find(s => s.id === entry.sourceId);
      const live = source?.windows.find(w => w.id === entry.windowId);
      return {
        ...entry,
        key: windowKey(entry.sourceId, entry.windowId),
        name: seriesName(source ?? {provider: entry.provider}, entry),
        color: PROVIDERS[entry.provider]?.color ?? '#8b90b5',
        dash: DASHES[index % DASHES.length],
        current: live ? live.remaining : entry.points.at(-1)![1],
      };
    });
}
