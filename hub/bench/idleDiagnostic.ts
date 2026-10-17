import {openTab, type Browser, type Cdp} from './cdp.js';
import type {Reading} from './probe.js';
import {Requests} from './requests.js';
import {idleProblems, IDLE_SCRIPT_MS_PER_SECOND} from './budget.js';
import {scriptPerSecond, type Metrics} from './report.js';
import {idleWindow, idlePhaseScript, idlePhaseProblems, type IdlePhase} from './still.js';
import type {Evidence} from './evidence.js';
import type {Heard} from './stream.js';
import {idleRetentionProblems,type IdleRetention} from './idleRetention.js';

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
export async function doubledIdle(browser: Browser, primary: Cdp, base: string, seconds: number, cellMs: number, evidence: Evidence, heard: Heard, baselineScriptMsPerSecond:number,
  baseline:{retention:IdleRetention|null;bootstrapSource:string}) {
  if (!browser.owned) throw new Error('idle sensitivity requires an owned synthetic browser');
  const extra = await openTab(browser);
  let failed = false;
  try {
    const {cdp} = extra;
    await cdp.send('Page.enable'); await cdp.send('Network.enable'); await cdp.send('Performance.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source: baseline.bootstrapSource});
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
    heard.reset({from:planned.from,to:planned.to});
    const starts = await Promise.all(pages.map(async ({page, requests}) => {
      await page.evaluate('__quotumBench.reset()'); await page.evaluate(idlePhaseScript(cellMs));
      requests.counting = true;
      const cards=await page.evaluate<number>('document.querySelectorAll(".card").length'),before=await metrics(page),from=Date.now();
      const retentionBefore=await page.evaluate<IdleRetention|null>('window.__quotumIdleRetention()');
      const firstReading=await page.evaluate<Reading>('__quotumBench.read()');
      return {before,from,cards,retentionBefore,firstReading};
    }));
    await sleep(planned.to - Date.now());
    const events = heard.counts();
    const boardEvents=heard.boardCounts(),deviceContacts=heard.contacts(),deviceHints=heard.hints();
    const reports = await Promise.all(pages.map(async ({page, requests}, index) => {
      const lastReading=await page.evaluate<Reading>('__quotumBench.read()');
      const retentionAfter=await page.evaluate<IdleRetention|null>('window.__quotumIdleRetention()'),to=Date.now();
      const after=await metrics(page),reading=await page.evaluate<Reading>('__quotumBench.read()');
      requests.counting = false;
      const phase = await page.evaluate<IdlePhase>('(()=>{const p=__quotumIdlePhase.read();__quotumIdlePhase.stop();return p;})()');
      const seconds = after.Timestamp - starts[index].before.Timestamp;
      const scriptMsPerSecond = scriptPerSecond(starts[index].before, after, reading.instrumentMs, seconds);
      const calendar=heard.calendar();
      const start=starts[index],idle = {from:start.from,to,cellMs,requests,events:boardEvents,calendar,renders:reading.renders,mutations:reading.mutations,scriptMsPerSecond};
      const problems=[...idlePhaseProblems(phase,planned.boundary,planned.quotaBoundary),
        ...idleRetentionProblems(start.retentionBefore,retentionAfter,start.from,to,planned.quotaBoundary),...idleProblems(idle)];
      if(!(start.from<planned.quotaBoundary&&planned.quotaBoundary<to))problems.push('idle counters did not include regular quota retirement');
      if(start.firstReading.commits||start.firstReading.mutations.length)problems.push('idle work crossed the opening measurement boundary');
      if(reading.commits!==lastReading.commits||JSON.stringify(reading.mutations)!==JSON.stringify(lastReading.mutations))problems.push('idle work crossed the closing measurement boundary');
      if(!Number.isFinite(seconds)||seconds<=0)problems.push('idle performance duration unavailable');
      const period=start.retentionBefore?.selection.periodMs??NaN;
      const due=start.retentionBefore?.quota?.rows.filter(row=>row.second!==null&&start.from<row.second+1+period&&row.second+1+period<to)
        .map(row=>({sourceId:row.sourceId,windowId:row.windowId})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return {id:index,cards:start.cards,seconds,scriptMsPerSecond,phase,events,boardEvents,calendar,deviceContacts,deviceHints,
        counterFrom:start.from,counterTo:to,retentionBefore:start.retentionBefore,retentionAfter,due,problems};
    }));
    // Different calendar windows can retire different 5/15-minute rows. Preserve
    // their snapshots; growth concerns two live boards, not identical retirement cost.
    const cohort=(snapshot:IdleRetention|null)=>snapshot?.quota?JSON.stringify([snapshot.scopeKey,snapshot.selection,
      snapshot.quota.rows.map(row=>JSON.stringify([row.sourceId,row.windowId,row.last])).sort()]):null;
    const baselineCohort=cohort(baseline.retention);
    for(const report of reports){
      if(!baselineCohort||cohort(report.retentionBefore)!==baselineCohort)report.problems.push('idle copy differs from the baseline quota cohort or selection');
      if(JSON.stringify(report.due)!==JSON.stringify(reports[0].due))report.problems.push('idle copies retired different quota cohorts');
    }
    const phaseValid = reports.every(report => report.cards === reports[0].cards && report.cards > 0 && !report.problems.length);
    const result = {mode: 'diagnostic', mechanism: 'two independent live boards',baselineRetention:baseline.retention,reports,
      ...idleSensitivity(baselineScriptMsPerSecond,reports.map(report=>report.scriptMsPerSecond),phaseValid)};
    evidence.save('idle-double', result);
    return result;
  } catch (error) {failed = true; throw error;}
  finally {
    try {await extra.close();} catch (error) {if (!failed) throw error;}
  }
}
