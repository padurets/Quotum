import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Cdp} from '../cdp.js';
import {Requests} from '../index.js';

/** Stands in for what the benchmark hears of the browser: events by name, emitted by the test. */
function browser() {
  const listeners = new Map<string, ((params: unknown) => void)[]>();
  return {
    on: (method: string, listener: (params: unknown) => void) => void listeners.set(method, [...(listeners.get(method) ?? []), listener]),
    emit: (method: string, params: unknown) => listeners.get(method)?.forEach(listener => listener(params)),
  };
}

test('what the idle page asks is counted, a stream of events opened meanwhile too; not the one it opened before, nor its images', () => {
  const cdp = browser();
  const requests = new Requests(cdp as unknown as Cdp);
  const asked = (requestId: string, type: string, url: string) => cdp.emit('Network.requestWillBeSent', {requestId, type, request: {url}});
  asked('1', 'Fetch', 'http://127.0.0.1:8080/api/events?board=b');
  requests.counting = true;
  asked('2', 'Image', 'http://127.0.0.1:8080/logo.svg');
  asked('3', 'Fetch', 'http://127.0.0.1:8080/api/events?board=b');
  asked('4', 'Fetch', 'http://127.0.0.1:8080/api/events?board=b&mode=poll');
  cdp.emit('Network.loadingFinished', {requestId: '4', encodedDataLength: 120});
  cdp.emit('Network.loadingFinished', {requestId: '1', encodedDataLength: 999});
  assert.deepEqual({count: requests.count, bytes: requests.bytes, byPath: requests.byPath}, {count: 2, bytes: 120, byPath: {'/api/events': 2}});
});

test('a browser gone meanwhile answers nothing: a command is refused at once, not waited for', async () => {
  const closed = {readyState: WebSocket.CLOSED, addEventListener() {}, send() {}, close() {}};
  const cdp = new (Cdp as unknown as new (socket: unknown) => Cdp)(closed);
  const waited = new Promise((_, reject) => setTimeout(() => reject(new Error('still waiting')), 1000).unref());
  await assert.rejects(Promise.race([cdp.send('Performance.getMetrics'), waited]), /Performance.getMetrics: the browser closed the connection/);
});

/** Keeps the socket open even when a renderer promise never answers. */
class Socket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  readonly commands: {id: number; method: string}[] = [];
  send(value: string) {this.commands.push(JSON.parse(value));}
  answer(id: number, result: unknown) {this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({id, result})}));}
  close() {this.readyState = WebSocket.CLOSED;}
}
const connection = (socket: Socket) => new (Cdp as unknown as new (socket: unknown) => Cdp)(socket);

test('a silent open browser has a Node deadline even when the page RAF never advances', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const socket = new Socket(), cdp = connection(socket);
  cdp.at('browser/1d/reversal/reversal frame');
  const failed = assert.rejects(cdp.evaluate('new Promise(requestAnimationFrame)'), /browser\/1d\/reversal\/reversal frame: Runtime.evaluate: no browser response in 30 s/);
  t.mock.timers.tick(30_000);
  await failed; cdp.close();
});

test('completed and late CDP replies do not retain deadlines or settle another command', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const socket = new Socket(), cdp = connection(socket);
  const first = cdp.send('Performance.getMetrics');
  socket.answer(1, {metrics: []});
  assert.deepEqual(await first, {metrics: []});
  const failed = assert.rejects(cdp.send('Network.getResponseBody'), /Network.getResponseBody: no browser response/);
  t.mock.timers.tick(30_000); await failed;
  const next = cdp.send('Performance.getMetrics');
  socket.answer(2, {body: 'late'});
  socket.answer(3, {metrics: ['current']});
  assert.deepEqual(await next, {metrics: ['current']});
  t.mock.timers.tick(30_000); cdp.close();
});

test('closing CDP rejects pending commands even without a socket close event', async () => {
  const cdp = connection(new Socket());
  const first = assert.rejects(cdp.send('Input.dispatchKeyEvent'), /the browser closed the connection/);
  const second = assert.rejects(cdp.evaluate('new Promise(requestAnimationFrame)'), /the browser closed the connection/);
  cdp.close(); await Promise.all([first, second]);
});

test('history bytes are counted by path after reads finish, separately from other traffic', () => {
  const cdp = browser();
  const requests = new Requests(cdp as unknown as Cdp);
  requests.counting = true;
  cdp.emit('Network.requestWillBeSent', {requestId: 'history', type: 'Fetch', request: {url: 'http://localhost/api/history?cell=60000'}});
  cdp.emit('Network.requestWillBeSent', {requestId: 'session', type: 'Fetch', request: {url: 'http://localhost/api/session'}});
  assert.equal(requests.historyPending, 1);
  cdp.emit('Network.loadingFinished', {requestId: 'session', encodedDataLength: 999});
  cdp.emit('Network.loadingFinished', {requestId: 'history', encodedDataLength: 2345});
  assert.equal(requests.historyPending, 0);
  assert.equal(requests.bytesByPath['/api/history'], 2345);
});
