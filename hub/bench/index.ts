import {createServer} from 'node:net';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {SETS} from '../demo/catalogue.js';
import {addressOf, Demo, prepare, Stop} from '../demo/index.js';
import {people} from '../demo/model.js';
import {attachedChrome, findChrome, launchChrome, openTab, type Browser, type Cdp} from './cdp.js';
import {probeScript, type Reading} from './probe.js';
import {delta, round, scriptPerSecond, tally, type Metrics} from './report.js';
import {stillProblems, warmUntil, type StillCard} from './still.js';

/**
 * `npm run bench -- [--ci] [--cdp <http://host:port>]`: how much an open dashboard costs,
 * measured in a real browser on the built hub and page (`npm run build` first). A hub of
 * the demo's catalogue stands still (demo `--still`); Ana's personal board is opened in
 * headless Chrome (QUOTUM_CHROME, else the first Chrome on PATH, or one already running,
 * with `--cdp`), and the page is watched while nothing but the clock changes: what it
 * asks the hub, what React renders and the DOM changes, and the time its scripts take.
 * Prints the numbers as JSON; `--ci` watches for a shorter time.
 */

const USAGE = 'Usage: npm run bench -- [--ci] [--cdp <http://host:port>]';
/** How long the idle page is watched, in seconds. */
const IDLE = {full: 300, ci: 120};
/** How long the board may take to show its cards. */
const SHOWN_MS = 30_000;
/** The requests of a page, as Chrome types them: those it makes itself, not its images or styles. */
const ASKED = new Set(['Fetch', 'XHR', 'EventSource', 'Document']);

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

/** Counts what the page asks the hub while `counting`; the open stream of events is not a request of the idle page. */
class Requests {
  counting = false;
  count = 0;
  bytes = 0;
  readonly byPath: Record<string, number> = {};
  private readonly ids = new Set<string>();

  constructor(cdp: Cdp) {
    cdp.on<{requestId: string; type?: string; request: {url: string}}>('Network.requestWillBeSent', event => {
      if (!this.counting || !ASKED.has(event.type ?? '')) return;
      const url = new URL(event.request.url);
      if (url.pathname === '/api/events' && !url.searchParams.has('mode')) return;
      this.count++;
      this.byPath[url.pathname] = (this.byPath[url.pathname] ?? 0) + 1;
      this.ids.add(event.requestId);
    });
    cdp.on<{requestId: string; encodedDataLength: number}>('Network.loadingFinished', event => {
      if (this.ids.delete(event.requestId)) this.bytes += event.encodedDataLength;
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
  let finished = false;
  const finish = async (code: number) => {
    if (finished) return;
    finished = true;
    await tab?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await demo.stop();
    process.exit(code);
  };
  const set = SETS[0];
  const demo = new Demo({set, scene: set.scene, still: true, address, onExit: () => void finish(1)});
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void finish(1));

  try {
    say(`a still hub of the ${set.id} set at ${address.base}`);
    const stand = await demo.run();
    const ana = stand.people.get(people(set)[0].id)!;
    const board = ana.personalBoard;
    const overview = async () => (await ana.get<{sources: StillCard[]}>(`/api/overview?board=${encodeURIComponent(board)}`)).sources;

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

    const from = Date.now();
    const to = from + seconds * 1000;
    const problems = stillProblems(await overview(), from, to);
    if (problems.length) throw new Stop(`The stand does not stand still over the window, so its numbers would not be of an idle board: ${problems.join('; ')}.`);

    say(`watching the idle page for ${seconds} s`);
    await cdp.evaluate('__quotumBench.reset()');
    requests.counting = true;
    const before = await metrics(cdp);
    await sleep(to - Date.now());
    const after = await metrics(cdp);
    requests.counting = false;
    const reading = await cdp.evaluate<Reading>('__quotumBench.read()');

    const result = {
      set: set.id,
      idle: {
        seconds,
        requests: {count: requests.count, bytes: requests.bytes, byPath: requests.byPath},
        renders: {commits: reading.commits, ...tally(reading.renders)},
        mutations: tally(reading.mutations),
        scriptMsPerSecond: round(scriptPerSecond(before, after, reading.instrumentMs, seconds)),
        instrumentMsPerSecond: round(reading.instrumentMs / seconds),
        taskMsPerSecond: round((delta(before, after, 'TaskDuration') * 1000) / seconds),
        layouts: delta(before, after, 'LayoutCount'),
        recalcStyles: delta(before, after, 'RecalcStyleCount'),
      },
    };
    console.log(JSON.stringify(result, null, 2));
    await finish(0);
  } catch (error) {
    if (finished) return;
    await demo.settled();
    console.error(error instanceof Stop ? error.message : `The benchmark failed: ${(error as Error).stack ?? error}`);
    await finish(error instanceof Stop ? 2 : 1);
  }
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
