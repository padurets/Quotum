/**
 * The projects of the reader's machines, and the corrections they make (server/domain/projects.ts).
 * Requests name the groups as the tab shows them; the hub works out which reported names
 * they gather, so a correction without time and a name reported meanwhile go along.
 */

/** A project as the hub lists it: the name shown, and the reported names it gathers. */
export type ProjectGroup = {
  /** Null for time without a project. */
  name: string | null;
  agentMs: number;
  /** When its agents last worked; null for a correction with no time kept. */
  lastAt: number | null;
  machines: {id: string; name: string}[];
  reported: {name: string; agentMs: number}[];
};

export type Projects = {keptDays: number; projects: ProjectGroup[]};

/** What `POST /api/projects` takes: the groups and the name they go under (empty: each its own). */
export type Naming = {groups: string[]; name: string};

/** Renames one project; an empty name gives each name it gathers back its own. */
export const renaming = (group: ProjectGroup, name: string): Naming => ({groups: [group.name!], name});

/** Merges the selected projects under the name of one of them. */
export const merging = (selected: ProjectGroup[], target: ProjectGroup): Naming => ({groups: selected.map(group => group.name!), name: target.name!});

/** Gives one reported name back its own. */
export const restoring = (reported: string): {reported: string[]} => ({reported: [reported]});

/** The reported names a project gathers besides its own name, by name: what it was renamed or merged from. */
export const shown = (group: ProjectGroup): string[] =>
  group.reported
    .map(r => r.name)
    .filter(name => name !== group.name)
    .sort((a, b) => a.localeCompare(b));

/** A correction with nothing kept of its time: its time and when it worked are not zero but unknown. */
export const timeless = (group: ProjectGroup) => group.agentMs === 0 && group.lastAt === null;
