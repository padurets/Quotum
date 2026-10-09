import {cellOf, cellStart} from '../server/domain/history.js';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {realpathSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {MONEY_KEY} from '../demo/money.js';
import type {Credential} from '../server/store/credentials.js';
import type {Meter} from '../server/domain/meters.js';
import type {CurrencyDefinition,CurrencyManagement,RateSnapshot} from '../server/domain/currency.js';
import {fileURLToPath} from 'node:url';
import {SETS} from '../demo/catalogue.js';
import {addressOf, Demo, prepare, Stop} from '../demo/index.js';
import {cards, people} from '../demo/model.js';
import type {Snapshot} from '../server/projection.js';
import {chartProblems, creditRenderProblems, HISTORY_BYTES_PER_MEASUREMENT, idleProblems, measuredProblems, percentile, privateWorkRenderProblems, renderProblems} from './budget.js';
import {attachedChrome, findChrome, launchChrome, openTab, type Browser, type Cdp} from './cdp.js';
import {probeScript, type Reading} from './probe.js';
import {delta, round, scriptPerSecond, tally, type Metrics} from './report.js';
import {idlePhaseProblems, idlePhaseScript, idleWindow, overviewCards, stillProblems, stillSnapshot, warmUntil, type IdlePhase} from './still.js';
import {hear, type Heard} from './stream.js';
import {frequencyKeys, moneyView, selectMoney} from './controls.js';
import {panning} from './panning.js';
import {seedPanningBudgets,panningSet} from './fixture.js';
import {historyTraffic} from './historyTraffic.js';
import {diagnoseReversal} from './historyTrafficBrowser.js';
import {RunOwner} from './runOwner.js';
import {Evidence} from './evidence.js';
import {Requests} from './requests.js';
export {Requests} from './requests.js';
import {doubledIdle} from './idleDiagnostic.js';
import {panningPairs, tracePanning, traceControls} from './panningDiagnostic.js';
import {ChromeLaunchError} from './chrome.js';
import {creditSnapshot} from './credits.js';
import {startupTrials} from './startupDiagnostic.js';

/**
 * `npm run bench -- [--ci] [--cdp <http://host:port>]`: how much an open dashboard costs,
 * measured in a real browser on the built hub and page (`npm run build` first). A hub of
 * the demo's catalogue stands still, its agents not working; Ana's personal board is opened in
 * headless Chrome (QUOTUM_CHROME, else the first Chrome on PATH, or one already running,
 * with `--cdp`), and the page is watched while nothing but the clock changes: what it
 * asks the hub and the hub tells the board, what React renders and the DOM changes, and
 * the time its scripts take. Then one card is measured again and again: how soon each
 * measurement shows on it, and that nothing else of the board renders for it. Prints the
 * numbers as JSON, and exits 1 when they are over budget (budget.ts); `--ci` watches the
 * idle page for a shorter time.
 */

const USAGE = 'Usage: npm run bench -- [--ci] [--cdp <http://host:port>]';
/** How long the idle page is watched, in seconds. */
const IDLE = {full: 300, ci: 120};
/** How long the board may take to show its cards. */
const SHOWN_MS = 30_000;
/** The card measured again and again: on Ana's personal board, measured by her laptop, with no plan. */
const MEASURED = 'antigravity';
/** How many times, and how far apart. */
const MEASUREMENTS = 20;
const MEASURE_EVERY = 3_000;
/** A measurement that has not shown on its card by then does not show. */
const SHOWN_WITHIN = 5_000;

export function parseArgs(argv: string[]): {ci: boolean; cdp: string | null} {
  let ci = false;
  let cdp: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ci') ci = true;
    else if (arg === '--cdp') {
      cdp = argv[++i] ?? '';
      if (!/^https?:\/\/[^/]+\/?$/.test(cdp)) throw new Stop(`--cdp takes the browser's DevTools address, as http://host:port, not "${cdp}".\n${USAGE}`);
    } else throw new Stop(`Unknown argument "${arg}".\n${USAGE}`);
  }
  return {ci, cdp};
}

/** A port nothing listens on now, for the hub. */
function freePort(bind: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({host: bind, port: 0}, () => {
      const {port} = probe.address() as {port: number};
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const say = (text: string) => console.error(`bench: ${text}`);

async function metrics(cdp: Cdp): Promise<Metrics> {
  const {metrics} = await cdp.send<{metrics: {name: string; value: number}[]}>('Performance.getMetrics');
  return Object.fromEntries(metrics.map(m => [m.name, m.value]));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = new Evidence();
  const panDiagnostic = process.env.QUOTUM_BENCH_DIAGNOSE_PANNING;
  const idleDiagnostic = process.env.QUOTUM_BENCH_DIAGNOSE_IDLE;
  const startupDiagnostic = process.env.QUOTUM_BENCH_DIAGNOSE_STARTUP;
  const bind = process.env.QUOTUM_BIND || '127.0.0.1';
  let address: ReturnType<typeof addressOf>, chrome: ReturnType<typeof findChrome>;
  try {
    address = addressOf({...process.env, QUOTUM_PORT: process.env.QUOTUM_PORT || String(await freePort(bind))});
    if (startupDiagnostic && (startupDiagnostic !== '1' || options.cdp || panDiagnostic || idleDiagnostic || process.env.QUOTUM_BENCH_DIAGNOSE_NATIVE)) throw new Stop('Unknown or conflicting startup diagnostic mode');
    if (idleDiagnostic && (idleDiagnostic !== 'double' || panDiagnostic)) throw new Stop('Unknown or conflicting idle diagnostic mode');
    if (panDiagnostic && !['pairs', 'trace'].includes(panDiagnostic)) throw new Stop('Unknown panning diagnostic mode');
    await prepare(address);
    chrome = options.cdp ? null : findChrome(process.env);
    if (!options.cdp && !chrome) throw new Stop('No Chrome to run: set QUOTUM_CHROME, put google-chrome or chromium on PATH, or pass --cdp <http://host:port>.');
  } catch (error) {
    evidence.finish('failed', {stage: 'preparation', status: 'no-browser-created'});
    throw error;
  }
  const seconds = options.ci ? IDLE.ci : IDLE.full;

  let browser: Browser | undefined;
  let tab: Awaited<ReturnType<typeof openTab>> | undefined;
  let heard: Heard | undefined;
  const owner = new RunOwner(evidence);
  let cancelled = false;
  let finishing: Promise<void> | undefined;
  const finish = (code: number): Promise<void> => finishing ??= (async () => {
    heard?.close();
    evidence.begin('cleanup');
    try {await owner.close();} catch (error) {code = 1; say(String(error));}
    try {await demo.stop();} catch {code = 1; say('demo cleanup failed');}
    evidence.finish(cancelled ? 'cancelled' : code ? 'failed' : (process.env.QUOTUM_BENCH_DIAGNOSE_NATIVE === '1' || panDiagnostic || idleDiagnostic || startupDiagnostic) ? 'diagnostic' : 'passed', {browser: browser?.launchReport?.(), failures: owner.failures});
    process.exit(code);
  })();
  const set = panningSet(SETS[0]);
  const demo = new Demo({set, scene: set.scene, still: true, idleAgents: true,money:false, address, onExit: () => void finish(1)});
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => {cancelled = true; void finish(1);});

  try {
    say(`a still hub of the ${set.id} set at ${address.base}`);
    const stand = await demo.run();
    seedPanningBudgets(path.join(demo.dir,'quotum.sqlite'),stand);
    const ana = stand.people.get(people(set)[0].id)!;
    const board = ana.personalBoard;
    const overview = () => overviewCards(path => ana.get<Snapshot>(path), board);
    heard = await hear(address.base, ana.cookie, board);

    if(startupDiagnostic){
      const code = await startupTrials(chrome!,!process.env.CI,owner,evidence);
      await finish(code);return;
    }
    browser = await owner.start(signal => options.cdp ? Promise.resolve(attachedChrome(options.cdp)) : launchChrome(chrome!, !process.env.CI, signal));
    evidence.save('browser', browser.launchReport?.() ?? {mode: 'attached'});
    if(process.env.QUOTUM_BENCH_DIAGNOSE_NATIVE==='1'){
      say('diagnostic native replay only; this does not run the canonical benchmark');
      await diagnoseReversal(browser,address.base,ana.cookie,24);
      say('diagnostic replay completed; canonical benchmark was not run');
      await finish(0);return;
    }
    // The unchanged traffic matrix runs while the seeded measurements age. Its
    // temporary pages close before the idle board opens or any script budget starts.
    let traffic:Awaited<ReturnType<typeof historyTraffic>>|undefined;
    if(!panDiagnostic&&!idleDiagnostic){
      say('checking controlled pan traffic over fixed Brotli HTTP, separately from native performance');
      evidence.begin('history-traffic');
      const current = await ana.get<Snapshot>(`/api/overview?board=${encodeURIComponent(board)}`);
      try{traffic=await historyTraffic(address.base, ana.cookie, board, current.sources.flatMap(source => source.windows.map(window => `${source.id} ${window.id}`)), browser, evidence);}
      catch(error){
        if(/browser\/(?:1|30)d\/reversal/.test(String(error))){
          say('replaying the failed reversal with page and browser diagnostics; the original failure remains');
          try{await diagnoseReversal(browser,address.base,ana.cookie);}catch(diagnostic){say('reversal replay failed: '+String(diagnostic));}
        }
        throw error;
      }
      evidence.save('history-traffic', traffic);
      if(process.env.QUOTUM_BENCH_REVERSAL_PROBE==='1')await diagnoseReversal(browser,address.base,ana.cookie,12);
    }
    tab = await openTab(browser);
    const {cdp} = tab;
    const requests = new Requests(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    const split = ana.cookie.indexOf('=');
    await cdp.send('Network.setCookie', {name: ana.cookie.slice(0, split), value: ana.cookie.slice(split + 1), url: address.base, httpOnly: true, sameSite: 'Lax'});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source: `localStorage.setItem('quotum.locale','en');\n${probeScript()}`});
    await cdp.send('Page.navigate', {url: `${address.base}/`});

    const shownBy = Date.now() + SHOWN_MS;
    while ((await cdp.evaluate<number>(`document.querySelectorAll('.card:not(.is-loading)').length`)) === 0) {
      if (Date.now() > shownBy) throw new Stop(`The board showed no cards in ${SHOWN_MS / 1000} s.`);
      await sleep(250);
    }
    if (panDiagnostic) {
      evidence.begin('diagnostic-panning-'+panDiagnostic);
      say('diagnostic panning '+panDiagnostic+'; canonical benchmark is not run');
      await cdp.evaluate('__quotumBench.pause()');
      const result = panDiagnostic === 'pairs' ? await panningPairs(cdp, browser, evidence) : await tracePanning(cdp, browser, evidence);
      evidence.save('diagnostic-panning-result', 'attempts' in result ? result : {
        mode:'diagnostic',problems:result.problems.map(reason=>({reason})),
        reports:result.reports.map(report=>({initiator:report.initiator,period:report.period,
          frameP95:percentile(report.frames,.95),frameP99:percentile(report.frames,.99),inputP95:percentile(report.latency,.95),
          frames:report.frames.length,inputs:report.inputs,credited:report.latency.length,
          omitted:report.timeline?.omitted??0,cost:report.cost})),
      });
      if(panDiagnostic==='trace')await traceControls(browser,evidence);
      say('diagnostic panning completed; all outcomes remain in artifacts');
      await finish('attempts' in result && result.attempts.some(attempt => attempt.status === 'failed') ? 1 : 0); return;
    }
    const opened = Date.now();
    evidence.begin('warmup');
    const warm = warmUntil(await overview(), opened);
    say(`the board is open; it settles for ${Math.round((warm - Date.now()) / 1000)} s`);
    await sleep(warm - Date.now());
    if (heard.counts().history) throw new Stop('The stand credited agent work during warmup; its agents must be idle.');

    const cellMs = cellOf(86_400_000);
    const planned = idleWindow(Date.now(), seconds, cellMs);
    evidence.save('idle-plan', planned);
    say(`waiting ${Math.round((planned.from-Date.now())/1000)} s to include one real chart-cell transition`);
    await sleep(planned.from-Date.now());
    const from = Date.now();
    const to = from + seconds * 1000;
    const moving = stillProblems(await overview(), from, to);
    if (moving.length) throw new Stop(`The stand does not stand still over the window, so its numbers would not be of an idle board: ${moving.join('; ')}.`);

    say(`watching the idle page for ${seconds} s`);
    evidence.begin('idle');
    await cdp.evaluate('__quotumBench.reset()');
    await cdp.evaluate(idlePhaseScript(cellMs));
    heard.reset();
    requests.counting = true;
    const before = await metrics(cdp);
    const firstReading = await cdp.evaluate<Reading>('__quotumBench.read()');
    await sleep(to - Date.now());
    const lastReading = await cdp.evaluate<Reading>('__quotumBench.read()');
    const after = await metrics(cdp);
    requests.counting = false;
    const events = heard.counts();
    const reading = await cdp.evaluate<Reading>('__quotumBench.read()');
    const phase = await cdp.evaluate<IdlePhase>('(()=>{const p=__quotumIdlePhase.read();__quotumIdlePhase.stop();return p;})()');
    const actualSeconds = after.Timestamp - before.Timestamp;
    const phaseProblems = idlePhaseProblems(phase, planned.boundary);
    if (firstReading.commits || firstReading.mutations.length) phaseProblems.push('idle work crossed the opening measurement boundary');
    if (reading.commits !== lastReading.commits || JSON.stringify(reading.mutations) !== JSON.stringify(lastReading.mutations)) phaseProblems.push('idle work crossed the closing measurement boundary');
    if (!Number.isFinite(actualSeconds) || actualSeconds <= 0) phaseProblems.push('idle performance duration unavailable');
    const scriptMsPerSecond = scriptPerSecond(before, after, reading.instrumentMs, actualSeconds);
    const idle = {from, to, cellMs, requests, events, renders: reading.renders, mutations: reading.mutations, scriptMsPerSecond};
    evidence.save('idle', {...idle, planned, phase, actualSeconds, phaseProblems});
    if (idleDiagnostic) {
      const baselineProblems=[...phaseProblems,...idleProblems(idle)];
      if(baselineProblems.length)throw new Stop('idle sensitivity baseline failed: '+baselineProblems.join('; '));
      say('checking sensitivity with two independent copies of the same idle board');
      const control=await doubledIdle(browser,cdp,address.base,seconds,cellMs,evidence,heard,scriptMsPerSecond);
      say(`idle double control: ${JSON.stringify(control)}`);
      await finish(control.growthDetected?0:1);return;
    }

    evidence.begin('measurements');
    const measured = await measure(stand, cdp);
    evidence.save('measured', measured);
    evidence.begin('work');
    const worked = await work(demo, stand, cdp);
    evidence.save('work', worked);
    const privateWork = await workPrivate(demo, stand, cdp);
    evidence.save('private-work', privateWork);
    const problems = [
      ...idleProblems(idle),
      ...phaseProblems,
      ...worked.problems,
      ...privateWork.problems,
      ...chartProblems(measured.chartLatencies),
      ...(measured.historyBytes <= HISTORY_BYTES_PER_MEASUREMENT ? [] : [`history read ${measured.historyBytes} bytes per measurement, above budget`]),
      ...measuredProblems({
        card: measured.source,
        latencies: measured.latencies,
        renders: measured.reading.renders,
        mutations: measured.reading.mutations,
        from: measured.from,
        to: measured.to,
      }),
    ];
    // The readings above are frozen: keyboard checks do not enter the performance budget.
    say('checking consecutive frequency saves with native arrow keys');
    await frequencyKeys(cdp);
    // Panning has its own movement and mutation probe. Traversing React and the
    // DOM for the finished measurement phase would add unrelated work to every frame.
    await cdp.evaluate('__quotumBench.pause()');
    say('checking native continuous wheel and Shift-drag from quota, budget and subscription funds at 24h and 30d, CPU ×4');
    evidence.begin('panning');
    const panned = await panning(cdp, undefined, evidence);
    evidence.save('panning', panned);
    problems.push(...panned.problems);
    say(`native panning: ${JSON.stringify({reports: panned.reports.map(report => ({initiator: report.initiator, period: report.period, frameP95Ms: round(percentile(report.frames, .95)), frameP99Ms: round(percentile(report.frames, .99)), inputP95Ms: round(percentile(report.latency, .95))})), problems: panned.problems})}`);
    if(!traffic)throw new Stop('canonical history traffic readings unavailable');
    problems.push(...traffic.problems);
    evidence.begin('credits');
    const credits=await creditPhase(demo,stand,cdp,evidence);
    evidence.save('credits', credits);
    problems.push(...credits.problems);
    evidence.begin('money');
    const monetary=await moneyPhase(demo,stand,cdp,evidence);
    evidence.save('money', monetary);
    problems.push(...monetary.problems);
    const result = {
      set: set.id,
      idle: {
        seconds: actualSeconds, plannedSeconds: seconds, planned, phase, phaseProblems,
        requests: {count: requests.count, bytes: requests.bytes, byPath: requests.byPath},
        events,
        renders: {commits: reading.commits, ...tally(reading.renders)},
        mutations: tally(reading.mutations),
        scriptMsPerSecond,
        instrumentMsPerSecond: round(reading.instrumentMs / actualSeconds),
        taskMsPerSecond: round((delta(before, after, 'TaskDuration') * 1000) / actualSeconds),
        layouts: delta(before, after, 'LayoutCount'),
        recalcStyles: delta(before, after, 'RecalcStyleCount'),
      },
      measured: {
        card: MEASURED,
        count: measured.latencies.length,
        lost: measured.latencies.filter(latency => !Number.isFinite(latency)).length,
        medianMs: Math.round(percentile(measured.latencies, 0.5)),
        p95Ms: Math.round(percentile(measured.latencies, 0.95)),
        chartP95Ms: Math.round(percentile(measured.chartLatencies, 0.95)),
        chartLost: measured.chartLatencies.filter(latency => !Number.isFinite(latency)).length,
        historyBytesPerMeasurement: measured.historyBytes,
        renders: tally(measured.reading.renders).outsideBy,
        mutations: tally(measured.reading.mutations).outsideBy,
      },
      work: worked.reports,
      privateWork: privateWork.reports,
      money:monetary,
      credits,
      historyTraffic: traffic,
      panning: panned.reports.map(report => ({...report,
        frames: {count: report.frames.length, p95Ms: round(percentile(report.frames, .95)), p99Ms: round(percentile(report.frames, .99))},
        latency: {count: report.latency.length, p95Ms: round(percentile(report.latency, .95))},
      })),
      problems,
    };
    console.log(JSON.stringify(result, null, 2));
    evidence.save('result', result);
    if (problems.length) say(`over budget:\n- ${problems.join('\n- ')}`);
    await finish(problems.length ? 1 : 0);
  } catch (error) {
    if (finishing) return;
    evidence.save('failure', {status: 'failed', kind: error instanceof Stop ? 'fixture' : 'runtime'});
    if(error instanceof ChromeLaunchError)evidence.save('browser',error.report);
    await demo.settled();
    console.error(error instanceof Stop ? error.message : `The benchmark failed: ${(error as Error).stack ?? error}`);
    await finish(error instanceof Stop ? 2 : 1);
  }
}

/**
 * Measures one card of Ana's board `MEASUREMENTS` times, a different number each time, as
 * its machine would: how long after each measurement was sent its card changed outside
 * what shows time, and what the page did over all of them.
 */
async function measure(stand: Awaited<ReturnType<Demo['run']>>, cdp: Cdp) {
  const card = cards(stand.set).find(c => c.id === MEASURED)!;
  const source = stand.sources.get(MEASURED)!;
  const agent = stand.agents.get(card.machines[0])!;
  say(`measuring ${MEASURED} ${MEASUREMENTS} times, ${MEASURE_EVERY / 1000} s apart`);
  await cdp.evaluate('__quotumBench.reset()');
  const from = Date.now();
  const latencies: number[] = [];
  const chartLatencies: number[] = [];
  const requests = new Requests(cdp); requests.counting = true;
  const overview = await stand.people.get(people(stand.set)[0].id)!.get<Snapshot>('/api/overview');
  const initial = overview.sources.find(s => s.id === source)!.windows.find(w => w.id === 'gemini:weekly')!.used;
  for (let i = 0; i < MEASUREMENTS; i++) {
    await cdp.evaluate('__quotumBench.forgetCards()');
    const taken = stillSnapshot(card, stand.start, Date.now());
    const used = initial + (i + 1) * .1;
    const windows = taken.windows.map(w => w.id === 'gemini:weekly' ? {...w, usedPercent: used} : w);
    const last = `${cellStart(Date.parse(taken.observedAt), cellOf(86_400_000))}:${Math.round((100 - used) * 100) / 100}`;
    const sent = Date.now();
    await agent.ingest([{...taken, windows}], [], sent);
    let changed: number | null = null;
    let chart: number | null = null;
    while ((changed === null || chart === null) && Date.now() < sent + SHOWN_WITHIN) {
      changed = await cdp.evaluate<number | null>(`__quotumBench.cardChanged(${JSON.stringify(source)})`);
      chart = await cdp.evaluate<number | null>(`__quotumBench.seriesChanged(${JSON.stringify(source + ' gemini:weekly')}, ${JSON.stringify(last)})`);
      if (changed === null || chart === null) await sleep(20);
    }
    latencies.push(changed === null ? Infinity : changed - sent);
    chartLatencies.push(chart === null ? Infinity : chart - sent);
    if (!Number.isFinite(chart)) {
      const key = source + ' gemini:weekly';
      const shown = await cdp.evaluate(`(() => {
        const line = [...document.querySelectorAll('[data-series]')].find(node => node.getAttribute('data-series') === ${JSON.stringify(key)});
        return {last: line?.getAttribute('data-last'), chart: line?.closest('svg')?.dataset, paths: line?.querySelectorAll('path').length};
      })()`);
      say(`missing quota update: ${JSON.stringify({measurement: i + 1, observedAt: taken.observedAt, expected: last, observed: String(chart), shown})}`);
    }
    await sleep(sent + MEASURE_EVERY - Date.now());
  }
  await drain(requests); requests.counting = false;
  say(`quota measurement latencies: ${JSON.stringify({cards: latencies.map(String), charts: chartLatencies.map(String)})}`);
  return {source, latencies, chartLatencies, historyBytes: (requests.bytesByPath['/api/history'] ?? 0) / MEASUREMENTS, reading: await cdp.evaluate<Reading>('__quotumBench.read()'), from, to: Date.now()};
}

/** Mixed-source credit updates retain quota drawings and only read their own financial tail. */
async function creditPhase(demo:Demo,stand:Awaited<ReturnType<Demo['run']>>,cdp:Cdp,evidence:Evidence) {
  say('checking Codex balance changes and unchanged credit heartbeats independently of quota and wallet analytics');
  const owner=stand.people.get(people(stand.set)[0].id)!,overview=await owner.get<Snapshot>('/api/overview');
  const card=cards(stand.set).find(card=>card.provider==='codex'&&overview.sources.some(source=>source.id===stand.sources.get(card.id)&&source.windows.length))!;
  if(!card)throw new Stop('no measured Codex subscription for the credit heartbeat phase');
  const source=stand.sources.get(card.id)!,agent=stand.agents.get(card.machines[0])!;
  const deliver=(amount:string,at:number)=>agent.ingest([creditSnapshot(card,stand.start,at,amount)],[],Date.now());
  await cdp.evaluate(`(async()=>{document.querySelector('.period .picker > button').click();await new Promise(requestAnimationFrame);document.querySelectorAll('.period .popover .popover-row')[4].click();})()`);
  // Late independent balances are accepted without replacing these newer quotas.
  // Observation time stays in the past; latency below starts at actual delivery.
  const quotaAt=Date.now();
  await agent.ingest([stillSnapshot(card,stand.start,quotaAt)],[],quotaAt);
  await deliver('2500',quotaAt-25_000);
  await selectMoney(cdp,[[source,'balance:credits']],'funds');
  const ledger=new DatabaseSync(path.join(demo.dir,'quotum.sqlite'),{readOnly:true});
  const rows=()=>Number(ledger.prepare('SELECT count(*) n FROM readings WHERE source_id=? AND meter_id=?').get(source,'balance:credits')?.n);
  const coverage=()=>Number(ledger.prepare('SELECT max(to_at) at FROM meter_spans WHERE source_id=? AND meter_id=?').get(source,'balance:credits')?.at);
  const drawing=async()=>{
    const {paths,...state}=await cdp.evaluate<{present:boolean;at:number|null;value:number|null;ready:boolean;paths:string[]}>(`(() => {
      const line=[...document.querySelectorAll('[data-series]')].find(node=>node.getAttribute('data-series')===${JSON.stringify(source+' balance:credits')});
      const mark=/^(\\d+):(-?\\d+)$/.exec(line?.getAttribute('data-last')??'');
      return {present:!!line,at:mark?Number(mark[1]):null,value:mark?Number(mark[2]):null,
        ready:line?.closest('.chart')?.querySelector('svg')?.dataset.drawReady==='true',
        paths:[...(line?.querySelectorAll('path')??[])].map(path=>path.getAttribute('d')??'')};
    })()`);
    return {...state,paths:paths.length,geometryHash:createHash('sha256').update(JSON.stringify(paths)).digest('hex')};
  };
  const problems:string[]=[],updates:{amount:string;heartbeat:boolean;cardMs:number|null;chartMs:number|null;historyRequests:number;historyBytes:number;ledgerRowsUnchanged:boolean;coverageAdvanced:boolean}[]=[];
  try {
    for(const [index,amount] of ['2499','2498','2498','2498'].entries()) {
      const before=await drawing();
      await cdp.evaluate('__quotumBench.reset()');
      const beforeRows=rows(),beforeCoverage=coverage(),at=quotaAt-20_000+index*2000,sent=Date.now(),heartbeat=index>=2,requests=new Requests(cdp);requests.counting=true;
      await deliver(amount,at);
      const value=String(BigInt(amount)*40_000n);
      let chart:number|null=null,changed:number|null=null;
      while(Date.now()<sent+SHOWN_WITHIN&&(chart===null||!heartbeat&&changed===null)) {
        chart=await cdp.evaluate<number|null>(`__quotumBench.seriesChanged(${JSON.stringify(source+' balance:credits')},${JSON.stringify(at+':'+value)})`);
        changed=await cdp.evaluate<number|null>(`__quotumBench.moneyChanged(${JSON.stringify(source)},${JSON.stringify(value)})`);
        if(chart===null||!heartbeat&&changed===null)await sleep(20);
      }
      await drain(requests);await sleep(100);requests.counting=false;
      const reading=await cdp.evaluate<Reading>('__quotumBench.read()'),to=Date.now(),historyBytes=requests.bytesByPath['/api/history']??0;
      const balance=await cdp.evaluate<string|null>(`document.querySelector('[data-card="${source}"] [data-money]')?.getAttribute('data-money')??null`);
      const point={amount,heartbeat,cardMs:changed===null?null:changed-sent,chartMs:chart===null?null:chart-sent,historyRequests:requests.history.length,historyBytes,ledgerRowsUnchanged:rows()===beforeRows,coverageAdvanced:coverage()>beforeCoverage};
      updates.push(point);
      const after=await drawing();
      evidence.save(`credit-update-${index+1}`,{index,observedAt:at,sent,to,expectedValue:Number(value),cellStart:cellStart(to,cellOf(86_400_000)),before,after,...point,reading});
      if(chart===null)say(`missing credit update: ${JSON.stringify({index,observedAt:at,sent,to,before,after,heartbeat})}`);
      problems.push(...chartProblems([chart===null?Infinity:chart-sent]),...creditRenderProblems({card:source,renders:reading.renders,mutations:reading.mutations,from:sent,to,cellMs:cellOf(86_400_000)}));
      if(!heartbeat)problems.push(...measuredProblems({card:source,latencies:[changed===null?Infinity:changed-sent],renders:reading.renders,mutations:reading.mutations,from:sent,to}));
      if(balance!==value||!point.coverageAdvanced||heartbeat&&!point.ledgerRowsUnchanged)problems.push('Codex heartbeat lost coverage, changed the ledger or displayed the wrong amount');
      if(requests.history.length!==1||historyBytes>HISTORY_BYTES_PER_MEASUREMENT)problems.push('Codex credit update exceeds the existing single-tail history budget');
      if(requests.history.some(read=>read.scope!=='budget'||read.meters!==JSON.stringify([[source,'balance:credits']])||read.from<cellStart(at,cellOf(86_400_000))-cellOf(86_400_000)))problems.push('Codex credit update read another resource or its full historical period');
    }
  } finally {ledger.close();}
  return {source,updates,problems};
}

async function moneyPhase(demo:Demo,stand:Awaited<ReturnType<Demo['run']>>,cdp:Cdp,evidence?:Evidence) {
  const owner=stand.people.get(people(stand.set)[0].id)!;
  say('checking money updates, partial inventory, pagination, selection and unchanged observations');
  // The panning scenarios finish at 30d; this phase measures one-day cell updates.
  await cdp.evaluate(`(async () => {
    document.querySelector('.period .picker > button').click();
    await new Promise(requestAnimationFrame);
    document.querySelectorAll('.period .popover .popover-row')[4].click();
  })()`);
  const record=await owner.post<Credential>('/api/credentials',{provider:'openrouter',secret:MONEY_KEY(1),allowNoExpiry:true});
  const source=record.sourceId!;
  const shownBy=Date.now()+SHOWN_WITHIN;
  while(!await cdp.evaluate<boolean>(`!!document.querySelector('[data-card="${source}"] [data-money]')`)){if(Date.now()>shownBy)throw new Stop('money card did not appear');await sleep(20);}
  // The dense panning wallets must not change the single-account update baseline.
  await selectMoney(cdp, [[source, 'balance']]);
  const readyBy=Date.now()+SHOWN_WITHIN;
  while(!await cdp.evaluate<boolean>(`!!document.querySelector('[data-series="${source} balance"]')`)){if(Date.now()>readyBy)throw new Stop('money chart did not appear');await sleep(20);}
  await cdp.evaluate(`(async () => {
    let before = '', stable = 0;
    const until = performance.now() + 5000;
    while (stable < 3) {
      await new Promise(requestAnimationFrame);
      const size = JSON.stringify(Array.from(document.querySelectorAll('.widgets > .widget')).map(widget => {
        const box = widget.getBoundingClientRect(); return [box.x, box.y, box.width, box.height];
      }));
      const moving = document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.target?.matches('.widget, .widget-body'));
      stable = !moving && size === before ? stable + 1 : 0; before = size;
      if (performance.now() > until) throw new Error('new money widget did not finish layout');
    }
  })()`);
  await cdp.evaluate('__quotumBench.reset()');
  const from=Date.now(),latencies:number[]=[],chartLatencies:number[]=[],requests=new Requests(cdp);requests.counting=true;
  for(let i=0;i<6;i++) {
    await cdp.evaluate('__quotumBench.forgetCards()');
    const at=Date.now(),credits=i<2?70:90,usage=33+(i+1)/10;
    writeFileSync(path.join(demo.dir,'money-control.json'),JSON.stringify({at,credits,usage}));
    await owner.post('/api/credentials/'+record.id,{secret:MONEY_KEY(1),allowNoExpiry:true});
    const value=String(Math.round((credits-usage)*1_000_000)),last=cellStart(at,cellOf(86_400_000))+':'+value;
    let card:number|null=null,chart:number|null=null;
    while((card===null||chart===null)&&Date.now()<at+SHOWN_WITHIN){
      card=await cdp.evaluate<number|null>(`__quotumBench.cardChanged(${JSON.stringify(source)})`);
      chart=await cdp.evaluate<number|null>(`__quotumBench.seriesChanged(${JSON.stringify(source+' balance')},${JSON.stringify(last)})`);
      if(card===null||chart===null)await sleep(20);
    }
    latencies.push(card===null?Infinity:card-at);chartLatencies.push(chart===null?Infinity:chart-at);await sleep(at+4_000-Date.now());
  }
  await drain(requests);requests.counting=false;
  const reading=await cdp.evaluate<Reading>('__quotumBench.read()'),to=Date.now();
  const problems=[...measuredProblems({card:source,latencies,renders:reading.renders,mutations:reading.mutations,from,to}),...chartProblems(chartLatencies)];
  const bytes=(requests.bytesByPath['/api/history']??0)/6;if(bytes>HISTORY_BYTES_PER_MEASUREMENT)problems.push('money history exceeds the existing measurement byte budget');
  const first=await owner.get<{keys:unknown[];next:string|null}>('/api/boards/'+owner.personalBoard+'/sources/'+source+'/keys?limit=50');
  if(first.keys.length!==50||!first.next)problems.push('money key pagination did not expose a full first page');
  const second=await owner.get<{keys:unknown[]}>('/api/boards/'+owner.personalBoard+'/sources/'+source+'/keys?limit=50&after='+encodeURIComponent(first.next??''));
  if(second.keys.length!==7)problems.push('money key pagination lost the final page');
  const state=await owner.get<Snapshot>('/api/overview?board='+owner.personalBoard);
  if(state.sources.find(s=>s.id===source)?.inventory?.complete!==false)problems.push('partial money inventory was reported complete');
  const previous=state.sources.find(s=>s.id===source)!;
  const previousBalance=previous.meters?.find(m=>m.id==='balance')?.amount;
  const ledger=new DatabaseSync(path.join(demo.dir,'quotum.sqlite'),{readOnly:true});
  let heartbeat:{historyRequests:number;historyBytes:number;coverageAdvanced:boolean;ledgerRowsUnchanged:boolean;valuesUnchanged:boolean};
  try {
    const rows=()=>Number(ledger.prepare("SELECT count(*) AS count FROM readings WHERE source_id=? AND meter_id IN ('credits','usage')").get(source)!.count);
    const coverage=()=>Number(ledger.prepare("SELECT max(to_at) AS at FROM meter_spans WHERE source_id=? AND meter_id='usage'").get(source)!.at);
    const beforeRows=rows(),beforeCoverage=coverage(),heartbeatFrom=Date.now(),heartbeatRequests=new Requests(cdp);
    heartbeatRequests.counting=true;await cdp.evaluate('__quotumBench.reset()');
    // A later observation of identical values must travel through the real event and history path.
    writeFileSync(path.join(demo.dir,'money-control.json'),JSON.stringify({at:heartbeatFrom,credits:90,usage:33.6}));
    await owner.post('/api/credentials/'+record.id,{secret:MONEY_KEY(1),allowNoExpiry:true});
    const deadline=Date.now()+SHOWN_WITHIN;
    while(!heartbeatRequests.byPath['/api/history']){if(Date.now()>deadline)throw new Stop('unchanged money observation did not reach browser history');await sleep(20);}
    await drain(heartbeatRequests);heartbeatRequests.counting=false;
    const current=(await owner.get<Snapshot>('/api/overview?board='+owner.personalBoard)).sources.find(s=>s.id===source)!;
    const browserBalance=await cdp.evaluate<string|null>(`document.querySelector('[data-card="${source}"] [data-money]')?.getAttribute('data-money')??null`);
    heartbeat={historyRequests:heartbeatRequests.byPath['/api/history']??0,historyBytes:heartbeatRequests.bytesByPath['/api/history']??0,coverageAdvanced:coverage()>beforeCoverage&&current.successAt!>previous.successAt!,ledgerRowsUnchanged:rows()===beforeRows,valuesUnchanged:current.meters?.find(m=>m.id==='balance')?.amount===previousBalance&&browserBalance===previousBalance};
    if(!heartbeat.coverageAdvanced||!heartbeat.ledgerRowsUnchanged||!heartbeat.valuesUnchanged)problems.push('unchanged money observation lost freshness or changed the ledger or balance');
    if(heartbeat.historyRequests>1||heartbeat.historyBytes>HISTORY_BYTES_PER_MEASUREMENT)problems.push('unchanged money observation exceeds the existing history traffic budget');
    const heartbeatReading=await cdp.evaluate<Reading>('__quotumBench.read()');
    problems.push(...renderProblems({card:source,renders:heartbeatReading.renders,mutations:heartbeatReading.mutations,from:heartbeatFrom,to:Date.now()}));
  }finally{ledger.close();}
  const currencies=await currencyPhase(demo,stand,cdp,source,record.id);problems.push(...currencies.problems);
  const capped=await owner.post<Credential>('/api/credentials',{provider:'openrouter',secret:MONEY_KEY(5),allowNoExpiry:true});
  const cappedSource=capped.sourceId!;
  let cap:Meter|undefined;
  const cappedBy=Date.now()+SHOWN_WITHIN;
  while(!cap) {
    const cappedState=await owner.get<Snapshot>('/api/overview?board='+owner.personalBoard);
    cap=cappedState.sources.find(s=>s.id===cappedSource)?.meters?.find(m=>m.kind==='cap'&&m.limit==='0');
    if(!cap){if(Date.now()>cappedBy)throw new Stop('zero-cap money fixture did not appear');await sleep(20);}
  }
  await moneyView(cdp,source,cappedSource,cap.id,evidence);
  return {count:latencies.length,p95Ms:Math.round(percentile(latencies,.95)),chartP95Ms:Math.round(percentile(chartLatencies,.95)),historyBytesPerMeasurement:bytes,heartbeat,currencies,problems};
}

/** The personal display path uses the same measurement and render budgets as native money. */
async function currencyPhase(demo:Demo,stand:Awaited<ReturnType<Demo['run']>>,cdp:Cdp,source:string,credential:string) {
  const owner=stand.people.get(people(stand.set)[0].id)!,problems:string[]=[];
  const created=await owner.post<CurrencyDefinition>('/api/currencies',{name:'Bench points',symbol:'BP',fractionDigits:2,base:'JPY',rate:'2000000'});
  const command=async(url:string,body:object)=>{const state=await owner.get<CurrencyManagement>('/api/currencies/manage');return owner.post(url,{...body,expectedRevision:state.registryRevision,requestId:crypto.randomUUID()});};
  const waitBalance=async(value:string|null)=>{
    const until=Date.now()+SHOWN_WITHIN;
    while(await cdp.evaluate<string|null>(`document.querySelector('[data-card="${source}"] [data-money]')?.getAttribute('data-money')??null`)!==value){if(Date.now()>until)throw new Stop('personal currency balance did not reach '+value);await sleep(20);}
  };
  await owner.post('/api/currencies/display',{currency:created.id});await waitBalance(null);
  const quote=await owner.post<RateSnapshot>('/api/currencies/'+created.id+'/rates',{base:'USD',rate:'2000000',date:0});await waitBalance('112800000');
  const observation=(await owner.get<Snapshot>('/api/overview?board='+owner.personalBoard)).sources.find(row=>row.id===source)!.successAt!;
  await cdp.evaluate(`(async () => {
    const end = Date.now() + ${SHOWN_WITHIN};
    while (document.querySelector('.history.is-loading') || document.querySelector('.history .chart > svg')?.dataset.drawReady !== 'true' || document.querySelector(${JSON.stringify('[data-series="'+source+' balance"]')})?.getAttribute('data-last') !== ${JSON.stringify(cellStart(observation,cellOf(86_400_000))+':112800000')}) {
      if (Date.now() > end) throw new Error('personal currency history did not recover');
      await new Promise(requestAnimationFrame);
    }
  })()`);
  const requests=new Requests(cdp),from=Date.now();requests.counting=true;await cdp.evaluate('__quotumBench.reset();__quotumBench.forgetCards()');
  writeFileSync(path.join(demo.dir,'money-control.json'),JSON.stringify({at:from,credits:90,usage:34}));
  await owner.post('/api/credentials/'+credential,{secret:MONEY_KEY(1),allowNoExpiry:true});await waitBalance('112000000');
  const last=cellStart(from,cellOf(86_400_000))+':112000000',until=Date.now()+SHOWN_WITHIN;
  let chart:number|null=null;
  while(chart===null&&Date.now()<until){chart=await cdp.evaluate<number|null>(`__quotumBench.seriesChanged(${JSON.stringify(source+' balance')},${JSON.stringify(last)})`);if(chart===null)await sleep(20);}
  await drain(requests);requests.counting=false;const reading=await cdp.evaluate<Reading>('__quotumBench.read()');
  const card=await cdp.evaluate<number|null>(`__quotumBench.cardChanged(${JSON.stringify(source)})`),to=Date.now();
  problems.push(...measuredProblems({card:source,latencies:[card===null?Infinity:card-from],renders:reading.renders,mutations:reading.mutations,from,to}),...chartProblems([chart===null?Infinity:chart-from]));
  if((requests.byPath['/api/history']??0)>1||(requests.bytesByPath['/api/history']??0)>HISTORY_BYTES_PER_MEASUREMENT)problems.push('personal currency measurement exceeds the existing history traffic budget');
  await command('/api/currencies/'+created.id+'/rates/'+quote.id+'/archive',{base:'USD'});
  writeFileSync(path.join(demo.dir,'money-control.json'),JSON.stringify({at:Date.now(),credits:90,usage:34}));
  await owner.post('/api/credentials/'+credential,{secret:MONEY_KEY(1),allowNoExpiry:true});await waitBalance(null);
  await command('/api/currencies/'+created.id+'/archive',{replacement:'USD'});await waitBalance('56000000');
  await command('/api/currencies/'+created.id+'/restore',{});await owner.post('/api/currencies/display',{currency:created.id});await waitBalance(null);
  await owner.post('/api/currencies/'+created.id+'/rates',{base:'USD',rate:'4000000'});
  writeFileSync(path.join(demo.dir,'money-control.json'),JSON.stringify({at:Date.now(),credits:90,usage:34}));
  await owner.post('/api/credentials/'+credential,{secret:MONEY_KEY(1),allowNoExpiry:true});await waitBalance('224000000');
  await owner.post('/api/currencies/display',{currency:'USD'});await waitBalance('56000000');
  return {historyRequests:requests.byPath['/api/history']??0,historyBytes:requests.bytesByPath['/api/history']??0,cardMs:card===null?null:card-from,chartMs:chart===null?null:chart-from,problems};
}

async function drain(requests: Requests) {
  const until = Date.now() + SHOWN_WITHIN;
  while (requests.historyPending && Date.now() < until) await sleep(20);
  if (requests.historyPending) throw new Stop('history reads did not finish');
}

/** Every credited tick is observed separately; the stand remains the sole list writer. */
async function work(demo: Demo, stand: Awaited<ReturnType<Demo['run']>>, cdp: Cdp) {
  const source = stand.sources.get(MEASURED)!;
  const reports: {at: number; reads: number; bytes: number}[] = [];
  const problems: string[] = [];
  demo.work(true);
  await demo.nextReport('laptop'); // First list starts the work; the next credits it.
  await sleep(1000);
  for (let i = 0; i < 3; i++) {
    await cdp.evaluate('__quotumBench.reset()');
    const requests = new Requests(cdp); requests.counting = true;
    const from = Date.now();
    if (i === 2) demo.work(false); // This report credits the last working list.
    const at = await demo.nextReport('laptop');
    await sleep(1000); await drain(requests); requests.counting = false;
    const reading = await cdp.evaluate<Reading>('__quotumBench.read()');
    const reads = requests.byPath['/api/history'] ?? 0;
    const bytes = requests.bytesByPath['/api/history'] ?? 0;
    reports.push({at, reads, bytes});
    if (reads !== 1 || bytes > HISTORY_BYTES_PER_MEASUREMENT) problems.push(`work report read history ${reads} times, ${bytes} bytes`);
    problems.push(...renderProblems({card: source, renders: reading.renders, mutations: reading.mutations, from, to: Date.now()}));
  }
  return {reports, problems};
}

async function workPrivate(demo: Demo, stand: Awaited<ReturnType<Demo['run']>>, cdp: Cdp) {
  say('checking private client credit without card, header or financial renders');
  const agent=stand.agents.get('laptop')!,start=Date.now();
  const session={clientId:'opencode',sessionId:'d'.repeat(32),source:null,origin:'terminal',project:'Private benchmark',startedAt:new Date(start).toISOString(),working:true};
  agent.trackClients([session],[]);await demo.nextReport('laptop');await sleep(1000);
  const reports:{at:number;reads:number;bytes:number}[]=[],problems:string[]=[];
  for(let i=0;i<3;i++) {
    await cdp.evaluate('__quotumBench.reset()');const requests=new Requests(cdp);requests.counting=true;const from=Date.now();
    if(i===2)agent.trackClients([{...session,working:false}],[]);
    const at=await demo.nextReport('laptop');await sleep(1000);await drain(requests);requests.counting=false;
    const reading=await cdp.evaluate<Reading>('__quotumBench.read()'),reads=requests.byPath['/api/history']??0,bytes=requests.bytesByPath['/api/history']??0;
    reports.push({at,reads,bytes});
    if(reads!==1||bytes>HISTORY_BYTES_PER_MEASUREMENT)problems.push(`private work read history ${reads} times, ${bytes} bytes`);
    problems.push(...privateWorkRenderProblems({renders:reading.renders,mutations:reading.mutations,from,to:Date.now(),cellMs:cellOf(86_400_000)}));
  }
  agent.trackClients([],[]);await demo.nextReport('laptop');
  return {reports,problems};
}

/** Run as the command, not imported. */
const isMain = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  main().catch(error => {
    console.error(error instanceof Stop ? error.message : error);
    process.exit(error instanceof Stop ? 2 : 1);
  });
}
