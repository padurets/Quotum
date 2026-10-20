import {accountingPath} from './accountingTraffic';
import {PERIOD_SCOPES,type PeriodScope,type PeriodReply,type PeriodRequest} from '../server/domain/periodRead';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Evidence} from './evidence';
import {cellStart, expandHistory, type HistoryAnswer, type HistoryBasis, type HistoryReply} from '../server/domain/history';
import {openTab, type Browser, type Cdp} from './cdp';
import {HISTORY_COHORT_TAKES, historyCutInvalidation, historyIdentity, bodyTotals, readUnion, stableHistory, trafficProblems, transferFor} from './historyTrafficBudget';
import {HISTORY_ATTEMPT_HEADER, historyBody, historyProxy, type BodyCount, type Transfer} from './historyProxy';
import {observeReversal} from './reversalDiagnostic';
import {historyPoolReceiptScript} from './historyPoolReceipt';
import {ScriptBinding} from './scriptBinding';
import {clientIdentity} from './evidence';
import {deadline} from './deadline';
import {periodBodyDiagnostic} from './requests';

const DAY = 86_400_000;
type ResourceRead={scope?:PeriodScope;selection:string;from:number;to:number;cell:number;answer?:Pick<HistoryAnswer,'run'|'now'|'known'>;chunks?:[number,number][]};
type RequestDiagnostic={selection?:{mode:'live';periodMs:number}|{mode:'range';from:number;to:number};evaluatedAt?:number;sections:{scope:PeriodScope;from:number;to:number;cell:number;cells:'skip'|'read';evidence:'skip'|'cursor'|'baseline'}[];values:number;sessions:boolean;sessionsCursor?:boolean;sourceWork?:boolean;sourceWorkCursor?:boolean;calendar?:boolean;calendarCursor?:boolean};
type Read = {requestBytes?:number;errorCode?:'history_limit'|'too_large'|'other'|'unavailable';httpStatus?:number;endpoint?:'history'|'period'|'period/sessions';stage?:string;diagnostic?:RequestDiagnostic;sections?:ResourceRead[];request?:Promise<void>;selection: string; id: string; phase: string; from: number; to: number; cell: number; lower: number; before: Promise<unknown[]>; coding?: string; length?: number; attemptId?: string; transferId?: string; canceled?: boolean; count?: BodyCount; answer?: Pick<HistoryAnswer, 'run' | 'now' | 'known'>; chunks?: [number, number][]};
const lowerHeaders = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
let pageSerial = 0;

/** Time coordinates and borrowed metadata do not identify a resource selection. */
export function historyReadSelection(url: URL) {
  const params = new URLSearchParams(url.search);
  for (const field of ['from', 'to', 'cell', 'meta', 'evidence', 'cells']) params.delete(field);
  params.sort();
  return params.toString();
}

/** Private work bounds belong to quota history, so every response keeps its own seed. */
export function stableHistoryReads(reads: readonly Pick<Read, 'selection' | 'answer' | 'to'>[], seeds: ReadonlyMap<string, {answer: NonNullable<Read['answer']>}>, cell: number) {
  for (const read of reads) {
    const seed = seeds.get(read.selection); assert.ok(seed, 'the gesture must retain its seeded resource selection');
    if (read.answer) historyIdentity(read.answer, seed.answer);
  }
  for (const read of reads) {
    if (read.answer) stableHistory(read.answer, seeds.get(read.selection)!.answer, cell, read.to);
  }
}

/** Identity is attached before fetch; cancellation need not receive response headers. */
export function historyPageScript(period: string) {
  return `localStorage.setItem('quotum.locale','en');localStorage.setItem('quotum.prefs',JSON.stringify({range:${JSON.stringify(period)},horizon:'1d',filtersVisible:true}));`+historyIdentityScript();
}

/** Tag existing fetches before their observers see them, without changing page preferences. */
export function historyIdentityScript() {
  const prefix = `b${++pageSerial}`;
  return `(() => {
    const original=window.fetch.bind(window),attempts=window.__quotumHistoryAttempts={};let serial=0;
    window.fetch=(resource,init={})=>{
      const uri=resource instanceof Request?resource.url:String(resource);
      const path=new URL(uri,location.href).pathname;if(path!='/api/history'&&!/^\\/api\\/boards\\/[^/]+\\/period(?:\\/sessions)?$/.test(path))return original(resource,init);
      const id=${JSON.stringify(prefix)}+':'+(++serial),headers=new Headers(init.headers||(resource instanceof Request?resource.headers:undefined)),signal=init.signal||(resource instanceof Request?resource.signal:undefined);
      headers.set(${JSON.stringify(HISTORY_ATTEMPT_HEADER)},id);
      const started=performance.now(),attempt=attempts[id]={aborted:!!signal?.aborted};signal?.addEventListener('abort',()=>{attempt.aborted=true;attempt.abortedAt=performance.now()-started;attempt.reason=signal.reason?.name;},{once:true});
      return original(resource,{...init,headers}).then(response=>{attempt.headersAt=performance.now()-started;return response;},error=>{attempt.failedAt=performance.now()-started;attempt.error=error.name;throw error;});
    };
  })()`;
}

/** Counts encoded bodies only. Chrome's loadingFinished total includes headers. */
export class HistoryBodies {
  phase = 'seed';
  stage = 'seed';
  readonly reads: Read[] = [];
  readonly pending = new Set<Promise<unknown>>();
  readonly errors: unknown[] = [];
  private readonly active = new Map<string, Read>();
  private readonly metadata = new Map<string, HistoryBasis>();
  private readonly rawBodies=new Map<Read,Buffer>();
  private readonly bodyDiagnostics=new Map<Read,ReturnType<typeof periodBodyDiagnostic>>();
  private bodyBytes=0;
  private bodyOmitted=0;
  get activeCount() {return this.active.size;}
  get resources():Read[] {return this.reads.flatMap(read=>read.sections?read.sections.map(section=>({...read,...section})):read.cell>0?[read]:[]);}
  /** Only request shape and body counts: identities, cursors and response contents stay private. */
  diagnostic(phase:string){
    const reads=this.reads.filter(read=>read.phase===phase);
    // The phase's original traffic verdict is frozen before diagnostics consume bodies.
    for(const read of reads){const raw=this.rawBodies.get(read);if(raw){this.bodyDiagnostics.set(read,periodBodyDiagnostic(raw));this.bodyBytes-=raw.length;this.rawBodies.delete(read);}}
    return {attempts:reads.length,omitted:Math.max(0,reads.length-64),bodyOmitted:this.bodyOmitted,reads:reads.slice(0,64).map(read=>({...read.attemptId&&/^b\d+:\d+$/.test(read.attemptId)?{attemptId:read.attemptId}:{},stage:read.stage,endpoint:read.endpoint,request:read.diagnostic,requestBytes:read.requestBytes??null,errorCode:read.errorCode??null,httpStatus:read.httpStatus??null,canceled:read.canceled??false,complete:read.count?.complete??false,decoded:read.count?.decoded,encodedLower:read.count?.lower,encodedUpper:read.count?.upper,body:this.bodyDiagnostics.get(read)??null}))};
  }
  constructor(cdp: Pick<Cdp, 'on' | 'send'>) {
    cdp.on<{requestId: string; request: {url: string;postData?:string; headers?: Record<string, string>}}>('Network.requestWillBeSent', event => {
      const url = new URL(event.request.url); if (!accountingPath(url.pathname)) return;
      const read: Read = {endpoint:url.pathname==='/api/history'?'history':url.pathname.endsWith('/sessions')?'period/sessions':'period',stage:this.stage,selection: historyReadSelection(url), id: event.requestId, phase: this.phase, from: Number(url.searchParams.get('from')), to: Number(url.searchParams.get('to')), cell: Number(url.searchParams.get('cell')), lower: 0, before: Promise.all([...this.pending]), attemptId: lowerHeaders(event.request.headers ?? {})[HISTORY_ATTEMPT_HEADER]};
      this.active.set(read.id, read); this.reads.push(read);
      if(url.pathname!=='/api/history'){
        read.sections=[];
        const classify=(postData:string)=>{
          read.requestBytes=Buffer.byteLength(postData);
          const body=JSON.parse(postData) as PeriodRequest;
          const selection=body.selection;
          read.diagnostic={...(selection?{selection:selection.mode==='live'?{mode:'live',periodMs:Number(selection.periodMs)}:{mode:'range',from:Number(selection.from),to:Number(selection.to)}}:{}),evaluatedAt:Number(body.evaluatedAt),sections:PERIOD_SCOPES.flatMap(scope=>{const query=body[scope];return query?[{scope,from:Number(query.from),to:Number(query.to),cell:Number(query.cell),cells:query.cells==='skip'?'skip' as const:'read' as const,evidence:query.evidence==='skip'?'skip' as const:query.evidence?'cursor' as const:'baseline' as const}]:[];}),values:body.values?.length??0,sessions:!!body.sessions,sessionsCursor:!!body.sessions?.cursor,sourceWork:!!body.sourceWork,sourceWorkCursor:!!body.sourceWork?.cursor,calendar:!!body.calendar,calendarCursor:!!body.calendar?.cursor};
          for(const scope of PERIOD_SCOPES)if(body[scope]&&body[scope]!.cells!=='skip'){const query=new URL('/api/history',url);query.search=new URLSearchParams({board:decodeURIComponent(url.pathname.split('/')[3]),scope:scope==='funds'?'budget':scope,...body[scope]}).toString();read.sections!.push({scope,selection:historyReadSelection(query),from:Number(body[scope]!.from),to:Number(body[scope]!.to),cell:Number(body[scope]!.cell)});}
          if(read.sections![0])Object.assign(read,read.sections![0]);
        };
        if(event.request.postData!==undefined){try{classify(event.request.postData);}catch(error){this.errors.push(error);}}
        else {
          // Chrome may omit the inline POST body. Its absence says nothing
          // about the requested resources, even if the response finishes first.
          const work=cdp.send<{postData:string}>('Network.getRequestPostData',{requestId:read.id}).then(result=>classify(result.postData)).catch(error=>{this.errors.push(error);});
          read.request=work;this.pending.add(work);void work.then(()=>this.pending.delete(work));
        }
      }else read.diagnostic={sections:[{scope:url.searchParams.get('scope')==='budget'?'budget':'quota',from:read.from,to:read.to,cell:read.cell,cells:'read',evidence:'skip'}],values:0,sessions:false};
    });
    cdp.on<{requestId: string; headers: Record<string, string>}>('Network.requestWillBeSentExtraInfo', event => {
      const read = this.reads.find(r => r.id === event.requestId), id = lowerHeaders(event.headers)[HISTORY_ATTEMPT_HEADER];
      if (!read || id === undefined) return;
      read.attemptId = id;
      if (read.count) read.count.id = id;
    });
    cdp.on<{requestId: string; response: {status:number;headers: Record<string, string>}}>('Network.responseReceived', event => {
      const read = this.active.get(event.requestId); if (!read) return;
      const status=event.response.status;read.httpStatus=Number.isInteger(status)&&status>=100&&status<=599?status:undefined;
      const headers = lowerHeaders(event.response.headers);
      read.coding = headers['content-encoding']; read.length = headers['content-length'] === undefined ? undefined : Number(headers['content-length']); read.transferId = headers['x-quotum-bench-id'];
    });
    cdp.on<{requestId: string; encodedDataLength: number}>('Network.dataReceived', event => {const read = this.active.get(event.requestId); if (read) read.lower += event.encodedDataLength;});
    cdp.on<{requestId: string}>('Network.loadingFinished', event => {
      const read = this.active.get(event.requestId); if (!read) return; this.active.delete(read.id);
      const work = cdp.send<{body: string; base64Encoded: boolean}>('Network.getResponseBody', {requestId: read.id}).then(async result => {
        const decoded = result.base64Encoded ? Buffer.from(result.body, 'base64') : Buffer.from(result.body);
        // DevTools can finish fetching an earlier full body after the page has
        // already used its metadata to start this request. Count the raw body.
        await read.before;await read.request;
        // Count a complete error body without accepting it as accounting data.
        if(read.httpStatus!==200){
          try{const error=(JSON.parse(decoded.toString()) as {error?:unknown}|null)?.error;read.errorCode=error==='history_limit'||error==='too_large'?error:'other';}
          catch{read.errorCode='unavailable';}
          read.count = {complete: true, decoded: decoded.length, lower: read.length ?? NaN, upper: read.length, length: read.length, coding: read.coding, id: read.attemptId ?? read.transferId, responseId: read.transferId};
          this.errors.push(new Error(read.httpStatus===undefined?'accounting HTTP status unavailable':`accounting HTTP status ${read.httpStatus}`));
          return;
        }
        const raw=JSON.parse(decoded.toString()) as HistoryReply|PeriodReply;
        const parts=read.sections??[read];
        for(const part of parts){
          const scope='scope' in part?part.scope:undefined;
          const section=scope?(raw as PeriodReply)[scope]:undefined;
          if(scope&&section?.state!=='complete')throw new Error('accounting section did not complete');
          const reply=section?.state==='complete'?section.value:raw as HistoryReply;
          const answer=expandHistory(reply,this.metadata.get(reply.meta??''));
          if(answer.meta)this.metadata.set(answer.meta,{run:answer.run,now:answer.now,historyStart:answer.historyStart,known:answer.known,meta:answer.meta});
          part.answer={run:answer.run,now:answer.now,known:answer.known};part.chunks=answer.chunks.map(chunk=>[chunk.from,chunk.to]);
        }
        if(read.sections?.[0])Object.assign(read,read.sections[0]);
        read.count = {complete: true, decoded: decoded.length, lower: read.length ?? NaN, upper: read.length, length: read.length, coding: read.coding, id: read.attemptId ?? read.transferId, responseId: read.transferId};
        if(read.phase.endsWith('/cold')&&read.endpoint==='period'&&read.sections?.length===0){
          if(decoded.length<=1024*1024&&this.rawBodies.size<8&&this.bodyBytes+decoded.length<=8*1024*1024){this.rawBodies.set(read,decoded);this.bodyBytes+=decoded.length;}
          else this.bodyOmitted++;
        }
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

export function trafficReadEvidence(reads: readonly Read[]) {
  const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return reads.map(read=>({id:read.id,phase:read.phase,from:read.from,to:read.to,cell:read.cell,
    httpStatus:read.httpStatus??null,lower:read.lower,coding:read.coding,length:read.length,attemptId:read.attemptId,transferId:read.transferId,
    canceled:read.canceled,count:read.count,selectionHash:hash(read.selection),chunks:read.chunks,
    run:read.answer?.run,now:read.answer?.now,knownHash:read.answer?.known===undefined?undefined:hash(read.answer.known)}));
}

/** A complete drawing can precede a queued cell read backed by its period evidence. */
export function hasSeededHistory(reads:readonly Read[],phase:string){
  return PERIOD_SCOPES.every(scope=>reads.some(read=>read.phase===phase&&read.count?.complete&&read.sections?.some(section=>section.scope===scope)));
}

/** CDP's speed is an integer; keep the named cold gesture near 750 ms. */
export function historyScroll(geometry: {x: number; y: number; width: number}, fraction: number, distance: number) {
  if (![geometry.x, geometry.y, geometry.width, fraction, distance].every(Number.isFinite) || geometry.width <= 0 || fraction <= 0) throw new Error('invalid history gesture geometry');
  return {x: geometry.x, y: geometry.y, xDistance: distance, yDistance: 0, speed: Math.max(1, Math.round(geometry.width * fraction / .75)), gestureSourceType: 'mouse', preventFling: true};
}

/** A hovered legend bubble can cover a ready plot without belonging to its input handler. */
export async function prepareHistoryTarget(cdp: Pick<Cdp, 'send' | 'evaluate'>, selector: string, point: {x: number; y: number}) {
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0});
  const reachable = await cdp.evaluate<boolean>(`(() => {
    const chart=document.querySelector(${JSON.stringify(selector)}),{x,y}=${JSON.stringify(point)};
    return !!chart&&chart.contains(document.elementFromPoint(x,y))&&chart.contains(document.elementFromPoint(Math.trunc(x),Math.trunc(y)));
  })()`);
  assert.ok(reachable, 'native history gesture target is covered');
}

type TrafficProxy = {url: string; transfers: Transfer[]; phase(value: string, latency?: number): void; settled(value: string): Promise<void>};

async function historyPage(browser: Browser, proxy: TrafficProxy, cookie: string, name: string, length: number, future: number, poolEvidence?:Pick<Evidence, 'save'>,evidence?:Pick<Evidence,'save'>) {
  const tab = await openTab(browser), cdp = tab.cdp, bodies = new HistoryBodies(cdp);
  const poolName=name.replace(/[^a-zA-Z0-9_-]/g,'-');
  const poolBinding=poolEvidence?new ScriptBinding(cdp,clientIdentity(),(file,value)=>poolEvidence.save('pool-'+poolName+'-'+file,value)):null;
  let poolCaptured=false;
  cdp.at(`${name}/seed`);
  const capturePool = async () => {
    if(!poolEvidence||poolCaptured)return;
    poolCaptured=true;
    try{
      // A failed or pending original command must release its target without another renderer wait.
      const command=cdp.snapshot(),available=command.socketState===1&&!command.terminal&&!command.failure&&!command.pending.length;
      poolEvidence.save('pool-original-'+poolName,{name,status:'partial',reads:trafficReadEvidence(bodies.reads),command});
      let receipt:unknown={status:'insufficient-evidence',reason:'original renderer unavailable'};
      if(available){
        try{receipt=await deadline(2000,signal=>cdp.evaluate('window.__quotumHistoryPoolReceipt?.read()??({status:"unavailable"})',signal));}
        catch{receipt={status:'insufficient-evidence',reason:'pool receipt unavailable'};}
      }
      poolEvidence.save('pool-receipt-'+poolName,{name,mode:'diagnostic',receipt});
      if(available){
        try{await poolBinding!.afterFamily([1]);}
        catch{poolEvidence.save('pool-binding-'+poolName,{status:'insufficient-evidence',reason:'source binding cleanup unconfirmed'});}
      }
    }finally{poolBinding?.close();}
  };
  // Closing this owned target discards its observers and overrides. A stalled
  // renderer cannot acknowledge a cleanup evaluation before its target closes.
  const close = async () => {cdp.at(`${name}/cleanup`); await tab.close();};
  try {
    const seedPhase = `${name}/seed`; bodies.phase = seedPhase; proxy.phase(seedPhase);
    await cdp.send('Network.enable'); await cdp.send('Page.enable'); await cdp.send('Performance.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
    const split = cookie.indexOf('='); await cdp.send('Network.setCookie', {name: cookie.slice(0, split), value: cookie.slice(split + 1), url: proxy.url, httpOnly: true, sameSite: 'Lax'});
    if(poolEvidence)await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:historyPoolReceiptScript()});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source: historyPageScript(length === DAY ? '24h' : '30d')});
    await cdp.send('Page.navigate', {url: proxy.url});
    const settled = async (seed = false) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        if (bodies.errors.length) throw bodies.errors[0];
        if ((!seed||hasSeededHistory(bodies.reads,seedPhase))&&!bodies.activeCount && !bodies.pending.size && await cdp.evaluate<boolean>(poolEvidence?`(()=>{window.__quotumHistoryPoolReceipt?.mark(${seed?0:bodies.phase.endsWith('/warm')?2:1},${bodies.stage==='cold scroll'?1:bodies.stage==='cached return'?2:bodies.stage==='cached repeat'?3:0});return ['[data-widget="quota-history"]','[data-widget="quota-session-history"]','.activity','.budget-history','.subscription-funds'].every(panel=>document.querySelector(panel+' .chart>svg'))&&!!document.querySelector('[data-widget="quota-history"] .series[d]:not([d=""])')&&!document.querySelector('.history.is-loading,.activity.is-loading,.budget-history.is-loading,.subscription-funds.is-loading,.chart>svg[data-pan-end],.chart>svg[data-draw-ready="false"],.chart>svg.is-panning');})()`:`['[data-widget="quota-history"]','[data-widget="quota-session-history"]','.activity','.budget-history','.subscription-funds'].every(panel=>document.querySelector(panel+' .chart>svg'))&&!!document.querySelector('[data-widget="quota-history"] .series[d]:not([d=""])')&&!document.querySelector('.history.is-loading,.activity.is-loading,.budget-history.is-loading,.subscription-funds.is-loading,.chart>svg[data-pan-end],.chart>svg[data-draw-ready="false"],.chart>svg.is-panning')`)) {
          await cdp.evaluate('new Promise(resolve=>setTimeout(resolve,250))');
          if (!bodies.activeCount && !bodies.pending.size) return;
        }
        if (Date.now() > deadline) throw new Error(`${name}: full drawings or terminal HTTP did not settle: ${JSON.stringify({reads:bodies.reads.map(read=>({id:read.attemptId,phase:read.phase,resources:read.sections?.map(section=>section.scope),complete:read.count?.complete,canceled:read.canceled})),attempts:await cdp.evaluate('window.__quotumHistoryAttempts'),transfers:proxy.transfers.filter(t=>t.phase===seedPhase)})}`);
        await cdp.evaluate('new Promise(resolve=>setTimeout(resolve,20))');
      }
    };
    await settled(true);
    await cdp.evaluate(`(() => {const style=document.createElement('style');style.textContent='.widgets{display:flex!important;flex-direction:column!important}.widget{height:auto!important;--fill:0px!important}.widget:not(:has(.history,.activity)){display:none!important}.widget-body{height:auto!important}.widget-body>.panel{--fill:0px!important}.history .chart>svg{height:260px!important}.activity .chart>svg{height:180px!important}.legend{max-height:40px;overflow:auto}';document.head.append(style);document.querySelector('.analytics-head').scrollIntoView();})()`);
    await settled();
    const geometry = await cdp.evaluate<{x: number; y: number; width: number; series: number}>(`(() => {const svg=document.querySelector(${JSON.stringify(future ? '[data-widget="quota-history"] .chart>svg' : '.activity .chart>svg')});svg.scrollIntoView({block:'center'});const r=svg.getBoundingClientRect(),left=${future ? 40 : 48};return {x:r.left+r.width*.5,y:r.top+80,width:r.width*(svg.viewBox.baseVal.width-left-12)/svg.viewBox.baseVal.width,series:document.querySelectorAll('[data-widget="quota-history"] .series[d]:not([d=""])').length};})()`);
    assert.ok(geometry.series >= 12, `${name}: fewer than twelve actual series`);
    await prepareHistoryTarget(cdp, future ? '[data-widget="quota-history"] .chart' : '.activity .chart', geometry);
    const seedReads = bodies.resources.filter(read => read.phase === seedPhase && read.count?.complete);
    assert.ok(seedReads.length,`${name}: no complete seed resources: ${JSON.stringify(bodies.reads.map(read=>({phase:read.phase,resources:read.sections?.length,cell:read.cell,complete:read.count?.complete,canceled:read.canceled})))}`); const cell = seedReads[0].cell;
    const seeds = new Map<string, {answer: NonNullable<Read['answer']>; initial: Set<number>; closedBefore: number}>();
    for (const read of seedReads) {
      let group = seeds.get(read.selection);
      if (!group) seeds.set(read.selection, group = {answer: read.answer!, initial: new Set(), closedBefore: read.answer!.now});
      group.answer = read.answer!;
      group.closedBefore = Math.min(group.closedBefore, read.answer!.now);
      for (const [from, to] of read.chunks!) for (let at = from; at < to; at += cell) group.initial.add(at);
    }
    await cdp.evaluate(`(() => {
      const root=document.querySelector('[data-widget="quota-history"] .chart>svg'),originalPush=history.pushState;
      const p=window.__historyTraffic={tokens:[],poses:[],pushes:0,running:true,originalPush};
      history.pushState=function(...args){p.pushes++;return originalPush.apply(this,args);};
      const frame=()=>{if(!p.running)return;if(root.dataset.panEnd){const token=root.dataset.panToken;if(p.tokens.at(-1)!==token)p.tokens.push(token);const end=Number(root.dataset.panEnd),origin=Number(root.dataset.panOrigin);if(p.poses.at(-1)?.end!==end)p.poses.push({end,origin});}p.raf=requestAnimationFrame(frame);};p.raf=requestAnimationFrame(frame);
    })()`);
    return {cdp, bodies, settled, geometry, cell, seeds, close,capturePool};
  } catch (error) {
    try{evidence?.save('traffic-seed-failure-'+poolName,{name,stage:bodies.stage,...bodies.diagnostic(`${name}/seed`)});}
    catch{browser.owner?.failures.push('history seed evidence failed');}
    try{poolBinding?.close();}catch{browser.owner?.failures.push('history source binding cleanup failed');}
    try{await close();}catch{/* The target owner retains cleanup separately from the seed failure. */}
    throw error;
  }
}

/** Separate tabs use the fixed-codec proxy; this never changes the native perf route. */
export async function browserHistoryTraffic(browser: Browser, proxy: TrafficProxy, cookie: string, board: string, evidence?: Pick<Evidence, 'save'>) {
  const reports = [], invalidated = [], problems: string[] = [];
  for (const length of [DAY, 30 * DAY]) for (const future of [DAY, 0]) for (const latency of [0, 100, 400]) for (const fraction of [.5, .04]) {
    for (let take = 1; take <= HISTORY_COHORT_TAKES; take++) {
      const name = `browser/${length / DAY}d/${future ? 'history' : 'activity'}/${latency}ms/${fraction}/take${take}`;
      evidence?.save('traffic-stage', {name, stage: 'seed'});
      const poolTarget=length===DAY&&!future&&[100,400].includes(latency)&&fraction===.5&&take===1;
      const poolEvidence=process.env.QUOTUM_BENCH_DIAGNOSE_HISTORY_POOL==='1'&&poolTarget?evidence:undefined;
      const {cdp, bodies, settled, geometry, cell, seeds, close,capturePool} = await historyPage(browser, proxy, cookie, name, length, future,poolEvidence,evidence);
      let observer:Awaited<ReturnType<typeof observeReversal>>|null=null, status='failed';
      try {
        observer=await observeReversal(cdp,browser,{postmortem:true,closeTarget:close});
        const phase = `${name}/cold`; bodies.phase = phase; proxy.phase(phase, latency);
        const scroll = (distance: number,stage:string) => {
          bodies.stage=stage;
          cdp.at(`${bodies.phase}/${stage}`);
          return observer!.watch(`${bodies.phase}/${stage}`,()=>cdp.send('Input.synthesizeScrollGesture', historyScroll(geometry, fraction, distance)));
        };
        await scroll(geometry.width * fraction,'cold scroll'); await settled();
        const pose = await cdp.evaluate<{tokens: string[]; poses: {end: number; origin: number}[]; pushes: number; from: number; to: number}>('({tokens:__historyTraffic.tokens,poses:__historyTraffic.poses,pushes:__historyTraffic.pushes,from:Number(new URLSearchParams(location.search).get("from")),to:Number(new URLSearchParams(location.search).get("to"))})');
        assert.equal(pose.tokens.length, 1); assert.equal(pose.pushes, 1); assert.ok(pose.poses.length > 1 && pose.from > 0);
        assert.ok(Math.abs(pose.to - pose.poses[0].origin + (length + future) * fraction) <= 3 * (length + future) / geometry.width, 'native gesture did not move by its named fraction');
        const physical=bodies.reads.filter(read=>read.phase===phase),cold = bodies.resources.filter(read => read.phase === phase);
        await proxy.settled(phase);
        assert.ok(physical.every(read=>read.count),'every attempt needs a terminal body count');
        const physicalTotals=bodyTotals(physical.map(read=>({count:read.count!,transfer:transferFor(read.count!,proxy.transfers)})));
        const maxAttempts = fraction === .04 ? 2 : future ? 7 : 5;
        // Check every resource before a changed cutoff can discard this cohort.
        const groups = [...new Set(cold.map(read => read.selection))].map(selection => {
          const group = seeds.get(selection); assert.ok(group, 'the gesture must retain its seeded resource selection: '+JSON.stringify({selection,seeds:[...seeds.keys()]}));
          assert.equal(new URLSearchParams(selection).get('board'), board);
          const scope = new URLSearchParams(selection).get('scope'), reads = cold.filter(read => read.selection === selection);
          const requested = new Set<number>(), visited = new Set<number>(), ahead = scope === 'budget' ? 0 : DAY;
          for (const {end, origin} of pose.poses) for (let at = cellStart(end - length, cell); at < Math.ceil(Math.min(origin, end + ahead) / cell) * cell; at += cell) visited.add(at);
          // Release can commit its final coalesced input before the observer's RAF.
          for (let at = cellStart(pose.from, cell); at < Math.ceil(Math.min(pose.poses[0].origin, pose.to + ahead) / cell) * cell; at += cell) visited.add(at);
          assert.ok(reads.every(read=>read.count),'every attempt needs a terminal body count');
          const totals = bodyTotals(reads.map(read => ({count: read.count!, transfer: transferFor(read.count!, proxy.transfers)})));
          for (const read of reads) {
            for (let at = read.from; at < read.to; at += cell) requested.add(at);
          }
          const optional = [...requested].filter(at => !visited.has(at)); assert.ok(optional.length <= Math.min(60, Math.ceil(length / cell / 4)), 'browser traffic has an unbounded optional footprint');
          assert.ok(reads.length <= maxAttempts, 'browser history exceeded its request cap');
          return {selection, group, scope, reads, requested, optional, totals};
        });
        // Closed seed cells cannot become missing merely because the live cut moved.
        for (const {group, requested} of groups) for (const at of requested) {
          assert.ok(at + cell > group.closedBefore || !group.initial.has(at), 'browser reread closed fresh seed data in the same selection');
        }
        stableHistoryReads(cold, seeds, cell);
        const families = [];
        for (const {selection, group, scope, reads, requested, optional, totals} of groups) {
          for (const at of requested) assert.ok(!group.initial.has(at), 'browser reread fresh seed data in the same selection');
          proxy.phase(`${name}/reference/${scope}`); let referenceDecoded = 0, referenceEncoded = 0;
          for (const [from, to] of readUnion(requested, cell)) {
            const answer = await historyBody(`${proxy.url}/api/history?${selection}&cell=${cell}&from=${from}&to=${to}`, cookie, undefined, body => {assert.ok(body.complete); referenceDecoded += body.decoded!; referenceEncoded += body.lower;}) as HistoryAnswer;
            stableHistory(answer, group.answer, cell, to);
          }
          families.push({name: `${name}/${scope}`, attempts: reads.length, maxAttempts, ...totals, referenceDecoded, referenceEncoded, ratios: fraction === .5, optionalUnvisitedCells: optional.length});
        }
        const aggregate={name:name+'/all-accounting',attempts:physical.length,...physicalTotals,referenceDecoded:families.reduce((n,f)=>n+f.referenceDecoded,0),referenceEncoded:families.reduce((n,f)=>n+f.referenceEncoded,0),ratios:fraction===.5};
        problems.push(...trafficProblems(aggregate));reports.push(aggregate);
        console.error(`bench: ${aggregate.name}: ${JSON.stringify(aggregate)}`);
        const warmPhase = `${name}/warm`; bodies.phase = warmPhase; proxy.phase(warmPhase);
        // A selected chart has no future, so its return uses the captured time delta.
        await scroll(-(pose.poses[0].origin - pose.to) / length * geometry.width,'cached return'); await settled();
        assert.equal(await cdp.evaluate<boolean>('new URLSearchParams(location.search).has("from")'), false, 'cached return did not reach live');
        await scroll(geometry.width * fraction,'cached repeat'); await settled();
        const warm = bodies.reads.filter(read => read.phase === warmPhase);
        if(warm.length)console.error('bench: warm history diagnostic '+JSON.stringify({name,...bodies.diagnostic(warmPhase)}));
        assert.equal(warm.length, 0, 'browser cached return/repeat started history');
        const metrics = await cdp.send<{metrics: {name: string; value: number}[]}>('Performance.getMetrics');
        for (const family of families) {
          const report = {...family, ratios:false, warmAttempts: warm.length, series: geometry.series, movement: {tokens: pose.tokens.length, samples: pose.poses.length, pushes: pose.pushes, from: pose.from, to: pose.to}, heapBytes: metrics.metrics.find(m => m.name === 'JSHeapUsedSize')?.value};
          reports.push(report); problems.push(...trafficProblems({...report,ratios:false}));
          console.error(`bench: ${report.name}: ${report.attempts} requests, ${warm.length} warm requests, decoded ratio ${report.decoded === null ? 'unknown' : report.decoded / report.referenceDecoded}, encoded ratio ${report.encodedUpper === null ? 'unknown' : report.encodedUpper / report.referenceEncoded}`);
        }
        status=reports.filter(report=>report.name.startsWith(name+'/')).some(report=>trafficProblems(report).length)?'over-budget':'passed';
        break;
      } catch (error) {
        const cut=historyCutInvalidation(error,name,take);
        status='invalidated';
        invalidated.push({...cut,reads:bodies.reads.map(read=>({phase:read.phase,from:read.from,to:read.to,count:read.count}))});
      } finally {
        evidence?.save('traffic-'+name.replace(/[^a-zA-Z0-9_-]/g,'-'), {name,status,geometry,cell,
          reads:trafficReadEvidence(bodies.reads),cold:bodies.diagnostic(`${name}/cold`),reports:reports.filter(report=>report.name.startsWith(name+'/')),
          transfers:proxy.transfers.filter(transfer=>transfer.phase.startsWith(name+'/')),command:cdp.snapshot()});
        const cleanupErrors:unknown[]=[];
        try{await capturePool();}catch(error){cleanupErrors.push(error);browser.owner?.failures.push('history pool cleanup failed');}
        try{await observer?.close();}catch(error){cleanupErrors.push(error);browser.owner?.failures.push('history observer cleanup failed');}
        try{await close();}catch(error){cleanupErrors.push(error);}
        if(status!=='failed'&&cleanupErrors.length)throw cleanupErrors[0];
      }
    }
  }
  return {reports, invalidated, problems};
}

/** Native cancellation/reversal keeps one Shift-wheel token while responses are owned. */
export async function browserCancellationTraffic(browser: Browser, proxy: TrafficProxy, cookie: string,diagnostic=false,profileBeforeInput=false,evidence?:Pick<Evidence,'save'>) {
  const reports = [], invalidated = [];
  for (const length of [DAY, 30 * DAY]) for (const mode of ['before-headers', 'after-delivery', 'reversal'] as const) {
    if(diagnostic&&(length!==DAY||mode!=='reversal'))continue;
    for (let take = 1; take <= HISTORY_COHORT_TAKES; take++) {
      const name = `browser/${length / DAY}d/${mode}/take${take}`;
      evidence?.save('traffic-stage', {name,stage:'seed'});
      console.error(`bench: ${name}: opening seed page`);
      const {cdp, bodies, settled, geometry, cell, seeds, close} = await historyPage(browser, proxy, cookie, name, length, DAY,undefined,evidence);
      let observer:Awaited<ReturnType<typeof observeReversal>>|null=null,status='failed';
      console.error(`bench: ${name}: seed page ready`);
      const phase = `${name}/gesture`, reads = () => bodies.reads.filter(r => r.phase === phase);
      let stage = 'start';
      const step = async <T>(value: string, run: () => Promise<T>) => {
        stage = value; cdp.at(`${name}/${stage}`);
        console.error(`bench: ${name}: ${stage}`);
        return observer ? observer.watch(value, run) : run();
      };
      const until = async (predicate: () => boolean | Promise<boolean>) => {const end = Date.now() + 10_000; while (!await predicate()) {if (bodies.errors.length) throw bodies.errors[0]; if (Date.now() > end) throw new Error(`${name}: lifecycle boundary not reached`); await cdp.evaluate('new Promise(resolve=>setTimeout(resolve,10))');}};
      const key = (type: string, name: string, code: number, modifiers: number) => cdp.send('Input.dispatchKeyEvent', {type, key: name, code: name === 'Shift' ? 'ShiftLeft' : name, windowsVirtualKeyCode: code, modifiers});
      const wheel = (pixels: number) => cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: geometry.x, y: geometry.y, deltaX: pixels, deltaY: 0, modifiers: 8});
      try {
        // The canonical failing page is observed without changing V8 before input.
        observer=await observeReversal(cdp,browser,{mode:diagnostic?'diagnostic':'canonical',profileBeforeInput,postmortem:true,closeTarget:close});
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
        const state = await step('read final state', () => cdp.evaluate<{tokens: string[]; poses: {end: number; origin: number}[]; pushes: number; selected: boolean; attempts: Record<string, {aborted: boolean}>}>('({tokens:__historyTraffic.tokens,poses:__historyTraffic.poses,pushes:__historyTraffic.pushes,selected:new URLSearchParams(location.search).has("from"),attempts:__quotumHistoryAttempts})'));
        assert.equal(state.tokens.length, 1); assert.ok(state.poses.some(p => p.end < p.origin));
        assert.equal(state.pushes, mode === 'reversal' ? 1 : 0); assert.equal(state.selected, mode === 'reversal');
        const aborted = attempts.filter(r => r.canceled || state.attempts[r.count!.id!]?.aborted).length;
        assert.ok(mode === 'after-delivery' || aborted > 0, 'cancel-before-delivery must exercise abort');
        // A changed reference must not hide a failed native gesture or cancellation.
        stableHistoryReads(bodies.resources.filter(r=>r.phase===phase), seeds, cell);
        const report = {name, attempted: attempts.length, completed: attempts.filter(r => r.count?.complete).length, failed: attempts.filter(r => !r.count?.complete && !r.canceled && !state.attempts[r.count!.id!]?.aborted).length, aborted, transportAbortedDelivered: attempts.filter(r => r.count?.complete && state.attempts[r.count!.id!]?.aborted).length, stagingDisposition: 'not-observed', ...totals, finalComplete: true, movement: {tokens: state.tokens.length, poses: state.poses.length, pushes: state.pushes}, requests: attempts.map(r => ({from: r.from, to: r.to, id: r.count!.id, canceled: r.canceled}))};
        reports.push(report); console.error(`bench: ${name}: ${report.attempted} attempts, ${aborted} aborted, ${totals.byteVerdict} body proof`);
        status='passed';break;
      } catch (error) {
        console.error(`bench: ${name}: failed at ${stage}; HTTP ${JSON.stringify({active: bodies.activeCount, pending: bodies.pending.size, reads: reads().map(r => ({from: r.from, to: r.to, canceled: r.canceled, complete: r.count?.complete}))})}`);
        cdp.at(`${name}/failure state`);
        const state = cdp.snapshot();
        console.error(`bench: ${name}: failure state ${JSON.stringify(state)}`);
        const cut=historyCutInvalidation(error,name,take);status='invalidated';
        invalidated.push({...cut,reads:reads().map(r=>({from:r.from,to:r.to,count:r.count}))});
      } finally {
        evidence?.save('traffic-'+name.replace(/[^a-zA-Z0-9_-]/g,'-'), {name,stage,status,reads:trafficReadEvidence(bodies.reads),
          reports:reports.filter(report=>report.name===name),transfers:proxy.transfers.filter(transfer=>transfer.phase.startsWith(name+'/')),command:cdp.snapshot()});
        const cleanupErrors:unknown[]=[];
        try{await observer?.close();}catch(error){cleanupErrors.push(error);browser.owner?.failures.push('history observer cleanup failed');}
        cdp.at(`${name}/release shift`);
        try{await key('keyUp', 'Shift', 16, 0);}catch(error){cleanupErrors.push(error);browser.owner?.failures.push('history input cleanup failed');}
        try{await close();console.error(`bench: ${name}: page closed`);}catch(error){cleanupErrors.push(error);}
        if(status!=='failed'&&cleanupErrors.length)throw cleanupErrors[0];
      }
    }
  }
  return {reports,invalidated};
}

/** An instrumented replay diagnoses an earlier failure and never replaces its verdict. */
export async function diagnoseReversal(browser:Browser,upstream:string,cookie:string,repeats=1){
  const proxy=await historyProxy(upstream, browser.owner);
  try{for(let take=0;take<repeats;take++){const profileBeforeInput=take%2===0;console.error(`reversal diagnostic replay ${take+1}/${repeats}, profiler ${profileBeforeInput?'before input':'after stall'}`);await browserCancellationTraffic(browser,proxy,cookie,true,profileBeforeInput);}}
  finally{await proxy.close();}
}
