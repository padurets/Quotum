import {accessSync, constants} from 'node:fs';
import path from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {deadline, devtoolsJson} from './deadline.js';
import type {RunOwner} from './runOwner.js';

/**
 * Just enough of the Chrome DevTools Protocol for the benchmark, over the WebSocket built
 * into Node: commands and their answers, events by name. No dependency.
 */
export class Cdp {
  private next = 1;
  private context = '';
  private lastAck: {id: number; method: string; at: number} | null = null;
  private lastEvent: {method: string; at: number} | null = null;
  private terminal: {method: 'Inspector.targetCrashed' | 'Inspector.detached'; at: number} | null = null;
  private failure: {id: number; method: string; context: string; started: number; deadline: number; elapsedMs: number; reason?: string} | null = null;
  private readonly waiting = new Map<number, {resolve: (value: never) => void; reject: (error: Error) => void; method: string; context: string; started: number; timer: ReturnType<typeof setTimeout>; clean(): void}>();
  private readonly listeners = new Map<string, ((params: never) => void)[]>();

  private constructor(private readonly socket: WebSocket,readonly endpoint:string|null=null) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as {id?: number; result?: unknown; error?: {message: string}; method?: string; params?: unknown};
      if (message.id !== undefined) {
        const call = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (call) {call.clean(); this.lastAck = {id: message.id, method: call.method, at: performance.now()};}
        // Page exceptions are successful protocol replies but failed evaluations.
        // Save their command before the caller starts cleanup, without page text.
        if (call?.method === 'Runtime.evaluate' && (message.result as {exceptionDetails?: unknown} | undefined)?.exceptionDetails) {
          this.failure ??= {id: message.id, method: call.method, context: call.context, started: call.started, deadline: call.started + 30_000,
            elapsedMs: performance.now() - call.started, reason: 'a page evaluation failed'};
        }
        if (message.error) call?.reject(new Error(`${call.method}: ${message.error.message}`));
        else call?.resolve(message.result as never);
      } else if (message.method) {
        this.lastEvent = {method: message.method, at: performance.now()};
        // A renderer can die while its DevTools socket remains open.
        // Retain that failure before cleanup sends more commands to the target.
        if (message.method === 'Inspector.targetCrashed' || message.method === 'Inspector.detached') {
          this.terminal = {method: message.method, at: this.lastEvent.at};
          this.rejectWaiting(this.terminalReason());
        } else if (message.method === 'Inspector.targetReloadedAfterCrash' && this.terminal?.method === 'Inspector.targetCrashed') this.terminal = null;
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params as never);
      }
    });
    socket.addEventListener('close', () => this.rejectWaiting());
  }

  static connect(url: string, signal?: AbortSignal): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {reject(signal.reason); return;}
      const socket = new WebSocket(url);
      const clean = () => {clearTimeout(timer); signal?.removeEventListener('abort', cancelled); socket.removeEventListener('open', opened); socket.removeEventListener('error', failed);};
      const fail = (error: Error) => {clean(); socket.close(); reject(error);};
      const timer = setTimeout(() => fail(new Error('the browser did not open its DevTools connection in 30 s')), 30_000);
      const cancelled = () => fail(new Error('DevTools connection cancelled'));
      const opened = () => {clean(); resolve(new Cdp(socket, url));};
      const failed = () => fail(new Error('cannot reach the browser DevTools connection'));
      socket.addEventListener('open', opened, {once: true});
      socket.addEventListener('error', failed, {once: true});
      signal?.addEventListener('abort', cancelled, {once: true});
    });
  }

  /** The current scenario boundary, without request parameters such as cookies. */
  at(context: string) {this.context = context;}

  snapshot() {
    return {context: this.context, socketState: this.socket.readyState, lastAck: this.lastAck, lastEvent: this.lastEvent, terminal: this.terminal, failure: this.failure,
      pending: [...this.waiting].map(([id, call]) => ({id, method: call.method, started: call.started, deadline: call.started + 30_000}))};
  }

  send<T = unknown>(method: string, params: object = {}, signal?: AbortSignal): Promise<T> {
    // A browser gone meanwhile (it crashed, or was closed) answers nothing: said at once, not waited for.
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${method}: the browser closed the connection`));
    if (this.terminal) return Promise.reject(new Error(`${method}: ${this.terminalReason()}`));
    if (signal?.aborted) return Promise.reject(new Error(`${method}: command cancelled`));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const context = this.context;
      const started = performance.now();
      const clean = () => {clearTimeout(timer); signal?.removeEventListener('abort', cancelled);};
      const cancelled = () => {clean(); this.waiting.delete(id); reject(new Error(`${method}: command cancelled`));};
      // A page promise can stop advancing while its DevTools socket stays open.
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        clean();
        this.failure ??= {id, method, context, started, deadline: started + 30_000, elapsedMs: performance.now() - started};
        reject(new Error(`${context ? `${context}: ` : ''}${method}: no browser response in 30 s`));
      }, 30_000);
      this.waiting.set(id, {resolve: resolve as (value: never) => void, reject, method, context, started, timer, clean});
      signal?.addEventListener('abort', cancelled, {once: true});
      try {this.socket.send(JSON.stringify({id, method, params}));}
      catch (error) {clean(); this.waiting.delete(id); reject(error);}
    });
  }

  on<T>(method: string, listener: (params: T) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener as (params: never) => void]);
  }

  off<T>(method: string, listener: (params: T) => void) {
    this.listeners.set(method, (this.listeners.get(method) ?? []).filter(value => value !== listener));
  }

  /** The value of an expression in the page, awaited when it is a promise. */
  async evaluate<T>(expression: string, signal?: AbortSignal): Promise<T> {
    const answer = await this.send<{result: {value: T}; exceptionDetails?: {text: string; exception?: {description?: string}}}>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, signal);
    if (answer.exceptionDetails) throw new Error(`in the page: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`);
    return answer.result.value;
  }

  close() {
    this.rejectWaiting();
    this.listeners.clear();
    this.socket.close();
  }

  private terminalReason() {
    return this.terminal?.method === 'Inspector.targetCrashed' ? 'the renderer crashed' : 'the browser detached the target';
  }

  private rejectWaiting(reason = 'the browser closed the connection') {
    for (const [id, call] of this.waiting) {
      call.clean();
      if (this.terminal) this.failure ??= {id, method: call.method, context: call.context, started: call.started, deadline: call.started + 30_000, elapsedMs: performance.now() - call.started, reason};
      call.reject(new Error(`${call.context ? `${call.context}: ` : ''}${call.method}: ${reason}`));
    }
    this.waiting.clear();
  }
}

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
export type Browser = {endpoint: string; owned?: boolean; owner?: RunOwner; launchReport?(): unknown; close(): Promise<void>; diagnostics?(pids:number[],candidate?:number,signal?:AbortSignal):Promise<unknown>};

/** Fixed categories survive evidence filtering without exposing kernel symbol text. */
export function threadWait(value: string) {
  const symbol = value.trim();
  const kind = /^(?:__)?futex_wait(?:_queue(?:_me)?)?$/.test(symbol) ? 'futex'
    : /^(?:ep_poll|do_epoll_wait|poll_schedule_timeout|do_poll|do_select)$/.test(symbol) ? 'poll'
    : /^(?:hrtimer_nanosleep|do_nanosleep)$/.test(symbol) ? 'timer'
    : /^(?:pipe_read|pipe_write)$/.test(symbol) ? 'pipe'
    : symbol === 'do_wait' ? 'child'
    : /^(?:io_schedule|folio_wait_bit_common)$/.test(symbol) ? 'io'
    : !symbol || symbol === 'unavailable' ? 'unavailable' : 'unknown';
  return {kind};
}

/** Only a launched browser's descendants may expose native thread state. */
export async function nativeProcesses(owner:number,pids:number[],signal?:AbortSignal){
  const status=async(pid:number)=>readFile(`/proc/${pid}/status`,{encoding:'utf8',signal}).catch(()=> '');
  const processes=[];
  for(const pid of pids.slice(0,32)){
    if(signal?.aborted)break;
    let ancestor=pid,owned=false;
    for(let depth=0;depth<16&&ancestor>1;depth++){
      if(signal?.aborted)break;
      if(ancestor===owner){owned=true;break;}
      ancestor=Number((await status(ancestor)).match(/^PPid:\s+(\d+)/m)?.[1]??0);
    }
    if(!owned)continue;
    const state=(await status(pid)).split('\n').filter(line=>/^(Name|State|VmRSS|Threads):/.test(line));
    const threads=[];
    for(const id of (await readdir(`/proc/${pid}/task`).catch(()=>[])).slice(0,50)){
      if(signal?.aborted)break;
      const text=await readFile(`/proc/${pid}/task/${id}/status`,{encoding:'utf8',signal}).catch(()=> '');
      const wait=await readFile(`/proc/${pid}/task/${id}/wchan`,{encoding:'utf8',signal}).catch(()=> 'unavailable');
      threads.push({id:Number(id),state:text.split('\n').filter(line=>/^(Name|State):/.test(line)),wait:threadWait(wait)});
    }
    processes.push({pid,state,threads});
  }
  return processes;
}

export {launchChrome, launchedChrome} from './chrome.js';

/** A Chrome someone else started (`--cdp http://host:port`): the benchmark only opens and closes its own tab there. */
export const attachedChrome = (endpoint: string): Browser => ({endpoint: endpoint.replace(/\/+$/, ''), close: async () => {}});

/** A new tab of the browser, and its connection. */
export function openTab(browser: Browser): Promise<{cdp: Cdp; close(): Promise<void>}> {
  const work = async () => {
    const signal = browser.owner?.signal;
    signal?.throwIfAborted();
    const create = new AbortController();
    let late: ReturnType<typeof setTimeout> | undefined;
    // Cancellation keeps the create response alive briefly to recover and close its exact ID.
    const cancelled = () => {late = setTimeout(() => create.abort(), 5_000);};
    signal?.addEventListener('abort', cancelled, {once: true});
    let tab: {id: string; webSocketDebuggerUrl: string};
    try {
      tab = await deadline(10_000, pending => devtoolsJson(`${browser.endpoint}/json/new?about:blank`, pending, 'PUT'), create.signal) as typeof tab;
      if (!tab || typeof tab.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(tab.id)) throw new Error('DevTools returned no target identity');
    } catch {
      browser.owner?.failures.push('tab creation outcome unknown');
      throw new Error('tab creation outcome unknown; no foreign targets were closed');
    } finally {clearTimeout(late); signal?.removeEventListener('abort', cancelled);}
    let cdp: Cdp | undefined;
    const abortConnection = () => cdp?.close();
    let closing: Promise<void> | undefined;
    const closeTab = () => closing ??= (async () => {
      signal?.removeEventListener('abort', abortConnection); cdp?.close();
      await deadline(5_000, async pending => {
        const response = await fetch(`${browser.endpoint}/json/close/${tab.id}`, {signal: pending, redirect: 'error'});
        await response.body?.cancel();
        if (!response.ok) throw new Error('DevTools could not close the owned target');
      });
    })();
    const close = browser.owner?.resource(closeTab) ?? closeTab;
    try {
      signal?.throwIfAborted();
      if (typeof tab.webSocketDebuggerUrl !== 'string' || !/^wss?:\/\//.test(tab.webSocketDebuggerUrl)) throw new Error('DevTools returned no target connection');
      cdp = await Cdp.connect(tab.webSocketDebuggerUrl, signal);
      signal?.addEventListener('abort', abortConnection, {once: true});
      signal?.throwIfAborted();
      return {cdp, close};
    } catch (error) {try {await close();} catch {browser.owner?.failures.push('owned target cleanup failed');} throw error;}
  };
  return browser.owner ? browser.owner.operation(work) : work();
}
