import {DASHES, CATEGORY_COLORS} from './providers';
import type {PlotLine} from './lines';
import {OTHER_COLOR} from './activity';
import type {PlotGroup} from './historyPlot';

/** Preserve the seed and surviving entries; a new window takes a free dash slot. */
export function lineRegistry(seed: readonly PlotLine[], previous: readonly PlotLine[], candidates: readonly PlotLine[]): PlotLine[] {
  const original = new Set(seed.map(line => line.key));
  const current = new Map(candidates.map(line => [line.key, line]));
  const result = previous.filter(line => original.has(line.key) || current.has(line.key)).map(line => ({...(current.get(line.key) ?? {...line, points: [], blocks: []}), dash: line.dash}));
  for (const line of candidates) {
    if (result.some(old => old.key === line.key)) continue;
    const used = new Set(result.filter(old => old.sourceId === line.sourceId).map(old => old.dash));
    result.push({...line, dash: DASHES.find(dash => !used.has(dash)) ?? DASHES[result.filter(old => old.sourceId === line.sourceId).length % DASHES.length]});
  }
  return result;
}

export type GroupIdentity = Pick<PlotGroup, 'key' | 'name'> & {color: string};
export function groupRegistry(seed: readonly GroupIdentity[], previous: readonly GroupIdentity[], candidates: readonly Pick<PlotGroup, 'key' | 'name'>[], sourceColor?: (key: string) => string): GroupIdentity[] {
  const original = new Set(seed.map(group => group.key));
  const current = new Map(candidates.map(group => [group.key, group]));
  const result = previous.filter(group => original.has(group.key) || current.has(group.key)).map(group => ({...group, name: current.get(group.key)?.name ?? group.name}));
  for (const group of candidates) {
    if (result.some(old => old.key === group.key)) continue;
    const used = new Set(result.map(old => old.color));
    result.push({...group, color: sourceColor?.(group.key) ?? CATEGORY_COLORS.find(color => !used.has(color)) ?? OTHER_COLOR});
  }
  return result;
}
