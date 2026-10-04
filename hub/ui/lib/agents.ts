import type {LiveSession, View} from './types';
import {cardId, isHidden} from './view';
import {sourceLabel} from './quota';
import {duration, durationChangesAt} from './format';
import {formatLocale, t} from '../i18n';

/** More sessions than this are counted in a card's tray instead of drawn one by one. */
export const DRAWN = 10;

/** Whether a card's tray draws a mark for each of its running agents. */
export const drawn = (sessions: unknown[]) => sessions.length <= DRAWN;

/**
 * The folder shown under an agent's project, where it tells agents of one project apart
 * (a worktree, a folder inside the repository); none where it is the project itself.
 */
export const folderOf = (session: LiveSession) => (session.folder !== session.project ? session.folder : null);

/** How long an agent has run, short: a fresh one is "just now". */
export const since = (ms: number) => (ms < 60_000 ? t('agents.justNow') : duration(ms, true));

/** When `since` reads otherwise: at a minute it stops being fresh, then as `duration` rounds. */
export const sinceChangesAt = (from: number, now: number) => (now - from < 60_000 ? from + 60_000 : durationChangesAt(from, now, true));

/** A source of the board as the list of agents names it, with its agents. */
export type AgentSource = {id: string; provider: string; title?: string; sessions: LiveSession[]};
/** A running agent in the board's table, with the card whose subscription it spends. */
export type AgentRow = {source: AgentSource; session: LiveSession};

/** What a row can be about besides time: the ones the list gathers its agents by. */
export const DIMENSIONS = ['project', 'machine', 'subscription'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
/** What the list gathers its agents by, each viewer for themselves: a dimension, or nothing (a row per agent). */
export const AGENTS_BY = [...DIMENSIONS, 'none'] as const;
export type AgentsBy = (typeof AGENTS_BY)[number];
export const AGENT_COLUMNS = [...DIMENSIONS, 'agents', 'worked', 'activity', 'lastwork', 'running'] as const;
export type AgentColumn = (typeof AGENT_COLUMNS)[number];
export type AgentsSort = {column: AgentColumn; descending: boolean} | null;

/** Saved preferences are untrusted: anything but a known choice gathers by project. */
export const readAgentsBy = (value: unknown): AgentsBy => (AGENTS_BY.includes(value as AgentsBy) ? (value as AgentsBy) : 'project');

/**
 * Agents that share what the list gathers them by, as one row: in activity order, how
 * many work, how long they have worked together (each counted, as agent-hours are), when
 * one last worked and since when the oldest runs, and the projects, machines and
 * subscriptions among them, each once in the order of its most active agent. With
 * nothing to gather by, a row is one agent.
 */
export type AgentGroup = {
  key: string;
  /** Its project's, machine's or subscription's name; null for agents of no project. */
  name: string | null;
  rows: AgentRow[];
  working: number;
  workedMs: number;
  /** When one of its agents was last seen working, the working ones aside; null when none was. */
  lastWorkedAt: number | null;
  startedAt: number;
  projects: (string | null)[];
  machines: {id: string; name: string}[];
  sources: AgentSource[];
};

const once = <T>(items: T[], id: (item: T) => string) => [...new Map(items.map(item => [id(item), item])).values()];

function groupOf(key: string, name: string | null, rows: AgentRow[]): AgentGroup {
  const seen = rows.flatMap(row => (row.session.lastWorkedAt === null ? [] : [row.session.lastWorkedAt]));
  return {
    key,
    name,
    rows,
    working: rows.filter(row => row.session.working).length,
    workedMs: rows.reduce((sum, row) => sum + row.session.workedMs, 0),
    lastWorkedAt: seen.length ? Math.max(...seen) : null,
    startedAt: Math.min(...rows.map(row => row.session.startedAt)),
    projects: once(rows.map(row => row.session.project), project => JSON.stringify(project)),
    machines: once(rows.map(row => row.session.device), device => device.id),
    sources: once(rows.map(row => row.source), source => source.id),
  };
}

/**
 * The agents given in activity order (`agentRows`), gathered `by` what they share, each
 * group in the order of its most active agent, as a card's machines are: a project by its
 * name as its people named it (one group across people, as agent activity counts it), a
 * machine, a subscription; a group per agent when there is nothing to gather by.
 */
export function groupsOf(rows: AgentRow[], by: AgentsBy): AgentGroup[] {
  const groups = new Map<string, {name: string | null; rows: AgentRow[]}>();
  rows.forEach((row, i) => {
    const [key, name] =
      by === 'project' ? [JSON.stringify(row.session.project), row.session.project]
      : by === 'machine' ? [row.session.device.id, row.session.device.name]
      : by === 'subscription' ? [row.source.id, sourceLabel(row.source)]
      : [String(i), row.session.project];
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, {name, rows: [row]});
  });
  return [...groups].map(([key, {name, rows}]) => groupOf(key, name, rows));
}

/**
 * The columns of the list gathered `by` (`inGroup`: the agents of one of its groups, in a
 * dialog), before the owner hides any: the first names a row, always there; the rest
 * follow. A group tells how many agents it has and the dimensions it is not gathered by;
 * an agent, its machine and subscription, the one its group already names left out, and
 * how long it has run.
 */
export function columnsOf(by: AgentsBy, inGroup = false): {name: Dimension; rest: AgentColumn[]} {
  if (by === 'none' || inGroup) return {name: 'project', rest: ['worked', 'activity', 'lastwork', ...(['machine', 'subscription'] as const).filter(column => column !== by), 'running']};
  return {name: by, rest: ['agents', 'worked', 'activity', 'lastwork', ...DIMENSIONS.filter(column => column !== by)]};
}

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
export function agentRows(sources: AgentSource[], view: View): {rows: AgentRow[]; empty: 'none' | 'noneShown' | null} {
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

/** How recently a group worked, the more the sooner: now while one of its agents works, else when one last did. */
const recency = (group: AgentGroup) => (group.working ? Infinity : (group.lastWorkedAt ?? -Infinity));
const compare = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);

/**
 * Groups (in activity order, as `groupsOf` gives them) sorted by a column shown, else as
 * they are; equal ones keep activity order. A dimension sorts by the names it lists, the
 * agents by how many, the time worked by how long, activity and when one last worked the
 * most recent first, how long one has run the shortest first. No project always comes last.
 */
export function sortedGroups(groups: AgentGroup[], sort: AgentsSort, columns: readonly AgentColumn[]): AgentGroup[] {
  const active = visibleAgentsSort(sort, columns);
  if (!active) return groups;
  const {column, descending} = active;
  const at = new Map(groups.map((group, i) => [group, i]));
  const text = (a: string, b: string) => a.localeCompare(b, formatLocale());
  const names = (group: AgentGroup) =>
    (column === 'project' ? group.projects.filter(project => project !== null)
      : column === 'machine' ? group.machines.map(machine => machine.name)
      : group.sources.map(source => sourceLabel(source))).join(', ');
  const nameless = (group: AgentGroup) => column === 'project' && group.projects.every(project => project === null);
  return [...groups].sort((a, b) => {
    const activity = at.get(a)! - at.get(b)!;
    if (nameless(a) || nameless(b)) return Number(nameless(a)) - Number(nameless(b)) || activity;
    const order = column === 'agents' ? a.rows.length - b.rows.length || a.working - b.working
      : column === 'worked' ? a.workedMs - b.workedMs
      : column === 'activity' || column === 'lastwork' ? compare(recency(b), recency(a))
      : column === 'running' ? b.startedAt - a.startedAt
      : text(names(a), names(b));
    return (descending ? -order : order) || activity;
  });
}

/** The first column, whatever it names: room for a name to read. */
export const NAME_WIDTH = 180;
/** Room for the widest heading in either language and a readable, possibly shortened value. */
export const AGENT_WIDTHS: Record<AgentColumn, number> = {project: 150, machine: 132, subscription: 148, agents: 116, worked: 120, activity: 116, lastwork: 156, running: 120};
/** A table where the name and the columns after it (`columns`) fit `width`, else a list. */
export function agentsLayout(columns: readonly AgentColumn[], width: number): 'table' | 'list' {
  return columns.reduce((sum, column) => sum + AGENT_WIDTHS[column], NAME_WIDTH) <= width ? 'table' : 'list';
}

/**
 * How many of the agents a list shows in a widget of `budget` CSS pixels, in its own order:
 * all where they fit whole, otherwise the most whole rows that fit with a last row saying
 * how many more there are (`footer` high), and at least one. `rows` are the rows' heights as
 * they stand one above another, each with the border under it, which the last row shown
 * without a row after it does not have (`border`); `shell` is the rest of the widget. The
 * least the widget needs is its first row and the one saying the rest, or all of them where
 * that is less; `natural`, all of them.
 */
export function agentsFit({shell, rows, footer, border, budget}: {shell: number; rows: number[]; footer: number; border: number; budget: number}) {
  const natural = shell + rows.reduce((sum, row) => sum + row, 0) - (rows.length ? border : 0);
  if (rows.length < 2) return {shown: rows.length, hidden: 0, min: natural, natural};
  const min = Math.min(natural, shell + rows[0] + footer);
  // Measured pixels are fractions: what fits to half a pixel fits.
  const fits = (height: number) => height <= budget + 0.5;
  let shown = rows.length;
  if (!fits(natural)) {
    shown = 1;
    let used = shell + rows[0];
    while (shown < rows.length - 1 && fits(used + rows[shown] + footer)) used += rows[shown++];
  }
  return {shown, hidden: rows.length - shown, min, natural};
}
