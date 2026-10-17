import type {Activity, ActivityDimension, LiveSession, View} from './types';
import {sourceKey} from '../../server/domain/workAccess';
import {compareWorkRatio} from '../../server/domain/workRatio';
import {clientName} from '../../server/domain/clients';
import {sourceLabel} from './quota';
import {duration, durationChangesAt} from './format';
import {formatLocale, t} from '../i18n';
import {nextTableSort,visibleTableSort,tableLayout} from './table';

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

/** The current stream confirms presence; retained analytical replies cannot renew it. */
export const sessionPresent = (session:LiveSession,_now:number) => !session.ref || !!session.currentPresence;
export const sessionPresenceChangesAt = (_session:LiveSession,_now:number):number|null => null;

export const runningFrom = (rows:readonly AgentRow[],now:number) => Math.min(...rows.map(({session})=>session.ref?sessionPresent(session,now)?session.currentPresence!.startedAt:Infinity:session.startedAt));
export function runningChangesAt(rows:readonly AgentRow[],now:number){
  const from=runningFrom(rows,now),next=Math.min(Number.isFinite(from)?sinceChangesAt(from,now):Infinity,...rows.map(({session})=>sessionPresenceChangesAt(session,now)??Infinity));
  return Number.isFinite(next)?next:null;
}

/** A source of the board as the list of agents names it, with its agents. */
export type AgentSource = {id: string; provider: string; title?: string; sessions: LiveSession[]};
/** A running agent in the board's table, with the card whose subscription it spends. */
export type AgentRow = {source: AgentSource | null; session: LiveSession};

/** What a row can be about besides time: the ones the list gathers its agents by. */
export const DIMENSIONS = ['project', 'machine', 'subscription'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
/** What the list gathers its agents by, each viewer for themselves: a dimension, or nothing (a row per agent). */
export const AGENTS_BY = ['none', ...DIMENSIONS] as const;
export type AgentsBy = (typeof AGENTS_BY)[number];
export const AGENT_COLUMNS = [...DIMENSIONS,'client', 'agents', 'worked', 'active', 'concurrency', 'activity', 'running'] as const;
export type AgentColumn = (typeof AGENT_COLUMNS)[number];
export type AgentsSort = {column: AgentColumn; descending: boolean} | null;

/** Saved preferences are untrusted: anything but a known choice gathers by project. */
export const readAgentsBy = (value: unknown): AgentsBy => (AGENTS_BY.includes(value as AgentsBy) ? (value as AgentsBy) : 'project');

export const activityDimension = (by: Dimension): ActivityDimension => by === 'machine' ? 'device' : by === 'subscription' ? 'source' : 'project';

/** Union time and concurrency belong to a group, not a sum of its rows. */
export function agentActivityValue(summary: Activity | null, by: Dimension, column: 'active' | 'concurrency', key?: string): number | null {
  if (!summary?.known) return null;
  const group = key === undefined ? summary : summary.by[activityDimension(by)].find(group => group.key === key);
  if (!group) return null;
  return column === 'active' ? group.activeMs : group.activeMs ? group.agentMs / group.activeMs : 0;
}

/**
 * Agents that share what the list gathers them by, as one row: in activity order, how
 * many work, how long they have worked together (each counted, as agent-hours are), when
 * one last worked and since when the oldest runs. With nothing to gather by, a row is
 * one agent.
 */
export type AgentGroup = {
  key: string;
  /** Its project's, machine's or subscription's name; null for agents of no project. */
  name: string | null;
  rows: AgentRow[];
  working: number;
  workedMs: number | null;
  /** Period union time, supplied only for grouped analytics. */
  activeMs?: number | null;
  /** When one of its agents was last seen working, the working ones aside; null when none was. */
  lastWorkedAt: number | null;
  startedAt: number;
};

export const agentCount=(rows:readonly AgentRow[])=>new Set(rows.map(({session})=>session.identityRef??session.ref??session)).size;

/** A temporal funding fragment keeps its time, but its agent has one mark. */
export function distinctAgents(rows:readonly AgentRow[]):AgentRow[] {
  const agents=new Map<string|LiveSession,AgentRow>();
  const presence=(session:LiveSession)=>session.currentPresence?2:session.working?1:0;
  for(const row of rows){const key=row.session.identityRef??row.session.ref??row.session,previous=agents.get(key);if(!previous||presence(row.session)>presence(previous.session)||presence(row.session)===presence(previous.session)&&byActivity(row.session,previous.session)<0)agents.set(key,row);}
  return [...agents.values()];
}

function groupOf(key: string, name: string | null, rows: AgentRow[]): AgentGroup {
  const seen = rows.flatMap(row => (row.session.lastWorkedAt === null ? [] : [row.session.lastWorkedAt]));
  return {
    key,
    name,
    rows,
    working:agentCount(rows.filter(row=>row.session.working)),
    workedMs: rows.some(row => row.session.workedMs === null) ? null : rows.reduce((sum, row) => sum + row.session.workedMs!, 0),
    lastWorkedAt: seen.length ? Math.max(...seen) : null,
    startedAt: Math.min(...rows.map(row => row.session.ref ? row.session.currentPresence?.startedAt ?? Infinity : row.session.startedAt)),
  };
}

/**
 * The agents given in activity order (`agentRows`), gathered `by` what they share, each
 * group in the order of its most active agent, as a card's machines are: a project by its
 * name as its people named it (one group across people, as agent activity counts it), a
 * machine, a subscription; a group per agent when there is nothing to gather by.
 */
export function groupsOf(rows: AgentRow[], by: AgentsBy, summary?: Activity | null): AgentGroup[] {
  const groups = new Map<string, {name: string | null; rows: AgentRow[]}>();
  rows.forEach((row, i) => {
    const [key, name] =
      by === 'project' ? [JSON.stringify(row.session.project), row.session.project]
      : by === 'machine' ? [row.session.device.id, row.session.device.name]
      : by === 'subscription' ? [sourceKey({source:row.source?.id??null,sourceStatus:row.session.sourceStatus}),agentSourceLabel(row.source,row.session.sourceStatus)]
      : [row.session.ref ?? String(i), row.session.project];
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, {name, rows: [row]});
  });
  const activity = by === 'none' || !summary?.known ? null : new Map(summary.by[activityDimension(by)].map(group => [group.key, group.activeMs]));
  return [...groups].map(([key, {name, rows}]) => ({...groupOf(key, name, rows), ...(by !== 'none' && summary !== undefined ? {activeMs: activity?.get(key) ?? null} : {})}));
}

/**
 * The columns of the list gathered `by` (`inGroup`: the agents of one of its groups, in a
 * dialog), before the owner hides any: the first names a row, always there; the rest
 * follow. A group tells its session count, worked time, optional union time and
 * concurrency, and last activity;
 * an agent also tells its machine and subscription, the one its group already names
 * left out, and how long it has run.
 */
export function columnsOf(by: AgentsBy, inGroup = false): {name: Dimension; rest: AgentColumn[]} {
  if (by === 'none' || inGroup) return {name: 'project', rest: ['client','worked', 'activity', ...(['machine', 'subscription'] as const).filter(column => column !== by), 'running']};
  return {name: by, rest: ['agents', 'worked', 'active', 'concurrency', 'activity']};
}

/** Working now, idle since known work, then never seen working; newest first in each group. */
export function byActivity(a: LiveSession, b: LiveSession): number {
  if(a.ref&&b.ref)return (b.lastWorkedAt??0)-(a.lastWorkedAt??0)||a.ref.localeCompare(b.ref);
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

const rowActivity = (a: AgentRow, b: AgentRow) => byActivity(a.session, b.session) || (a.source?.id ?? '').localeCompare(b.source?.id ?? '');

/** All admitted mapped and unattributed agents, in activity order. */
export function agentRows(sources:AgentSource[],_view:View,unattributed:LiveSession[]=[]):{rows:AgentRow[];empty:'none'|'noneShown'|null} {
  const rows=[...sources.flatMap(source=>source.sessions.map(session=>({source,session}))),...unattributed.map(session=>({source:null,session}))].sort(rowActivity);
  return {rows,empty:rows.length?null:'none'};
}

/** Saved preferences are untrusted and can come from a different dashboard version. */
export function readAgentsSort(value: unknown): AgentsSort {
  if (!value || typeof value !== 'object') return null;
  const sort = value as Record<string, unknown>;
  return AGENT_COLUMNS.includes(sort.column as AgentColumn) && typeof sort.descending === 'boolean'
    ? {column: sort.column as AgentColumn, descending: sort.descending} : null;
}

/** Headers cycle ascending, descending, activity. Menus use their activity row to reset. */
export const nextAgentsSort = (sort: AgentsSort, column: AgentColumn|null, cycle = true): AgentsSort => nextTableSort(sort,column,cycle);

/** A hidden column never sorts the visible rows, but its viewer's choice is kept. */
export const visibleAgentsSort = (sort: AgentsSort, columns: readonly AgentColumn[]): AgentsSort =>
  visibleTableSort(sort,columns);

/** How recently a group worked, the more the sooner: now while one of its agents works, else when one last did. */
const recency = (group: AgentGroup) => (group.working&&!group.rows[0]?.session.ref ? Infinity : (group.lastWorkedAt ?? -Infinity));
const compare = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);

/**
 * Groups (in activity order, as `groupsOf` gives them) sorted by a column shown, else as
 * they are; equal ones keep activity order. A dimension sorts by its name (shared by
 * every agent of a group), the agents by how many, the time worked by how long, activity
 * chronologically, how long one has run the shortest first. No project always comes last.
 */
export function sortedGroups(groups: AgentGroup[], sort: AgentsSort, columns: readonly AgentColumn[]): AgentGroup[] {
  const active = visibleAgentsSort(sort, columns);
  if (!active) return groups;
  const {column, descending} = active;
  const at = new Map(groups.map((group, i) => [group, i]));
  const text = (a: string, b: string) => a.localeCompare(b, formatLocale());
  const name = ({rows: [row]}: AgentGroup) =>
    column === 'project' ? row.session.project ?? ''
      : column === 'client'?row.session.clientId?clientName(row.session.clientId):'':column === 'machine' ? row.session.device.name : agentSourceLabel(row.source,row.session.sourceStatus);
  const nameless = (group: AgentGroup) => column === 'project' && group.name === null;
  return [...groups].sort((a, b) => {
    const activity = at.get(a)! - at.get(b)!;
    if (nameless(a) || nameless(b)) return Number(nameless(a)) - Number(nameless(b)) || activity;
    if (column === 'worked' && (a.workedMs === null || b.workedMs === null)) return Number(a.workedMs === null) - Number(b.workedMs === null) || activity;
    if ((column === 'active' || column === 'concurrency') && (a.activeMs == null || b.activeMs == null)) return Number(a.activeMs == null) - Number(b.activeMs == null) || activity;
    const order = column === 'agents' ? agentCount(a.rows) - agentCount(b.rows) || a.working - b.working
      : column === 'worked' ? a.workedMs! - b.workedMs!
      : column === 'active' ? a.activeMs! - b.activeMs!
      : column === 'concurrency' ? compareWorkRatio(a.workedMs??0,a.activeMs??0,b.workedMs??0,b.activeMs??0)
      : column === 'activity' ? compare(recency(a), recency(b))
      : column === 'running' ? b.startedAt - a.startedAt
      : text(name(a), name(b));
    return (descending ? -order : order) || activity;
  });
}

/** The first column, whatever it names: room for a name to read. */
export const NAME_WIDTH = 180;
/** Room for the widest heading in either language and a readable, possibly shortened value. */
export const AGENT_WIDTHS: Record<AgentColumn, number> = {project:150,client:120,machine: 116, subscription: 132, agents: 190, worked: 120, active: 170, concurrency: 210, activity: 210, running: 120};
/** A table where the name and the columns after it (`columns`) fit `width`, else a list. */
export function agentsLayout(columns: readonly AgentColumn[], width: number): 'table' | 'list' {
  return tableLayout(columns.map(column=>AGENT_WIDTHS[column]),width,NAME_WIDTH,0);
}

export const agentSourceLabel=(source:AgentSource|null,status?:'notProvided',short=false)=>source?sourceLabel(source):t(status==='notProvided'?short?'agents.notProvidedShort':'agents.notProvided':short?'agents.notIdentifiedShort':'agents.unknownSource');
