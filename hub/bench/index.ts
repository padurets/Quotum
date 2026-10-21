import {accountingPath,accountingTotal} from './accountingTraffic';
import {cellOf, cellStart} from '../server/domain/history.js';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,realpathSync,writeFileSync} from 'node:fs';
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
import {activityCreditProblems, chartProblems, creditRenderProblems, HISTORY_BYTES_PER_MEASUREMENT, idleProblems, measuredProblems, percentile, privateWorkRenderProblems, renderProblems} from './budget.js';
import {attachedChrome, findChrome, launchChrome, openTab, type Browser, type Cdp} from './cdp.js';
import {probeScript, type Reading} from './probe.js';
import {delta, round, scriptPerSecond, tally, type Metrics} from './report.js';
import {overviewCards, quietAfter, stillProblems, stillSnapshot, warmUntil} from './still.js';
import {hear, type Heard} from './stream.js';
import {frequencyKeys, moneyView, selectMoney} from './controls.js';
import {panning} from './panning.js';
import {panningProblems} from './panningBudget.js';
import {seedPanningBudgets,panningSet} from './fixture.js';
import {profilePanning} from './panningProfile.js';
import {historyTraffic} from './historyTraffic.js';
import {diagnoseReversal} from './historyTrafficBrowser.js';
import {observeReversal} from './reversalDiagnostic.js';
import {reloadHubProbe} from './panningReload.js';
import {creditSnapshot} from './credits.js';
import {IdleCpuDiagnostic,clientIdentity,sourceIdentity,idleGeometry,planIdleEdge,type IdleEdgePlan,type IdleGeometry} from './idleCpuDiagnostic.js';
import {ObservedWork} from './observed.js';
import {fixedActivity} from './fixedActivity.js';

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
  readonly history: {scope:string|null;meters:string|null;from:number;to:number}[] = [];
  private readonly ids = new Map<string, string>();
  get historyPending() {return [...this.ids.values()].filter(accountingPath).length;}

  get historyRequests() {return accountingTotal(this.byPath);}
  get historyBytes() {return accountingTotal(this.bytesByPath);}

  constructor(cdp: Cdp) {
    const partial=new Map<string,number>();
    cdp.on<{requestId:string;encodedDataLength:number}>('Network.dataReceived',event=>{if(this.ids.has(event.requestId))partial.set(event.requestId,(partial.get(event.requestId)??0)+event.encodedDataLength);});
    cdp.on<{requestId:string}>('Network.loadingFailed',event=>{const path=this.ids.get(event.requestId);if(path){this.ids.delete(event.requestId);const bytes=partial.get(event.requestId)??0;this.bytes+=bytes;this.bytesByPath[path]=(this.bytesByPath[path]??0)+bytes;}partial.delete(event.requestId);});
    cdp.on<{requestId: string; type?: string; request: {url: string;postData?:string}}>('Network.requestWillBeSent', event => {
      if (!this.counting || !ASKED.has(event.type ?? '')) return;
      const url = new URL(event.request.url);
      this.count++;
      this.byPath[url.pathname] = (this.byPath[url.pathname] ?? 0) + 1;
      if(url.pathname==='/api/history')this.history.push({scope:url.searchParams.get('scope'),meters:url.searchParams.get('meters'),from:Number(url.searchParams.get('from')),to:Number(url.searchParams.get('to'))});
      if(accountingPath(url.pathname)&&url.pathname!=='/api/history'){const body=JSON.parse(event.request.postData??'{}');for(const scope of ['quota','budget','funds'])if(body[scope]){const q=body[scope];this.history.push({scope:scope==='funds'?'budget':scope,meters:q.meters??null,from:Number(q.from),to:Number(q.to)});}}
      this.ids.set(event.requestId, url.pathname);
    });
    cdp.on<{requestId: string; encodedDataLength: number}>('Network.loadingFinished', event => {
      const path = this.ids.get(event.requestId);
      if (path) {partial.delete(event.requestId);this.ids.delete(event.requestId); this.bytes += event.encodedDataLength; this.bytesByPath[path] = (this.bytesByPath[path] ?? 0) + event.encodedDataLength;}
    });
  }
}

async function metrics(cdp: Cdp): Promise<Metrics> {
  const {metrics} = await cdp.send<{metrics: {name: string; value: number}[]}>('Performance.getMetrics');
  return Object.fromEntries(metrics.map(m => [m.name, m.value]));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const idleCpuMode=process.env.QUOTUM_BENCH_DIAGNOSE_IDLE_CPU;
  if(idleCpuMode&&(!['1','trace'].includes(idleCpuMode)||!options.ci||options.cdp||process.env.QUOTUM_BENCH_DIAGNOSE_NATIVE==='1'))throw new Stop('Unknown or conflicting idle CPU diagnostic mode');
  let idleCpu:IdleCpuDiagnostic|undefined;
  const diagnosticDirectory=path.join('/tmp/quotum-idle-cpu-diagnostic',`${process.env.GITHUB_RUN_ID??'local'}-${process.env.GITHUB_RUN_ATTEMPT??'1'}-${process.pid}`);
  const saveDiagnostic=(name:string,value:unknown,large=false)=>{
    if(!/^idle-cpu-[a-z0-9-]+$/.test(name))throw Error('Invalid diagnostic artifact name');
    const data=JSON.stringify(value),limit=large?32*1024*1024:1024*1024;
    mkdirSync(diagnosticDirectory,{recursive:true});
    writeFileSync(path.join(diagnosticDirectory,name+'.json'),Buffer.byteLength(data)<=limit?data:JSON.stringify({mode:'diagnostic',status:'insufficient-evidence',reason:'artifact size',bytes:Buffer.byteLength(data),limit}));
  };
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
    try{await idleCpu?.close();}catch{saveDiagnostic('idle-cpu-cleanup',{mode:'diagnostic',status:'insufficient-evidence'});code=1;}
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
    seedPanningBudgets(path.join(demo.dir,'quotum.sqlite'),stand);
    const ana = stand.people.get(people(set)[0].id)!;
    const board = ana.personalBoard;
    const overview = () => overviewCards(path => ana.get<Snapshot>(path), board);
    heard = await hear(address.base, ana.cookie, board);

    browser = options.cdp ? attachedChrome(options.cdp) : await launchChrome(chrome!, !process.env.CI);
    if(process.env.QUOTUM_BENCH_DIAGNOSE_NATIVE==='1'){
      say('diagnostic native replay only; this does not run the canonical benchmark');
      await diagnoseReversal(browser,address.base,ana.cookie,24);
      say('diagnostic replay completed; canonical benchmark was not run');
      await finish(0);return;
    }
    tab = await openTab(browser);
    const {cdp} = tab;
    const requests = new Requests(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable');
    if(idleCpuMode){
      idleCpu=new IdleCpuDiagnostic(cdp,saveDiagnostic,clientIdentity(),!options.cdp,idleCpuMode==='trace'?'trace':'profile');
      saveDiagnostic('idle-cpu-source',sourceIdentity());
    }
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    const split = ana.cookie.indexOf('=');
    await cdp.send('Network.setCookie', {name: ana.cookie.slice(0, split), value: ana.cookie.slice(split + 1), url: address.base, httpOnly: true, sameSite: 'Lax'});
    // Historical work leaves the rolling window even with every agent idle.
    // Name order keeps this phase still; clock-driven numeric crossings have
    // their own subscribed-selector tests, including equal displayed labels.
    const bootstrapSource=`localStorage.setItem('quotum.locale','en');
      localStorage.setItem('quotum.prefs',JSON.stringify({...JSON.parse(localStorage.getItem('quotum.prefs')||'{}'),agentsSort:{column:'project',descending:false}}));
      window.__quotumInspectHistoryPool=pool=>{window.__quotumWalletState=(source,authority)=>{
        const p=[...pool.members].find(m=>m.tapes),reader=[...pool.members].find(m=>m.scope==='budget'),tape=p?.tapes.get('budget');
        const work=p?.moneyWorkAt(source,Date.now()),group=tape?.tape.money.find(m=>m.source===source),shown=reader?.get();
        return {selection:p?.selection,financialIdentity:p?.financialIdentity,authorityReady:authority===undefined?undefined:!!p&&p.workAuthority===authority,periodLoading:p?.get().loading,periodError:!!p?.get().error,workNeeded:p?.workNeeded,work:work?{activeMs:work.activeMs,knownFrom:work.knownFrom}:null,
          preparation:p?{generation:p.generation,revision:p.revision,retiring:p.retiring,retirementPreparing:p.retirementPreparing,quotaSeries:p.tapes.get('quota')?.tape.quota.length,
            flights:[...p.transport.flights].slice(0,6).map(f=>({generation:f.intent.generation,revision:f.intent.revision,preparing:!!f.preparing,aborted:f.controller.signal.aborted,extras:f.extras,sections:Object.keys(f.intent.request)}))}:null,
          recentPeriods:performance.getEntriesByType('resource').filter(r=>/\\/period$/.test(new URL(r.name).pathname)).slice(-4).map(r=>({start:r.startTime,duration:r.duration,responseEnd:r.responseEnd,bytes:r.decodedBodySize})),
          budget:group?{meter:group.meter,counter:!!group.workCounter,readings:group.workCounter?.readings.length,workFrom:group.workCounter?.workFrom}:null,
          drawing:shown?{loading:shown.loading,error:shown.error,range:shown.history?.range,series:shown.history?.meterSeries?.slice(0,24).map(m=>({source:m.sourceId,meter:m.meterId,unit:m.unit,kind:m.kind,role:m.role}))}:null};
      };window.__quotumPeriodState=()=>{
        const p=[...pool.members].find(m=>m.tapes);
        return {bytes:pool.estimatedBytes,reservations:pool.reservations.size,waiting:pool.waiting.length,
          period:p?{generation:p.generation,revision:p.revision,workNeeded:p.workNeeded,dirty:[...p.dirtyScopes],error:p.get().error,calendar:p.calendar.state.error,calendarNeeded:p.calendar.needed,completed:p.transport.completed,failed:p.transport.failed,
            flights:[...p.transport.flights].map(f=>({extras:f.extras,preparing:!!f.preparing,aborted:f.controller.signal.aborted,sections:Object.keys(f.intent.request)}))}:null};
      };};
      ${probeScript()}`;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source:bootstrapSource});
    idleCpu?.binding.rememberInjected(1,bootstrapSource);
    await cdp.send('Page.navigate', {url: `${address.base}/`});

    const shownBy = Date.now() + SHOWN_MS;
    while ((await cdp.evaluate<number>(`document.querySelectorAll('.card:not(.is-loading)').length`)) === 0) {
      if (Date.now() > shownBy) throw new Stop(`The board showed no cards in ${SHOWN_MS / 1000} s.`);
      await sleep(250);
    }
    while(!await cdp.evaluate<boolean>(`!!document.querySelector('.agent-hours-heatmap[data-calendar-ready="true"]')`)){
      if(Date.now()>shownBy)throw new Stop('The enabled agent-hours calendar did not receive its baseline.');
      await sleep(100);
    }
    const opened = Date.now();
    // Measure with the shared controls open, as before they could be collapsed.
    await cdp.evaluate(`(async () => {
      const toggle = document.querySelector('.filter-toggle > button');
      if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
      await new Promise(requestAnimationFrame);
      if (!document.querySelector('.analytics-head:not([hidden]) .period')) throw new Error('shared filters did not open');
    })()`);
    const warm = warmUntil(await overview(), opened);
    say(`the board is open; it settles for ${Math.round((warm - Date.now()) / 1000)} s`);
    await sleep(warm - Date.now());
    if (heard.counts().history) throw new Stop('The stand credited agent work during warmup; its agents must be idle.');

    let edgePlan:IdleEdgePlan|undefined,geometryBefore:IdleGeometry|undefined;
    if(idleCpuMode==='1'){
      edgePlan=planIdleEdge(Date.now(),seconds,cellOf(86_400_000));
      saveDiagnostic('idle-cpu-plan',{mode:'diagnostic',kind:'Temporally aligned diagnostic only; no canonical benchmark timing change.',...edgePlan});
      say(`diagnostic only: waiting until ${new Date(edgePlan.from).toISOString()} to capture the natural ${new Date(edgePlan.boundary).toISOString()} edge`);
      await sleep(edgePlan.from-Date.now());
      geometryBefore=await idleGeometry(cdp);
    }
    if(idleCpu)await idleCpu.start();
    const from = Date.now();
    const to = from + seconds * 1000;
    const moving = stillProblems(await overview(), from, to);
    if (moving.length) throw new Stop(`The stand does not stand still over the window, so its numbers would not be of an idle board: ${moving.join('; ')}.`);

    say(`watching the idle page for ${seconds} s`);
    await cdp.evaluate('__quotumBench.reset()');
    heard.reset();
    requests.counting = true;
    const before = await metrics(cdp);
    const counterFrom=idleCpu?Date.now():null;
    await sleep(to - Date.now());
    const counterTo=idleCpu?Date.now():null;
    const after = await metrics(cdp);
    requests.counting = false;
    const events = heard.counts();
    const boardEvents=heard.boardCounts(),deviceContacts=heard.contacts(),deviceHints=heard.hints();
    const reading = await cdp.evaluate<Reading>('__quotumBench.read()');
    const cellMs = cellOf(86_400_000);
    const scriptMsPerSecond = round(scriptPerSecond(before, after, reading.instrumentMs, seconds));
    const idle = {from, to, cellMs, requests, events:boardEvents, renders: reading.renders, mutations: reading.mutations, scriptMsPerSecond};

    if(idleCpu){
      const diagnosticProblems=idleProblems(idle);
      const geometryAfter=idleCpuMode==='1'?await idleGeometry(cdp):undefined;
      saveDiagnostic('idle-cpu-result',{mode:'diagnostic',kind:idleCpuMode==='trace'?'Original unaligned120s CI idle protocol; no CPU sampling, tracing overhead is unqualified.':'Temporally aligned natural edge using the unchanged120s CI idle protocol; profiler and trace overhead is unqualified.',original:{seconds,from,to,cellMs,scriptMsPerSecond,requests:{count:requests.count,byPath:requests.byPath},events,reading,problems:diagnosticProblems}});
      await idleCpu.stop({before,after,instrumentMs:reading.instrumentMs,seconds});
      await idleCpu.bindAndClose();
      const edge=idleCpuMode==='trace'?idleCpu.traceReceipt(from,to,cellMs,{before,after,instrumentMs:reading.instrumentMs,seconds},reading):idleCpu.edgeReceipt(edgePlan!,from,to,counterFrom!,counterTo!,geometryBefore!,geometryAfter!,{before,after,instrumentMs:reading.instrumentMs,seconds});
      say(`diagnostic only: ${idleCpuMode==='trace'?'original idle trace':'aligned natural edge'} ${edge.status}; observer overhead is unqualified`);
      await finish(diagnosticProblems.length||edge.status!=='complete'?1:0);return;
    }

    const measured = await measure(stand, cdp);
    const worked = await work(demo, stand, cdp);
    const observedWork=await workObserved(stand,cdp);
    const privateWork = await workPrivate(demo, stand, cdp);
    const problems = [
      ...idleProblems(idle),
      ...worked.problems,
      ...observedWork.problems,
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
    // Keep completed measurements available if a later browser phase stops the job.
    say(`initial readings: ${JSON.stringify({idle:{scriptMsPerSecond,requests:{count:requests.count,byPath:requests.byPath},events,renders:reading.renders,mutations:reading.mutations},measured:{historyBytes:measured.historyBytes,ingestP95Ms:percentile(measured.ingestLatencies,.95),cardP95Ms:percentile(measured.latencies,.95),chartP95Ms:percentile(measured.chartLatencies,.95)},work:worked.reports,observedWork:observedWork.reports,observedWorkSetup:observedWork.setup,problems})}`);
    // The readings above are frozen: keyboard checks do not enter the performance budget.
    say('checking consecutive frequency saves with native arrow keys');
    await frequencyKeys(cdp);
    // Panning has its own movement and mutation probe. Traversing React and the
    // DOM for the finished measurement phase would add unrelated work to every frame.
    await cdp.evaluate('__quotumBench.pause()');
    say('checking native continuous wheel and Shift-drag from all five charts at 24h and 30d, CPU ×4');
    const panningBrowser=browser;
    const panned = await panning(cdp,undefined,async(label,signal,origin)=>{
      await Promise.all([reloadHubProbe(address.base,signal,origin),(async()=>{
        const observer=await observeReversal(cdp,panningBrowser,false,signal,origin);
        try{await observer.diagnose(label);}finally{await observer.close();}
      })()]);
    });
    problems.push(...panned.problems);
    say(`native panning: ${JSON.stringify({reports: panned.reports.map(report => ({initiator: report.initiator, period: report.period, frameP95Ms: round(percentile(report.frames, .95)), frameP99Ms: round(percentile(report.frames, .99)), inputP95Ms: round(percentile(report.latency, .95)),pushesDuring:report.pushesDuring,pushesAfter:report.pushesAfter,forbiddenMutations:report.forbiddenMutations})), problems: panned.problems})}`);
    for(const report of panned.reports)if(panningProblems(report).length)say('native panning failure details: '+JSON.stringify(report));
    // A diagnostic replay must not consume the deadline of the remaining gates.
    if (panned.problems.length && process.env.QUOTUM_BENCH_PROFILE_PANNING==='1') {
      try {await profilePanning(cdp);}
      catch (error) {say(`panning diagnostic failed: ${(error as Error).message}`);}
    }
    say('checking controlled pan traffic over fixed Brotli HTTP, separately from native performance');
    const current = await ana.get<Snapshot>(`/api/overview?board=${encodeURIComponent(board)}`);
    let traffic:Awaited<ReturnType<typeof historyTraffic>>;
    try{traffic=await historyTraffic(address.base, ana.cookie, board, current.sources.flatMap(source => source.windows.map(window => `${source.id} ${window.id}`)), browser);}
    catch(error){
      if(/browser\/(?:1|30)d\/reversal/.test(String(error))){
        say('replaying the failed reversal with page and browser diagnostics; the original failure remains');
        try{await diagnoseReversal(browser,address.base,ana.cookie);}catch(diagnostic){say('reversal replay failed: '+String(diagnostic));}
      }
      throw error;
    }
    problems.push(...traffic.problems);
    if(process.env.QUOTUM_BENCH_REVERSAL_PROBE==='1')await diagnoseReversal(browser,address.base,ana.cookie,12);
    const credits=await creditPhase(demo,stand,cdp);
    problems.push(...credits.problems);
    const monetary=await moneyPhase(demo,stand,cdp);
    say('checking fixed Activity subsets, late-work cells, cancellation and shared preparation costs at 24h/30d');
    const selectedActivity=await fixedActivity(browser,stand);
    problems.push(...selectedActivity.problems);
    problems.push(...monetary.problems);
    const result = {
      set: set.id,
      idle: {
        seconds,
        requests: {count: requests.count, bytes: requests.bytes, byPath: requests.byPath},
        events,
        boardEvents,
        deviceContacts,
        deviceHints,
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
      observedWork:observedWork.reports,
      observedWorkSetup:observedWork.setup,
      privateWork: privateWork.reports,
      money:monetary,
      credits,
      historyTraffic: traffic,
      selectedActivity,
      panning: panned.reports.map(report => ({...report,
        frames: {count: report.frames.length, p95Ms: round(percentile(report.frames, .95)), p99Ms: round(percentile(report.frames, .99))},
        latency: {count: report.latency.length, p95Ms: round(percentile(report.latency, .95))},
      })),
      problems,
    };
    console.log(JSON.stringify(result, null, 2));
    if (problems.length) say(`over budget:\n- ${problems.join('\n- ')}`);
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
  const ingestLatencies: number[] = [];
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
    ingestLatencies.push(Date.now()-sent);
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
  return {source, latencies, chartLatencies, ingestLatencies, historyBytes: requests.historyBytes / MEASUREMENTS, reading: await cdp.evaluate<Reading>('__quotumBench.read()'), from, to: Date.now()};
}

/** Mixed-source credit updates retain quota drawings and only read their own financial tail. */
async function creditPhase(demo:Demo,stand:Awaited<ReturnType<Demo['run']>>,cdp:Cdp) {
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
  // A reset or the source's hourly forecast timer can change quota independently
  // of credits. Finish selection, then wait outside those natural boundaries.
  const readCards=()=>overviewCards(path=>owner.get<Snapshot>(path),overview.board.id);
  const windowMs=4*(2*SHOWN_WITHIN+100),setupUntil=Date.now()+60_000,waits:{from:number;until:number;resets:number[];forecasts:number[]}[]=[];
  for(;;) {
    const cards=await readCards(),from=Date.now();
    const quiet=quietAfter(cards,from,from+windowMs+SHOWN_WITHIN);
    if(!quiet)break;
    if(quiet.until>setupUntil)throw new Stop('credit measurement has no quiet quota interval');
    waits.push({from,...quiet});
    await sleep(quiet.until-from);
  }
  const qualifiedFrom=Date.now(),qualifiedTo=qualifiedFrom+windowMs;
  const changing=stillProblems(await readCards(),qualifiedFrom,qualifiedTo,source);
  if(changing.length)throw new Stop('credit measurement baseline changes independently: '+changing.join('; '));
  const ledger=new DatabaseSync(path.join(demo.dir,'quotum.sqlite'),{readOnly:true});
  const rows=()=>Number(ledger.prepare('SELECT count(*) n FROM readings WHERE source_id=? AND meter_id=?').get(source,'balance:credits')?.n);
  const coverage=()=>Number(ledger.prepare('SELECT max(to_at) at FROM meter_spans WHERE source_id=? AND meter_id=?').get(source,'balance:credits')?.at);
  const problems:string[]=[],updates:{amount:string;heartbeat:boolean;observedAt:number;from:number;to:number;renders:Reading['renders'];mutations:Reading['mutations'];cardMs:number|null;chartMs:number|null;historyRequests:number;historyBytes:number;ledgerRowsUnchanged:boolean;coverageAdvanced:boolean}[]=[];
  try {
    for(const [index,amount] of ['2499','2498','2498','2498'].entries()) {
      await cdp.evaluate('__quotumBench.reset()');
      const beforeRows=rows(),beforeCoverage=coverage(),at=quotaAt-20_000+index*2000,sent=Date.now(),heartbeat=index>=2,requests=new Requests(cdp);requests.counting=true;
      await deliver(amount,at);
      const value=String(BigInt(amount)*40_000n);
      let chart:number|null=null,changed:number|null=null;
      while(Date.now()<sent+SHOWN_WITHIN&&(chart===null||!heartbeat&&changed===null)) {
        const last=`observation:${at}:${value}`;
        chart=await cdp.evaluate<number|null>(`__quotumBench.seriesChanged(${JSON.stringify(source+' balance:credits')},${JSON.stringify(last)})`);
        changed=await cdp.evaluate<number|null>(`__quotumBench.moneyChanged(${JSON.stringify(source)},${JSON.stringify(value)})`);
        if(chart===null||!heartbeat&&changed===null)await sleep(20);
      }
      await drain(requests);await sleep(100);requests.counting=false;
      const reading=await cdp.evaluate<Reading>('__quotumBench.read()'),to=Date.now(),historyBytes=requests.historyBytes;
      const balance=await cdp.evaluate<string|null>(`document.querySelector('[data-card="${source}"] [data-money]')?.getAttribute('data-money')??null`);
      const point={amount,heartbeat,observedAt:at,from:sent,to,renders:reading.renders,mutations:reading.mutations,cardMs:changed===null?null:changed-sent,chartMs:chart===null?null:chart-sent,historyRequests:requests.historyRequests,historyBytes,ledgerRowsUnchanged:rows()===beforeRows,coverageAdvanced:coverage()>beforeCoverage};
      updates.push(point);
      problems.push(...chartProblems([chart===null?Infinity:chart-sent]),...creditRenderProblems({card:source,renders:reading.renders,mutations:reading.mutations,from:sent,to,cellMs:cellOf(86_400_000)}));
      if(!heartbeat)problems.push(...measuredProblems({card:source,latencies:[changed===null?Infinity:changed-sent],renders:reading.renders,mutations:reading.mutations,from:sent,to}));
      if(balance!==value||!point.coverageAdvanced||heartbeat&&!point.ledgerRowsUnchanged)problems.push('Codex heartbeat lost coverage, changed the ledger or displayed the wrong amount');
      if(requests.historyRequests!==1||historyBytes>HISTORY_BYTES_PER_MEASUREMENT)problems.push('Codex credit update exceeds the existing single-tail history budget');
      if(requests.history.some(read=>read.scope!=='budget'||read.meters!==JSON.stringify([[source,'balance:credits']])||read.from<cellStart(at,cellOf(86_400_000))-cellOf(86_400_000)))problems.push('Codex credit update read another resource or its full historical period');
      if(to>qualifiedTo)problems.push('Codex credit update outlasted its qualified quiet interval');
    }
  } finally {ledger.close();}
  return {source,qualification:{from:qualifiedFrom,to:qualifiedTo,waits},updates,problems};
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
  // The dense panning wallets must not exclude this newly connected account.
  await selectMoney(cdp, [[source, 'balance']]);
  const shownBy=Date.now()+SHOWN_WITHIN;
  while(!await cdp.evaluate<boolean>(`!!document.querySelector('[data-card="${source}"] [data-money]')`)){if(Date.now()>shownBy)throw new Stop('money card did not appear');await sleep(20);}
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
  const bytes=requests.historyBytes/6;if(bytes>HISTORY_BYTES_PER_MEASUREMENT)problems.push('money history exceeds the existing measurement byte budget');
  const first=await owner.get<{keys:unknown[];next:string|null}>('/api/boards/'+owner.personalBoard+'/sources/'+source+'/keys?limit=50');
  if(first.keys.length!==50||!first.next)problems.push('money key pagination did not expose a full first page');
  const second=await owner.get<{keys:unknown[]}>('/api/boards/'+owner.personalBoard+'/sources/'+source+'/keys?limit=50&after='+encodeURIComponent(first.next??''));
  if(second.keys.length!==7)problems.push('money key pagination lost the final page');
  const state=await owner.get<Snapshot>('/api/overview?board='+owner.personalBoard);
  if(state.sources.find(s=>s.id===source)?.inventory?.complete!==false)problems.push('partial money inventory was reported complete');
  const previous=state.sources.find(s=>s.id===source)!;
  const previousBalance=previous.meters?.find(m=>m.id==='balance')?.amount;
  const ledger=new DatabaseSync(path.join(demo.dir,'quotum.sqlite'),{readOnly:true});
  let heartbeat:{historyRequests:number;historyBytes:number;coverageAdvanced:boolean;ledgerRowsUnchanged:boolean;pairAnchorAdvanced:boolean;valuesUnchanged:boolean};
  try {
    const rows=()=>Number(ledger.prepare("SELECT count(*) AS count FROM readings WHERE source_id=? AND pair_anchor=0 AND meter_id IN ('credits','usage')").get(source)!.count);
    const anchors=()=>Number(ledger.prepare("SELECT count(*) AS count FROM readings WHERE source_id=? AND pair_anchor=1 AND meter_id='usage'").get(source)!.count);
    const coverage=()=>Number(ledger.prepare("SELECT max(to_at) AS at FROM meter_spans WHERE source_id=? AND meter_id='usage'").get(source)!.at);
    const beforeRows=rows(),beforeAnchors=anchors(),beforeCoverage=coverage(),heartbeatFrom=Date.now(),heartbeatRequests=new Requests(cdp);
    heartbeatRequests.counting=true;await cdp.evaluate('__quotumBench.reset()');
    // A later observation of identical values must travel through the real event and history path.
    writeFileSync(path.join(demo.dir,'money-control.json'),JSON.stringify({at:heartbeatFrom,credits:90,usage:33.6}));
    await owner.post('/api/credentials/'+record.id,{secret:MONEY_KEY(1),allowNoExpiry:true});
    const deadline=Date.now()+SHOWN_WITHIN;
    while(!heartbeatRequests.historyRequests){if(Date.now()>deadline)throw new Stop('unchanged money observation did not reach browser history');await sleep(20);}
    await drain(heartbeatRequests);heartbeatRequests.counting=false;
    const current=(await owner.get<Snapshot>('/api/overview?board='+owner.personalBoard)).sources.find(s=>s.id===source)!;
    const browserBalance=await cdp.evaluate<string|null>(`document.querySelector('[data-card="${source}"] [data-money]')?.getAttribute('data-money')??null`);
    heartbeat={historyRequests:heartbeatRequests.historyRequests,historyBytes:heartbeatRequests.historyBytes,coverageAdvanced:coverage()>beforeCoverage&&current.successAt!>previous.successAt!,ledgerRowsUnchanged:rows()===beforeRows,pairAnchorAdvanced:anchors()===beforeAnchors+1,valuesUnchanged:current.meters?.find(m=>m.id==='balance')?.amount===previousBalance&&browserBalance===previousBalance};
    if(!heartbeat.coverageAdvanced||!heartbeat.ledgerRowsUnchanged||!heartbeat.valuesUnchanged)problems.push('unchanged money observation lost freshness or changed the ledger or balance');
    if(!heartbeat.pairAnchorAdvanced)problems.push('unchanged money observation did not retain its native spending endpoint');
    if(heartbeat.historyRequests>1||heartbeat.historyBytes>HISTORY_BYTES_PER_MEASUREMENT)problems.push('unchanged money observation exceeds the existing history traffic budget');
    const heartbeatReading=await cdp.evaluate<Reading>('__quotumBench.read()');
    problems.push(...renderProblems({card:source,renders:heartbeatReading.renders,mutations:heartbeatReading.mutations,from:heartbeatFrom,to:Date.now()}));
  }finally{ledger.close();}
  const linkedWork=await workLinkedWallet(demo,stand,cdp,source);problems.push(...linkedWork.problems);
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
  await moneyView(cdp,source,cappedSource,cap.id);
  return {count:latencies.length,p95Ms:Math.round(percentile(latencies,.95)),chartP95Ms:Math.round(percentile(chartLatencies,.95)),historyBytesPerMeasurement:bytes,heartbeat,linkedWork,currencies,problems};
}

/** Attributed wallet credit updates work readers once while financial drawing stays still. */
async function workLinkedWallet(demo:Demo,stand:Awaited<ReturnType<Demo['run']>>,cdp:Cdp,source:string) {
  say('checking linked wallet credit with Activity, money work columns and a stable financial chart');
  const owner=stand.people.get(people(stand.set)[0].id)!,agent=stand.agents.get('laptop')!,start=Date.now();
  const initial=new Requests(cdp);initial.counting=true;
  const revision=(await owner.get<{revision:string}>('/api/links')).revision;
  const created=await owner.post<{revision:string;links:{id:string}[]}>('/api/links',{clientId:'opencode',deviceId:null,route:null,sourceId:source,from:start,to:null,expectedRevision:revision,requestId:randomUUID()});
  const session={clientId:'opencode',sessionId:'e'.repeat(32),source:null,origin:'terminal',project:'Linked benchmark',startedAt:new Date(start).toISOString(),working:true};
  agent.trackClients([session],[]);await demo.reportNow('laptop');
  const setupFrom=Date.now(),readyBy=setupFrom+SHOWN_WITHIN;
  const authority=(await owner.get<Snapshot>('/api/overview?board='+owner.personalBoard)).workAuthority;
  const geometry=()=>cdp.evaluate<string>(`JSON.stringify(Array.from(document.querySelectorAll('.budget-history [data-series]')).map(node=>[node.getAttribute('data-series'),node.getAttribute('data-last'),Array.from(node.querySelectorAll('path')).map(path=>path.getAttribute('d'))]))`);
  const active=()=>cdp.evaluate<number>(`Number(document.querySelector('[data-work-source="${source}"]')?.getAttribute('data-active-ms')??-1)`);
  // A rolling board can lose more old work than this credit adds. Observe its own rendered project.
  const activitySelector='.activity [data-series-key='+JSON.stringify('activity:project:'+JSON.stringify(session.project))+']';
  const activityRead=`Number(document.querySelector(${JSON.stringify(activitySelector)})?.getAttribute('data-agent-ms')??0)`;
  const agentTime=()=>cdp.evaluate<number>(activityRead);
  const unavailable=async()=>{
    const state=await cdp.evaluate(`(()=>({period:window.__quotumWalletState?.(${JSON.stringify(source)})??null,table:document.querySelector('.budget-table')?.textContent?.slice(0,1600),markers:document.querySelectorAll('[data-work-source]').length,range:JSON.parse(localStorage.getItem('quotum.prefs')||'{}').range,selected:new URLSearchParams(location.search).has('from')}))()`).catch(()=>({status:'unavailable'}));
    console.error('bench: linked wallet state '+JSON.stringify(state));throw new Stop('linked wallet work columns are not ready');
  };
  // The first list starts a lease. Configuration changes need a cold baseline before credit measurements.
  let previous='',stable=0;
  while(stable<3){
    const layout=await cdp.evaluate<string|null>(`(()=>{
      const baseline=window.__quotumWalletState?.(${JSON.stringify(source)},${JSON.stringify(authority)});
      if(!baseline?.authorityReady||baseline.periodLoading||baseline.periodError||baseline.workNeeded||!baseline.work||baseline.preparation?.flights.length)return null;
      if(!document.querySelector('[data-work-source="${source}"]')||!document.querySelector('.activity-totals')||document.querySelector('.agents-panel.is-loading,.history.is-loading,.activity.is-loading,.budget-history.is-loading,.subscription-funds.is-loading,.chart>svg[data-draw-ready="false"]'))return null;
      if(document.getAnimations().some(animation=>animation.playState==='running'&&animation.effect?.target?.matches('.widget,.widget-body')))return null;
      return JSON.stringify(Array.from(document.querySelectorAll('.widgets>.widget')).map(node=>{const box=node.getBoundingClientRect();return[box.x,box.y,box.width,box.height];}));
    })()`);
    stable=!initial.historyPending&&layout!==null&&layout===previous?stable+1:0;previous=layout??'';
    if(stable<3){if(Date.now()>=readyBy)await unavailable();await sleep(20);}
  }
  initial.counting=false;
  const setup={waitMs:Date.now()-setupFrom,historyRequests:initial.historyRequests,historyBytes:initial.historyBytes};
  const reports:{at:number;capturedAt:number;reads:number;bytes:number;activeMs:number;activityAgentMs:number;activeMsLatency:number|null;activityMsLatency:number|null}[]=[],problems:string[]=[];
  for(let i=0;i<3;i++) {
    const before=await active(),beforeAgent=await agentTime(),drawing=await geometry();
    if(before<0||beforeAgent<0)await unavailable();
    await cdp.evaluate('__quotumBench.reset()');const requests=new Requests(cdp);requests.counting=true;const from=Date.now();
    await cdp.evaluate(`(()=>{
      let activeAt=null,activityAt=null;
      const values=()=>({activeMs:Number(document.querySelector('[data-work-source="${source}"]')?.getAttribute('data-active-ms')??-1),activityAgentMs:${activityRead}});
      const observer=new MutationObserver(()=>{
        const value=values(),now=Date.now();
        if(activeAt===null&&value.activeMs>${before})activeAt=now;
        if(activityAt===null&&value.activityAgentMs>${beforeAgent})activityAt=now;
      });
      observer.observe(document.body,{attributes:true,attributeFilter:['data-active-ms','data-agent-ms'],childList:true,subtree:true});
      window.__quotumLinkedWork=()=>{observer.disconnect();delete window.__quotumLinkedWork;return{...values(),activeAt,activityAt,capturedAt:Date.now(),reading:__quotumBench.read()};};
    })()`);
    if(i===2)agent.trackClients([{...session,working:false}],[]);
    const at=await demo.reportNow('laptop');await sleep(at+1000-Date.now());
    const shown=await cdp.evaluate<{activeMs:number;activityAgentMs:number;activeAt:number|null;activityAt:number|null;capturedAt:number;reading:Reading}>('window.__quotumLinkedWork()');
    // Drain only accounts for terminal traffic and late renders; it cannot extend the credit deadline.
    await drain(requests);requests.counting=false;
    const reading=await cdp.evaluate<Reading>('__quotumBench.read()'),reads=requests.historyRequests,bytes=requests.historyBytes;
    const activeMsLatency=shown.activeAt===null?null:shown.activeAt-at,activityMsLatency=shown.activityAt===null?null:shown.activityAt-at;
    reports.push({at,capturedAt:shown.capturedAt,reads,bytes,activeMs:shown.activeMs,activityAgentMs:shown.activityAgentMs,activeMsLatency,activityMsLatency});
    if(reads!==1||bytes>HISTORY_BYTES_PER_MEASUREMENT)problems.push(`linked wallet work read history ${reads} times, ${bytes} bytes`);
    if(shown.activeMs<=before||activeMsLatency===null||activeMsLatency<0||activeMsLatency>1000)problems.push('linked wallet active time did not advance within 1000 ms');
    problems.push(...activityCreditProblems(shown.reading.renders,beforeAgent,shown.activityAgentMs));
    if(activityMsLatency===null||activityMsLatency<0||activityMsLatency>1000)problems.push('linked wallet Activity did not advance within 1000 ms');
    if(await geometry()!==drawing)problems.push('linked wallet work changed financial geometry');
    if(reading.renders.some(part=>!part.time&&part.widget==='budget'&&part.node.includes('.budget-history')))problems.push('linked wallet work rendered the financial chart');
    problems.push(...renderProblems({card:source,renders:reading.renders,mutations:reading.mutations,from,to:Date.now()}));
  }
  agent.trackClients([],[]);await demo.reportNow('laptop');
  const response=await fetch(owner.base+'/api/links/'+created.links.at(-1)!.id,{method:'DELETE',headers:{cookie:owner.cookie,origin:new URL(owner.base).origin,'content-type':'application/json'},body:JSON.stringify({expectedRevision:created.revision,requestId:randomUUID()})});
  if(!response.ok)throw new Stop('linked wallet fixture could not remove its rule');
  return {setup,activityProject:session.project,reports,problems};
}

/** The personal display path uses the same measurement and render budgets as native money. */
async function currencyPhase(demo:Demo,stand:Awaited<ReturnType<Demo['run']>>,cdp:Cdp,source:string,credential:string) {
  const owner=stand.people.get(people(stand.set)[0].id)!,problems:string[]=[];
  const created=await owner.post<CurrencyDefinition>('/api/currencies',{name:'Bench points',symbol:'BP',fractionDigits:2,base:'JPY',rate:'2000000'});
  const command=async(url:string,body:object)=>{const state=await owner.get<CurrencyManagement>('/api/currencies/manage');return owner.post(url,{...body,expectedRevision:state.registryRevision,requestId:crypto.randomUUID()});};
  const waitBalance=async(value:string|null,stage:string)=>{
    const until=Date.now()+SHOWN_WITHIN;
    while(await cdp.evaluate<string|null>(`document.querySelector('[data-card="${source}"] [data-money]')?.getAttribute('data-money')??null`)!==value){
      if(Date.now()>until){
        const browser=await cdp.evaluate(`(()=>{const card=document.querySelector('[data-card="${source}"]');return{url:location.href,range:JSON.parse(localStorage.getItem('quotum.prefs')||'{}').range,card:card?{text:card.textContent?.slice(0,1200),values:Array.from(card.querySelectorAll('[data-money]')).map(node=>node.getAttribute('data-money'))}:null,series:document.querySelector('[data-series="${source} balance"]')?.getAttribute('data-last'),period:window.__quotumWalletState?.(${JSON.stringify(source)})??null};})()`).catch(()=>({status:'unavailable'}));
        const snapshot=await owner.get<Snapshot>('/api/overview?board='+owner.personalBoard).catch(()=>null),card=snapshot?.sources.find(row=>row.id===source);
        console.error('bench: personal currency state '+JSON.stringify({stage,expected:value,browser,server:snapshot?{target:snapshot.currencies?.target,revision:snapshot.currencies?.revision,source:card?{successAt:card.successAt,meters:card.meters,currencyUnavailable:card.currencyUnavailable}:null}:null}));
        throw new Stop('personal currency balance did not reach '+value+' at '+stage);
      }
      await sleep(20);
    }
  };
  await owner.post('/api/currencies/display',{currency:created.id});await waitBalance(null,'initial missing path');
  const quote=await owner.post<RateSnapshot>('/api/currencies/'+created.id+'/rates',{base:'USD',rate:'2000000',date:0});await waitBalance('112800000','initial path recovery');
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
  await owner.post('/api/credentials/'+credential,{secret:MONEY_KEY(1),allowNoExpiry:true});await waitBalance('112000000','converted measurement');
  const last=cellStart(from,cellOf(86_400_000))+':112000000',until=Date.now()+SHOWN_WITHIN;
  let chart:number|null=null;
  while(chart===null&&Date.now()<until){chart=await cdp.evaluate<number|null>(`__quotumBench.seriesChanged(${JSON.stringify(source+' balance')},${JSON.stringify(last)})`);if(chart===null)await sleep(20);}
  await drain(requests);requests.counting=false;const reading=await cdp.evaluate<Reading>('__quotumBench.read()');
  const card=await cdp.evaluate<number|null>(`__quotumBench.cardChanged(${JSON.stringify(source)})`),to=Date.now();
  problems.push(...measuredProblems({card:source,latencies:[card===null?Infinity:card-from],renders:reading.renders,mutations:reading.mutations,from,to}),...chartProblems([chart===null?Infinity:chart-from]));
  if(requests.historyRequests>1||requests.historyBytes>HISTORY_BYTES_PER_MEASUREMENT)problems.push('personal currency measurement exceeds the existing history traffic budget');
  await command('/api/currencies/'+created.id+'/rates/'+quote.id+'/archive',{base:'USD'});
  writeFileSync(path.join(demo.dir,'money-control.json'),JSON.stringify({at:Date.now(),credits:90,usage:34}));
  await owner.post('/api/credentials/'+credential,{secret:MONEY_KEY(1),allowNoExpiry:true});await waitBalance(null,'stopped path measurement');
  await command('/api/currencies/'+created.id+'/archive',{replacement:'USD'});await waitBalance('56000000','archive replacement USD');
  await command('/api/currencies/'+created.id+'/restore',{});await owner.post('/api/currencies/display',{currency:created.id});await waitBalance(null,'restored stopped path');
  await owner.post('/api/currencies/'+created.id+'/rates',{base:'USD',rate:'4000000'});
  writeFileSync(path.join(demo.dir,'money-control.json'),JSON.stringify({at:Date.now(),credits:90,usage:34}));
  await owner.post('/api/credentials/'+credential,{secret:MONEY_KEY(1),allowNoExpiry:true});await waitBalance('224000000','resumed path measurement');
  await owner.post('/api/currencies/display',{currency:'USD'});await waitBalance('56000000','final selection USD');
  return {historyRequests:requests.historyRequests,historyBytes:requests.historyBytes,cardMs:card===null?null:card-from,chartMs:chart===null?null:chart-from,problems};
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
    // The opposite end of a live period may retire older work during this report.
    // Check the recent buckets receiving this credit, with one fixed comparison cut.
    const calendarFrom=Date.now()-2*3_600_000;
    const calendarTotal=`Array.from(document.querySelectorAll('.agent-hours-heatmap [data-agent-ms]')).filter(node=>Number(node.getAttribute('data-heatmap-cell'))>=${calendarFrom}).reduce((sum,node)=>sum+Number(node.getAttribute('data-agent-ms')),0)`;
    const calendarBefore=await cdp.evaluate<number>(calendarTotal);
    const requests = new Requests(cdp); requests.counting = true;
    const from = Date.now();
    if (i === 2) demo.work(false); // This report credits the last working list.
    const at = await demo.nextReport('laptop');
    await sleep(1000); await drain(requests); requests.counting = false;
    const reading = await cdp.evaluate<Reading>('__quotumBench.read()');
    const reads = requests.historyRequests;
    const bytes = requests.historyBytes;
    reports.push({at, reads, bytes});
    if (reads !== 1 || bytes > HISTORY_BYTES_PER_MEASUREMENT) problems.push(`work report read history ${reads} times, ${bytes} bytes`);
    const calendarAfter=await cdp.evaluate<number>(calendarTotal);
    if(calendarAfter<=calendarBefore)problems.push('work report did not update recent registered calendar hours');
    problems.push(...renderProblems({card: source, renders: reading.renders, mutations: reading.mutations, from, to: Date.now()}));
  }
  return {reports, problems};
}

/** The interval endpoint has the same history and rendering budget as the released writer. */
async function workObserved(stand:Awaited<ReturnType<Demo['run']>>,cdp:Cdp) {
  say('checking captured intervals without extra history reads or unrelated renders');
  const source=stand.sources.get(MEASURED)!,owner=stand.people.get(people(stand.set)[0].id)!;
  const initial=new Requests(cdp);initial.counting=true;const setupFrom=Date.now();
  const actor=await ObservedWork.open(owner,cards(stand.set).find(card=>card.id===MEASURED)!);
  const reports:{at:number;reads:number;bytes:number;history:Requests['history']}[]=[],problems:string[]=[];
  const setup={waitMs:0,historyRequests:0,historyBytes:0};
  try {
    await sleep(1000);
    const authority=(await owner.get<Snapshot>('/api/overview?board='+owner.personalBoard)).workAuthority;
    const readyBy=Date.now()+SHOWN_WITHIN;let previous='',stable=0;
    // Joining a device changes the admitted cohort. Finish its cold baseline
    // before measuring the history tail read caused by a completed interval.
    while(stable<3){
      const layout=await cdp.evaluate<string|null>(`(()=>{
        const baseline=window.__quotumWalletState?.(${JSON.stringify(source)},${JSON.stringify(authority)});
        if(!baseline?.authorityReady||baseline.periodLoading||baseline.periodError||baseline.workNeeded||baseline.preparation?.flights.length)return null;
        if(document.querySelector('.agents-panel.is-loading,.history.is-loading,.activity.is-loading,.budget-history.is-loading,.subscription-funds.is-loading,.chart>svg[data-draw-ready="false"]'))return null;
        if(document.getAnimations().some(animation=>animation.playState==='running'&&animation.effect?.target?.matches('.widget,.widget-body')))return null;
        return JSON.stringify(Array.from(document.querySelectorAll('.widgets>.widget')).map(node=>{const box=node.getBoundingClientRect();return[box.x,box.y,box.width,box.height];}));
      })()`);
      stable=!initial.historyPending&&layout!==null&&layout===previous?stable+1:0;previous=layout??'';
      if(stable<3){
        if(Date.now()>=readyBy){
          const state=await cdp.evaluate(`window.__quotumWalletState?.(${JSON.stringify(source)},${JSON.stringify(authority)})`);
          console.error('bench: captured work setup '+JSON.stringify({state,pending:initial.historyPending,history:initial.history}));
          throw new Stop('captured work configuration history did not settle');
        }
        await sleep(20);
      }
    }
    initial.counting=false;
    Object.assign(setup,{waitMs:Date.now()-setupFrom,historyRequests:initial.historyRequests,historyBytes:initial.historyBytes});
    for(let i=0;i<3;i++) {
      await cdp.evaluate('__quotumBench.reset()');const requests=new Requests(cdp);requests.counting=true;
      const from=Date.now(),at=await actor.report(i<2);
      await sleep(1000);await drain(requests);requests.counting=false;
      const reading=await cdp.evaluate<Reading>('__quotumBench.read()'),reads=requests.historyRequests,bytes=requests.historyBytes;
      reports.push({at,reads,bytes,history:requests.history});
      if(reads!==1||bytes>HISTORY_BYTES_PER_MEASUREMENT)problems.push(`captured work read history ${reads} times, ${bytes} bytes`);
      problems.push(...renderProblems({card:source,renders:reading.renders,mutations:reading.mutations,from,to:Date.now()}));
    }
  }finally{initial.counting=false;await actor.close();await sleep(1000);}
  return {reports,setup,problems};
}

async function workPrivate(demo: Demo, stand: Awaited<ReturnType<Demo['run']>>, cdp: Cdp) {
  say('checking private client credit without card, header or financial renders');
  const agent=stand.agents.get('laptop')!,start=Date.now();
  const session={clientId:'opencode',sessionId:'d'.repeat(32),source:null,origin:'terminal',project:'Private benchmark',startedAt:new Date(start).toISOString(),working:true};
  agent.trackClients([session],[]);await demo.reportNow('laptop');await sleep(1000);
  const reports:{at:number;reads:number;bytes:number}[]=[],problems:string[]=[];
  for(let i=0;i<3;i++) {
    await cdp.evaluate('__quotumBench.reset()');const requests=new Requests(cdp);requests.counting=true;const from=Date.now();
    if(i===2)agent.trackClients([{...session,working:false}],[]);
    const at=await demo.reportNow('laptop');await sleep(1000);await drain(requests);requests.counting=false;
    const reading=await cdp.evaluate<Reading>('__quotumBench.read()'),reads=requests.historyRequests,bytes=requests.historyBytes;
    reports.push({at,reads,bytes});
    if(reads!==1||bytes>HISTORY_BYTES_PER_MEASUREMENT)problems.push(`private work read history ${reads} times, ${bytes} bytes`);
    problems.push(...privateWorkRenderProblems({renders:reading.renders,mutations:reading.mutations,from,to:Date.now(),cellMs:cellOf(86_400_000)}));
  }
  agent.trackClients([],[]);await demo.reportNow('laptop');
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
