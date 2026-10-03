import {DAY, type DemoSet} from '../demo/model.js';

/** Twelve real sources continue beyond the 30d strip's rebuild and read-ahead edges. */
export function panningSet(set: DemoSet): DemoSet {
  let count = 0;
  return {...set, workHistoryMs: 75 * DAY, entries: set.entries.map(entry => entry.kind === 'card' && count++ < 12 ? {...entry, history: Math.max(entry.history, 75 * DAY), agents: entry.agents?.map(agent => ({...agent, since: Math.min(agent.since, -75 * DAY)}))} : entry)};
}
