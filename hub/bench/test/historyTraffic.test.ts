import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {brotliCompressSync, constants} from 'node:zlib';
import {HISTORY_ATTEMPT_HEADER, historyBody, historyProxy, type BodyCount, type Transfer} from '../historyProxy';
import {HistoryCutChanged, bodyBounds, bodyTotals, stableHistory, trafficProblems, transferFor} from '../historyTrafficBudget';

const transfer: Transfer = {id: '1', phase: 'cold', cell: 1, from: 0, to: 60, started: 0, sent: true, finished: true, aborted: false, decoded: 100, encoded: 40};
test('body budgets require actual matching coding and payload lengths, never transport totals', () => {
  const body = {id: '1', complete: true, decoded: 100, lower: 40, upper: 40, length: 40, coding: 'br'};
  assert.equal(bodyBounds(body, transfer).upper, 40);
  for (const bad of [{...body, coding: 'identity'}, {...body, lower: 200}, {...body, decoded: 99}, {...body, length: 39}, {...body, id: 'different'}, {...body, responseId: 'different'}]) assert.throws(() => bodyBounds(bad, transfer));
  assert.throws(() => bodyBounds(body));
  assert.deepEqual(bodyBounds({complete: false, lower: 12}, transfer), {lower: 12, upper: 40, unknown: 1, partial: 1});
  assert.equal(bodyBounds({complete: false, lower: 0}).upper, null);
  assert.deepEqual(bodyBounds({complete: false, lower: 0}, {...transfer, sent: false, finished: false, aborted: true}), {lower: 0, upper: 0, unknown: 0, partial: 1});
  const reading = {name: 'cold', attempts: 5, maxAttempts: 7, decoded: 100, encodedUpper: 40, referenceDecoded: 100, referenceEncoded: 40, ratios: true};
  assert.deepEqual(trafficProblems(reading), []);
  for (const bad of [{...reading, attempts: 8}, {...reading, decoded: 151}, {...reading, encodedUpper: 81}, {...reading, encodedUpper: null}]) assert.ok(trafficProblems(bad).length);
});

test('the owned proxy measures a real fixed-codec HTTP body without changing JSON', async () => {
  const answer = {run: 'r', known: {work: 123, sources: {s: 456}}, chunks: [{from: 0, to: 60, series: []}]};
  const upstream = createServer((_req, res) => res.setHeader('Content-Type', 'application/json').end(JSON.stringify(answer)));
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await historyProxy(`http://127.0.0.1:${(upstream.address() as {port: number}).port}`);
  try {
    let counted;
    assert.deepEqual(await historyBody(`${proxy.url}/api/history?cell=1&from=0&to=60`, '', undefined, count => {counted = count;}), answer);
    assert.equal(proxy.transfers.length, 1);
    assert.equal(bodyBounds(counted!, proxy.transfers[0]).upper, proxy.transfers[0].encoded);
    assert.equal(proxy.transfers[0].decoded, Buffer.byteLength(JSON.stringify(answer)));
    assert.equal(proxy.transfers[0].finished, true);
  } finally {await proxy.close(); await new Promise<void>(resolve => upstream.close(() => resolve()));}
});

import {HistoryBodies, hasSeededHistory, historyReadSelection, historyScroll, stableHistoryReads} from '../historyTrafficBrowser';
import {readUnion} from '../historyTrafficBudget';

test('traffic references preserve each resource selection instead of merging equal time cells', () => {
  const uri = new URL('http://localhost/api/history?board=b&scope=budget&unit=USD&meters=%5B%5B%22wallet%22%2C%22balance%22%5D%5D&cell=1&from=0&to=60&meta=old');
  const selection = historyReadSelection(uri);
  uri.searchParams.set('from', '60'); uri.searchParams.set('to', '120'); uri.searchParams.set('meta', 'new');
  assert.equal(historyReadSelection(uri), selection, 'new cells borrow the same selection reference');
  const reference = new URL('http://localhost/api/history?' + selection);
  assert.equal(reference.searchParams.get('scope'), 'budget');
  assert.equal(reference.searchParams.get('meters'), '[["wallet","balance"]]');
  for (const [key, value] of [['scope', 'quota'], ['unit', 'CNY'], ['meters', '[]'], ['currency', 'EUR'], ['board', 'another']]) {
    const other = new URL(uri); other.searchParams.set(key, value);
    assert.notEqual(historyReadSelection(other), selection, `${key} is part of the reference identity`);
  }
});

test('cancelled resource cohorts keep private quota bounds separate from financial metadata', () => {
  const quota = {run: 'r', now: 0, known: {work: 0, own: 100, sources: {s: 0}}};
  const money = {run: 'r', now: 0, known: {work: 0, sources: {s: 0}}};
  const seeds = new Map([['quota', {answer: quota}], ['budget', {answer: money}], ['funds', {answer: money}]]);
  const reads = [{selection: 'quota', answer: quota}, {selection: 'budget', answer: money}, {selection: 'funds', answer: money}, {selection: 'quota'}];
  stableHistoryReads(reads, seeds, 60_000);
  assert.throws(() => stableHistoryReads([{selection: 'quota', answer: money}], seeds, 60_000));
  assert.throws(() => stableHistoryReads([{selection: 'budget', answer: {...money, known: {...money.known, work: 1}}}], seeds, 60_000));
  assert.throws(() => stableHistoryReads([{selection: 'other', answer: money}], seeds, 60_000));
});

test('the browser observer expands late metadata while counting only each actual response body', async () => {
  const listeners = new Map<string, (event: never) => void>();
  const full = {run: 'r', now: 1, historyStart: 0, meta: 'tag', known: {work: 0, sources: {s: 0}}, chunks: [{from: 0, to: 60}]};
  const compact = {run: 'r', now: 2, meta: 'tag', chunks: [{from: 60, to: 120}]};
  let finishFirst!: (value: {body: string; base64Encoded: boolean}) => void;
  const cdp = {on: <T>(name: string, fn: (event: T) => void) => listeners.set(name, fn as (event: never) => void),
    send: <T>(_method: string, params: object) => ((params as {requestId: string}).requestId === 'first' ? new Promise<{body: string; base64Encoded: boolean}>(resolve => {finishFirst = resolve;}) : Promise.resolve({body: JSON.stringify(compact), base64Encoded: false})) as Promise<T>};
  const observer = new HistoryBodies(cdp);
  const emit = (name: string, event: object) => listeners.get(name)?.(event as never);
  const start = (id: string) => emit('Network.requestWillBeSent', {requestId: id, request: {url: 'http://localhost/api/history?cell=1&from=0&to=60'}});
  start('first'); emit('Network.loadingFinished', {requestId: 'first'});
  start('second'); emit('Network.loadingFinished', {requestId: 'second'});
  finishFirst({body: JSON.stringify(full), base64Encoded: false});
  await Promise.all([...observer.pending]);
  assert.deepEqual(observer.errors, []);
  assert.deepEqual(observer.reads[1].answer, {run: 'r', now: 2, known: full.known});
  assert.equal(observer.reads[1].count?.decoded, Buffer.byteLength(JSON.stringify(compact)));
  assert.ok(observer.reads[1].count!.decoded! < Buffer.byteLength(JSON.stringify({...compact, known: full.known, historyStart: 0})));
});

test('the reference union respects fresh holes and the eight-tile API limit', () => {
  assert.deepEqual(readUnion(new Set([0, 1, 3, 4]), 1), [[0, 2], [3, 5]]);
  assert.deepEqual(readUnion(new Set(Array.from({length: 481}, (_, i) => i)), 1), [[0, 480], [480, 481]]);
});

function cdpFixture() {
  const listeners = new Map<string, (event: never) => void>();
  const answer = {run: 'r', now: 1, known: {work: 0, sources: {}}, chunks: [{from: 0, to: 60}]};
  const cdp = {on: <T>(name: string, listener: (event: T) => void) => listeners.set(name, listener as (event: never) => void), send: async <T>() => ({body: JSON.stringify(answer), base64Encoded: false} as T)};
  const observer = new HistoryBodies(cdp);
  const emit = (name: string, event: object) => listeners.get(name)?.(event as never);
  const start = (id: string) => {emit('Network.requestWillBeSent', {requestId: id, request: {url: 'http://localhost/api/history?cell=1&from=0&to=60'}}); emit('Network.responseReceived', {requestId: id, response: {headers: {'Content-Encoding': 'br', 'Content-Length': '40', 'X-Quotum-Bench-Id': id}}});};
  return {observer, emit, start, answer};
}

test('the Chrome observer excludes headers and preserves aborted-body uncertainty', async () => {
  const f = cdpFixture(); f.start('1');
  f.emit('Network.dataReceived', {requestId: '1', encodedDataLength: 40});
  f.emit('Network.loadingFinished', {requestId: '1', encodedDataLength: 1000});
  await Promise.all([...f.observer.pending]);
  const complete = f.observer.reads[0];
  assert.equal(complete.count?.lower, 40, 'the 1000-byte transport total is not a body');
  assert.equal(bodyBounds(complete.count!, {...transfer, decoded: Buffer.byteLength(JSON.stringify(f.answer))}).upper, 40);
  f.start('2'); f.emit('Network.dataReceived', {requestId: '2', encodedDataLength: 12}); f.emit('Network.loadingFailed', {requestId: '2', canceled: true});
  assert.deepEqual(bodyBounds(f.observer.reads[1].count!, {...transfer, id: '2'}), {lower: 12, upper: 40, unknown: 1, partial: 1});
  f.emit('Network.requestWillBeSent', {requestId: '3', request: {url: 'http://localhost/api/history?cell=1&from=0&to=60'}});
  f.emit('Network.loadingFailed', {requestId: '3', canceled: true});
  assert.equal(bodyBounds(f.observer.reads[2].count!).upper, null, 'missing fixture evidence must stay unknown');
  assert.equal(f.observer.activeCount, 0);
});

test('abort before proxy delivery is proved zero body while the attempted request remains counted', async () => {
  const upstream = createServer((_req, res) => res.end(JSON.stringify({run: 'r', chunks: []})));
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await historyProxy(`http://127.0.0.1:${(upstream.address() as {port: number}).port}`);
  try {
    proxy.phase('cancel', 1000); const controller = new AbortController(); let counted;
    const read = historyBody(`${proxy.url}/api/history?cell=1&from=0&to=60`, '', controller.signal, count => {counted = count;});
    const failed = assert.rejects(read);
    for (let n = 0; n < 100 && !proxy.transfers[0]?.encoded; n++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(proxy.transfers[0]?.encoded); controller.abort(); await failed; await proxy.settled('cancel');
    assert.equal(proxy.transfers.length, 1); assert.equal(bodyBounds(counted!, proxy.transfers[0]).upper, 0);
  } finally {await proxy.close(); await new Promise<void>(resolve => upstream.close(() => resolve()));}
});

test('complete payloads and partial bounds remain separate in a bounded verdict', () => {
  const counts = bodyTotals([{count: {complete: true, decoded: 100, lower: 40, length: 40, coding: 'br'}, transfer}, {count: {id: '2', complete: false, lower: 12}, transfer: {...transfer, id: '2'}}]);
  assert.deepEqual(counts.complete, {count: 1, decoded: 100, encoded: 40});
  assert.deepEqual(counts.partial, {count: 1, encodedLower: 12, encodedUpper: 40});
  assert.equal(counts.decoded, 200); assert.equal(counts.encodedLower, 52); assert.equal(counts.encodedUpper, 80); assert.equal(counts.unknown, 1); assert.equal(counts.byteVerdict, 'bounded');
  const unknown = bodyTotals([{count: {complete: false, lower: 0}}]);
  assert.equal(unknown.decoded, null); assert.equal(unknown.encodedUpper, null); assert.equal(unknown.byteVerdict, 'unverified');
  assert.throws(() => bodyBounds({complete: false, lower: 1}, {...transfer, sent: false}));
});

test('a cutoff crossing is a retryable invalid cohort, while changed known metadata remains a failure', () => {
  const seed = {run: 'r', now: 0, known: {work: 0, sources: {s: 0}}};
  stableHistory({...seed, now: 10_000}, seed, 60_000);
  assert.throws(() => stableHistory({...seed, now: 31_000}, seed, 60_000), HistoryCutChanged);
  assert.throws(() => stableHistory({...seed, known: {work: 1, sources: {s: 0}}}, seed, 60_000), error => !(error instanceof HistoryCutChanged));
});

test('native history gestures use CDP integer speed while retaining the requested movement and cadence', () => {
  for (const fraction of [.5, .04]) {
    const geometry = {x: 250, y: 200, width: 1001}, distance = geometry.width * fraction;
    const gesture = historyScroll(geometry, fraction, distance);
    assert.ok(Number.isInteger(gesture.speed));
    assert.ok(Math.abs(distance / gesture.speed - .75) < .01);
    assert.equal(gesture.xDistance, distance); assert.equal(gesture.gestureSourceType, 'mouse'); assert.equal(gesture.preventFling, true);
  }
  assert.throws(() => historyScroll({x: 0, y: 0, width: NaN}, .5, 10));
});

test('an actual partial Brotli delivery counts payload bytes and retains the full fixture upper bound', async () => {
  const decoded = Buffer.from(JSON.stringify({run: 'r', values: Array.from({length: 300}, (_, i) => i)}));
  const encoded = brotliCompressSync(decoded, {params: {[constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_LGWIN]: 22}});
  const controller = new AbortController(); let counted: BodyCount | undefined;
  const upstream = createServer((_req, res) => {
    res.writeHead(200, {'content-encoding': 'br', 'content-length': encoded.length}); res.write(encoded.subarray(0, 12));
    const timer = setTimeout(() => controller.abort(), 30); res.once('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(upstream.address() as {port: number}).port}/api/history`;
    await assert.rejects(historyBody(url, '', controller.signal, count => {counted = count;}));
    assert.equal(counted!.complete, false); assert.equal(counted!.lower, 12, 'only the delivered compressed prefix is known');
    const bounds = bodyBounds(counted!, {...transfer, id: counted!.id!, decoded: decoded.length, encoded: encoded.length, finished: false, aborted: true});
    assert.equal(bounds.lower, 12); assert.equal(bounds.upper, encoded.length); assert.equal(bounds.unknown, 1);
  } finally {controller.abort(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));}
});

test('pending or unidentified attempts never borrow an earlier cancelled range’s zero-body proof', () => {
  const pending = {...transfer, sent: false, finished: false, aborted: false};
  assert.deepEqual(bodyBounds({id: pending.id, complete: false, lower: 0}, pending), {lower: 0, upper: 40, unknown: 1, partial: 1});
  assert.equal(transferFor({complete: false, lower: 0}, [{...pending, aborted: true}]), undefined);
  assert.equal(transferFor({id: '1', complete: false, lower: 0}, [pending, pending]), undefined);
  assert.throws(() => bodyBounds({id: 'other', complete: false, lower: 0}, {...pending, aborted: true}));
  assert.throws(() => bodyTotals([{count: {id: '1', complete: false, lower: 0}, transfer}, {count: {id: '1', complete: false, lower: 0}, transfer}]));
});

test('same-range aborted retries retain distinct pre-header identities and fail an excessive aggregate byte budget', async () => {
  const answer = {run: 'r', values: Array.from({length: 6000}, (_, i) => [i, `sample-${i}`, i / 19])};
  const waiting: import('node:http').ServerResponse[] = [];
  const upstream = createServer((req, res) => {assert.equal(req.headers[HISTORY_ATTEMPT_HEADER], undefined, 'fixture identity is stripped before the hub'); waiting.push(res);});
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await historyProxy(`http://127.0.0.1:${(upstream.address() as {port: number}).port}`), counts: BodyCount[] = [];
  const ready = async (index: number) => {const end = Date.now() + 2000; while (!waiting[index]) {if (Date.now() > end) throw new Error('upstream did not receive attempt'); await new Promise(resolve => setTimeout(resolve, 1));} return waiting[index];};
  try {
    proxy.phase('retry');
    const url = `${proxy.url}/api/history?cell=1&from=0&to=60`;
    for (let index = 0; index < 3; index++) {
      const controller = new AbortController(), read = historyBody(url, '', controller.signal, count => counts.push(count)), failed = assert.rejects(read);
      const response = await ready(index), record = proxy.transfers[index];
      if (index === 0) controller.abort();
      else {
        let sent = false;
        Object.defineProperty(record, 'sent', {get: () => sent, set(value: boolean) {sent = value; if (value) queueMicrotask(() => controller.abort());}});
        response.end(JSON.stringify(answer));
      }
      await failed; await proxy.settled('retry');
      assert.ok(counts[index].id, 'request identity exists even without response headers');
      assert.equal(counts[index].responseId, undefined);
      assert.equal(transferFor(counts[index], proxy.transfers), record);
    }
    const read = historyBody(url, '', undefined, count => counts.push(count));
    (await ready(3)).end(JSON.stringify(answer)); assert.deepEqual(await read, answer); await proxy.settled('retry');
    assert.equal(new Set(counts.map(count => count.id)).size, 4);
    const totals = bodyTotals(counts.map(count => ({count, transfer: transferFor(count, proxy.transfers)})));
    const reference = counts[3];
    assert.equal(totals.unknown, 2); assert.equal(totals.byteVerdict, 'bounded');
    assert.equal(totals.decoded, 3 * reference.decoded!); assert.equal(totals.encodedUpper, 3 * reference.lower);
    assert.equal(trafficProblems({name: 'retry', attempts: 4, ...totals, referenceDecoded: reference.decoded!, referenceEncoded: reference.lower, ratios: true}).length, 2);
  } finally {await proxy.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));}
});

test('Chrome request headers preserve a cancelled attempt identity before response headers', () => {
  const f = cdpFixture();
  f.emit('Network.requestWillBeSent', {requestId: 'raw1', request: {url: 'http://localhost/api/history?cell=1&from=0&to=60', headers: {[HISTORY_ATTEMPT_HEADER]: 'b1:1'}}});
  f.emit('Network.loadingFailed', {requestId: 'raw1', canceled: true});
  assert.equal(f.observer.reads[0].count?.id, 'b1:1'); assert.equal(f.observer.reads[0].canceled, true);
  f.emit('Network.requestWillBeSent', {requestId: 'raw2', request: {url: 'http://localhost/api/history?cell=1&from=0&to=60'}});
  f.emit('Network.loadingFailed', {requestId: 'raw2', canceled: true});
  f.emit('Network.requestWillBeSentExtraInfo', {requestId: 'raw2', headers: {[HISTORY_ATTEMPT_HEADER]: 'b1:2'}});
  assert.equal(f.observer.reads[1].count?.id, 'b1:2', 'late extra headers update the terminal count instead of matching a query');
});

import {runInNewContext} from 'node:vm';
import {historyPageScript} from '../historyTrafficBrowser';

test('the browser fixture tags each fetch before IO and keeps cancellation identity without response headers', async () => {
  const calls: {resource: unknown; init: RequestInit}[] = [];
  const window = {fetch: async (resource: unknown, init: RequestInit) => {calls.push({resource, init}); return {};}, __quotumHistoryAttempts: {} as Record<string, {aborted: boolean}>};
  runInNewContext(historyPageScript('24h'), {window, location: {href: 'http://localhost:8080/'}, localStorage: {setItem: () => {}}, URL, Headers, Request, performance});
  const headers = new Headers({Accept: 'application/json'}), controller = new AbortController();
  await window.fetch('/api/history?cell=1&from=0&to=60', {headers, signal: controller.signal, credentials: 'same-origin'});
  await window.fetch('/api/history?cell=1&from=0&to=60', {headers});
  const ids = calls.map(call => new Headers(call.init.headers).get(HISTORY_ATTEMPT_HEADER)!);
  assert.ok(ids.every(Boolean)); assert.notEqual(ids[0], ids[1]);
  assert.equal(calls[0].init.signal, controller.signal); assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(headers.has(HISTORY_ATTEMPT_HEADER), false, 'the production options are not mutated');
  controller.abort(); assert.equal(window.__quotumHistoryAttempts[ids[0]].aborted, true);
  assert.equal(window.__quotumHistoryAttempts[ids[1]].aborted, false);
});

test('composite bodies count once while both resource selections and standalone detail attempts remain visible',async()=>{
  const listeners=new Map<string,(event:never)=>void>();
  const history={run:'r',now:1,historyStart:0,known:{work:0,sources:{}},chunks:[{from:0,to:60}]};
  const raw={basis:{},quota:{state:'complete',value:history},budget:{state:'complete',value:history},funds:{state:'complete',value:history},sessions:{state:'complete',value:{refs:[]}}};
  const cdp={on:<T>(name:string,fn:(event:T)=>void)=>listeners.set(name,fn as (event:never)=>void),send:async<T>()=>({body:JSON.stringify(raw),base64Encoded:false} as T)};
  const observer=new HistoryBodies(cdp),emit=(name:string,event:object)=>listeners.get(name)?.(event as never);
  const query={cell:'1',from:'0',to:'60',evidence:'cursor'};
  emit('Network.requestWillBeSent',{requestId:'combined',request:{url:'http://localhost/api/boards/b/period',postData:JSON.stringify({quota:query,budget:{...query,meters:'[]',unit:'USD'}})}});
  emit('Network.loadingFinished',{requestId:'combined'});await Promise.all([...observer.pending]);
  assert.deepEqual(observer.errors,[]);assert.equal(observer.reads.length,1);assert.equal(observer.resources.length,2);
  assert.equal(observer.reads[0].count?.decoded,Buffer.byteLength(JSON.stringify(raw)));
  assert.deepEqual(observer.resources.map(r=>new URLSearchParams(r.selection).get('scope')),['quota','budget']);
  assert.ok(observer.resources.every(r=>!new URLSearchParams(r.selection).has('evidence')));
  emit('Network.requestWillBeSent',{requestId:'details',request:{url:'http://localhost/api/boards/b/period/sessions',postData:'{}'}});
  emit('Network.loadingFailed',{requestId:'details',canceled:true});
  assert.equal(observer.reads.length,2);assert.equal(observer.resources.length,2);assert.equal(observer.reads[1].canceled,true);
  emit('Network.requestWillBeSent',{requestId:'evidence',request:{url:'http://localhost/api/boards/b/period',postData:JSON.stringify({quota:{...query,cells:'skip'}})}});
  emit('Network.loadingFinished',{requestId:'evidence'});await Promise.all([...observer.pending]);
  assert.equal(observer.reads.length,3);assert.equal(observer.resources.length,2,'evidence bytes count without pretending cached cells were reread');
  assert.equal(observer.reads[2].count?.decoded,Buffer.byteLength(JSON.stringify(raw)));assert.deepEqual(observer.errors,[]);
  assert.equal(hasSeededHistory(observer.reads,'seed'),false,'evidence and two complete families cannot stand in for the third cell seed');
  emit('Network.requestWillBeSent',{requestId:'funds',request:{url:'http://localhost/api/boards/b/period',postData:JSON.stringify({funds:query})}});
  assert.equal(hasSeededHistory(observer.reads,'seed'),false,'the queued family must finish its physical read');
  emit('Network.loadingFinished',{requestId:'funds'});await Promise.all([...observer.pending]);
  assert.equal(hasSeededHistory(observer.reads,'seed'),true);assert.equal(hasSeededHistory(observer.reads,'different phase'),false);
});

test('composite resource classification waits for an omitted POST body even after the response arrives',async()=>{
  const listeners=new Map<string,(event:never)=>void>();
  const history={run:'r',now:1,historyStart:0,known:{work:0,sources:{}},chunks:[{from:0,to:60}]};
  const raw=JSON.stringify({basis:{},quota:{state:'complete',value:history}});
  let finish!:(value:{postData:string})=>void;
  const cdp={on:<T>(name:string,fn:(event:T)=>void)=>listeners.set(name,fn as (event:never)=>void),send:<T>(method:string)=>
    (method==='Network.getRequestPostData'?new Promise<{postData:string}>(resolve=>{finish=resolve;}):Promise.resolve({body:raw,base64Encoded:false})) as Promise<T>};
  const observer=new HistoryBodies(cdp),emit=(name:string,event:object)=>listeners.get(name)?.(event as never);
  emit('Network.requestWillBeSent',{requestId:'omitted',request:{url:'http://localhost/api/boards/b/period'}});
  assert.equal(observer.reads.length,1);assert.equal(observer.activeCount,1);assert.equal(observer.pending.size,1);
  emit('Network.loadingFinished',{requestId:'omitted'});await Promise.resolve();
  assert.equal(observer.reads[0].count,undefined,'a response cannot settle before its resource selection is known');
  finish({postData:JSON.stringify({quota:{cell:'1',from:'0',to:'60'}})});
  await Promise.all([...observer.pending]);
  assert.deepEqual(observer.errors,[]);assert.equal(observer.reads.length,1);assert.equal(observer.resources.length,1);
  assert.equal(new URLSearchParams(observer.resources[0].selection).get('scope'),'quota');
  assert.deepEqual(observer.resources[0].chunks,[[0,60]]);assert.equal(observer.resources[0].count?.decoded,Buffer.byteLength(raw));
});

test('a missing POST body that Chrome cannot recover fails observation and retains the canceled attempt',async()=>{
  const listeners=new Map<string,(event:never)=>void>(),missing=new Error('POST data unavailable');
  const cdp={on:<T>(name:string,fn:(event:T)=>void)=>listeners.set(name,fn as (event:never)=>void),send:<T>()=>Promise.reject<T>(missing)};
  const observer=new HistoryBodies(cdp),emit=(name:string,event:object)=>listeners.get(name)?.(event as never);
  emit('Network.requestWillBeSent',{requestId:'missing',request:{url:'http://localhost/api/boards/b/period'}});
  emit('Network.loadingFailed',{requestId:'missing',canceled:true});
  await Promise.all([...observer.pending]);
  assert.deepEqual(observer.errors,[missing]);assert.equal(observer.reads.length,1);assert.equal(observer.reads[0].canceled,true);
  assert.equal(observer.reads[0].count?.complete,false);assert.equal(observer.activeCount,0);
});
