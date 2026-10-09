import {openTab, type Browser, type Cdp} from './cdp.js';
import {probeScript, type Reading} from './probe.js';
import {Requests} from './requests.js';
import {idleProblems, IDLE_SCRIPT_MS_PER_SECOND} from './budget.js';
import {scriptPerSecond, type Metrics} from './report.js';
import {idleWindow, idlePhaseScript, idlePhaseProblems, type IdlePhase} from './still.js';
import type {Evidence} from './evidence.js';
import type {Heard} from './stream.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const metrics = async (cdp: Cdp): Promise<Metrics> => Object.fromEntries((await cdp.send<{metrics: {name: string; value: number}[]}>('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

/** Sensitivity is measured growth; crossing the absolute idle budget is reported separately. */
export function idleSensitivity(baselineScriptMsPerSecond:number,copies:readonly number[],phaseValid:boolean) {
  const valid=phaseValid&&copies.length===2&&Number.isFinite(baselineScriptMsPerSecond)&&baselineScriptMsPerSecond>0&&copies.every(cost=>Number.isFinite(cost)&&cost>=0);
  const scriptMsPerSecond=copies.reduce((sum,cost)=>sum+cost,0);
  return {baselineScriptMsPerSecond,scriptMsPerSecond,valid,
    increaseMsPerSecond:valid?scriptMsPerSecond-baselineScriptMsPerSecond:null,
    ratio:valid?scriptMsPerSecond/baselineScriptMsPerSecond:null,
    growthDetected:valid&&scriptMsPerSecond>baselineScriptMsPerSecond,
    overBudget:valid&&scriptMsPerSecond>IDLE_SCRIPT_MS_PER_SECOND,threshold:IDLE_SCRIPT_MS_PER_SECOND};
}

/** Two independent live boards execute the same clock work; no measured cost is multiplied. */
export async function doubledIdle(browser: Browser, primary: Cdp, base: string, seconds: number, cellMs: number, evidence: Evidence, heard: Heard, baselineScriptMsPerSecond:number) {
  if (!browser.owned) throw new Error('idle sensitivity requires an owned synthetic browser');
  const extra = await openTab(browser);
  try {
    const {cdp} = extra;
    await cdp.send('Page.enable'); await cdp.send('Network.enable'); await cdp.send('Performance.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source: probeScript()});
    await cdp.send('Page.navigate', {url: base + '/'});
    const until = Date.now() + 20_000;
    while (!await cdp.evaluate<boolean>(`document.querySelectorAll('.card:not(.is-loading)').length>0 && ['.history','.activity','.budget-history','.subscription-funds'].every(panel=>document.querySelector(panel+' .chart>svg[data-draw-ready="true"]'))`)) {
      if (Date.now() > until) throw new Error('the second idle board did not load');
      await sleep(100);
    }
    const planned = idleWindow(Date.now() + 30_000, seconds, cellMs);
    evidence.begin('diagnostic-double-idle'); evidence.save('idle-double-plan', planned);
    await sleep(planned.from - Date.now());
    const pages = [primary, cdp].map(page => ({page, requests: new Requests(page)}));
    heard.reset();
    const starts = await Promise.all(pages.map(async ({page, requests}) => {
      await page.evaluate('__quotumBench.reset()'); await page.evaluate(idlePhaseScript(cellMs));
      requests.counting = true;
      return {before: await metrics(page), from: Date.now(), cards: await page.evaluate<number>('document.querySelectorAll(".card").length')};
    }));
    await sleep(planned.to - Date.now());
    const events = heard.counts();
    const reports = await Promise.all(pages.map(async ({page, requests}, index) => {
      const reading = await page.evaluate<Reading>('__quotumBench.read()'), after = await metrics(page);
      requests.counting = false;
      const phase = await page.evaluate<IdlePhase>('(()=>{const p=__quotumIdlePhase.read();__quotumIdlePhase.stop();return p;})()');
      const seconds = after.Timestamp - starts[index].before.Timestamp;
      const scriptMsPerSecond = scriptPerSecond(starts[index].before, after, reading.instrumentMs, seconds);
      const idle = {from: starts[index].from, to: Date.now(), cellMs, requests, events, renders: reading.renders, mutations: reading.mutations, scriptMsPerSecond};
      return {id: index, cards: starts[index].cards, seconds, scriptMsPerSecond, phase, events,
        problems: [...idlePhaseProblems(phase, planned.boundary), ...idleProblems(idle)]};
    }));
    const phaseValid = reports.every(report => report.cards === reports[0].cards && report.cards > 0 && !report.problems.length);
    const result = {mode: 'diagnostic', mechanism: 'two independent live boards', reports,
      ...idleSensitivity(baselineScriptMsPerSecond,reports.map(report=>report.scriptMsPerSecond),phaseValid)};
    evidence.save('idle-double', result);
    return result;
  } finally {await extra.close();}
}
