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
  private readonly waiting = new Map<number, {resolve: (value: never) => void; reject: (error: Error) => void; method: string}>();
  private readonly listeners = new Map<string, ((params: never) => void)[]>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as {id?: number; result?: unknown; error?: {message: string}; method?: string; params?: unknown};
      if (message.id !== undefined) {
        const call = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (message.error) call?.reject(new Error(`${call.method}: ${message.error.message}`));
        else call?.resolve(message.result as never);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params as never);
      }
    });
    socket.addEventListener('close', () => {
      for (const call of this.waiting.values()) call.reject(new Error(`${call.method}: the browser closed the connection`));
      this.waiting.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new Cdp(socket)), {once: true});
      socket.addEventListener('error', () => reject(new Error(`cannot reach the browser at ${url}`)), {once: true});
    });
  }

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, {resolve: resolve as (value: never) => void, reject, method});
      this.socket.send(JSON.stringify({id, method, params}));
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
    this.socket.close();
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
  const response = await fetch(`${browser.endpoint}/json/new?about:blank`, {method: 'PUT'});
  if (!response.ok) throw new Error(`the browser at ${browser.endpoint} opened no tab: HTTP ${response.status}`);
  const tab = (await response.json()) as {id: string; webSocketDebuggerUrl: string};
  const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
  return {
    cdp,
    async close() {
      cdp.close();
      await fetch(`${browser.endpoint}/json/close/${tab.id}`).catch(() => undefined);
    },
  };
}
