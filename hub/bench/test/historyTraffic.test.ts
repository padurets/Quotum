import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {brotliCompressSync, constants} from 'node:zlib';
import {historyBody, historyProxy, type BodyCount, type Transfer} from '../historyProxy';
import {HistoryCutChanged, bodyBounds, bodyTotals, stableHistory, trafficProblems} from '../historyTrafficBudget';

const transfer: Transfer = {id: '1', phase: 'cold', cell: 1, from: 0, to: 60, started: 0, sent: true, finished: true, aborted: false, decoded: 100, encoded: 40};
test('body budgets require actual matching coding and payload lengths, never transport totals', () => {
  const body = {complete: true, decoded: 100, lower: 40, upper: 40, length: 40, coding: 'br'};
  assert.equal(bodyBounds(body, transfer).upper, 40);
  for (const bad of [{...body, coding: 'identity'}, {...body, lower: 200}, {...body, decoded: 99}, {...body, length: 39}]) assert.throws(() => bodyBounds(bad, transfer));
  assert.throws(() => bodyBounds(body));
  assert.deepEqual(bodyBounds({complete: false, lower: 12}, transfer), {lower: 12, upper: 40, unknown: 1, partial: 1});
  assert.equal(bodyBounds({complete: false, lower: 0}).upper, null);
  assert.deepEqual(bodyBounds({complete: false, lower: 0}, {...transfer, sent: false}), {lower: 0, upper: 0, unknown: 0, partial: 1});
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

import {HistoryBodies, historyScroll} from '../historyTrafficBrowser';
import {readUnion} from '../historyTrafficBudget';

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
  assert.deepEqual(bodyBounds(f.observer.reads[1].count!, transfer), {lower: 12, upper: 40, unknown: 1, partial: 1});
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
    assert.ok(proxy.transfers[0]?.encoded); controller.abort(); await failed;
    assert.equal(proxy.transfers.length, 1); assert.equal(bodyBounds(counted!, proxy.transfers[0]).upper, 0);
  } finally {await proxy.close(); await new Promise<void>(resolve => upstream.close(() => resolve()));}
});

test('complete payloads and partial bounds remain separate in a bounded verdict', () => {
  const counts = bodyTotals([{count: {complete: true, decoded: 100, lower: 40, length: 40, coding: 'br'}, transfer}, {count: {complete: false, lower: 12}, transfer}]);
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
    const bounds = bodyBounds(counted!, {...transfer, decoded: decoded.length, encoded: encoded.length, finished: false, aborted: true});
    assert.equal(bounds.lower, 12); assert.equal(bounds.upper, encoded.length); assert.equal(bounds.unknown, 1);
  } finally {controller.abort(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));}
});
