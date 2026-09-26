import type {Counted} from './probe.js';

/**
 * What an idle dashboard may cost, per second of watching it (index.ts, `--ci`).
 *
 * Before the page was driven by events (commit 6f04eed), the bench job of CI run
 * 36269781391 measured it three times at 1.45, 1.54 and 1.51 ms of script a second
 * (Chrome's ScriptDuration less the probe's own time): 1.50 on average, with runs apart by
 * less than a tenth. An idle page now spends at most a fifth of that.
 */
export const IDLE_SCRIPT_MS_PER_SECOND = 0.3;

/** A measurement shows on its card within this, for 95 of 100. */
export const LATENCY_P95_MS = 1000;

/** The chart and the table: they move on with time a cell of the history's grid at a time. */
const ANALYTICS = new Set(['chart', 'table']);

/** What the idle page did over its window. */
export type Idle = {
  from: number;
  to: number;
  /** The cell of the history on screen. */
  cellMs: number;
  requests: {count: number; byPath: Record<string, number>};
  /** What the hub told the benchmark's own reader of the board. */
  events: Record<string, number>;
  renders: Counted[];
  mutations: Counted[];
  scriptMsPerSecond: number;
};

/**
 * What an idle page did that it may not: ask the hub anything, be told anything but
 * `ping`, render or change anything but what shows time, show time more often than it
 * reads otherwise (a label once a minute, the chart and the table once a cell), or spend
 * more script than its budget.
 */
export function idleProblems(idle: Idle): string[] {
  const found: string[] = [];
  const minutes = Math.ceil((idle.to - idle.from) / 60_000);
  const cells = Math.floor(idle.to / idle.cellMs) - Math.floor(idle.from / idle.cellMs);
  if (idle.requests.count) found.push(`the page asked the hub ${idle.requests.count} times: ${JSON.stringify(idle.requests.byPath)}`);
  const told = Object.entries(idle.events).filter(([type]) => type !== 'ping');
  if (told.length) found.push(`the hub told the board ${told.map(([type, count]) => `${type} ×${count}`).join(', ')}`);
  for (const [what, parts] of [
    ['rendered', idle.renders],
    ['changed', idle.mutations],
  ] as const) {
    const outside = parts.filter(part => !part.time);
    if (outside.length) found.push(`${what} outside what shows time: ${outside.map(part => `${part.region} ${part.node} ×${part.count}`).join(', ')}`);
    for (const part of parts.filter(part => part.time)) {
      const most = (part.kind && ANALYTICS.has(part.kind) ? cells : minutes) + 1;
      if (part.count > most) found.push(`${part.region} ${part.node} ${what} ${part.count} times, more than ${most}`);
    }
  }
  if (idle.scriptMsPerSecond > IDLE_SCRIPT_MS_PER_SECOND) found.push(`script took ${idle.scriptMsPerSecond} ms a second, more than ${IDLE_SCRIPT_MS_PER_SECOND}`);
  return found;
}

/** The value `share` of the samples are at or under. */
export function percentile(samples: number[], share: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] ?? NaN;
}

/**
 * What measurements of one card did beyond it: rendering anything but the card, the list
 * of agents and the analytics, or changing another card or the header (what shows time
 * is the clock, not this). And how late they showed on their card.
 */
export function measuredProblems(card: string, latencies: number[], renders: Counted[], mutations: Counted[]): string[] {
  const found: string[] = [];
  const p95 = percentile(latencies, 0.95);
  if (!(p95 <= LATENCY_P95_MS)) found.push(`a measurement showed on its card in ${Math.round(p95)} ms at the 95th percentile, more than ${LATENCY_P95_MS}`);
  const own = `card:${card}`;
  const beyond = renders.filter(part => !part.time && ![own, 'agents', 'analytics'].includes(part.region));
  if (beyond.length) found.push(`measurements of ${card} rendered ${beyond.map(part => `${part.region} ${part.node} ×${part.count}`).join(', ')}`);
  const changed = mutations.filter(part => !part.time && ((part.region.startsWith('card:') && part.region !== own) || part.region === 'header'));
  if (changed.length) found.push(`measurements of ${card} changed ${changed.map(part => `${part.region} ${part.node} ×${part.count}`).join(', ')}`);
  return found;
}
