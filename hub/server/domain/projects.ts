/**
 * The projects of a person's machines as they correct them (spec: Reporting running
 * agents). A correction maps a name their machines report to the name it is shown and
 * counted under; names are kept as reported and corrected when read, so a correction
 * applies to all time kept, and taking it back restores the reported name.
 */

/** Names of projects are as long as agents send them, in characters. */
export const PROJECT_NAME_CHARS = 120;

/** A project as a person's tab lists it: every name that is shown under it, with their machines' time. */
export type ProjectGroup = {
  /** The name shown; null for time without a project. */
  name: string | null;
  agentMs: number;
  /** When its agents last worked; null for a correction with no time kept. */
  lastAt: number | null;
  machines: {id: string; name: string}[];
  /** The reported names it gathers, its own among them, by name; none for time without a project. */
  reported: {name: string; agentMs: number}[];
};

/** Time a person's machine worked under a reported name ('' for none). */
export type ReportedWork = {reported: string; machine: {id: string; name: string}; agentMs: number; lastAt: number};

/**
 * The reported names a group gathers: those corrected to its name, and the name itself
 * unless corrected to another, when their machines reported it or nothing is corrected to
 * it (a name given before any time came). A name nothing leads to that was never reported
 * is not a member of a group corrected to it: renaming `a` to `X` and then `X` to `Y`
 * corrects only `a`.
 */
export function members(group: string, names: Map<string, string>, sent: Set<string>): string[] {
  const found = [...names].filter(([, name]) => name === group).map(([reported]) => reported);
  if (!names.has(group) && (sent.has(group) || !found.length)) found.push(group);
  return found;
}

/** A person's projects, most recently worked on first, then by name; time without a project last. */
export function projectGroups(work: ReportedWork[], names: Map<string, string>): ProjectGroup[] {
  const groups = new Map<string | null, ProjectGroup & {byReported: Map<string, number>}>();
  const group = (reported: string) => {
    const name = reported === '' ? null : (names.get(reported) ?? reported);
    let found = groups.get(name);
    if (!found) groups.set(name, (found = {name, agentMs: 0, lastAt: null, machines: [], reported: [], byReported: new Map()}));
    if (name !== null) found.byReported.set(reported, found.byReported.get(reported) ?? 0);
    return found;
  };
  for (const {reported, machine, agentMs, lastAt} of work) {
    const found = group(reported);
    found.agentMs += agentMs;
    found.lastAt = Math.max(found.lastAt ?? lastAt, lastAt);
    if (!found.machines.some(m => m.id === machine.id)) found.machines.push(machine);
    if (found.name !== null) found.byReported.set(reported, found.byReported.get(reported)! + agentMs);
  }
  // A correction with no time kept is still listed, under the name it gives.
  for (const reported of names.keys()) group(reported);
  const byName = (a: string, b: string) => a.localeCompare(b);
  return [...groups.values()]
    .map(({byReported, ...found}) => ({
      ...found,
      machines: found.machines.sort((a, b) => byName(a.name, b.name) || byName(a.id, b.id)),
      reported: [...byReported].map(([name, agentMs]) => ({name, agentMs})).sort((a, b) => byName(a.name, b.name)),
    }))
    .sort((a, b) => Number(a.name === null) - Number(b.name === null) || (b.lastAt ?? -Infinity) - (a.lastAt ?? -Infinity) || byName(a.name ?? '', b.name ?? ''));
}
