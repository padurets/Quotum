import {Cdp, type Browser} from './cdp.js';
import {deadline, devtoolsJson} from './deadline.js';
import {safeEvidence} from './evidence.js';

type Options = {mode?: 'canonical' | 'diagnostic'; profileBeforeInput?: boolean; closeTarget?: () => Promise<void>};
type Process = {type: string; id: number; cpuTime: number};
let serial = 0;

/** Cancellation releases the underlying CDP waiters, not just the outer Promise. */
export const bounded = <T>(label: string, work: (signal: AbortSignal) => Promise<T>, ms = 5000, signal?: AbortSignal) =>
  deadline(ms, work, signal).catch(error => {if (error instanceof Error && error.message === 'deadline exceeded') throw new Error(label + ': diagnostic deadline'); throw error;});

/** Canonical observation is passive until the unchanged command deadline has failed. */
export async function observeReversal(page: Cdp, browser: Browser, options: Options = {}) {
  const diagnostic = options.mode === 'diagnostic';
  const id = ++serial, signal = browser.owner?.signal;
  let intervention = false, capture: Promise<void> | undefined, released = false;
  const report: Record<string, unknown> = {id, mode: diagnostic ? 'diagnostic' : 'canonical', ownedBrowser: Boolean(browser.owned)};
  const store = () => {
    const safe = safeEvidence(report);
    browser.owner?.evidence?.save('cdp-' + id, safe);
    console.error('reversal diagnostic ' + JSON.stringify(safe));
  };
  const send = (method: string, pending: AbortSignal) => page.send(method, {}, pending);
  const release = async () => {
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
        control = await Cdp.connect(reply.webSocketDebuggerUrl, alive);
        const processes = await control.send<{processInfo: Process[]}>('SystemInfo.getProcessInfo', {}, alive);
        report.processes = processes.processInfo.map(({type, id, cpuTime}) => ({type, id, cpuTime}));
        if (browser.diagnostics) report.native = await browser.diagnostics(processes.processInfo.map(value => value.id), undefined, alive);
      }, 2000, pending);
    } catch {report.livenessStatus = 'unavailable';}
    finally {control?.close();}
  };
  const collect = async (label: string) => {
    report.scenario = label; report.command = page.snapshot();
    try {
      await bounded('failure collection', async pending => {
        await Promise.all([
          liveness(pending),
          bounded('page liveness', async probe => {
            report.page = await page.evaluate('({visibility:document.visibilityState,focus:document.hasFocus(),ready:document.readyState})', probe);
          }, 2000, pending).catch(() => {report.page = 'unresponsive';}),
        ]);
        if (diagnostic) {
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
    async watch<T>(label: string, run: () => Promise<T>) {
      signal?.throwIfAborted();
      const timer = setTimeout(() => {
        report.waiting = page.snapshot();
        if (diagnostic) capture ??= collect(label);
      }, 5000);
      try {
        const result = await run();
        if (capture) throw new Error(label + ': response arrived after diagnostic intervention');
        return result;
      } catch (error) {
        clearTimeout(timer);
        report.status = 'failed';
        capture ??= collect(label);
        await capture;
        throw error;
      } finally {clearTimeout(timer);}
    },
    async close() {
      try {if (capture) await capture;}
      finally {await release();}
    },
  };
}
