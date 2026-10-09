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

/** A measurement shows on its card and chart within this, for 95 of 100. */
export const LATENCY_P95_MS = 1000;
/** Ana's day measured up to 3.1 KB per update (rounded up); 1.5 times that is below a tenth of its former 364 KB. */
export const HISTORY_BYTES_PER_MEASUREMENT = 4650;

/** How often the hub tells a stream it is there (spec/dashboard-v1.md, `hello.heartbeatMs`). */
const HEARTBEAT_MS = 25_000;

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
 * What shows time rendered or changed more often than the clock alone would: a label once a
 * minute, the chart once a cell of the history's grid (a label past its right edge counts
 * down as a label of its own). A label past the edge is drawn, then measured: one counting
 * minutes renders twice a minute, and a board with one would need more; the bench's are
 * hours away.
 */
function tooOften(parts: Counted[], from: number, to: number, cellMs: number, what: string): string[] {
  const minutes = Math.ceil((to - from) / 60_000);
  const cells = Math.floor(to / cellMs) - Math.floor(from / cellMs);
  return parts.flatMap(part => {
    const most = (part.kind === 'chart' ? cells : minutes) + 1;
    return part.count > most ? [`${part.region} ${part.node} ${what} ${part.count} times, more than ${most}`] : [];
  });
}

/**
 * What an idle page did that it may not: ask the hub anything, be told anything but
 * `ping`, render or change anything but what shows time, show time more often than it
 * reads otherwise (a label once a minute, the chart once a cell), or spend
 * more script than its budget. And whether the benchmark could tell: its own reader of the
 * board heard the hub all along.
 */
export function idleProblems(idle: Idle): string[] {
  const found: string[] = [];
  if (idle.requests.count) found.push(`the page asked the hub ${idle.requests.count} times: ${JSON.stringify(idle.requests.byPath)}`);
  const told = Object.entries(idle.events).filter(([type]) => type !== 'ping');
  if (told.length) found.push(`the hub told the board ${told.map(([type, count]) => `${type} ×${count}`).join(', ')}`);
  const pings = idle.events.ping ?? 0;
  const least = Math.floor((idle.to - idle.from) / HEARTBEAT_MS) - 1;
  if (pings < least) found.push(`the benchmark's own reader of the board heard ${pings} pings, fewer than ${least}: it heard nothing it could count`);
  for (const [what, parts] of [
    ['rendered', idle.renders],
    ['changed', idle.mutations],
  ] as const) {
    const outside = parts.filter(part => !part.time);
    if (outside.length) found.push(`${what} outside what shows time: ${outside.map(part => `${part.region} ${part.node} ×${part.count}`).join(', ')}`);
    found.push(...tooOften(parts.filter(part => part.time), idle.from, idle.to, idle.cellMs, what));
  }
  if (idle.scriptMsPerSecond > IDLE_SCRIPT_MS_PER_SECOND) found.push(`script took ${idle.scriptMsPerSecond} ms a second, more than ${IDLE_SCRIPT_MS_PER_SECOND}`);
  return found;
}

/** The value `share` of the samples are at or under. */
export function percentile(samples: number[], share: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] ?? NaN;
}

/** What the measurements of one card were: how late each showed on it (`Infinity`: never), and what the page did over all of them, from `from` to `to`. */
export type Measured = {card: string; latencies: number[]; renders: Counted[]; mutations: Counted[]; from: number; to: number};

function latencyProblems(latencies: number[], where: 'card' | 'chart'): string[] {
  const found: string[] = [];
  const lost = latencies.filter(latency => !Number.isFinite(latency)).length;
  if (lost) found.push(`${lost} of ${latencies.length} measurements never showed on their ${where}`);
  const p95 = percentile(latencies, 0.95);
  if (!(p95 <= LATENCY_P95_MS)) found.push(`a measurement showed on its ${where} in ${Math.round(p95)} ms at the 95th percentile, more than ${LATENCY_P95_MS}`);
  return found;
}

/** Every chart point must arrive, independently of the latency percentile. */
export const chartProblems = (latencies: number[]) => latencyProblems(latencies, 'chart');

/**
 * What measurements of one card did beyond it: rendering anything but the card, the list
 * of agents and the analytics, or changing another card or the header; what shows time on
 * another card or the header, more often than the clock alone would. How late they showed
 * on their card, and whether each did at all. And whether the benchmark could tell: the
 * card was seen to render for them.
 */
export function measuredProblems({card, latencies, renders, mutations, from, to}: Measured): string[] {
  const found = latencyProblems(latencies, 'card');
  const lost = latencies.filter(latency => !Number.isFinite(latency)).length;
  const own = `card:${card}`;
  const seen = renders.filter(part => part.region === own && !part.time).reduce((sum, part) => Math.max(sum, part.count), 0);
  if (seen < latencies.length - lost) found.push(`the card rendered ${seen} times for ${latencies.length - lost} measurements shown: React's work is not seen`);
  return [...found, ...renderProblems({card, renders, mutations, from, to})];
}

/** Reports and measurements may render only their card, the agents and analytics. */
export function renderProblems({card, renders, mutations, from, to}: Omit<Measured, 'latencies'>): string[] {
  const found: string[] = [];
  const own = `card:${card}`;
  const beyond = renders.filter(part => !part.time && ![own, 'agents', 'analytics'].includes(part.region));
  if (beyond.length) found.push(`measurements of ${card} rendered ${beyond.map(part => `${part.region} ${part.node} ×${part.count}`).join(', ')}`);
  const changed = mutations.filter(part => !part.time && ((part.region.startsWith('card:') && part.region !== own) || part.region === 'header'));
  if (changed.length) found.push(`measurements of ${card} changed ${changed.map(part => `${part.region} ${part.node} ×${part.count}`).join(', ')}`);
  // What shows time elsewhere renders with the clock, as when idle, not with the measurements.
  const elsewhere = (part: Counted) => part.time && ((part.region.startsWith('card:') && part.region !== own) || part.region === 'header');
  found.push(...tooOften(renders.filter(elsewhere), from, to, Infinity, 'rendered'), ...tooOften(mutations.filter(elsewhere), from, to, Infinity, 'changed'));
  return found;
}

/** A subscription balance may update its own funds chart, never quota or wallet work. */
export function creditRenderProblems({card,renders,mutations,from,to,cellMs}:Omit<Measured,'latencies'>&{cellMs:number}):string[] {
  const found=renderProblems({card,renders,mutations,from,to});
  const ticks=Math.floor(to/cellMs)-Math.floor(from/cellMs);
  for(const [what,parts] of [['rendered',renders],['changed',mutations]] as const)for(const part of parts) {
    if(!part.widget||part.widget==='funds'||part.time&&part.kind!=='chart')continue;
    if(part.count>(part.kind==='chart'?ticks:0))found.push(`subscription credit ${what} ${part.widget} ${part.node} ×${part.count}`);
  }
  return found;
}

/** Private CPU work has no card or financial balance to update. */
export function privateWorkRenderProblems({renders,mutations,from,to,cellMs}:Omit<Measured,'latencies'|'card'>&{cellMs:number}):string[] {
  const found=renderProblems({card:'private-client-no-card',renders,mutations,from,to});
  const ticks=Math.floor(to/cellMs)-Math.floor(from/cellMs);
  for(const [what,parts] of [['rendered',renders],['changed',mutations]] as const)for(const part of parts) {
    if(!['budget','funds'].includes(part.widget??'')||part.time&&part.kind!=='chart')continue;
    if(part.count>(part.kind==='chart'?ticks:0))found.push(`private work ${what} ${part.widget} ${part.node} ×${part.count}`);
  }
  return found;
}
