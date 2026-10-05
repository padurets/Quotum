import {spawn,execFile, type ChildProcess} from 'node:child_process';
import {accessSync, constants, mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readFile,readdir} from 'node:fs/promises';

/**
 * Just enough of the Chrome DevTools Protocol for the benchmark, over the WebSocket built
 * into Node: commands and their answers, events by name. No dependency.
 */
export class Cdp {
  private next = 1;
  private context = '';
  private readonly waiting = new Map<number, {resolve: (value: never) => void; reject: (error: Error) => void; method: string; timer: ReturnType<typeof setTimeout>}>();
  private readonly listeners = new Map<string, ((params: never) => void)[]>();

  private constructor(private readonly socket: WebSocket,readonly endpoint:string|null=null) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as {id?: number; result?: unknown; error?: {message: string}; method?: string; params?: unknown};
      if (message.id !== undefined) {
        const call = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (call) clearTimeout(call.timer);
        if (message.error) call?.reject(new Error(`${call.method}: ${message.error.message}`));
        else call?.resolve(message.result as never);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params as never);
      }
    });
    socket.addEventListener('close', () => this.rejectWaiting());
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {socket.close(); reject(new Error('the browser did not open its DevTools connection in 30 s'));}, 30_000);
      socket.addEventListener('open', () => {clearTimeout(timer); resolve(new Cdp(socket,url));}, {once: true});
      socket.addEventListener('error', () => {clearTimeout(timer); reject(new Error(`cannot reach the browser at ${url}`));}, {once: true});
    });
  }

  /** The current scenario boundary, without request parameters such as cookies. */
  at(context: string) {this.context = context;}

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    // A browser gone meanwhile (it crashed, or was closed) answers nothing: said at once, not waited for.
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${method}: the browser closed the connection`));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const context = this.context;
      // A page promise can stop advancing while its DevTools socket stays open.
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${context ? `${context}: ` : ''}${method}: no browser response in 30 s`));
      }, 30_000);
      this.waiting.set(id, {resolve: resolve as (value: never) => void, reject, method, timer});
      try {this.socket.send(JSON.stringify({id, method, params}));}
      catch (error) {clearTimeout(timer); this.waiting.delete(id); reject(error);}
    });
  }

  on<T>(method: string, listener: (params: T) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener as (params: never) => void]);
  }

  /** The value of an expression in the page, awaited when it is a promise. */
  async evaluate<T>(expression: string): Promise<T> {
    const answer = await this.send<{result: {value: T}; exceptionDetails?: {text: string; exception?: {description?: string}}}>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer.exceptionDetails) throw new Error(`in the page: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`);
    return answer.result.value;
  }

  close() {
    this.rejectWaiting();
    this.socket.close();
  }

  private rejectWaiting() {
    for (const call of this.waiting.values()) {clearTimeout(call.timer); call.reject(new Error(`${call.method}: the browser closed the connection`));}
    this.waiting.clear();
  }
}

/** Flags that make a headless tab behave as a visible one in front: no throttled timers, no extras that ask the network. */
const FLAGS = [
  '--headless=new',
  // Parallel software raster jobs can strand a pending tile in Chrome 154,
  // leaving the next input frame blocked in LayerTreeHost's commit wait.
  '--num-raster-threads=1',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-component-update',
  '--disable-extensions',
  '--disable-sync',
  '--mute-audio',
];

/** Chrome's own names on Linux, as the runners of CI and distributions install it. */
const CHROMES = ['google-chrome', 'chromium', 'chromium-browser'];

/** Where a Chrome to start is: QUOTUM_CHROME, else the first of its usual names on PATH. */
export function findChrome(env: NodeJS.ProcessEnv): string | null {
  if (env.QUOTUM_CHROME) return env.QUOTUM_CHROME;
  for (const name of CHROMES) {
    for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      const file = path.join(dir, name);
      try {
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        /* not there */
      }
    }
  }
  return null;
}

/** A browser the benchmark drives: the DevTools endpoint (`http://host:port`) and how to let go of it. */
export type Browser = {endpoint: string; close(): Promise<void>; diagnostics?(pids:number[],candidate?:number):Promise<unknown>};

/** Only a launched browser's descendants may expose native thread state. */
export async function nativeProcesses(owner:number,pids:number[]){
  const status=async(pid:number)=>readFile(`/proc/${pid}/status`,'utf8').catch(()=> '');
  const processes=[];
  for(const pid of pids){
    let ancestor=pid,owned=false;
    for(let depth=0;depth<16&&ancestor>1;depth++){
      if(ancestor===owner){owned=true;break;}
      ancestor=Number((await status(ancestor)).match(/^PPid:\s+(\d+)/m)?.[1]??0);
    }
    if(!owned)continue;
    const state=(await status(pid)).split('\n').filter(line=>/^(Name|State|VmRSS|Threads):/.test(line));
    const threads=[];
    for(const id of (await readdir(`/proc/${pid}/task`).catch(()=>[])).slice(0,50)){
      const text=await readFile(`/proc/${pid}/task/${id}/status`,'utf8').catch(()=> '');
      const wait=await readFile(`/proc/${pid}/task/${id}/wchan`,'utf8').catch(()=> 'unavailable');
      threads.push({id:Number(id),state:text.split('\n').filter(line=>/^(Name|State):/.test(line)),wait});
    }
    processes.push({pid,state,threads});
  }
  return processes;
}

/** Startup has no CDP process list yet; follow only this owned browser's native children. */
async function startupProcesses(owner: number) {
  const pids = [owner];
  for (let i = 0; i < pids.length && i < 32; i++) {
    const children = await readFile('/proc/' + pids[i] + '/task/' + pids[i] + '/children', 'utf8').catch(() => '');
    for (const value of children.trim().split(/\s+/)) {
      const pid = Number(value);
      if (pid > 1 && !pids.includes(pid) && pids.length < 32) pids.push(pid);
    }
  }
  return nativeProcesses(owner, pids);
}

/** Starts a headless Chrome of its own, with a throwaway profile; `sandbox: false` where the system forbids it (CI). */
export async function launchChrome(file: string, sandbox: boolean, signal?: AbortSignal): Promise<Browser> {
  if (signal?.aborted) throw new Error('Chrome startup cancelled');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'quotum-bench-chrome-'));
  const chrome: ChildProcess = spawn(file, [...FLAGS, ...(sandbox ? [] : ['--no-sandbox']), '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  return launchedChrome(chrome, profile, process.platform !== 'win32', signal);
}

/** Owns startup and cleanup even when Chrome never publishes a usable DevTools endpoint. */
export async function launchedChrome(chrome: ChildProcess, profile: string, ownsGroup = false, signal?: AbortSignal): Promise<Browser> {
  const started = performance.now();
  let output = '';
  let stdout = '', portState = 'not observed', httpState = 'not attempted';
  let exit: {code: number | null; signal: NodeJS.Signals | null} | null = null;
  let spawnError: Error | null = null;
  let fail = (_error: Error) => {};
  const reaped = new Promise<void>(resolve => {
    chrome.once('exit', (code, signal) => {
      exit = {code, signal}; resolve();
      fail(new Error('Chrome exited before DevTools was ready: ' + JSON.stringify(exit)));
    });
    chrome.once('error', error => {
      spawnError = error;
      if (!chrome.pid) resolve();
      fail(new Error('Chrome could not start: ' + error.message));
    });
  });
  chrome.stderr?.on('data', chunk => {output = (output + chunk.toString()).slice(-4_000);});
  chrome.stdout?.on('data', chunk => {stdout = (stdout + chunk.toString()).slice(-4_000);});
  const kill = (signal: NodeJS.Signals) => {
    if (ownsGroup && chrome.pid) {
      try {process.kill(-chrome.pid, signal);}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
    } else chrome.kill(signal);
  };
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    try {
      if (chrome.pid) {
        if (ownsGroup || !exit) kill('SIGTERM');
        if (!exit) {
          const hard = setTimeout(() => kill('SIGKILL'), 5_000);
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([reaped, new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(() => reject(new Error('Chrome did not exit after termination and kill')), 7_000);
            })]);
          } finally {clearTimeout(hard); clearTimeout(deadline);}
        }
        // Workers may close their output pipes before they exit.
        if (ownsGroup) kill('SIGKILL');
      }
    } finally {
      // An escaped descendant can retain these pipes after the owned process is reaped.
      chrome.stdout?.destroy(); chrome.stderr?.destroy(); chrome.unref();
      if (exit || !chrome.pid) rmSync(profile, {recursive: true, force: true, maxRetries: 5});
    }
  })();
  const portObserved = (value: string) => {
    if (portState === value) return;
    portState = value;
    console.error('bench: Chrome port ' + JSON.stringify({elapsedMs: Math.round(performance.now() - started), activePort: value}));
  };
  const httpObserved = (value: string) => {
    if (httpState === value) return;
    httpState = value;
    console.error('bench: Chrome probe ' + JSON.stringify({elapsedMs: Math.round(performance.now() - started), http: value}));
  };
  const state = async () => ({
    elapsedMs: Math.round(performance.now() - started), pid: chrome.pid, exit,
    spawnError: spawnError?.message, activePort: portState, http: httpState,
    stdout, stderr: output,
    native: process.platform === 'linux' && chrome.pid && !exit
      ? await startupProcesses(chrome.pid) : null,
  });
  let endpoint: string;
  try {
    endpoint = await new Promise<string>((resolve, reject) => {
      let settled = false, poll: ReturnType<typeof setTimeout> | undefined;
      let request: AbortController | undefined;
      let cancelled: (() => void) | undefined;
      const finish = (error: Error | null, value?: string) => {
        if (settled) return;
        settled = true; clearTimeout(late); clearTimeout(poll); request?.abort();
        if (cancelled) signal?.removeEventListener('abort', cancelled);
        if (error) reject(error); else resolve(value!);
      };
      fail = error => finish(error);
      const late = setTimeout(() => finish(new Error('Chrome DevTools was not ready in 20 s')), 20_000);
      cancelled = () => finish(new Error('Chrome startup cancelled'));
      signal?.addEventListener('abort', cancelled, {once: true});
      if (signal?.aborted) {cancelled(); return;}
      const inspect = async () => {
        try {
          // ChromeDriver also discovers a random debugging port through this owned profile.
          const text = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
          if (settled) return;
          const match = /^(\d{1,5})\r?\n(\/devtools\/browser\/[a-zA-Z0-9-]+)\r?\n?$/.exec(text);
          const port = Number(match?.[1]);
          if (!match || port < 1 || port > 65535) {portObserved('invalid'); return;}
          portObserved('port ' + port);
          const candidate = 'http://127.0.0.1:' + port;
          request = new AbortController();
          const bound = setTimeout(() => request?.abort(), 1_000);
          try {
            const response = await fetch(candidate + '/json/version', {signal: request.signal, redirect: 'error'});
            httpObserved('HTTP ' + response.status);
            if (!response.ok || settled) return;
            const version = await response.json() as {Browser?: string; webSocketDebuggerUrl?: string};
            if (settled) return;
            const socket = new URL(version.webSocketDebuggerUrl ?? '');
            if (socket.protocol !== 'ws:' || socket.port !== String(port)
              || !['127.0.0.1', 'localhost', '[::1]'].includes(socket.hostname)
              || socket.pathname !== match[2]) {httpObserved('mismatched browser endpoint'); return;}
            console.error('bench: Chrome ready ' + JSON.stringify({
              elapsedMs: Math.round(performance.now() - started), browser: version.Browser,
              announced: /DevTools listening on/.test(output),
            }));
            finish(null, candidate);
          } finally {clearTimeout(bound);}
        } catch (error) {
          if (!settled) httpObserved((error as Error).message.slice(0, 200));
        } finally {
          if (!settled) poll = setTimeout(() => {void inspect();}, 100);
        }
      };
      void inspect();
    });
  } catch (error) {
    const detail = await state();
    console.error('bench: Chrome startup ' + JSON.stringify(detail));
    let cleanupError: string | undefined;
    try {await stop();} catch (error) {cleanupError = (error as Error).message;}
    throw new Error((error as Error).message + '\n' + JSON.stringify({...detail, cleanupError}));
  }
  return {
    endpoint,
    async diagnostics(pids:number[],candidate?:number){
      const processes=chrome.exitCode===null&&chrome.signalCode===null?await nativeProcesses(chrome.pid!,pids):[];
      let stack:unknown;
      if(process.env.QUOTUM_BENCH_NATIVE_STACKS==='1'&&processes.some(p=>p.pid===candidate)){
        // Arguments, locals, init scripts and symbol downloads are deliberately excluded.
        stack=await new Promise(resolve=>execFile('sudo',['-n','gdb','--readnever','--batch','--nx',
          '-iex','set auto-load off','-iex','set debuginfod enabled off',
          '-iex','set print frame-arguments none','-iex','set print entry-values no',
          '-p',String(candidate),'-ex','thread apply all bt 16','-ex','detach'],
          {timeout:20000,killSignal:'SIGKILL',maxBuffer:262144},(error,stdout,stderr)=>resolve({candidate,error:error?.code,stdout:stdout.slice(-48000),stderr:stderr.slice(-4000)})));
      }
      return {stderr:output,processes,stack};
    },
    close: stop,
  };
}

/** A Chrome someone else started (`--cdp http://host:port`): the benchmark only opens and closes its own tab there. */
export const attachedChrome = (endpoint: string): Browser => ({endpoint: endpoint.replace(/\/+$/, ''), close: async () => {}});

/** A new tab of the browser, and its connection. */
export async function openTab(browser: Browser): Promise<{cdp: Cdp; close(): Promise<void>}> {
  const response = await fetch(`${browser.endpoint}/json/new?about:blank`, {method: 'PUT', signal: AbortSignal.timeout(10_000)});
  if (!response.ok) throw new Error(`the browser at ${browser.endpoint} opened no tab: HTTP ${response.status}`);
  const tab = (await response.json()) as {id: string; webSocketDebuggerUrl: string};
  const closeTab = () => fetch(`${browser.endpoint}/json/close/${tab.id}`, {signal: AbortSignal.timeout(5_000)}).catch(() => undefined);
  let cdp: Cdp;
  try {cdp = await Cdp.connect(tab.webSocketDebuggerUrl);}
  catch (error) {await closeTab(); throw error;}
  return {
    cdp,
    async close() {
      cdp.close();
      await closeTab();
    },
  };
}
