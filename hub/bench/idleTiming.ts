import {Cdp, type Browser} from './cdp.js';
import {deadline} from './deadline.js';
import type {Metrics} from './report.js';
import {traceInterval} from './panningDiagnostic.js';

const counters = ['Timestamp', 'ScriptDuration', 'TaskDuration', 'ThreadTime', 'DevToolsCommandDuration', 'V8CompileDuration', 'LayoutDuration', 'RecalcStyleDuration'] as const;
type Reading = {before: Metrics; after: Metrics; reading?: {instrumentMs: number}; actualSeconds?: number};
type Files = {save(name: string, value: unknown): void; saveTrace?(name: string, value: unknown): void};

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
    const instrumentMs = value?.reading?.instrumentMs, actualSeconds = value?.actualSeconds;
    const exact = !!value && Number.isFinite(instrumentMs) && instrumentMs! >= 0 && Number.isFinite(actualSeconds) && actualSeconds! > 0 && actualSeconds === value.after.Timestamp - value.before.Timestamp;
    evidence.save('idle-timing', {
      mode: 'diagnostic', status: complete ? 'complete' : 'insufficient-evidence', stage, cleanup, cleanupMs: performance.now() - started,
      kind: 'Raw thread CPU counters bracket the unchanged elapsed measurement; probe and observer overhead are included and unqualified.',
      thread: {before: before ?? null, after: after ?? null},
      measurement: value ? {status: exact ? 'complete' : 'insufficient-evidence', before: Object.fromEntries(counters.map(key => [key, value!.before[key]])), after: Object.fromEntries(counters.map(key => [key, value!.after[key]])),
        instrumentMs: Number.isFinite(instrumentMs) ? instrumentMs : null,
        actualSeconds: Number.isFinite(actualSeconds) ? actualSeconds : null} : null,
    });
  }
  return value!;
}

/** Read version provenance after timing and secondary-session cleanup. */
export async function idleTimingVersion(cdp: Cdp, browser: Browser, evidence: Files) {
  let version: {product?: unknown; revision?: unknown; jsVersion?: unknown; protocolVersion?: unknown} | undefined;
  try {version = await deadline(2000, signal => cdp.send('Browser.getVersion', {}, signal), browser.owner?.signal);}
  catch {/* Version availability cannot replace the already saved original outcome. */}
  const kept = (field: unknown, pattern: RegExp) => typeof field === 'string' && field.length <= 80 && pattern.test(field) ? field : null;
  const product = kept(version?.product, /^(?:HeadlessChrome|Chrome|Chromium)\/[0-9]+(?:\.[0-9]+){1,3}$/);
  const revision = kept(version?.revision, /^@?[a-f0-9]{40}$/i);
  const jsVersion = kept(version?.jsVersion, /^[0-9]+(?:\.[0-9]+)+(?:[-+][a-z0-9.-]+)?$/i);
  const protocolVersion = kept(version?.protocolVersion, /^[0-9]+\.[0-9]+$/);
  evidence.save('idle-timing-browser-version', {mode: 'diagnostic', status: product && revision && jsVersion && protocolVersion ? 'complete' : 'insufficient-evidence',
    chromium: {version: product, sha: revision?.replace(/^@/, '').toLowerCase() ?? null}, v8: {version: jsVersion}, protocol: {version: protocolVersion}});
  return !!(product && revision && jsVersion && protocolVersion);
}

/** Timer evidence wraps the same original reading; no other board or clock drives it. */
export async function traceIdle<T extends Reading>(cdp: Cdp, browser: Browser, run: () => Promise<T>, evidence: Files, connect = Cdp.connect) {
  return traceInterval(cdp, browser, async () => {
    const value = await timeIdle(cdp, browser, run, evidence, connect);
    await idleTimingVersion(cdp,browser,evidence);
    return value;
  }, {
    save: (name, value) => evidence.save('idle-timing-' + name, value),
    saveTrace: (name, value) => evidence.saveTrace ? evidence.saveTrace('idle-timing-' + name, value) : evidence.save('idle-timing-' + name, value),
  }, true);
}
