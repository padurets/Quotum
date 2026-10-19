
type Profile = {startTime: number; endTime: number; nodes: {
  id: number; hitCount?: number; children?: number[];
  callFrame: {functionName: string; scriptId: string; url: string; lineNumber: number; columnNumber: number};
}[]; samples?: number[]; timeDeltas?: number[]};
type Clock = {stage: string; before: number | null; page: number; after: number | null; valid: boolean};
const LIMIT = 100_000;
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const kinds = new Set(['(root)', '(program)', '(idle)', '(garbage collector)', 'getBoundingClientRect', 'getComputedStyle', 'getAnimations']);

/** Call locations and numeric samples survive; names, URLs and deoptimization text do not. */
export function numericProfile(profile: Profile) {
  let invalid = 0, omittedChildren = 0, edges = 0;
  const scripts = new Map<string, number>();
  const nodes = profile.nodes.slice(0, LIMIT).flatMap(node => {
    if (!integer(node.id, 1)) {invalid++; return [];}
    const frame = node.callFrame;
    const scriptId = typeof frame.scriptId === 'string' ? frame.scriptId : '';
    if (!scripts.has(scriptId)) scripts.set(scriptId, scripts.size + 1);
    const children = (node.children ?? []).flatMap(id => {
      if (!integer(id, 1)) {invalid++; return [];}
      if (edges++ >= LIMIT) {omittedChildren++; return [];}
      return [id];
    });
    const line = integer(frame.lineNumber, -1) ? frame.lineNumber : null;
    const column = integer(frame.columnNumber, -1) ? frame.columnNumber : null;
    if (line === null || column === null) invalid++;
    return [{id: node.id, children, scriptId: scripts.get(scriptId),
      rendererScriptId: /^[1-9]\d*$/.test(scriptId) && Number.isSafeInteger(Number(scriptId)) ? Number(scriptId) : null, line, column,
      hitCount: integer(node.hitCount) ? node.hitCount : null,
      kind: kinds.has(frame.functionName) ? frame.functionName : 'function',
      sourceRole: typeof frame.url === 'string' && /\/assets\/index-[\w-]+\.js(?:[?#].*)?$/.test(frame.url) ? 1 : frame.url === '' ? 0 : 2}];
  });
  const samples = (profile.samples ?? []).slice(0, LIMIT).map(value => {if (integer(value, 1)) return value; invalid++; return null;});
  // V8 can report adjacent samples a few microseconds out of timestamp order.
  // Keep their signed deltas and original order; clipping changes later positions.
  const timeDeltas = (profile.timeDeltas ?? []).slice(0, LIMIT).map(value => {if (typeof value === 'number' && Number.isSafeInteger(value)) return value; invalid++; return null;});
  const reversedDeltas = timeDeltas.filter(value => value !== null && value < 0).length;
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length) invalid++;
  invalid += nodes.reduce((count, node) => count + node.children.filter(id => !ids.has(id)).length, 0);
  invalid += samples.filter(id => id !== null && !ids.has(id)).length;
  const omittedNodes = Math.max(0, profile.nodes.length - LIMIT), omittedSamples = Math.max(0, (profile.samples?.length ?? 0) - LIMIT), omittedDeltas = Math.max(0, (profile.timeDeltas?.length ?? 0) - LIMIT);
  const times = Number.isFinite(profile.startTime) && Number.isFinite(profile.endTime) && profile.startTime >= 0 && profile.endTime >= profile.startTime;
  const complete = times && !invalid && !omittedNodes && !omittedSamples && !omittedDeltas && !omittedChildren && samples.length > 0 && samples.length === timeDeltas.length;
  const report = {status: complete ? 'complete' : 'insufficient-evidence', startTime: times ? profile.startTime : null, endTime: times ? profile.endTime : null,
    nodes, samples, timeDeltas, reversedDeltas, invalid, omittedNodes, omittedSamples, omittedDeltas, omittedChildren};
  const bytes = Buffer.byteLength(JSON.stringify(report));
  return bytes <= 32 * 1024 * 1024 ? report : {status: 'insufficient-evidence', reason: 'profile byte limit', bytes};
}

function bridge(clocks: Clock[]) {
  if (clocks.length !== 2 || !clocks.every(clock => clock.valid)) return null;
  const from = Math.max(...clocks.map(clock => clock.before! - clock.page));
  const to = Math.min(...clocks.map(clock => clock.after! - clock.page));
  return Number.isFinite(from) && Number.isFinite(to) && from <= to ? {from, to} : null;
}

/** Bracket uncertainty bounds membership; sampling points do not prove continuous execution. */
export function profileWindow(profile: ReturnType<typeof numericProfile>, clocks: Clock[], from: number, to: number) {
  const offset = bridge(clocks);
  if (profile.status !== 'complete' || !('samples' in profile) || !offset || to <= from) return {status: 'insufficient-evidence'};
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  let stamp = profile.startTime! / 1000, certainSamples = 0, possibleSamples = 0, certainFunctionSamples = 0, possibleFunctionSamples = 0;
  for (const [index, id] of profile.samples.entries()) {
    stamp += profile.timeDeltas[index]! / 1000;
    const certain = stamp >= from + offset.to && stamp <= to + offset.from;
    const possible = stamp >= from + offset.from && stamp <= to + offset.to;
    if (certain) certainSamples++;
    if (possible) possibleSamples++;
    if (nodes.get(id!)?.kind === 'function') {if (certain) certainFunctionSamples++; if (possible) possibleFunctionSamples++;}
  }
  return {status: possibleSamples ? 'observed' : 'insufficient-evidence', offset, certainSamples, possibleSamples, certainFunctionSamples, possibleFunctionSamples};
}
