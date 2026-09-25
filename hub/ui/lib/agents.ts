import type {LiveSession, SourceState, View} from './types';
import {cardId, isHidden} from './view';

/** More sessions than this are counted in a card's tray instead of drawn one by one. */
export const DRAWN = 10;

/** Whether a card's tray draws a mark for each of its running agents. */
export const drawn = (sessions: unknown[]) => sessions.length <= DRAWN;

/** A running agent in the board's table, with the card whose subscription it spends. */
export type AgentRow = {source: SourceState; session: LiveSession};

/**
 * The board's table of running agents: every agent on the cards it shows, by machine and
 * then by age. Without any, why: none runs (`none`), or they run only on cards hidden
 * here (`noneShown`), which the table leaves out as well.
 */
export function agentRows(sources: SourceState[], view: View): {rows: AgentRow[]; empty: 'none' | 'noneShown' | null} {
  const shown = sources.filter(source => !isHidden(view, cardId(source.id)));
  const rows = shown
    .flatMap(source => source.sessions.map(session => ({source, session})))
    .sort((a, b) => a.session.device.name.localeCompare(b.session.device.name) || a.session.startedAt - b.session.startedAt);
  if (rows.length) return {rows, empty: null};
  return {rows, empty: sources.some(source => source.sessions.length && !shown.includes(source)) ? 'noneShown' : 'none'};
}
