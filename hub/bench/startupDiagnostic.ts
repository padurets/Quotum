import {readFile, readdir, statfs} from 'node:fs/promises';
import {ChromeLaunchError, launchChrome, type LaunchReport} from './chrome.js';
import type {Evidence} from './evidence.js';
import type {RunOwner} from './runOwner.js';

const read = (file: string) => readFile(file, 'utf8').catch(() => null);

/** Linux proc counters only; process names and raw file contents never enter evidence. */
export function processCounters(stat: string | null) {
  if (!stat) return null;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (fields.length < 40 || !/^[RSDZTtXxKWPI]$/.test(fields[0])) return null;
  const number = (index: number) => /^\d+$/.test(fields[index] ?? '') ? Number(fields[index]) : null;
  return {state: fields[0], parent: number(1), birth: number(19), minorFaults: number(7), majorFaults: number(9),
    userTicks: number(11), systemTicks: number(12), threads: number(17), blockIoTicks: number(39)};
}

export function pressureCounters(text: string | null) {
  if (text === null) return null;
  return Object.fromEntries([...text.matchAll(/^(some|full) .*\btotal=(\d+)$/gm)].map(match => [match[1], Number(match[2])]));
}

export function namedCounters(text: string | null, names: string[]) {
  if (text === null) return null;
  const allowed = new Set(names);
  return Object.fromEntries(text.trim().split('\n').flatMap(line => {
    const match = /^([a-zA-Z_]+):?\s+(\d+)(?: kB)?$/.exec(line);
    return match && allowed.has(match[1]) ? [[match[1], Number(match[2])]] : [];
  }));
}

async function taskCounters(pid: number, birth: number) {
  const before = processCounters(await read(`/proc/${pid}/stat`));
  if (before?.birth !== birth) return null;
  const [io, schedule, channel] = await Promise.all([read(`/proc/${pid}/io`), read(`/proc/${pid}/schedstat`), read(`/proc/${pid}/wchan`)]);
  const after = processCounters(await read(`/proc/${pid}/stat`));
  if (after?.birth !== birth) return null;
  const sched = schedule?.trim().split(/\s+/);
  return {pid, ...after, io: namedCounters(io, ['rchar', 'wchar', 'read_bytes', 'write_bytes', 'cancelled_write_bytes']),
    schedule: sched?.length === 3 && sched.every(value => /^\d+$/.test(value)) ? {cpuNs: Number(sched[0]), waitNs: Number(sched[1]), slices: Number(sched[2])} : null,
    wait: {reason: channel && /^[a-zA-Z_][a-zA-Z0-9_]{0,100}\n?$/.test(channel) ? channel.trim() : 'unavailable'}};
}

async function machineCounters() {
  const [cpu, memory, io, ticks, free, throttling, shm] = await Promise.all([
    read('/proc/pressure/cpu'), read('/proc/pressure/memory'), read('/proc/pressure/io'), read('/proc/stat'), read('/proc/meminfo'),
    read('/sys/fs/cgroup/cpu.stat'), statfs('/dev/shm').catch(() => null),
  ]);
  const cpuTicks = ticks?.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  return {pressure: {cpu: pressureCounters(cpu), memory: pressureCounters(memory), io: pressureCounters(io)}, cpuTicks,
    memory: namedCounters(free, ['MemAvailable', 'SwapFree', 'Dirty', 'Writeback']),
    throttling: namedCounters(throttling, ['usage_usec', 'nr_periods', 'nr_throttled', 'throttled_usec']),
    sharedMemory: shm ? {totalBytes: shm.blocks * shm.bsize, availableBytes: shm.bavail * shm.bsize} : null};
}

/** Diagnostic-only sampling never changes a launch deadline or touches a foreign process. */
export class StartupSampler {
  private readonly started = performance.now();
  private readonly identities = new Map<number, number>();
  private readonly samples: unknown[] = [];
  private readonly stages: unknown[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;
  private stopping?: Promise<void>;
  private omitted = 0;
  private pid?: number;

  constructor(private readonly save: (value: unknown) => void) {}

  observe = (report: LaunchReport) => {
    this.pid = report.pid;
    for (const member of report.processes ?? []) this.identities.set(member.pid, Number(member.birth));
    if (this.stages.length < 256) this.stages.push({ms: report.elapsedMs, stage: report.stage, port: report.port,
      probe: report.probes ? structuredClone(report.probes) : undefined});
    else this.omitted++;
  };

  async start() {await this.collect(); this.schedule();}
  stop() {return this.stopping ??= (async () => {this.stopped = true; clearTimeout(this.timer); await this.pending; await this.collect();})();}

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {this.pending = this.collect().finally(() => this.schedule());}, 500);
  }

  private async collect() {
    const from = performance.now();
    if (this.samples.length >= 64) {this.omitted++; return;}
    // The first observation may precede the launcher's first ancestry scan.
    if (this.pid && !this.identities.has(this.pid)) {
      const root = processCounters(await read(`/proc/${this.pid}/stat`));
      if (root?.parent === process.pid && root.birth !== null) this.identities.set(this.pid, root.birth);
    }
    const tasks = await Promise.all([...this.identities].slice(0,32).map(async ([pid,birth]) => {
      const counters = await taskCounters(pid,birth);
      if (!counters) return null;
      const tids = await readdir(`/proc/${pid}/task`).catch(() => []);
      const threads = await Promise.all(tids.slice(0,64).map(async tid => {
        const stat = processCounters(await read(`/proc/${pid}/task/${tid}/stat`));
        if (!stat || stat.birth === null || !/^\d+$/.test(tid)) return null;
        return taskCounters(Number(tid),stat.birth);
      }));
      // Verify process identity again after reading threads; PID reuse grants no scope.
      if ((processCounters(await read(`/proc/${pid}/stat`)))?.birth !== birth) return null;
      return {...counters, threads, omittedThreads: Math.max(0,tids.length-64)};
    }));
    const machine = await machineCounters();
    this.samples.push({ms: Math.round(from-this.started), collectionMs: performance.now()-from, tasks, machine});
    this.save({samples: this.samples, stages: this.stages, omitted: this.omitted, omittedProcesses: Math.max(0,this.identities.size-32)});
  }
}

/** A fixed first/repeat pair keeps every outcome; a warm success never replaces a failure. */
export async function startupTrials(file: string, sandbox: boolean, owner: RunOwner, evidence: Evidence) {
  let failed = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    owner.signal.throwIfAborted();
    evidence.begin(`startup-${attempt}`);
    const sampler = new StartupSampler(value => evidence.saveTrace(`startup-${attempt}-samples`,value));
    await sampler.start();
    try {
      const browser = await owner.start(signal => launchChrome(file,sandbox,signal,sampler.observe));
      await sampler.stop();
      evidence.save(`startup-${attempt}-result`,{status:'ready',browser:browser.launchReport?.()});
      await browser.close();
      evidence.save(`startup-${attempt}-cleanup`,browser.launchReport?.());
    } catch (error) {
      failed = true;
      if (!(error instanceof ChromeLaunchError)) throw error;
      evidence.save(`startup-${attempt}-result`,{status:'failed',browser:error.report});
      if (error.report.cleanup?.status !== 'closed') throw error;
    } finally {await sampler.stop();}
  }
  return failed ? 1 : 0;
}
