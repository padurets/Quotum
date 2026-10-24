import {spawn, type ChildProcess} from 'node:child_process';
import {closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync, watch, type FSWatcher} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {browserProcess, type ProcessCleanup, type ProcessIdentity} from './browserProcess.js';
import {deadline, devtoolsJson} from './deadline.js';
import {nativeProcesses, type Browser} from './cdp.js';
import {nativePostmortem} from './nativePostmortem.js';

const FLAGS = [
  '--headless=new',
  // Keep the established software raster workaround independent of startup readiness.
  '--num-raster-threads=1',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-component-update', '--disable-extensions',
  '--disable-sync', '--mute-audio',
];
type Failure = 'spawn-error' | 'early-exit' | 'no-port' | 'invalid-port' | 'endpoint-unreachable' | 'invalid-reply' | 'cancelled';
type StartupClock = {monoBeforeMs: number; wallMs: number; monoAfterMs: number};
type PortMetadata = {status: 'available' | 'unavailable'; reason?: string;
  before: {device: number; inode: number; bytes: number; modifiedWallMs: number; changedWallMs: number} | null;
  after: PortMetadata['before']};
type StartupScan = {id: number; observeFrom: StartupClock | null; observeTo: StartupClock | null;
  portFrom: StartupClock | null; portTo: StartupClock | null; metadata: PortMetadata | null; failure?: Failure};
// Stage stamps begin each wait; jsonTo also includes reader cleanup and its deadline wrapper.
type StartupProbe = {id: number; from: StartupClock | null; to: StartupClock | null; headers: StartupClock | null;
  body: StartupClock | null; parse: StartupClock | null; jsonTo: StartupClock | null; status?: number; reason?: string};
type StartupSpanReport = {status: 'observed' | 'incomplete' | 'unavailable'; terminal: StartupClock | null;
  scanLimit: number; probeLimit: number; omittedScans: number; omittedProbes: number; unavailableClocks: number;
  scans: StartupScan[]; probes: StartupProbe[]; publicationProof: false; observerOverheadMs: null; clockMapping: {status: 'unknown'}};

/** Only existing operation boundaries are sampled; terminal export retains bounded tails. */
export class StartupSpans {
  private readonly scans: StartupScan[] = [];
  private readonly probes: StartupProbe[] = [];
  private omittedScans = 0;
  private omittedProbes = 0;
  private unavailableClocks = 0;
  private scanId = 0;
  private probeId = 0;
  private sealed = false;
  private frozen?: StartupSpanReport;

  clock(): StartupClock | null {
    if (this.sealed) return null;
    try {
      const monoBeforeMs = performance.now(), wallMs = Date.now(), monoAfterMs = performance.now();
      if ([monoBeforeMs, wallMs, monoAfterMs].every(Number.isFinite) && monoAfterMs >= monoBeforeMs) return {monoBeforeMs, wallMs, monoAfterMs};
    } catch { /* An unavailable diagnostic clock cannot reject readiness. */ }
    this.unavailableClocks++;
    return null;
  }
  scan(): StartupScan {
    const row: StartupScan = {id: ++this.scanId, observeFrom: this.clock(), observeTo: null, portFrom: null, portTo: null, metadata: null};
    if (!this.sealed) {if (this.scans.length === 48) {this.scans.shift(); this.omittedScans++;} this.scans.push(row);}
    return row;
  }
  probe(): StartupProbe {
    const row: StartupProbe = {id: ++this.probeId, from: this.clock(), to: null, headers: null, body: null, parse: null, jsonTo: null};
    if (!this.sealed) {if (this.probes.length === 64) {this.probes.shift(); this.omittedProbes++;} this.probes.push(row);}
    return row;
  }
  freeze(): StartupSpanReport {
    if (this.frozen) return this.frozen;
    const terminal = this.clock();
    this.sealed = true;
    const unfinished = this.scans.some(row => row.observeTo === null || row.portFrom !== null && row.portTo === null)
      || this.probes.some(row => row.to === null);
    const status = this.unavailableClocks ? 'unavailable' : unfinished || this.omittedScans || this.omittedProbes ? 'incomplete' : 'observed';
    // Abandoned work may finish after the original deadline; it cannot revise this receipt.
    this.frozen = structuredClone({status, terminal, scanLimit: 48, probeLimit: 64,
      omittedScans: this.omittedScans, omittedProbes: this.omittedProbes, unavailableClocks: this.unavailableClocks,
      scans: this.scans, probes: this.probes, publicationProof: false, observerOverheadMs: null, clockMapping: {status: 'unknown'}}) as StartupSpanReport;
    return this.frozen;
  }
}

export type LaunchReport = {
  executable: string; platform: string; pid?: number; ownedGroup: boolean; stage: string;
  elapsedMs: number; readyMs?: number; version?: string; failure?: Failure;
  exit?: {code: number | null; signal: NodeJS.Signals | null}; spawnCode?: string;
  stdout: ReturnType<ReturnType<typeof safeStream>['read']>; stderr: ReturnType<ReturnType<typeof safeStream>['read']>;
  cleanup?: ProcessCleanup;
  port?: number;
  portMs?: number;
  probes?: {attempts: number; stage: string; status?: number; reason?: string; elapsedMs: number; failures: Record<string,number>};
  processes?: ProcessIdentity[];
  startupSamples?: {status: 'available' | 'unavailable'; omitted: number; samples: (ProcessIdentity & {elapsedMs: number})[]};
  startupSpans?: StartupSpanReport;
};

export class ChromeLaunchError extends Error {
  constructor(readonly report: LaunchReport, reason: string) {
    super('Chrome startup failed: '+JSON.stringify({...report,reason}));
  }
}

/** HTTP errors may contain URLs or system paths; only these fixed categories are evidence. */
export function probeFailure(error: unknown, aborted: boolean) {
  if(aborted)return 'cancelled-or-deadline';
  const code=(error as {cause?:{code?:unknown}})?.cause?.code;
  if(typeof code==='string'&&['ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code))return code;
  if(error instanceof SyntaxError)return 'invalid-json';
  return 'unavailable';
}

/** Emit known diagnostics as fixed labels, never arbitrary browser output or paths. */
export function safeStream() {
  let bytes = 0, discardedBytes = 0, truncated = false, tail = '';
  const counts: Record<string, number> = {};
  const add = (chunk: Buffer | string) => {
    const text = chunk.toString(); bytes += Buffer.byteLength(text);
    tail += text;
    if (Buffer.byteLength(tail) > 4096) {discardedBytes += Buffer.byteLength(tail); tail = ''; truncated = true; return;}
    const lines = tail.split('\n'); tail = lines.pop()!;
    for (const line of lines) {
      const label = /^DevTools listening on ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/devtools\/browser\/[\w-]+\s*$/.test(line)
        ? 'devtools-announcement' : /ERROR:dbus\/bus\.cc\(\d+\)\]/.test(line) ? 'dbus-error' : null;
      if (label) counts[label] = (counts[label] ?? 0) + 1;
      else discardedBytes += Buffer.byteLength(line + '\n');
    }
  };
  return {add, read: () => ({bytes, discardedBytes: discardedBytes + Buffer.byteLength(tail), truncated, counts: {...counts}})};
}

function activePort(profile: string): {port: number; browserPath: string; metadata: PortMetadata} | null {
  let fd: number;
  try {fd = openSync(path.join(profile, 'DevToolsActivePort'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('invalid port file');}
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('invalid port file');
    const bytes = Buffer.alloc(1025), length = readSync(fd, bytes, 0, bytes.length, 0);
    const match = /^(\d{1,5})\r?\n(\/devtools\/browser\/[a-zA-Z0-9-]+)\r?\n?$/.exec(bytes.subarray(0, length).toString());
    const port = Number(match?.[1]);
    if (!match || port < 1 || port > 65535) throw new Error('invalid port file');
    let metadata: PortMetadata = {status: 'unavailable', reason: 'metadata-unavailable', before: null, after: null};
    try {
      // The original fd stat supplies the first tuple. One diagnostic stat checks it after reading.
      const after = fstatSync(fd);
      const tuple = (stat: typeof before) => ({device: stat.dev, inode: stat.ino, bytes: stat.size, modifiedWallMs: stat.mtimeMs, changedWallMs: stat.ctimeMs});
      const a = tuple(before), b = tuple(after);
      const numeric = [a, b].every(value => Object.values(value).every(Number.isFinite)
        && [value.device, value.inode, value.bytes].every(number => Number.isSafeInteger(number) && number >= 0));
      if (numeric) {
        const consistent = after.isFile() && a.device === b.device && a.inode === b.inode && a.bytes === b.bytes
          && a.modifiedWallMs === b.modifiedWallMs && a.changedWallMs === b.changedWallMs;
        metadata = {status: consistent ? 'available' : 'unavailable', ...(consistent ? {} : {reason: 'metadata-changed-during-read'}), before: a, after: b};
      }
    } catch { /* Metadata never grants or rejects the validated endpoint. */ }
    return {port, browserPath: match[2], metadata};
  } finally {closeSync(fd);}
}

export async function launchChrome(file: string, sandbox: boolean, signal?: AbortSignal, progress?: (report: LaunchReport) => void): Promise<Browser> {
  if (signal?.aborted) throw new Error('Chrome startup cancelled');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'quotum-bench-chrome-'));
  const group = process.platform !== 'win32';
  let child: ChildProcess;
  const startedAt = performance.now();
  try {
    child = spawn(file, [...FLAGS, ...(sandbox ? [] : ['--no-sandbox']), '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {
      stdio: ['ignore', 'pipe', 'pipe'], detached: group,
    });
  } catch (error) {rmSync(profile, {recursive: true, force: true}); throw error;}
  return launchedChrome(child, profile, group, signal, file, progress, startedAt);
}

/** Ownership begins before the first readiness await, including failed spawn and cancellation. */
export async function launchedChrome(child: ChildProcess, profile: string, group = false, signal?: AbortSignal, executable = 'stand-in', progress?: (report: LaunchReport) => void, startedAt = performance.now()): Promise<Browser> {
  const started = startedAt, processOwner = browserProcess(child, group), spans = new StartupSpans();
  const stdout = safeStream(), stderr = safeStream();
  child.stdout?.on('data', stdout.add); child.stderr?.on('data', stderr.add);
  const state: LaunchReport = {executable: path.basename(executable).replace(/[^a-zA-Z0-9._-]/g, '_'), platform: process.platform, pid: child.pid,
    ownedGroup: group, stage: 'spawn', elapsedMs: 0, stdout: stdout.read(), stderr: stderr.read()};
  const samples: NonNullable<LaunchReport['startupSamples']> = state.startupSamples = {status: 'unavailable', omitted: 0, samples: []};
  let sampledAt = -Infinity;
  const snapshot = () => ({...state, elapsedMs: Math.round(performance.now() - started), stdout: stdout.read(), stderr: stderr.read()});
  const startup = new AbortController();
  const cancel = () => {state.failure = 'cancelled'; startup.abort(new Error('Chrome startup cancelled'));};
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted) cancel();
  const exited = (code: number | null, signal: NodeJS.Signals | null) => {
    state.exit = {code, signal};
    if (state.stage === 'ready' || stopping) return;
    state.failure = 'early-exit';
    startup.abort(new Error('Chrome exited before DevTools was ready'));
  };
  const errored = (error: NodeJS.ErrnoException) => {
    state.spawnCode = error.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'unknown';
    state.failure = 'spawn-error'; startup.abort(new Error('Chrome could not start'));
  };
  child.on('exit', exited); child.on('error', errored);
  let stopping: Promise<void> | undefined;
  const close = (captureRootWait=false) => stopping ??= (async () => {
    state.cleanup = await processOwner.close(captureRootWait);
    child.stdout?.off('data', stdout.add); child.stderr?.off('data', stderr.add);
    child.off('exit', exited); child.off('error', errored);
    if (state.cleanup.status === 'closed') rmSync(profile, {recursive: true, force: true});
    console.error('bench: Chrome cleanup ' + JSON.stringify(snapshot()));
    if (state.cleanup.status !== 'closed') throw new Error('Chrome cleanup unconfirmed; owned profile retained');
  })();
  let portWatch: FSWatcher | undefined, portRevision = 0, wakePort: (() => void) | undefined;
  const closePortWatch = () => {
    const watcher = portWatch; portWatch = undefined;
    try {watcher?.close();} catch { /* Watching cannot replace the startup outcome or block owned cleanup. */ }
  };
  try {
    progress?.(snapshot());
    const remaining = 20_000 - (performance.now() - started);
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 20_000) {startup.abort(new Error('deadline exceeded')); startup.signal.throwIfAborted();}
    const endpoint = await deadline(remaining, async pending => {
      try {
        // A publication wakes validation; polling still covers missing filesystem events.
        portWatch = watch(profile, {persistent: false}, (_event, file) => {
          if (portWatch && file === 'DevToolsActivePort') {portRevision++; wakePort?.();}
        });
        portWatch.on('error', () => {closePortWatch(); wakePort?.();});
      } catch { /* Unsupported watching falls back to the existing poll. */ }
      let failure: Failure = 'no-port';
      while (true) {
        pending.throwIfAborted();
        const scannedRevision = portRevision;
        const scan = spans.scan();
        let processes: ProcessIdentity[];
        try {processes = await processOwner.observe(pending);} finally {scan.observeTo = spans.clock();}
        pending.throwIfAborted();
        state.processes=processes.slice(0,32);
        const root=state.processes.find(process=>process.pid===child.pid),elapsedMs=Math.round(performance.now()-started);
        // Reuse the ownership observation and its existing sampling checkpoint.
        if(root&&elapsedMs-sampledAt>=500){
          sampledAt=elapsedMs;samples.status='available';
          if(samples.samples.length<48)samples.samples.push({...root,elapsedMs});else samples.omitted++;
        }
        let published: ReturnType<typeof activePort> = null;
        scan.portFrom = spans.clock();
        try {published = activePort(profile); failure = published ? 'endpoint-unreachable' : 'no-port';}
        catch {failure = 'invalid-port';}
        finally {scan.portTo = spans.clock(); scan.failure = failure; scan.metadata = published?.metadata ?? null;}
        state.failure = failure; state.stage = published ? 'port' : 'spawn';
        progress?.(snapshot());
        if (published) {
          state.port=published.port;
          state.portMs??=Math.round(performance.now()-started);
          const candidate = `http://127.0.0.1:${published.port}`;
          const probeStarted=performance.now(), span = spans.probe();
          const probe=state.probes={attempts:(state.probes?.attempts??0)+1,stage:'headers',elapsedMs:0,failures:state.probes?.failures??{}} as NonNullable<LaunchReport['probes']>;
          try {
            let reply: {Browser?: unknown; webSocketDebuggerUrl?: unknown};
            try {
              // Headers and the entire body share the remaining startup deadline.
              reply = await devtoolsJson(candidate + '/json/version', pending, 'GET',(stage,status)=>{
                span[stage] = spans.clock(); if (status !== undefined) span.status = status;
                probe.stage=stage;probe.status=status;progress?.(snapshot());
              }) as typeof reply;
            } catch(error){probe.reason=probeFailure(error,pending.aborted);throw error;}
            span.jsonTo = spans.clock();
            failure = 'invalid-reply'; state.failure = failure; state.stage = 'reply';
            probe.reason='invalid-endpoint';
            const url = new URL(typeof reply.webSocketDebuggerUrl === 'string' ? reply.webSocketDebuggerUrl : '');
            if (url.protocol !== 'ws:' || url.port !== String(published.port) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
              || url.pathname !== published.browserPath || url.username || url.password || url.search || url.hash) throw new Error('mismatched DevTools endpoint');
            if (performance.now() - started >= 20_000) startup.abort(new Error('deadline exceeded'));
            pending.throwIfAborted();
            state.version = typeof reply.Browser === 'string' && /^[a-zA-Z][a-zA-Z0-9 -]{0,40}\/[a-zA-Z0-9.-]{1,64}$/.test(reply.Browser) ? reply.Browser : 'unavailable';
            delete probe.reason;
            state.stage = 'ready'; state.readyMs = Math.round(performance.now() - started); delete state.failure;
            progress?.(snapshot());
            return candidate;
          } catch {
            const reason=probe.reason??'cancelled-or-deadline';
            probe.failures[reason]=(probe.failures[reason]??0)+1;
            pending.throwIfAborted();
          } finally {span.to = spans.clock(); span.reason = probe.reason; probe.elapsedMs=Math.round(performance.now()-probeStarted);progress?.(snapshot());}
        }
        await deadline(150, waiting => new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer); waiting.removeEventListener('abort', done);
            if (wakePort === done) wakePort = undefined;
            if (waiting.aborted) reject(waiting.reason); else resolve();
          };
          const timer = setTimeout(done, 100);
          wakePort = done;
          waiting.addEventListener('abort', done, {once: true});
          if (waiting.aborted || scannedRevision !== portRevision) done();
        }), pending);
      }
    }, startup.signal).finally(() => {closePortWatch(); wakePort = undefined;});
    signal?.removeEventListener('abort', cancel);
    state.startupSpans = spans.freeze();
    console.error('bench: Chrome ready ' + JSON.stringify(snapshot()));
    const browser:Browser={endpoint, owned: true, close, launchReport: snapshot,
      ...(group && process.platform === 'linux' ? {observeProcesses: processOwner.observe,
        nativePostmortem:(candidates:import('./nativePostmortem.js').NativeCandidate[],signal:AbortSignal)=>nativePostmortem({root:child.pid!,
          live:()=>child.exitCode===null&&child.signalCode===null,observe:processOwner.observe,
          resource:browser.owner?(cleanup)=>browser.owner!.resource(cleanup):undefined},candidates,signal)} : {}),
      diagnostics: async (pids, _candidate, signal) => ({processes: child.pid && child.exitCode === null && child.signalCode === null ? await nativeProcesses(child.pid, pids, signal) : []})};
    return browser;
  } catch (error) {
    state.startupSpans = spans.freeze();
    const original = snapshot();
    progress?.(original);
    try {await close(!signal?.aborted&&performance.now()-started>=20_000&&error instanceof Error&&error.message==='deadline exceeded');} catch { /* The report retains unconfirmed cleanup. */ }
    throw new ChromeLaunchError({...original,cleanup:state.cleanup},startup.signal.aborted ? (error as Error).message : 'DevTools was not ready in 20 s');
  } finally {signal?.removeEventListener('abort', cancel);}
}
