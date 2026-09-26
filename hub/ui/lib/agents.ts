import type {LiveSession, SourceState, View} from './types';
import {cardId, isHidden} from './view';
import {sourceLabel} from './quota';
import {formatLocale} from '../i18n';

/** More sessions than this are counted in a card's tray instead of drawn one by one. */
export const DRAWN = 10;

/** Whether a card's tray draws a mark for each of its running agents. */
export const drawn = (sessions: unknown[]) => sessions.length <= DRAWN;

/**
 * The folder shown under an agent's project, where it tells agents of one project apart
 * (a worktree, a folder inside the repository); none where it is the project itself.
 */
export const folderOf = (session: LiveSession) => (session.folder !== session.project ? session.folder : null);

/** A running agent in the board's table, with the card whose subscription it spends. */
export type AgentRow = {source: SourceState; session: LiveSession};
export const AGENT_COLUMNS = ['project', 'state', 'subscription', 'machine', 'origin', 'running'] as const;
export type AgentColumn = (typeof AGENT_COLUMNS)[number];
export type AgentsSort = {column: AgentColumn; descending: boolean} | null;

/** Working now, idle since known work, then never seen working; newest first in each group. */
export function byActivity(a: LiveSession, b: LiveSession): number {
  const group = (s: LiveSession) => (s.working ? 0 : s.lastWorkedAt != null ? 1 : 2);
  const time = (s: LiveSession) => (!s.working && s.lastWorkedAt != null ? s.lastWorkedAt : s.startedAt);
  return group(a) - group(b) || time(b) - time(a) || b.startedAt - a.startedAt ||
    a.device.name.localeCompare(b.device.name) || a.device.id.localeCompare(b.device.id) ||
    (a.project === b.project ? 0 : a.project === null ? 1 : b.project === null ? -1 : a.project.localeCompare(b.project));
}

/** A card keeps its machine groups, with the most active session of each deciding their order. */
export function machinesOf(sessions: LiveSession[]): {id: string; name: string; sessions: LiveSession[]}[] {
  const machines = new Map<string, {id: string; name: string; sessions: LiveSession[]}>();
  for (const session of [...sessions].sort(byActivity)) {
    const machine = machines.get(session.device.id);
    if (machine) machine.sessions.push(session);
    else machines.set(session.device.id, {...session.device, sessions: [session]});
  }
  return [...machines.values()];
}

const rowActivity = (a: AgentRow, b: AgentRow) => byActivity(a.session, b.session) || a.source.id.localeCompare(b.source.id);

/** Every agent on the cards shown, by activity; when empty, whether hiding cards caused it. */
export function agentRows(sources: SourceState[], view: View): {rows: AgentRow[]; empty: 'none' | 'noneShown' | null} {
  const shown = sources.filter(source => !isHidden(view, cardId(source.id)));
  const rows = shown.flatMap(source => source.sessions.map(session => ({source, session}))).sort(rowActivity);
  if (rows.length) return {rows, empty: null};
  return {rows, empty: sources.some(source => source.sessions.length && !shown.includes(source)) ? 'noneShown' : 'none'};
}

/** Saved preferences are untrusted and can come from a different dashboard version. */
export function readAgentsSort(value: unknown): AgentsSort {
  if (!value || typeof value !== 'object') return null;
  const sort = value as Record<string, unknown>;
  return AGENT_COLUMNS.includes(sort.column as AgentColumn) && typeof sort.descending === 'boolean'
    ? {column: sort.column as AgentColumn, descending: sort.descending} : null;
}

/** Headers cycle ascending, descending, activity. Menus use their activity row to reset. */
export function nextAgentsSort(sort: AgentsSort, column: AgentColumn, cycle = true): AgentsSort {
  if (sort?.column !== column) return {column, descending: false};
  return sort.descending && cycle ? null : {column, descending: !sort.descending};
}

/** A hidden column never sorts the visible rows, but its viewer's choice is kept. */
export const visibleAgentsSort = (sort: AgentsSort, columns: readonly AgentColumn[]): AgentsSort =>
  sort && columns.includes(sort.column) ? sort : null;

export function sortedRows(rows: AgentRow[], sort: AgentsSort, columns: readonly AgentColumn[]): AgentRow[] {
  const active = visibleAgentsSort(sort, columns);
  if (!active) return [...rows].sort(rowActivity);
  const {column, descending} = active;
  const text = (a: string, b: string) => a.localeCompare(b, formatLocale());
  const state = (s: LiveSession) => (s.working ? 0 : s.origin === 'terminal' ? 1 : 2);
  const origin = {terminal: 0, editor: 1, app: 2};
  return [...rows].sort((a, b) => {
    const x = a.session, y = b.session;
    // No project always comes last, even when the direction is reversed.
    if (column === 'project' && (x.project === null || y.project === null)) {
      return Number(x.project === null) - Number(y.project === null) || rowActivity(a, b);
    }
    const order = column === 'project' ? text(x.project!, y.project!)
      : column === 'state' ? state(x) - state(y)
      : column === 'subscription' ? text(sourceLabel(a.source), sourceLabel(b.source))
      : column === 'machine' ? text(x.device.name, y.device.name)
      : column === 'origin' ? origin[x.origin] - origin[y.origin]
      : y.startedAt - x.startedAt;
    return (descending ? -order : order) || rowActivity(a, b);
  });
}

/** Room for the widest heading in either language and a readable, possibly shortened value. */
export const AGENT_WIDTHS: Record<AgentColumn, number> = {project: 180, state: 136, subscription: 148, machine: 132, origin: 92, running: 136};
export function agentsLayout(columns: readonly AgentColumn[], width: number): 'table' | 'list' {
  return columns.reduce((sum, column) => sum + AGENT_WIDTHS[column], 0) <= width ? 'table' : 'list';
}
