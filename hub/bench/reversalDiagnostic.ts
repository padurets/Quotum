import {Cdp, type Browser} from './cdp.js';
import {deadline, devtoolsJson} from './deadline.js';
import {safeEvidence} from './evidence.js';
import type {ProcessIdentity} from './browserProcess.js';
import type {RendererIdentity} from './rendererIdentity.js';

type DocumentMark={atMs:number;frame?:string;loader?:string};
export type DiagnosticOrigin={startedAt:number;navigation:()=>{requested?:DocumentMark;committed?:DocumentMark;loadAtMs:number|null}};
type Options = {lateRenderer?:{requireBeforeInput?:boolean;validDocument():boolean;resolve(signal:AbortSignal):Promise<RendererIdentity>};renderer?:RendererIdentity; mode?: 'canonical' | 'diagnostic'; profileBeforeInput?: boolean; postmortem?:boolean; closeTarget?: () => Promise<void>;signal?:AbortSignal;origin?:DiagnosticOrigin};
type Process = {type: string; id: number; cpuTime: number};
type ProcessSample = {status: 'pending' | 'observed' | 'unavailable'; fromMs: number; toMs: number | null; processes?: ProcessIdentity[]; omitted?: number};
const PAGE_LIVENESS = '({visibility:document.visibilityState,focus:document.hasFocus(),ready:document.readyState})';
let serial = 0;

/** Cancellation releases the underlying CDP waiters, not just the outer Promise. */
export const bounded = <T>(label: string, work: (signal: AbortSignal) => Promise<T>, ms = 5000, signal?: AbortSignal) =>
  deadline(ms, work, signal).catch(error => {if (error instanceof Error && error.message === 'deadline exceeded') throw new Error(label + ': diagnostic deadline'); throw error;});

/** Canonical observation is passive until the unchanged command deadline has failed. */
export async function observeReversal(page: Cdp, browser: Browser, options: Options = {}) {
  const diagnostic = options.mode === 'diagnostic';
  if(options.lateRenderer&&(options.renderer||diagnostic||options.profileBeforeInput))throw Error('Conflicting renderer identity options');
  const id = ++serial, signal = options.signal&&browser.owner?AbortSignal.any([options.signal,browser.owner.signal]):options.signal??browser.owner?.signal;
  let intervention = false, capture: Promise<void> | undefined, released = false;
  let nativeCapture:ReturnType<NonNullable<Browser['nativePostmortem']>>|undefined;
  let renderers:import('./nativePostmortem.js').NativeCandidate[]=[];
  let cancelPassive: (() => void) | undefined;
  const report: Record<string, unknown> = {id, mode: diagnostic ? 'diagnostic' : 'canonical', ownedBrowser: Boolean(browser.owned)};
  if(diagnostic||options.postmortem&&browser.owned){
    const sources:{scriptId:string;sourceHash:string;sourceLength:number}[]=[];
    page.on<{scriptId:string;url:string;hash:string;length:number}>('Debugger.scriptParsed',event=>{
      let pathname:string;try{const url=new URL(event.url);if(!['http:','https:'].includes(url.protocol))return;pathname=url.pathname;}catch{return;}
      if(/^\/assets\/index-[\w-]+\.js$/.test(pathname)&&/^[\da-f]{64}$/i.test(event.hash)&&sources.length<4){sources.push({scriptId:event.scriptId,sourceHash:event.hash.toLowerCase(),sourceLength:event.length});report.sources=sources;}
    });
    page.on<{reason:string;callFrames:{location:{scriptId:string;lineNumber:number;columnNumber:number}}[]}>('Debugger.paused',event=>{
      report.pause={reason:event.reason,frames:event.callFrames.slice(0,16).map(({location:{scriptId,lineNumber,columnNumber}})=>({scriptId,lineNumber,columnNumber})),omitted:Math.max(0,event.callFrames.length-16)};
    });
  }
  const store = () => {
    const safe = safeEvidence(report);
    browser.owner?.evidence?.save('cdp-' + id, safe);
    console.error('reversal diagnostic ' + JSON.stringify(safe));
  };
  const send = (method: string, pending: AbortSignal) => page.send(method, {}, pending);
  // Host read brackets and raw proc ticks do not identify page work or continuous liveness.
  const sampleProcesses = async (pending?: AbortSignal): Promise<ProcessSample> => {
    const fromMs = performance.now();
    try {
      if (!browser.owned || !browser.observeProcesses) throw new Error('owned process observation unavailable');
      const processes = await bounded('owned process observation', reading => browser.observeProcesses!(reading), 1000, pending);
      pending?.throwIfAborted();
      return {status: processes.length ? 'observed' : 'unavailable', fromMs, toMs: performance.now(), processes: processes.slice(0, 32), omitted: Math.max(0, processes.length - 32)};
    } catch {return {status: 'unavailable', fromMs, toMs: performance.now()};}
  };
  const release = async () => {
    if(nativeCapture){
      const captured=nativeCapture;nativeCapture=undefined;
      try {
        const native=await bounded('release native diagnostic',()=>captured,2000);
        report.nativeWait=native;
        if(native.intervened&&(!native.released||!native.reaped||!native.pipesClosed))throw new Error('native release unconfirmed');
      }catch{
        report.nativeCleanup='release incomplete';
        browser.owner?.failures.push('native diagnostic release unconfirmed');
        // The run owner already owns browser shutdown. A second target-close wait
        // here would extend the existing two-second diagnostic release budget.
        page.close();
      }
    }
    if (!intervention || released) return;
    released = true;
    // Sending pause may have taken effect even if its reply never arrived.
    let resumed = false;
    try {
      await bounded('release diagnostic', async pending => {
        await send('Debugger.resume', pending); resumed = true;
        await send('Profiler.stop', pending).catch(() => {});
        await send('Debugger.disable', pending);
      }, 2000);
    } catch {report.cleanup = 'release incomplete';}
    report.resumed = resumed;
    if (!resumed) {
      page.close();
      try {await options.closeTarget?.();} catch {report.cleanup = 'owned target close unconfirmed';}
      browser.owner?.failures.push('diagnostic resume unconfirmed');
    }
  };
  const enable = async (pending: AbortSignal) => {
    intervention = true;
    await send('Debugger.enable', pending);
    await send('Profiler.enable', pending);
    await send('Profiler.start', pending);
  };
  const liveness = async (pending: AbortSignal) => {
    let control: Cdp | undefined;
    try {
      await bounded('browser liveness', async alive => {
        const reply = await devtoolsJson(browser.endpoint + '/json/version', alive) as {webSocketDebuggerUrl?: string};
        report.browserAlive = true;
        if (!browser.owned) {report.native = 'unavailable for attached browser'; return;}
        if (typeof reply.webSocketDebuggerUrl !== 'string') throw new Error('browser connection unavailable');
        const connected=await Cdp.connect(reply.webSocketDebuggerUrl, alive);
        if(alive.aborted){connected.close();alive.throwIfAborted();}
        control=connected;
        const processes = await control.send<{processInfo: Process[]}>('SystemInfo.getProcessInfo', {}, alive);
        report.processes = processes.processInfo.map(({type, id, cpuTime}) => ({type, id, cpuTime}));
        renderers=processes.processInfo.filter(value=>value.type==='renderer').map(value=>({pid:value.id,cpuTime:value.cpuTime}));
        if (browser.diagnostics) report.native = await browser.diagnostics(processes.processInfo.map(value => value.id), undefined, alive);
      }, 2000, pending);
    } catch {report.livenessStatus = 'unavailable';}
    finally {control?.close();}
  };
  const freshPageLiveness = async (pending: AbortSignal) => {
    if (!browser.owned || !page.endpoint || !page.snapshot().failure) return;
    const probe = {status: 'unavailable', connected: false, fromMs: performance.now(), toMs: null as number | null};
    report.freshPage = probe;
    let connection: Cdp | undefined;
    try {
      // Browser liveness cannot distinguish a stalled page from its original session.
      await bounded('fresh page liveness', async alive => {
        const connected = await Cdp.connect(page.endpoint!, alive);
        if (alive.aborted) {connected.close(); alive.throwIfAborted();}
        connection = connected; probe.connected = true;
        await connection.evaluate(PAGE_LIVENESS, alive);
        alive.throwIfAborted(); probe.status = 'responded';
      }, 2000, pending);
    } catch {probe.status = probe.connected ? 'unresponsive' : 'unavailable';}
    finally {connection?.close(); probe.toMs = performance.now();}
  };
  const collect = async (label: string) => {
    report.scenario = label; report.command = page.snapshot();
    if(options.origin){
      const {requested,committed,loadAtMs}=options.origin.navigation();
      const mark=(value:DocumentMark|undefined)=>value?{atMs:value.atMs,frameId:value.frame,loaderId:value.loader}:undefined;
      report.startedAt=options.origin.startedAt;
      report.navigation={requested:mark(requested),committed:mark(committed),loadAtMs};
    }
    try {
      await bounded('failure collection', async pending => {
        await Promise.all([
          sampleProcesses(pending).then(sample => {if (!pending.aborted) report.failedProcesses = sample;}),
          liveness(pending),
          freshPageLiveness(pending),
          bounded('page liveness', async probe => {
            report.page = await page.evaluate(PAGE_LIVENESS, probe);
          }, 2000, pending).catch(() => {report.page = 'unresponsive';}),
        ]);
        // A failed owned page can be inspected after its original deadline;
        // accepted commands and attached browsers remain passive.
        const postmortem=options.postmortem&&browser.owned&&page.snapshot().failure&&report.page==='unresponsive';
        let nativeIntervention=false,renderer=options.renderer;
        if(postmortem&&options.lateRenderer){
          report.nativeBinding=false;
          // Missing optional metadata retains the old unbound path. Once mapping
          // starts, only a complete identity permits either intervention.
          if(!options.lateRenderer.validDocument()){
            if(options.lateRenderer.requireBeforeInput!==false)return;
          }else{
            try{renderer=await options.lateRenderer.resolve(pending);}catch{return;}
            report.rendererAtCapture=renderer.evidence();
            const pid=renderer.pid,birth=renderer.birth;
            if(!options.lateRenderer.validDocument()||!renderer.valid()||pid===null||birth===null||renderers.filter(value=>value.pid===pid).length!==1)return;
          }
        }
        if(postmortem&&!diagnostic&&browser.nativePostmortem){
          report.postmortem=true;
          let candidates=renderers;
          if(renderer){
            const identity=renderer;report.rendererAtCapture=identity.evidence();
            const pid=identity.pid,birth=identity.birth,selected=renderers.filter(value=>value.pid===pid);
            if(!identity.valid()||pid===null||birth===null||selected.length!==1){report.nativeBinding=false;return;}
            candidates=[{...selected[0],birth}];
          }
          nativeCapture=browser.nativePostmortem(candidates,pending);
          const native=await nativeCapture;report.nativeWait=native;nativeIntervention=native.intervened;
          if(renderer){
            const after=renderer.evidence();report.rendererAfterCapture=after;
            report.nativeBinding=after.status==='known'&&native.pid===after.pid&&native.birth===after.birth;
          }
        }
        if (diagnostic||postmortem&&!nativeIntervention) {
          if(renderer&&!renderer.valid()||options.lateRenderer&&options.lateRenderer.requireBeforeInput!==false&&!options.lateRenderer.validDocument()){report.nativeBinding=false;return;}
          if(postmortem)report.postmortem=true;
          if (!intervention) await enable(pending);
          await send('Debugger.pause', pending);
          const profile = await page.send<{profile: {samples?: number[]; timeDeltas?: number[]}}>('Profiler.stop', {}, pending);
          report.profile = {samples: profile.profile.samples?.length, microseconds: profile.profile.timeDeltas?.reduce((sum, value) => sum + value, 0)};
        }
      }, 5000, signal);
    } catch {report.collection = 'incomplete';}
    finally {await release(); store();}
  };
  if (diagnostic && options.profileBeforeInput) {
    try {await bounded('diagnostic setup', enable, 5000, signal);}
    catch (error) {await release(); store(); throw error;}
  }
  return {
    async diagnose(label:string){signal?.throwIfAborted();capture??=collect(label);await capture;signal?.throwIfAborted();},
    async watch<T>(label: string, run: () => Promise<T>) {
      signal?.throwIfAborted();
      if(options.renderer&&!options.renderer.valid()||options.lateRenderer&&options.lateRenderer.requireBeforeInput!==false&&!options.lateRenderer.validDocument())throw new Error('renderer identity invalidated before command');
      delete report.waiting; delete report.waitingProcesses;
      const passive = new AbortController(), pending = signal ? AbortSignal.any([signal, passive.signal]) : passive.signal;
      let waiting: {scenario: string; command: ReturnType<Cdp['snapshot']>; sample: ProcessSample} | undefined;
      const cancel = () => {
        passive.abort();
        if (waiting?.sample.status === 'pending') waiting.sample = {status: 'unavailable', fromMs: waiting.sample.fromMs, toMs: performance.now()};
      };
      cancelPassive = cancel;
      const timer = setTimeout(() => {
        if (pending.aborted) return;
        report.waiting = page.snapshot();
        if (diagnostic) capture ??= collect(label);
        else {
          waiting = {scenario: label, command: page.snapshot(), sample: {status: 'pending', fromMs: performance.now(), toMs: null}};
          report.waitingProcesses = waiting;
          const entry = waiting;
          void sampleProcesses(pending).then(sample => {if (!pending.aborted) entry.sample = sample;});
        }
      }, 5000);
      try {
        const result = await run();
        if (capture) throw new Error(label + ': response arrived after diagnostic intervention');
        return result;
      } catch (error) {
        clearTimeout(timer);
        cancel();
        report.status = 'failed';
        capture ??= collect(label);
        await capture;
        throw error;
      } finally {clearTimeout(timer); cancel(); if (cancelPassive === cancel) cancelPassive = undefined;}
    },
    async close() {
      cancelPassive?.();
      try {if (capture) await capture;}
      finally {await release();}
    },
  };
}
