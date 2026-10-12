import {Cdp, type Browser} from './cdp.js';
import {deadline} from './deadline.js';
import type {Metrics} from './report.js';

const counters = ['Timestamp', 'ScriptDuration', 'TaskDuration', 'ThreadTime', 'DevToolsCommandDuration', 'V8CompileDuration', 'LayoutDuration', 'RecalcStyleDuration'] as const;
type Reading = {before: Metrics; after: Metrics};
type Files = {save(name: string, value: unknown): void};

const metrics = async (cdp: Cdp, signal: AbortSignal): Promise<Metrics> => {
  const reply = await cdp.send<{metrics: {name: string; value: number}[]}>('Performance.getMetrics', {}, signal);
  return Object.fromEntries(reply.metrics.filter(metric => counters.includes(metric.name as typeof counters[number])).map(metric => [metric.name, metric.value]));
};
const valid = (before: Metrics, after: Metrics) => counters.every(key => Number.isFinite(before[key]) && Number.isFinite(after[key]) && after[key] >= before[key]);

/** A separate session leaves the benchmark's elapsed-time counters and interval intact. */
export async function timeIdle<T extends Reading>(cdp: Cdp, browser: Browser, run: () => Promise<T>, evidence: Files, connect = Cdp.connect) {
  if (!browser.owned || !cdp.endpoint) throw new Error('Idle timing requires an owned browser target');
  let thread: Cdp | undefined, before: Metrics | undefined, after: Metrics | undefined, value: T | undefined;
  let stage = 'connect', enabled = false, cleanup = 'complete';
  try {
    try {
      await deadline(2000, async signal => {
        thread = await connect(cdp.endpoint!, signal);
        stage = 'enable'; enabled = true;
        await thread.send('Performance.enable', {timeDomain: 'threadTicks'}, signal);
        stage = 'before'; before = await metrics(thread, signal);
      }, browser.owner?.signal);
      stage = 'idle';
    } catch {/* An unavailable thread clock never replaces the original measurement. */}
    value = await run();
    if (before && thread) {
      stage = 'after';
      try {after = await deadline(2000, signal => metrics(thread!, signal), browser.owner?.signal);} catch {/* Keep the missing endpoint explicit. */}
    }
  } finally {
    const started = performance.now();
    if (thread) {
      try {if (enabled) await deadline(2000, signal => thread!.send('Performance.disable', {}, signal));}
      catch {cleanup = 'incomplete'; browser.owner?.failures.push('Idle thread clock cleanup unconfirmed');}
      finally {thread.close();}
    }
    const complete = !!(value && before && after && cleanup === 'complete' && valid(before, after) && valid(value.before, value.after)
      && before.Timestamp <= value.before.Timestamp && value.before.Timestamp <= value.after.Timestamp && value.after.Timestamp <= after.Timestamp);
    evidence.save('idle-timing', {
      mode: 'diagnostic', status: complete ? 'complete' : 'insufficient-evidence', stage, cleanup, cleanupMs: performance.now() - started,
      kind: 'Raw thread CPU counters bracket the unchanged elapsed measurement; probe and observer overhead are included and unqualified.',
      thread: {before: before ?? null, after: after ?? null},
      measurement: value ? {before: Object.fromEntries(counters.map(key => [key, value!.before[key]])), after: Object.fromEntries(counters.map(key => [key, value!.after[key]]))} : null,
    });
  }
  return value!;
}
