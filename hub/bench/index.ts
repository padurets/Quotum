import {cellOf, cellStart} from '../server/domain/history.js';
import {createServer} from 'node:net';
import {realpathSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {MONEY_KEY} from '../demo/money.js';
import type {Credential} from '../server/store/credentials.js';
import type {Meter} from '../server/domain/meters.js';
import {fileURLToPath} from 'node:url';
import {SETS} from '../demo/catalogue.js';
import {addressOf, Demo, prepare, Stop} from '../demo/index.js';
import {cards, MIN, people, snapshot} from '../demo/model.js';
import type {Snapshot} from '../server/projection.js';
import {chartProblems, HISTORY_BYTES_PER_MEASUREMENT, idleProblems, measuredProblems, percentile, renderProblems} from './budget.js';
import {attachedChrome, findChrome, launchChrome, openTab, type Browser, type Cdp} from './cdp.js';
import {probeScript, type Reading} from './probe.js';
import {delta, round, scriptPerSecond, tally, type Metrics} from './report.js';
import {overviewCards, stillProblems, warmUntil} from './still.js';
import {hear, type Heard} from './stream.js';
import {frequencyKeys, moneyView} from './controls.js';
import {panning} from './panning.js';
import {panningSet} from './fixture.js';
import {profilePanning} from './panningProfile.js';

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
/** The requests of a page, as Chrome types them: those it makes itself, not its images or styles. */
const ASKED = new Set(['Fetch', 'XHR', 'EventSource', 'Document']);
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

/** Counts what the page asks the hub while `counting`: the stream of events it opened before is not asked again, one opened meanwhile is. */
export class Requests {
  counting = false;
  count = 0;
  bytes = 0;
  readonly byPath: Record<string, number> = {};
  readonly bytesByPath: Record<string, number> = {};
  private readonly ids = new Map<string, string>();
  get historyPending() {return [...this.ids.values()].filter(path => path === '/api/history').length;}

  constructor(cdp: Cdp) {
    cdp.on<{requestId: string; type?: string; request: {url: string}}>('Network.requestWillBeSent', event => {
      if (!this.counting || !ASKED.has(event.type ?? '')) return;
      const url = new URL(event.request.url);
      this.count++;
      this.byPath[url.pathname] = (this.byPath[url.pathname] ?? 0) + 1;
      this.ids.set(event.requestId, url.pathname);
    });
    cdp.on<{requestId: string; encodedDataLength: number}>('Network.loadingFinished', event => {
      const path = this.ids.get(event.requestId);
      if (path) {this.ids.delete(event.requestId); this.bytes += event.encodedDataLength; this.bytesByPath[path] = (this.bytesByPath[path] ?? 0) + event.encodedDataLength;}
    });
  }
}

async function metrics(cdp: Cdp): Promise<Metrics> {
  const {metrics} = await cdp.send<{metrics: {name: string; value: number}[]}>('Performance.getMetrics');
  return Object.fromEntries(metrics.map(m => [m.name, m.value]));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bind = process.env.QUOTUM_BIND || '127.0.0.1';
  const address = addressOf({...process.env, QUOTUM_PORT: process.env.QUOTUM_PORT || String(await freePort(bind))});
  await prepare(address);
  const chrome = options.cdp ? null : findChrome(process.env);
  if (!options.cdp && !chrome) throw new Stop('No Chrome to run: set QUOTUM_CHROME, put google-chrome or chromium on PATH, or pass --cdp <http://host:port>.');
  const seconds = options.ci ? IDLE.ci : IDLE.full;

  let browser: Browser | undefined;
  let tab: Awaited<ReturnType<typeof openTab>> | undefined;
  let heard: Heard | undefined;
  let finished = false;
  const finish = async (code: number) => {
    if (finished) return;
    finished = true;
    heard?.close();
    await tab?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await demo.stop();
    process.exit(code);
  };
  const set = panningSet(SETS[0]);
  const demo = new Demo({set, scene: set.scene, still: true, idleAgents: true,money:false, address, onExit: () => void finish(1)});
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void finish(1));

  try {
    say(`a still hub of the ${set.id} set at ${address.base}`);
    const stand = await demo.run();
    const ana = stand.people.get(people(set)[0].id)!;
    const board = ana.personalBoard;
    const overview = () => overviewCards(path => ana.get<Snapshot>(path), board);
    heard = await hear(address.base, ana.cookie, board);

    browser = options.cdp ? attachedChrome(options.cdp) : await launchChrome(chrome!, !process.env.CI);
    tab = await openTab(browser);
    const {cdp} = tab;
    const requests = new Requests(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    const split = ana.cookie.indexOf('=');
    await cdp.send('Network.setCookie', {name: ana.cookie.slice(0, split), value: ana.cookie.slice(split + 1), url: address.base, httpOnly: true, sameSite: 'Lax'});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source: probeScript()});
    await cdp.send('Page.navigate', {url: `${address.base}/`});

    const shownBy = Date.now() + SHOWN_MS;
    while ((await cdp.evaluate<number>(`document.querySelectorAll('.card:not(.is-loading)').length`)) === 0) {
      if (Date.now() > shownBy) throw new Stop(`The board showed no cards in ${SHOWN_MS / 1000} s.`);
      await sleep(250);
    }
    const opened = Date.now();
    const warm = warmUntil(await overview(), opened);
    say(`the board is open; it settles for ${Math.round((warm - Date.now()) / 1000)} s`);
    await sleep(warm - Date.now());
    if (heard.counts().history) throw new Stop('The stand credited agent work during warmup; its agents must be idle.');

    const from = Date.now();
    const to = from + seconds * 1000;
    const moving = stillProblems(await overview(), from, to);
    if (moving.length) throw new Stop(`The stand does not stand still over the window, so its numbers would not be of an idle board: ${moving.join('; ')}.`);

    say(`watching the idle page for ${seconds} s`);
    await cdp.evaluate('__quotumBench.reset()');
    heard.reset();
    requests.counting = true;
    const before = await metrics(cdp);
    await sleep(to - Date.now());
    const after = await metrics(cdp);
    requests.counting = false;
    const events = heard.counts();
    const reading = await cdp.evaluate<Reading>('__quotumBench.read()');
    const cellMs = cellOf(86_400_000);
    const scriptMsPerSecond = round(scriptPerSecond(before, after, reading.instrumentMs, seconds));
    const idle = {from, to, cellMs, requests, events, renders: reading.renders, mutations: reading.mutations, scriptMsPerSecond};

    const measured = await measure(stand, cdp);
    const worked = await work(demo, stand, cdp);
    const problems = [
      ...idleProblems(idle),
      ...worked.problems,
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
    say('checking native continuous wheel and Shift-drag at 24h and 30d, CPU ×4');
    const panned = await panning(cdp);
    problems.push(...panned.problems);
    const monetary=await moneyPhase(demo,stand,cdp);
    problems.push(...monetary.problems);
    const result = {
      set: set.id,
      idle: {
        seconds,
        requests: {count: requests.count, bytes: requests.bytes, byPath: requests.byPath},
        events,
        renders: {commits: reading.commits, ...tally(reading.renders)},
        mutations: tally(reading.mutations),
        scriptMsPerSecond,
        instrumentMsPerSecond: round(reading.instrumentMs / seconds),
        taskMsPerSecond: round((delta(before, after, 'TaskDuration') * 1000) / seconds),
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
      money:monetary,
      panning: panned.reports.map(report => ({...report,
        frames: {count: report.frames.length, p95Ms: round(percentile(report.frames, .95)), p99Ms: round(percentile(report.frames, .99))},
        latency: {count: report.latency.length, p95Ms: round(percentile(report.latency, .95))},
      })),
      problems,
    };
    console.log(JSON.stringify(result, null, 2));
    if (problems.length) say(`over budget:\n- ${problems.join('\n- ')}`);
    if (panned.problems.length) {
      try {await profilePanning(cdp);}
      catch (error) {say(`panning diagnostic failed: ${(error as Error).message}`);}
    }
    await finish(problems.length ? 1 : 0);
  } catch (error) {
    if (finished) return;
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
    const taken = snapshot(card, stand.start, Date.now() - stand.start, 5 * MIN);
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
    await sleep(sent + MEASURE_EVERY - Date.now());
  }
  await drain(requests); requests.counting = false;
  return {source, latencies, chartLatencies, historyBytes: (requests.bytesByPath['/api/history'] ?? 0) / MEASUREMENTS, reading: await cdp.evaluate<Reading>('__quotumBench.read()'), from, to: Date.now()};
}

async function moneyPhase(demo:Demo,stand:Awaited<ReturnType<Demo['run']>>,cdp:Cdp) {
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
  await cdp.evaluate(`Array.from(document.querySelectorAll('.analytics-head button')).find(b=>b.textContent==='USD')?.click()`);
  const readyBy=Date.now()+SHOWN_WITHIN;
  while(!await cdp.evaluate<boolean>(`!!document.querySelector('[data-series="${source} balance"]')`)){if(Date.now()>readyBy)throw new Stop('money chart did not appear');await sleep(20);}
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
  const capped=await owner.post<Credential>('/api/credentials',{provider:'openrouter',secret:MONEY_KEY(5),allowNoExpiry:true});
  const cappedSource=capped.sourceId!;
  let cap:Meter|undefined;
  const cappedBy=Date.now()+SHOWN_WITHIN;
  while(!cap) {
    const cappedState=await owner.get<Snapshot>('/api/overview?board='+owner.personalBoard);
    cap=cappedState.sources.find(s=>s.id===cappedSource)?.meters?.find(m=>m.kind==='cap'&&m.limit==='0');
    if(!cap){if(Date.now()>cappedBy)throw new Stop('zero-cap money fixture did not appear');await sleep(20);}
  }
  await moneyView(cdp,source,cappedSource,cap.id);
  return {count:latencies.length,p95Ms:Math.round(percentile(latencies,.95)),chartP95Ms:Math.round(percentile(chartLatencies,.95)),historyBytesPerMeasurement:bytes,problems};
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
