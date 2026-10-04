import {spawn, type ChildProcess} from 'node:child_process';
import {accessSync, constants, mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Just enough of the Chrome DevTools Protocol for the benchmark, over the WebSocket built
 * into Node: commands and their answers, events by name. No dependency.
 */
export class Cdp {
  private next = 1;
  private context = '';
  private readonly waiting = new Map<number, {resolve: (value: never) => void; reject: (error: Error) => void; method: string; timer: ReturnType<typeof setTimeout>}>();
  private readonly listeners = new Map<string, ((params: never) => void)[]>();

  private constructor(private readonly socket: WebSocket) {
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
      socket.addEventListener('open', () => {clearTimeout(timer); resolve(new Cdp(socket));}, {once: true});
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
export type Browser = {endpoint: string; close(): Promise<void>};

/** Starts a headless Chrome of its own, with a throwaway profile; `sandbox: false` where the system forbids it (CI). */
export async function launchChrome(file: string, sandbox: boolean): Promise<Browser> {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'quotum-bench-chrome-'));
  const chrome: ChildProcess = spawn(file, [...FLAGS, ...(sandbox ? [] : ['--no-sandbox']), '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let output = '';
  const endpoint = await new Promise<string>((resolve, reject) => {
    const late = setTimeout(() => reject(new Error(`Chrome did not start in 20 s:\n${output}`)), 20_000);
    chrome.stderr!.on('data', chunk => {
      output = (output + chunk.toString()).slice(-4_000);
      const found = output.match(/DevTools listening on ws:\/\/([^/\s]+)\//);
      if (found) {
        clearTimeout(late);
        resolve(`http://${found[1]}`);
      }
    });
    chrome.once('exit', code => {
      clearTimeout(late);
      reject(new Error(`Chrome exited (${code}) before it listened:\n${output}`));
    });
  });
  return {
    endpoint,
    async close() {
      if (chrome.exitCode === null && chrome.signalCode === null) {
        const exited = new Promise(resolve => chrome.once('exit', resolve));
        chrome.kill('SIGTERM');
        const hard = setTimeout(() => chrome.kill('SIGKILL'), 5_000);
        await exited;
        clearTimeout(hard);
      }
      rmSync(profile, {recursive: true, force: true, maxRetries: 5});
    },
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
