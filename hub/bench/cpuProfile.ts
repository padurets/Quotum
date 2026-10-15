import {deadline} from './deadline.js';
import {panning} from './panning.js';
import type {Browser, Cdp} from './cdp.js';
import {openTab} from './cdp.js';
import {clientIdentity} from './evidence.js';
import {ScriptBinding} from './scriptBinding.js';
import {panningProblems, type PanReading} from './panningBudget.js';
import {percentile} from './budget.js';

type Profile = {startTime: number; endTime: number; nodes: {
  id: number; hitCount?: number; children?: number[];
  callFrame: {functionName: string; scriptId: string; url: string; lineNumber: number; columnNumber: number};
}[]; samples?: number[]; timeDeltas?: number[]};
type Files = {save(name: string, value: unknown): void; saveTrace?(name: string, value: unknown): void};
type Clock = {stage: string; before: number | null; page: number; after: number | null; valid: boolean};
const LIMIT = 100_000;
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const kinds = new Set(['(root)', '(program)', '(idle)', '(garbage collector)', 'getBoundingClientRect', 'getComputedStyle', 'getAnimations']);

/** Allocation ancestry has no timestamps; self sizes exclude children. */
export function numericAllocations(profile: unknown) {
  type Node = {id: unknown; selfSize: unknown; callFrame?: {scriptId?: unknown; lineNumber?: unknown; columnNumber?: unknown}; children?: unknown};
  const head = (profile as {head?: unknown} | null)?.head;
  const pending = [{children: [head] as unknown[], index: 0, parent: null as number | null}];
  const nodes: {id: number; parent: number | null; selfSize: number | null; rendererScriptId: number | null; line: number | null; column: number | null}[] = [];
  const seen = new Set<unknown>();
  let invalid = 0, selfSize = 0, visited = 0;
  while (pending.length && visited < 10_000) {
    const part = pending.at(-1)!;
    if (part.index === part.children.length) {pending.pop(); continue;}
    visited++;
    const value = part.children[part.index++] as Node | null;
    if (!value || typeof value !== 'object' || !integer(value.id) || seen.has(value.id)) {invalid++; continue;}
    seen.add(value.id);
    const size = typeof value.selfSize === 'number' && Number.isFinite(value.selfSize) && value.selfSize >= 0 ? value.selfSize : null;
    const frame = value.callFrame, rawId = frame?.scriptId;
    const rendererScriptId = typeof rawId === 'string' && /^[1-9]\d*$/.test(rawId) && integer(Number(rawId), 1) ? Number(rawId) : null;
    const line = integer(frame?.lineNumber, -1) ? frame.lineNumber : null;
    const column = integer(frame?.columnNumber, -1) ? frame.columnNumber : null;
    if (size === null || line === null || column === null || !Array.isArray(value.children)) invalid++;
    selfSize += size ?? 0;
    const id = nodes.length + 1;
    nodes.push({id, parent: part.parent, selfSize: size, rendererScriptId, line, column});
    if (Array.isArray(value.children) && value.children.length) pending.push({children: value.children, index: 0, parent: id});
  }
  const omittedAtLeast = pending.reduce((total, part) => total + part.children.length - part.index, 0);
  const complete = !invalid && !omittedAtLeast && Number.isFinite(selfSize);
  const report = {status: complete ? 'complete' : 'insufficient-evidence', nodes, invalid, omittedAtLeast,
    selfSizeLowerBound: Number.isFinite(selfSize) ? selfSize : null, totalKnown: complete};
  const bytes = Buffer.byteLength(JSON.stringify(report));
  return bytes <= 1024 * 1024 ? report : {status: 'insufficient-evidence', reason: 'allocation byte limit', bytes, nodes: nodes.length, invalid, omittedAtLeast,
    selfSizeLowerBound: report.selfSizeLowerBound, totalKnown: false};
}

/** Only the original budget/24h CPU diagnostic requests transient allocation ancestry. */
class AllocationSampling {
  enabled = false;
  active = false;
  stopped = false;
  disabled = false;
  available = false;
  profile: unknown;
  version: unknown;
  constructor(private readonly cdp: Cdp) {}
  async start(signal: AbortSignal) {
    try {
      this.enabled = true;
      await this.cdp.send('HeapProfiler.enable', {}, signal);
      this.active = true;
      await this.cdp.send('HeapProfiler.startSampling', {samplingInterval: 32768, stackDepth: 128,
        includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true}, signal);
      this.available = true;
    } catch {
      // A confirmed disable lets an unsupported sampler leave the original workload intact.
      try {
        await this.cdp.send('HeapProfiler.disable', {}, signal);
        this.active = false; this.disabled = true;
      } catch (error) {
        // An unavailable domain never received a sampling start. A lost start is different.
        if (this.active || signal.aborted) throw error;
      }
    }
  }
  async stop(signal: AbortSignal) {
    if (!this.enabled || this.disabled || (!this.active && !this.available)) return;
    try {
      if (this.active) {
        const reply = await this.cdp.send<{profile: unknown}>('HeapProfiler.stopSampling', {}, signal);
        this.profile = reply.profile; this.active = false; this.stopped = true;
      }
    } finally {
      await this.cdp.send('HeapProfiler.disable', {}, signal);
      this.active = false; this.disabled = true;
    }
    try {
      const value = await this.cdp.send<{product?: string; revision?: string; jsVersion?: string; protocolVersion?: string}>('Browser.getVersion', {}, signal);
      const dotted = (text: unknown) => typeof text === 'string' && text.length <= 120 && /^\d+(?:\.\d+)+$/.test(text) ? text : null;
      this.version = {chromium: {version: dotted(value.product?.replace(/^Chrome\//, '')), sha: /^@?[a-f\d]{40}$/.test(value.revision ?? '') ? value.revision!.replace(/^@/, '') : null},
        v8: {version: dotted(value.jsVersion)}, protocol: {version: dotted(value.protocolVersion)}};
    } catch {/* Missing runtime attestation does not establish flag support. */}
  }
  report() {
    const profile = this.stopped ? numericAllocations(this.profile) : undefined;
    const report = {mode: 'diagnostic', kind: 'sampled allocation ancestry without timestamps; observer overhead unqualified',
      status: this.disabled && this.available && profile?.status === 'complete' ? 'complete' : !this.active && !this.available && !this.stopped ? 'unavailable' : 'insufficient-evidence',
      parameters: {samplingInterval: 32768, maxFrames: 128, minor: true, major: true}, collection: 'requested flags; runtime semantics unqualified',
      enabled: this.enabled, active: this.active, stopped: this.stopped, disabled: this.disabled, available: this.available,
      version: this.version, profile};
    const bytes = Buffer.byteLength(JSON.stringify(report));
    return bytes <= 1024 * 1024 ? report : {...report, status: 'insufficient-evidence',
      profile: {status: 'insufficient-evidence', reason: 'allocation receipt byte limit', bytes}};
  }
}

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

/** Sampling reports elapsed sample widths, including throttling; these are not thread CPU clocks. */
export async function profileInterval<T>(cdp: Cdp, browser: Browser, run: () => Promise<T>, evidence?: Files, samplingInterval: 1000 | 2000 = 1000, allocations = false) {
  if (!browser.owned) throw new Error('CPU profiling requires an owned synthetic browser');
  const clocks: Clock[] = [];
  const clock = async (stage: string, signal: AbortSignal) => {
    const stamp = async () => (await cdp.send<{metrics: {name: string; value: number}[]}>('Performance.getMetrics', {}, signal)).metrics.find(metric => metric.name === 'Timestamp')?.value;
    const before = await stamp(), page = await cdp.evaluate<number>('performance.now()', signal), after = await stamp();
    const valid = Number.isFinite(before) && Number.isFinite(after) && Number.isFinite(page) && before! <= after!;
    clocks.push({stage, before: Number.isFinite(before) ? before! * 1000 : null, page, after: Number.isFinite(after) ? after! * 1000 : null, valid});
    evidence?.save('clock', {clocks});
  };
  let enabled = false, active = false, succeeded = false, stopped = false, cleanup = 'complete';
  let profile: ReturnType<typeof numericProfile> | undefined;
  let captured: Profile | undefined;
  const drain = {stage: 'inactive', elapsedMs: 0};
  const heap = allocations ? new AllocationSampling(cdp) : undefined;
  try {
    await deadline(5000, async signal => {
      enabled = true;
      await cdp.send('Profiler.enable', {}, signal);
      await cdp.send('Profiler.setSamplingInterval', {interval: samplingInterval}, signal);
      await clock('start', signal);
      active = true;
      await cdp.send('Profiler.start', {}, signal);
      if (heap) await heap.start(signal);
    }, browser.owner?.signal);
    const result = await run(); succeeded = true; return result;
  } finally {
    const started = performance.now();
    if (enabled) try {
      await deadline(5000, async signal => {
        if (active) {
          drain.stage = 'clock';
          try {await deadline(1000, endSignal => clock('end', endSignal), signal);} catch {/* Missing calibration stays visible. */}
          drain.stage = 'stop-command';
          const reply = await cdp.send<{profile: Profile}>('Profiler.stop', {}, signal);
          if (heap) captured = reply.profile;
          active = false; stopped = true;
          // Disable before host-side sanitization can delay another browser command.
          drain.stage = 'disable';
          await cdp.send('Profiler.disable', {}, signal);
          if (heap) {drain.stage = 'allocation-stop'; await heap.stop(signal);}
          drain.stage = 'sanitize';
          profile = numericProfile(reply.profile);
        } else await cdp.send('Profiler.disable', {}, signal);
        drain.stage = 'complete';
      });
    } catch {
      if (heap?.stopped && heap.disabled && (drain.stage === 'allocation-stop' || drain.stage === 'complete')) drain.stage = 'allocation-version-unavailable';
      else {cleanup = 'incomplete'; browser.owner?.failures.push('CPU profile cleanup unconfirmed');}
    }
    if (!profile && captured) profile = numericProfile(captured);
    drain.elapsedMs = performance.now() - started;
    const report = {mode: 'diagnostic', kind: 'sampled elapsed widths, not thread CPU time; observer overhead unqualified',
      status: cleanup === 'complete' && stopped && profile?.status === 'complete' && bridge(clocks) ? 'complete' : 'insufficient-evidence',
      samplingInterval, clocks, cleanup, drain, profile};
    if (evidence?.saveTrace) evidence.saveTrace('profile', report); else evidence?.save('profile', report);
    if (heap) evidence?.save('allocations', heap.report());
    if (cleanup === 'incomplete') try {await deadline(8000, () => browser.close());} catch {browser.owner?.failures.push('CPU diagnostic browser cleanup unconfirmed');}
    if (cleanup === 'incomplete' && succeeded) throw new Error('CPU profile cleanup failed at ' + drain.stage);
  }
}

/** Each original CPU4 scenario owns its profile; no workload or budget is changed. */
export async function profilePanning(cdp: Cdp, browser: Browser, evidence?: Files, run = panning, client = clientIdentity()) {
  if (!browser.owned) throw new Error('CPU profiling requires an owned synthetic browser');
  let active: Promise<unknown> | undefined, release = () => {}, interval = 0, familyStart = 0;
  let selected = false, allocationSelected = false, selectedInterval: number | null = null, selectedReport: PanReading | undefined;
  const binding = new ScriptBinding(cdp, client, (name, value) => evidence?.save('cpu-' + name, value));
  const stop = async () => {if (active) {release(); const pending = active; active = undefined; await pending;}};
  const measured = {on: cdp.on.bind(cdp), off: cdp.off.bind(cdp), at: cdp.at?.bind(cdp),
    evaluate: async<T>(expression: string, signal?: AbortSignal): Promise<T> => {
      const value = await cdp.evaluate<T>(expression, signal);
      if (expression.startsWith('(() => {\n        const initiator=') && expression.includes('const probe=window.__quotumPan={') && expression.includes('probe.raf=schedule(tick);')) {
        binding.rememberInjected(interval + 1, expression);
        selected = expression.includes('const initiator="budget",period="24h";') && !allocationSelected;
        selectedReport = undefined;
      }
      if (selected && expression.startsWith('(() => {\n        const p=window.__quotumPan;p.cleanup();')) selectedReport = value as PanReading;
      // The original cleanup follows both periods and all extra family checks.
      if (expression === `document.getElementById('quotum-pan-layout')?.remove()`) {
        await stop();
        await binding.afterFamily(Array.from({length: interval - familyStart}, (_, index) => familyStart + index + 1));
        familyStart = interval;
      }
      return value;
    },
    send: async<T = unknown>(method: string, params: object = {}, signal?: AbortSignal): Promise<T> => {
      const rate = (params as {rate?: number}).rate;
      if (method === 'Emulation.setCPUThrottlingRate' && rate === 4) {
        await stop(); const id = ++interval;
        if (selected) {allocationSelected = true; selectedInterval = id;}
        let ready = () => {};
        const started = new Promise<void>(resolve => {ready = resolve;});
        active = profileInterval(cdp, browser, () => {ready(); return new Promise(resolve => {release = () => resolve(undefined);});}, {
          save: (name, value) => evidence?.save('cpu-' + id + '-' + name, value),
          saveTrace: (name, value) => evidence?.saveTrace ? evidence.saveTrace('cpu-' + id + '-' + name, value) : evidence?.save('cpu-' + id + '-' + name, value),
        }, 1000, selected);
        await Promise.race([started, active]);
      } else if (method === 'Emulation.setCPUThrottlingRate' && rate === 1) {
        if (selectedReport) {
          evidence?.save('cpu-' + interval + '-original-result', {mode: 'diagnostic', initiator: selectedReport.initiator, period: selectedReport.period,
            frames: {count: selectedReport.frames.length, p95: percentile(selectedReport.frames, .95), p99: percentile(selectedReport.frames, .99)},
            inputs: {count: selectedReport.inputs, measured: selectedReport.latency.length, p95: percentile(selectedReport.latency, .95)},
            problems: panningProblems(selectedReport).map(reason => ({reason}))});
        }
        await stop();
      }
      return cdp.send<T>(method, params, signal);
    }};
  let failed = false;
  try {return await run(measured, undefined, {timeline: true, save: (name, value) => evidence?.save('cpu-' + name, value)});}
  catch (error) {failed = true; throw error;}
  finally {
    binding.close();
    evidence?.save('cpu-allocation-selection', {mode: 'diagnostic', status: allocationSelected ? 'selected' : 'unavailable', interval: selectedInterval});
    try {await stop();} catch (error) {if (!failed) throw error;}
  }
}

/** Fixed sampler and clock controls follow the original scenarios on an empty owned tab. */
export async function profileControls(browser: Browser, evidence: Files) {
  if (!browser.owned) throw new Error('CPU profile controls require an owned synthetic browser');
  const tab = await openTab(browser), intervals: {kind: string; rate: number; from: number; to: number}[] = [];
  let reading: {status: string; clocks: Clock[]; profile?: ReturnType<typeof numericProfile>} | undefined;
  try {
    await tab.cdp.send('Performance.enable');
    await profileInterval(tab.cdp, browser, async () => {
      for (const rate of [1, 4]) {
        await tab.cdp.send('Emulation.setCPUThrottlingRate', {rate});
        for (const kind of ['busy', 'timer', 'busy']) {
          const interval = await tab.cdp.evaluate<{from: number; to: number}>(`(async()=>{
            await new Promise(requestAnimationFrame);
            const from=performance.now();
            ${kind === 'busy' ? 'while(performance.now()-from<100){}' : 'await new Promise(resolve=>setTimeout(resolve,100));'}
            const to=performance.now();
            await new Promise(requestAnimationFrame);
            return {from,to};
          })()`);
          intervals.push({kind, rate, ...interval});
          evidence.save('cpu-control-intervals', {mode: 'diagnostic', intervals});
        }
      }
      await tab.cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
    }, {save: (name, value) => evidence.save('cpu-control-' + name, value), saveTrace: (name, value) => {
      reading = value as typeof reading;
      if (evidence.saveTrace) evidence.saveTrace('cpu-control-' + name, value); else evidence.save('cpu-control-' + name, value);
    }});
    const reports = intervals.map(interval => ({...interval, ...(reading?.profile ? profileWindow(reading.profile, reading.clocks, interval.from, interval.to) : {status: 'insufficient-evidence'})}));
    const valid = reading?.status === 'complete' && reports.length === 6 && reports.every(report => report.status === 'observed')
      && reports.filter(report => report.rate === 1).every(report => 'certainFunctionSamples' in report && 'possibleFunctionSamples' in report
        && (report.kind === 'busy' ? report.certainFunctionSamples! >= 20 : report.possibleFunctionSamples! < 20));
    evidence.save('cpu-controls', {mode: 'diagnostic', status: valid ? 'passed' : 'insufficient-evidence', intervals: reports});
    if (!valid) throw new Error('CPU sample controls did not distinguish execution from timer waiting');
  } finally {await tab.close();}
}
