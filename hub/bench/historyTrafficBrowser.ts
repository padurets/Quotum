import assert from 'node:assert/strict';
import {cellStart, type HistoryAnswer} from '../server/domain/history';
import {openTab, type Browser, type Cdp} from './cdp';
import {HistoryCutChanged, bodyTotals, readUnion, stableHistory, trafficProblems} from './historyTrafficBudget';
import {historyBody, type BodyCount, type Transfer} from './historyProxy';

const DAY = 86_400_000;
type Read = {id: string; phase: string; from: number; to: number; cell: number; lower: number; coding?: string; length?: number; transferId?: string; count?: BodyCount; answer?: Pick<HistoryAnswer, 'run' | 'now' | 'known'>; chunks?: [number, number][]};

/** Counts encoded bodies only. Chrome's loadingFinished total includes headers. */
export class HistoryBodies {
  phase = 'seed';
  readonly reads: Read[] = [];
  readonly pending = new Set<Promise<unknown>>();
  readonly errors: unknown[] = [];
  private readonly active = new Map<string, Read>();
  get activeCount() {return this.active.size;}
  constructor(cdp: Pick<Cdp, 'on' | 'send'>) {
    cdp.on<{requestId: string; request: {url: string}}>('Network.requestWillBeSent', event => {
      const url = new URL(event.request.url); if (url.pathname !== '/api/history') return;
      const read: Read = {id: event.requestId, phase: this.phase, from: Number(url.searchParams.get('from')), to: Number(url.searchParams.get('to')), cell: Number(url.searchParams.get('cell')), lower: 0};
      this.active.set(read.id, read); this.reads.push(read);
    });
    cdp.on<{requestId: string; response: {headers: Record<string, string>}}>('Network.responseReceived', event => {
      const read = this.active.get(event.requestId); if (!read) return;
      const headers = Object.fromEntries(Object.entries(event.response.headers).map(([key, value]) => [key.toLowerCase(), value]));
      read.coding = headers['content-encoding']; read.length = headers['content-length'] === undefined ? undefined : Number(headers['content-length']); read.transferId = headers['x-quotum-bench-id'];
    });
    cdp.on<{requestId: string; encodedDataLength: number}>('Network.dataReceived', event => {const read = this.active.get(event.requestId); if (read) read.lower += event.encodedDataLength;});
    cdp.on<{requestId: string}>('Network.loadingFinished', event => {
      const read = this.active.get(event.requestId); if (!read) return; this.active.delete(read.id);
      const work = cdp.send<{body: string; base64Encoded: boolean}>('Network.getResponseBody', {requestId: read.id}).then(result => {
        const decoded = result.base64Encoded ? Buffer.from(result.body, 'base64') : Buffer.from(result.body);
        const answer = JSON.parse(decoded.toString()) as HistoryAnswer;
        read.answer = {run: answer.run, now: answer.now, known: answer.known}; read.chunks = answer.chunks.map(chunk => [chunk.from, chunk.to]);
        read.count = {complete: true, decoded: decoded.length, lower: read.length ?? NaN, upper: read.length, length: read.length, coding: read.coding, id: read.transferId};
      }).catch(error => {this.errors.push(error); read.count = {complete: false, lower: read.lower, upper: read.length, length: read.length, coding: read.coding, id: read.transferId};});
      this.pending.add(work); void work.then(() => this.pending.delete(work));
    });
    cdp.on<{requestId: string}>('Network.loadingFailed', event => {
      const read = this.active.get(event.requestId); if (!read) return; this.active.delete(read.id);
      read.count = {complete: false, lower: read.lower, upper: read.length, length: read.length, coding: read.coding, id: read.transferId};
    });
  }
}

/** Separate tabs use the fixed-codec proxy; this never changes the native perf route. */
export async function browserHistoryTraffic(browser: Browser, proxy: {url: string; transfers: Transfer[]; phase(value: string, latency?: number): void}, cookie: string, board: string) {
  const reports = [], invalidated = [], problems: string[] = [];
  for (const length of [DAY, 30 * DAY]) for (const future of [DAY, 0]) for (const latency of [0, 100, 400]) for (const fraction of [.5, .04]) {
    for (let take = 1; take <= 3; take++) {
      const name = `browser/${length / DAY}d/${future ? 'history' : 'activity'}/${latency}ms/${fraction}/take${take}`, tab = await openTab(browser), cdp = tab.cdp, bodies = new HistoryBodies(cdp);
      try {
        const seedPhase = `${name}/seed`; bodies.phase = seedPhase; proxy.phase(seedPhase);
        await cdp.send('Network.enable'); await cdp.send('Page.enable'); await cdp.send('Performance.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
        const split = cookie.indexOf('='); await cdp.send('Network.setCookie', {name: cookie.slice(0, split), value: cookie.slice(split + 1), url: proxy.url, httpOnly: true, sameSite: 'Lax'});
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source: `localStorage.setItem('quotum.prefs',JSON.stringify({range:${JSON.stringify(length === DAY ? '24h' : '30d')},horizon:'1d',lang:'en'}));`});
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
        const phase = `${name}/cold`; bodies.phase = phase; proxy.phase(phase, latency);
        const scroll = (distance: number) => cdp.send('Input.synthesizeScrollGesture', {x: geometry.x, y: geometry.y, xDistance: distance, yDistance: 0, speed: Math.max(1, geometry.width * fraction / .75), gestureSourceType: 'mouse', preventFling: true});
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
        const totals = bodyTotals(cold.map(read => ({count: read.count!, transfer: proxy.transfers.find(t => t.id === read.transferId) ?? proxy.transfers.find(t => t.phase === phase && t.from === read.from && t.to === read.to)})));
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
        break;
      } catch (error) {
        if (!(error instanceof HistoryCutChanged) || take === 3) throw error;
        invalidated.push({name, reason: error.message, reads: bodies.reads.map(read => ({phase: read.phase, from: read.from, to: read.to, count: read.count}))});
      } finally {await cdp.evaluate('(()=>{const p=window.__historyTraffic;if(p){p.running=false;cancelAnimationFrame(p.raf);history.pushState=p.originalPush;}})()').catch(() => {}); await tab.close();}
    }
  }
  return {reports, invalidated, problems};
}
