/**
 * The projects of the reader's machines, and the corrections they make (server/domain/projects.ts).
 * Requests name the groups as the tab shows them; the hub works out which reported names
 * they gather, so a correction with no work kept and a name reported meanwhile go along.
 */

/** A project as the hub lists it: the name shown, the reported names it gathers, and its machines. */
export type ProjectGroup = {
  /** Null for work without a project. */
  name: string | null;
  /** When its agents last worked; null for a correction with no work kept. */
  lastAt: number | null;
  machines: {id: string; name: string}[];
  reported: string[];
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
  group.reported.filter(name => name !== group.name).sort((a, b) => a.localeCompare(b));

/** A correction with no work kept: when it worked is not known. */
export const timeless = (group: ProjectGroup) => group.lastAt === null;
