import {compose, type Chunk} from '../domain/history.js';
import type {Shown, Store} from '../store/store.js';

/** Reads cells directly for storage tests; window metadata belongs to the cards. */
export function readHistory(store: Store, board: string, from: number, cell: number, options: {to?: number; now?: number; shown?: Shown} = {}) {
  const last = (store.db.prepare('SELECT max(at) AS at FROM samples').get() as {at: number | null}).at ?? from;
  const to = Math.ceil((options.to ?? Math.max(from + cell, last + 1)) / cell) * cell;
  const start = Math.floor(from / cell) * cell;
  const now = options.now ?? to;
  const shown = options.shown ?? store.shown(board, []);
  const chunks: Chunk[] = store.cells(board, cell, start, to, {now, shown}).map(chunk => ({...chunk, activity: {...chunk.activity, sessions: chunk.activity.sessions.map(([id, ...rest]) => [String(id), ...rest])}}));
  const windows = new Set(store.states(board).flatMap(s => s.windows.map(w => `${s.id} ${w.id}`)));
  return compose(chunks, {now, historyStart: store.historyStart(now), known: store.historyKnown(shown)}, {cell, k0: start / cell, k1: to / cell - 1, length: to - start, live: options.to === undefined, key: '', now}, windows);
}
