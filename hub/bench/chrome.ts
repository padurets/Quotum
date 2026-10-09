import {spawn, type ChildProcess} from 'node:child_process';
import {closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {browserProcess, type ProcessCleanup} from './browserProcess.js';
import {deadline, devtoolsJson} from './deadline.js';
import {nativeProcesses, type Browser} from './cdp.js';

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
export type LaunchReport = {
  executable: string; platform: string; pid?: number; ownedGroup: boolean; stage: string;
  elapsedMs: number; readyMs?: number; version?: string; failure?: Failure;
  exit?: {code: number | null; signal: NodeJS.Signals | null}; spawnCode?: string;
  stdout: ReturnType<ReturnType<typeof safeStream>['read']>; stderr: ReturnType<ReturnType<typeof safeStream>['read']>;
  cleanup?: ProcessCleanup;
  port?: number;
  probes?: {attempts: number; stage: string; status?: number; reason?: string; elapsedMs: number; failures: Record<string,number>};
  processes?: {pid: number; group: number; session: number; birth: string; state: string}[];
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

function activePort(profile: string): {port: number; browserPath: string} | null {
  let fd: number;
  try {fd = openSync(path.join(profile, 'DevToolsActivePort'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('invalid port file');}
  try {
    if (!fstatSync(fd).isFile()) throw new Error('invalid port file');
    const bytes = Buffer.alloc(1025), length = readSync(fd, bytes, 0, bytes.length, 0);
    const match = /^(\d{1,5})\r?\n(\/devtools\/browser\/[a-zA-Z0-9-]+)\r?\n?$/.exec(bytes.subarray(0, length).toString());
    const port = Number(match?.[1]);
    if (!match || port < 1 || port > 65535) throw new Error('invalid port file');
    return {port, browserPath: match[2]};
  } finally {closeSync(fd);}
}

export async function launchChrome(file: string, sandbox: boolean, signal?: AbortSignal, progress?: (report: LaunchReport) => void): Promise<Browser> {
  if (signal?.aborted) throw new Error('Chrome startup cancelled');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'quotum-bench-chrome-'));
  const group = process.platform !== 'win32';
  let child: ChildProcess;
  try {
    child = spawn(file, [...FLAGS, ...(sandbox ? [] : ['--no-sandbox']), '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {
      stdio: ['ignore', 'pipe', 'pipe'], detached: group,
    });
  } catch (error) {rmSync(profile, {recursive: true, force: true}); throw error;}
  return launchedChrome(child, profile, group, signal, file, progress);
}

/** Ownership begins before the first readiness await, including failed spawn and cancellation. */
export async function launchedChrome(child: ChildProcess, profile: string, group = false, signal?: AbortSignal, executable = 'stand-in', progress?: (report: LaunchReport) => void): Promise<Browser> {
  const started = performance.now(), processOwner = browserProcess(child, group);
  const stdout = safeStream(), stderr = safeStream();
  child.stdout?.on('data', stdout.add); child.stderr?.on('data', stderr.add);
  const state: LaunchReport = {executable: path.basename(executable).replace(/[^a-zA-Z0-9._-]/g, '_'), platform: process.platform, pid: child.pid,
    ownedGroup: group, stage: 'spawn', elapsedMs: 0, stdout: stdout.read(), stderr: stderr.read()};
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
  const close = () => stopping ??= (async () => {
    state.cleanup = await processOwner.close();
    child.stdout?.off('data', stdout.add); child.stderr?.off('data', stderr.add);
    child.off('exit', exited); child.off('error', errored);
    if (state.cleanup.status === 'closed') rmSync(profile, {recursive: true, force: true});
    console.error('bench: Chrome cleanup ' + JSON.stringify(snapshot()));
    if (state.cleanup.status !== 'closed') throw new Error('Chrome cleanup unconfirmed; owned profile retained');
  })();
  try {
    progress?.(snapshot());
    const endpoint = await deadline(20_000, async pending => {
      let failure: Failure = 'no-port';
      while (true) {
        pending.throwIfAborted();
        state.processes=(await processOwner.observe()).slice(0,32);
        pending.throwIfAborted();
        let published: ReturnType<typeof activePort> = null;
        try {published = activePort(profile); failure = published ? 'endpoint-unreachable' : 'no-port';}
        catch {failure = 'invalid-port';}
        state.failure = failure; state.stage = published ? 'port' : 'spawn';
        progress?.(snapshot());
        if (published) {
          state.port=published.port;
          const candidate = `http://127.0.0.1:${published.port}`;
          const probeStarted=performance.now();
          const probe=state.probes={attempts:(state.probes?.attempts??0)+1,stage:'headers',elapsedMs:0,failures:state.probes?.failures??{}} as NonNullable<LaunchReport['probes']>;
          try {
            const reply = await deadline(1_000, async signal => {
              try {return await devtoolsJson(candidate + '/json/version', signal, 'GET',(stage,status)=>{probe.stage=stage;probe.status=status;});}
              catch(error){probe.reason=probeFailure(error,signal.aborted);throw error;}
            }, pending) as {Browser?: unknown; webSocketDebuggerUrl?: unknown};
            failure = 'invalid-reply'; state.failure = failure; state.stage = 'reply';
            probe.reason='invalid-endpoint';
            const url = new URL(typeof reply.webSocketDebuggerUrl === 'string' ? reply.webSocketDebuggerUrl : '');
            if (url.protocol !== 'ws:' || url.port !== String(published.port) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
              || url.pathname !== published.browserPath || url.username || url.password || url.search || url.hash) throw new Error('mismatched DevTools endpoint');
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
          } finally {probe.elapsedMs=Math.round(performance.now()-probeStarted);}
        }
        await deadline(150, pending => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          pending.addEventListener('abort', () => {clearTimeout(timer); reject(pending.reason);}, {once: true});
        }), pending);
      }
    }, startup.signal);
    signal?.removeEventListener('abort', cancel);
    console.error('bench: Chrome ready ' + JSON.stringify(snapshot()));
    return {endpoint, owned: true, close, launchReport: snapshot,
      diagnostics: async (pids, _candidate, signal) => ({processes: child.pid && child.exitCode === null && child.signalCode === null ? await nativeProcesses(child.pid, pids, signal) : []})};
  } catch (error) {
    const original = snapshot();
    progress?.(original);
    try {await close();} catch { /* The report retains unconfirmed cleanup. */ }
    throw new ChromeLaunchError({...original,cleanup:state.cleanup},startup.signal.aborted ? (error as Error).message : 'DevTools was not ready in 20 s');
  } finally {signal?.removeEventListener('abort', cancel);}
}
