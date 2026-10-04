import assert from 'node:assert/strict';
import {cellStart, type HistoryAnswer} from '../server/domain/history';
import {openTab, type Browser, type Cdp} from './cdp';
import {HistoryCutChanged, bodyTotals, readUnion, stableHistory, trafficProblems, transferFor} from './historyTrafficBudget';
import {HISTORY_ATTEMPT_HEADER, historyBody, type BodyCount, type Transfer} from './historyProxy';

const DAY = 86_400_000;
type Read = {id: string; phase: string; from: number; to: number; cell: number; lower: number; coding?: string; length?: number; attemptId?: string; transferId?: string; canceled?: boolean; count?: BodyCount; answer?: Pick<HistoryAnswer, 'run' | 'now' | 'known'>; chunks?: [number, number][]};
const lowerHeaders = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
let pageSerial = 0;

/** Identity is attached before fetch; cancellation need not receive response headers. */
export function historyPageScript(period: string) {
  const prefix = `b${++pageSerial}`;
  return `(() => {
    localStorage.setItem('quotum.locale','en');localStorage.setItem('quotum.prefs',JSON.stringify({range:${JSON.stringify(period)},horizon:'1d'}));
    const original=window.fetch.bind(window),attempts=window.__quotumHistoryAttempts={};let serial=0;
    window.fetch=(resource,init={})=>{
      const uri=resource instanceof Request?resource.url:String(resource);
      if(new URL(uri,location.href).pathname!='/api/history')return original(resource,init);
      const id=${JSON.stringify(prefix)}+':'+(++serial),headers=new Headers(init.headers||(resource instanceof Request?resource.headers:undefined)),signal=init.signal||(resource instanceof Request?resource.signal:undefined);
      headers.set(${JSON.stringify(HISTORY_ATTEMPT_HEADER)},id);
      const attempt=attempts[id]={aborted:!!signal?.aborted};signal?.addEventListener('abort',()=>{attempt.aborted=true;},{once:true});
      return original(resource,{...init,headers});
    };
  })()`;
}

/** Counts encoded bodies only. Chrome's loadingFinished total includes headers. */
export class HistoryBodies {
  phase = 'seed';
  readonly reads: Read[] = [];
  readonly pending = new Set<Promise<unknown>>();
  readonly errors: unknown[] = [];
  private readonly active = new Map<string, Read>();
  get activeCount() {return this.active.size;}
  constructor(cdp: Pick<Cdp, 'on' | 'send'>) {
    cdp.on<{requestId: string; request: {url: string; headers?: Record<string, string>}}>('Network.requestWillBeSent', event => {
      const url = new URL(event.request.url); if (url.pathname !== '/api/history') return;
      const read: Read = {id: event.requestId, phase: this.phase, from: Number(url.searchParams.get('from')), to: Number(url.searchParams.get('to')), cell: Number(url.searchParams.get('cell')), lower: 0, attemptId: lowerHeaders(event.request.headers ?? {})[HISTORY_ATTEMPT_HEADER]};
      this.active.set(read.id, read); this.reads.push(read);
    });
    cdp.on<{requestId: string; headers: Record<string, string>}>('Network.requestWillBeSentExtraInfo', event => {
      const read = this.reads.find(r => r.id === event.requestId), id = lowerHeaders(event.headers)[HISTORY_ATTEMPT_HEADER];
      if (!read || id === undefined) return;
      read.attemptId = id;
      if (read.count) read.count.id = id;
    });
    cdp.on<{requestId: string; response: {headers: Record<string, string>}}>('Network.responseReceived', event => {
      const read = this.active.get(event.requestId); if (!read) return;
      const headers = lowerHeaders(event.response.headers);
      read.coding = headers['content-encoding']; read.length = headers['content-length'] === undefined ? undefined : Number(headers['content-length']); read.transferId = headers['x-quotum-bench-id'];
    });
    cdp.on<{requestId: string; encodedDataLength: number}>('Network.dataReceived', event => {const read = this.active.get(event.requestId); if (read) read.lower += event.encodedDataLength;});
    cdp.on<{requestId: string}>('Network.loadingFinished', event => {
      const read = this.active.get(event.requestId); if (!read) return; this.active.delete(read.id);
      const work = cdp.send<{body: string; base64Encoded: boolean}>('Network.getResponseBody', {requestId: read.id}).then(result => {
        const decoded = result.base64Encoded ? Buffer.from(result.body, 'base64') : Buffer.from(result.body);
        const answer = JSON.parse(decoded.toString()) as HistoryAnswer;
        read.answer = {run: answer.run, now: answer.now, known: answer.known}; read.chunks = answer.chunks.map(chunk => [chunk.from, chunk.to]);
        read.count = {complete: true, decoded: decoded.length, lower: read.length ?? NaN, upper: read.length, length: read.length, coding: read.coding, id: read.attemptId ?? read.transferId, responseId: read.transferId};
      }).catch(error => {this.errors.push(error); read.count = {complete: false, lower: read.lower, upper: read.length, length: read.length, coding: read.coding, id: read.attemptId ?? read.transferId, responseId: read.transferId};});
      this.pending.add(work); void work.then(() => this.pending.delete(work));
    });
    cdp.on<{requestId: string; canceled?: boolean}>('Network.loadingFailed', event => {
      const read = this.active.get(event.requestId); if (!read) return; this.active.delete(read.id);
      read.canceled = event.canceled === true;
      read.count = {complete: false, lower: read.lower, upper: read.length, length: read.length, coding: read.coding, id: read.attemptId ?? read.transferId, responseId: read.transferId};
    });
  }
}

/** CDP's speed is an integer; keep the named cold gesture near 750 ms. */
export function historyScroll(geometry: {x: number; y: number; width: number}, fraction: number, distance: number) {
  if (![geometry.x, geometry.y, geometry.width, fraction, distance].every(Number.isFinite) || geometry.width <= 0 || fraction <= 0) throw new Error('invalid history gesture geometry');
  return {x: geometry.x, y: geometry.y, xDistance: distance, yDistance: 0, speed: Math.max(1, Math.round(geometry.width * fraction / .75)), gestureSourceType: 'mouse', preventFling: true};
}

type TrafficProxy = {url: string; transfers: Transfer[]; phase(value: string, latency?: number): void; settled(value: string): Promise<void>};

async function historyPage(browser: Browser, proxy: TrafficProxy, cookie: string, name: string, length: number, future: number) {
  const tab = await openTab(browser), cdp = tab.cdp, bodies = new HistoryBodies(cdp);
  cdp.at(`${name}/seed`);
  const close = async () => {cdp.at(`${name}/cleanup`); await cdp.evaluate('(()=>{const p=window.__historyTraffic;if(p){p.running=false;cancelAnimationFrame(p.raf);history.pushState=p.originalPush;}})()').catch(() => {}); await tab.close();};
  try {
    const seedPhase = `${name}/seed`; bodies.phase = seedPhase; proxy.phase(seedPhase);
    await cdp.send('Network.enable'); await cdp.send('Page.enable'); await cdp.send('Performance.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
    const split = cookie.indexOf('='); await cdp.send('Network.setCookie', {name: cookie.slice(0, split), value: cookie.slice(split + 1), url: proxy.url, httpOnly: true, sameSite: 'Lax'});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source: historyPageScript(length === DAY ? '24h' : '30d')});
    await cdp.send('Page.navigate', {url: proxy.url});
    const settled = async () => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        if (bodies.errors.length) throw bodies.errors[0];
        if (!bodies.activeCount && !bodies.pending.size && await cdp.evaluate<boolean>(`!!document.querySelector('.history .series[d]:not([d=""])')&&!document.querySelector('.history.is-loading,.activity.is-loading,.chart>svg[data-pan-end],.chart>svg[data-draw-ready="false"],.chart>svg.is-panning')`)) {
          await cdp.evaluate('new Promise(resolve=>setTimeout(resolve,250))');
          if (!bodies.activeCount && !bodies.pending.size) return;
        }
        if (Date.now() > deadline) throw new Error(`${name}: full drawings or terminal HTTP did not settle`);
        await cdp.evaluate('new Promise(resolve=>setTimeout(resolve,20))');
      }
    };
    await settled();
    await cdp.evaluate(`(() => {const style=document.createElement('style');style.textContent='.widgets{display:flex!important;flex-direction:column!important}.widget{height:auto!important}.widget:not(:has(.history,.activity)){display:none!important}.widget-body{height:auto!important}.widget-body>.panel{--fill:0px!important}.history .chart>svg{height:260px!important}.activity .chart>svg{height:180px!important}.legend{max-height:40px;overflow:auto}';document.head.append(style);document.querySelector('.analytics-head').scrollIntoView();})()`);
    await settled();
    const geometry = await cdp.evaluate<{x: number; y: number; width: number; series: number}>(`(() => {const svg=document.querySelector(${JSON.stringify(future ? '.history .chart>svg' : '.activity .chart>svg')});svg.scrollIntoView({block:'center'});const r=svg.getBoundingClientRect(),left=${future ? 40 : 48};return {x:r.left+r.width*.5,y:r.top+80,width:r.width*(svg.viewBox.baseVal.width-left-12)/svg.viewBox.baseVal.width,series:document.querySelectorAll('.history .series[d]:not([d=""])').length};})()`);
    assert.ok(geometry.series >= 12, `${name}: fewer than twelve actual series`);
    const seedReads = bodies.reads.filter(read => read.phase === seedPhase && read.count?.complete);
    assert.ok(seedReads.length); const cell = seedReads[0].cell, seed = seedReads.at(-1)!.answer!;
    const initial = new Set<number>(); for (const read of seedReads) for (const [from, to] of read.chunks!) for (let at = from; at < to; at += cell) initial.add(at);
    await cdp.evaluate(`(() => {
      const root=document.querySelector('.history .chart>svg'),originalPush=history.pushState;
      const p=window.__historyTraffic={tokens:[],poses:[],pushes:0,running:true,originalPush};
      history.pushState=function(...args){p.pushes++;return originalPush.apply(this,args);};
      const frame=()=>{if(!p.running)return;if(root.dataset.panEnd){const token=root.dataset.panToken;if(p.tokens.at(-1)!==token)p.tokens.push(token);const end=Number(root.dataset.panEnd),origin=Number(root.dataset.panOrigin);if(p.poses.at(-1)?.end!==end)p.poses.push({end,origin});}p.raf=requestAnimationFrame(frame);};p.raf=requestAnimationFrame(frame);
    })()`);
    return {cdp, bodies, settled, geometry, seed, cell, initial, close};
  } catch (error) {await close(); throw error;}
}

/** Separate tabs use the fixed-codec proxy; this never changes the native perf route. */
export async function browserHistoryTraffic(browser: Browser, proxy: TrafficProxy, cookie: string, board: string) {
  const reports = [], invalidated = [], problems: string[] = [];
  for (const length of [DAY, 30 * DAY]) for (const future of [DAY, 0]) for (const latency of [0, 100, 400]) for (const fraction of [.5, .04]) {
    for (let take = 1; take <= 3; take++) {
      const name = `browser/${length / DAY}d/${future ? 'history' : 'activity'}/${latency}ms/${fraction}/take${take}`;
      const {cdp, bodies, settled, geometry, seed, cell, initial, close} = await historyPage(browser, proxy, cookie, name, length, future);
      try {
        const phase = `${name}/cold`; bodies.phase = phase; proxy.phase(phase, latency);
        const scroll = (distance: number) => cdp.send('Input.synthesizeScrollGesture', historyScroll(geometry, fraction, distance));
        await scroll(geometry.width * fraction); await settled();
        const pose = await cdp.evaluate<{tokens: string[]; poses: {end: number; origin: number}[]; pushes: number; from: number; to: number}>('({tokens:__historyTraffic.tokens,poses:__historyTraffic.poses,pushes:__historyTraffic.pushes,from:Number(new URLSearchParams(location.search).get("from")),to:Number(new URLSearchParams(location.search).get("to"))})');
        assert.equal(pose.tokens.length, 1); assert.equal(pose.pushes, 1); assert.ok(pose.poses.length > 1 && pose.from > 0);
        assert.ok(Math.abs(pose.to - pose.poses[0].origin + (length + future) * fraction) <= 3 * (length + future) / geometry.width, 'native gesture did not move by its named fraction');
        const cold = bodies.reads.filter(read => read.phase === phase), requested = new Set<number>(), visited = new Set<number>();
        for (const {end, origin} of pose.poses) for (let at = cellStart(end - length, cell); at < Math.ceil(Math.min(origin, end + DAY) / cell) * cell; at += cell) visited.add(at);
        // Release can commit its final coalesced input before the observer's RAF.
        for (let at = cellStart(pose.from, cell); at < Math.ceil(Math.min(pose.poses[0].origin, pose.to + DAY) / cell) * cell; at += cell) visited.add(at);
        for (const read of cold) {
          assert.ok(read.count, 'every attempt needs a terminal body count');
          if (read.answer) stableHistory(read.answer, seed, cell);
          for (let at = read.from; at < read.to; at += cell) {assert.ok(!initial.has(at), 'browser reread fresh seed data'); requested.add(at);}
        }
        await proxy.settled(phase);
        const totals = bodyTotals(cold.map(read => ({count: read.count!, transfer: transferFor(read.count!, proxy.transfers)})));
        const optional = [...requested].filter(at => !visited.has(at)); assert.ok(optional.length <= Math.min(60, Math.ceil(length / cell / 4)), 'browser traffic has an unbounded optional footprint');
        proxy.phase(`${name}/reference`); let referenceDecoded = 0, referenceEncoded = 0;
        for (const [from, to] of readUnion(requested, cell)) {
          const answer = await historyBody(`${proxy.url}/api/history?board=${encodeURIComponent(board)}&cell=${cell}&from=${from}&to=${to}`, cookie, undefined, body => {assert.ok(body.complete); referenceDecoded += body.decoded!; referenceEncoded += body.lower;}) as HistoryAnswer;
          stableHistory(answer, seed, cell);
        }
        const warmPhase = `${name}/warm`; bodies.phase = warmPhase; proxy.phase(warmPhase);
        // A selected chart has no future, so its return uses the captured time delta.
        await scroll(-(pose.poses[0].origin - pose.to) / length * geometry.width); await settled();
        assert.equal(await cdp.evaluate<boolean>('new URLSearchParams(location.search).has("from")'), false, 'cached return did not reach live');
        await scroll(geometry.width * fraction); await settled();
        const warm = bodies.reads.filter(read => read.phase === warmPhase); assert.equal(warm.length, 0, 'browser cached return/repeat started history');
        const metrics = await cdp.send<{metrics: {name: string; value: number}[]}>('Performance.getMetrics');
        const report = {name, attempts: cold.length, maxAttempts: fraction === .04 ? 2 : future ? 7 : 5, ...totals, referenceDecoded, referenceEncoded, ratios: fraction === .5, warmAttempts: warm.length, optionalUnvisitedCells: optional.length, series: geometry.series, movement: {tokens: pose.tokens.length, samples: pose.poses.length, pushes: pose.pushes, from: pose.from, to: pose.to}, heapBytes: metrics.metrics.find(m => m.name === 'JSHeapUsedSize')?.value};
        reports.push(report); problems.push(...trafficProblems(report));
        console.error(`bench: ${name}: ${cold.length} GETs, ${warm.length} warm GETs, decoded ratio ${report.decoded === null ? 'unknown' : report.decoded / referenceDecoded}, encoded ratio ${report.encodedUpper === null ? 'unknown' : report.encodedUpper / referenceEncoded}`);
        break;
      } catch (error) {
        if (!(error instanceof HistoryCutChanged) || take === 3) throw new Error(`${name}: ${String(error)}`, {cause: error});
        invalidated.push({name, reason: error.message, reads: bodies.reads.map(read => ({phase: read.phase, from: read.from, to: read.to, count: read.count}))});
      } finally {await close();}
    }
  }
  return {reports, invalidated, problems};
}

/** Native cancellation/reversal keeps one Shift-wheel token while responses are owned. */
export async function browserCancellationTraffic(browser: Browser, proxy: TrafficProxy, cookie: string) {
  const reports = [];
  for (const length of [DAY, 30 * DAY]) for (const mode of ['before-headers', 'after-delivery', 'reversal'] as const) {
    const name = `browser/${length / DAY}d/${mode}`;
    console.error(`bench: ${name}: opening seed page`);
    const {cdp, bodies, settled, geometry, seed, cell, close} = await historyPage(browser, proxy, cookie, name, length, DAY);
    console.error(`bench: ${name}: seed page ready`);
    const phase = `${name}/gesture`, reads = () => bodies.reads.filter(r => r.phase === phase);
    let stage = 'start';
    const step = async <T>(value: string, run: () => Promise<T>) => {
      stage = value; cdp.at(`${name}/${stage}`);
      console.error(`bench: ${name}: ${stage}`);
      return run();
    };
    const until = async (predicate: () => boolean | Promise<boolean>) => {const end = Date.now() + 10_000; while (!await predicate()) {if (bodies.errors.length) throw bodies.errors[0]; if (Date.now() > end) throw new Error(`${name}: lifecycle boundary not reached`); await cdp.evaluate('new Promise(resolve=>setTimeout(resolve,10))');}};
    const key = (type: string, name: string, code: number, modifiers: number) => cdp.send('Input.dispatchKeyEvent', {type, key: name, code: name === 'Shift' ? 'ShiftLeft' : name, windowsVirtualKeyCode: code, modifiers});
    const wheel = (pixels: number) => cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: geometry.x, y: geometry.y, deltaX: pixels, deltaY: 0, modifiers: 8});
    try {
      bodies.phase = phase; proxy.phase(phase, mode === 'after-delivery' ? 0 : 400);
      await step('shift down', () => key('keyDown', 'Shift', 16, 8));
      await step('first wheel', () => wheel(-geometry.width * .1));
      await step('first request', () => until(() => reads()[0]?.attemptId !== undefined && proxy.transfers.some(t => t.id === reads()[0].attemptId)));
      if (mode === 'after-delivery') await step('first delivery', () => until(() => reads()[0]?.count?.complete === true));
      if (mode === 'reversal') {
        await step('reverse wheel', () => wheel(geometry.width * .1));
        await step('first cancellation', () => until(() => reads()[0]?.canceled === true));
        await step('reversal frame', () => cdp.evaluate('new Promise(requestAnimationFrame)'));
        await step('repeat wheel', () => wheel(-geometry.width * .1));
        await step('repeat delivery', () => until(() => reads().length >= 2 && reads().slice(1).some(r => r.count?.complete)));
        await step('shift up', () => key('keyUp', 'Shift', 16, 0));
        await step('drawings settled', settled);
        assert.equal(reads()[0].from, reads()[1].from); assert.equal(reads()[0].to, reads()[1].to, 'a repeated range needs a new attempt identity');
      } else {
        await step('escape down', () => key('keyDown', 'Escape', 27, 8));
        await step('escape up', () => key('keyUp', 'Escape', 27, 8));
        await step('shift up', () => key('keyUp', 'Shift', 16, 0));
        await step('drawings settled', settled);
      }
      await step('proxy settled', () => proxy.settled(phase));
      const attempts = reads(); assert.ok(attempts.every(r => r.count?.id));
      const totals = bodyTotals(attempts.map(r => ({count: r.count!, transfer: transferFor(r.count!, proxy.transfers)})));
      for (const read of attempts) if (read.answer) stableHistory(read.answer, seed, cell);
      const state = await step('read final state', () => cdp.evaluate<{tokens: string[]; poses: {end: number; origin: number}[]; pushes: number; selected: boolean; attempts: Record<string, {aborted: boolean}>}>('({tokens:__historyTraffic.tokens,poses:__historyTraffic.poses,pushes:__historyTraffic.pushes,selected:new URLSearchParams(location.search).has("from"),attempts:__quotumHistoryAttempts})'));
      assert.equal(state.tokens.length, 1); assert.ok(state.poses.some(p => p.end < p.origin));
      assert.equal(state.pushes, mode === 'reversal' ? 1 : 0); assert.equal(state.selected, mode === 'reversal');
      const aborted = attempts.filter(r => r.canceled || state.attempts[r.count!.id!]?.aborted).length;
      assert.ok(mode === 'after-delivery' || aborted > 0, 'cancel-before-delivery must exercise abort');
      const report = {name, attempted: attempts.length, completed: attempts.filter(r => r.count?.complete).length, failed: attempts.filter(r => !r.count?.complete && !r.canceled && !state.attempts[r.count!.id!]?.aborted).length, aborted, transportAbortedDelivered: attempts.filter(r => r.count?.complete && state.attempts[r.count!.id!]?.aborted).length, stagingDisposition: 'not-observed', ...totals, finalComplete: true, movement: {tokens: state.tokens.length, poses: state.poses.length, pushes: state.pushes}, requests: attempts.map(r => ({from: r.from, to: r.to, id: r.count!.id, canceled: r.canceled}))};
      reports.push(report); console.error(`bench: ${name}: ${report.attempted} attempts, ${aborted} aborted, ${totals.byteVerdict} body proof`);
    } catch (error) {
      console.error(`bench: ${name}: failed at ${stage}; HTTP ${JSON.stringify({active: bodies.activeCount, pending: bodies.pending.size, reads: reads().map(r => ({from: r.from, to: r.to, canceled: r.canceled, complete: r.count?.complete}))})}`);
      cdp.at(`${name}/failure state`);
      const state = await cdp.evaluate('({visibility:document.visibilityState,ready:document.readyState,charts:[...document.querySelectorAll(".chart>svg")].map(svg=>({...svg.dataset})),selected:new URLSearchParams(location.search).has("from")})').catch(cause => String(cause));
      console.error(`bench: ${name}: failure state ${JSON.stringify(state)}`);
      throw error;
    } finally {
      cdp.at(`${name}/release shift`);
      await key('keyUp', 'Shift', 16, 0).catch(() => {}); await close();
      console.error(`bench: ${name}: page closed`);
    }
  }
  return reports;
}
