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
