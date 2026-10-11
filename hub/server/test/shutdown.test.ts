import assert from 'node:assert/strict';
import {request} from 'node:http';
import path from 'node:path';
import {test} from 'node:test';
import {Store} from '../store/store.js';
import {audited, deadline, partial, signalOptions, start} from './shutdownHarness.js';

for (const local of [false, true]) for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${local ? 'local' : 'server'} ${signal} bounds a stalled body and repeated stop`, signalOptions, async t => {
    const hub = await start(t, local);
    await partial(t, hub.port);
    const before = Date.now();
    hub.child.kill(signal);
    const repeat = setTimeout(() => hub.child.kill(signal), 1000);
    t.after(() => clearTimeout(repeat));
    assert.deepEqual(await deadline(hub.exited, local ? 3000 : 6000), {code: 0, signal: null});
    assert.ok(Date.now() - before >= (local ? 1800 : 4800), 'the request remains open through grace');
    assert.equal(hub.output().includes('"event":"stop"'), local);
    audited(hub.dir);
  });
}

test('a real ingest drains beside a stalled request before the server deadline', signalOptions, async t => {
  const hub = await start(t);
  await partial(t, hub.port);
  const at = new Date().toISOString();
  const body = JSON.stringify({version: 1, agent: 'quotum/test', machine: {id: 'shutdown-machine-0123456789', name: 'fixture', os: 'linux', arch: 'x86_64'}, sentAt: at,
    snapshots: [{provider: 'codex', account: 'a'.repeat(24), observedAt: at, via: 'fixture', staleAfterMs: 120_000, windows: [{id: 'weekly', kind: 'weekly', minutes: 10080, usedPercent: 91, resetsAt: null}]}], failures: []});
  const socket = await partial(t, hub.port, body.slice(0, 1), Buffer.byteLength(body));
  let response = '';
  socket.on('data', chunk => response += chunk);
  const finished = new Promise<void>(resolve => socket.once('end', resolve));
  hub.child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 200));
  socket.end(body.slice(1));
  await deadline(finished, 2000);
  assert.match(response, /HTTP\/1\.1 200/);
  assert.match(response, /"accepted":1/);
  assert.deepEqual(await deadline(hub.exited, 6000), {code: 0, signal: null});
  audited(hub.dir);
  const store = new Store(path.join(hub.dir, 'quotum.sqlite'));
  try { assert.equal((store.db.prepare('SELECT count(*) AS n FROM samples').get() as {n: number}).n, 1); }
  finally { store.close(); }
});

test('a cancelled integration cannot defer HTTP closure or the store deadline', signalOptions, async t => {
  const hub = await start(t, false, 'integration');
  const headers = new Promise<void>(resolve => {
    const req = request(`http://127.0.0.1:${hub.port}/test/hang`);
    req.on('error', () => {});
    t.after(() => req.destroy());
    req.end();
    req.once('finish', resolve);
  });
  await headers;
  hub.child.kill('SIGTERM');
  await deadline((async () => {
    for (;;) {
      try { const response = await fetch(`http://127.0.0.1:${hub.port}/health`, {signal: AbortSignal.timeout(500)}); await response.body?.cancel(); }
      catch (error) {
        if (['ECONNREFUSED', 'ECONNRESET'].includes((error as {cause?: {code?: string}}).cause?.code ?? '')) return;
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  })(), 1500);
  assert.deepEqual(await deadline(hub.exited, 6000), {code: 0, signal: null});
  audited(hub.dir);
});

test('ordinary stop is quick and cleanup errors never disclose their message', signalOptions, async t => {
  for (const scenario of ['', 'failure']) {
    const hub = await start(t, false, scenario);
    hub.child.kill('SIGTERM');
    assert.deepEqual(await deadline(hub.exited, 1500), {code: scenario ? 1 : 0, signal: null});
    assert.ok(!hub.output().includes('synthetic-secret-sentinel'));
    if (scenario) assert.match(hub.output(), /hub_stop_failed/);
    audited(hub.dir);
  }
});
