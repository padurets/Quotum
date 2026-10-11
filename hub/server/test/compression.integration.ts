import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {fixture, NEGOTIATION, NOW, raw} from './compressionHarness.js';

const exec = promisify(execFile);

test('shipped Caddy forwarding preserves negotiation, projections and immediate SSE', {timeout: 30_000}, async t => {
  const h = await fixture(t);
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as {port: number}).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const dir = mkdtempSync(path.join(tmpdir(), 'quotum-compression-caddy-'));
  const file = path.join(dir, 'Caddyfile'), name = `quotum-compression-${randomUUID()}`;
  writeFileSync(file, `{\n admin off\n}\nhttp://127.0.0.1:${port} {\n bind 127.0.0.1\n reverse_proxy ${h.base}\n}\n`);
  const child = spawn('docker', ['run', '--rm', '--name', name, '--network', 'host', '-v', `${file}:/etc/caddy/Caddyfile:ro`, 'caddy:2-alpine'], {stdio: ['ignore', 'pipe', 'pipe']});
  let logs = ''; child.stdout.on('data', chunk => logs += chunk); child.stderr.on('data', chunk => logs += chunk);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  t.after(async () => {await exec('docker', ['stop', name]).catch(() => {}); await exited; rmSync(dir, {recursive: true, force: true});});
  const proxy = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try {ready = (await raw(proxy + '/health')).status === 200;} catch { /* Caddy is starting. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, logs);
  const direct = await raw(h.base + '/api/overview', {cookie: h.cookie, 'accept-encoding': 'identity'});
  for (const [header, coding] of NEGOTIATION) {
    const result = await raw(proxy + '/api/overview', {cookie: h.cookie, ...(header === undefined ? {} : {'accept-encoding': header})});
    assert.equal(result.status, direct.status);
    // Go's transport requests gzip for an absent header, then decodes it downstream.
    assert.equal(h.received.at(-1)?.encoding, header === undefined ? 'gzip' : header === '' ? ', gzip' : header, String(header));
    assert.equal(result.headers['content-encoding'], coding, String(header));
    assert.deepEqual(result.decoded, direct.decoded, String(header));
    assert.match(String(result.headers.vary), /Accept-Encoding/i);
    if (result.headers['content-encoding']) assert.ok(result.wire.length < direct.wire.length / 2);
  }
  const cell = 300_000, from = Math.floor((NOW - 86_400_000) / cell) * cell;
  const history = `/api/history?board=${h.board}&cell=${cell}&from=${from}&to=${NOW}`;
  const original = await raw(h.base + history, {cookie: h.cookie, 'accept-encoding': 'identity'});
  for (const coding of ['br', 'gzip']) {
    const result = await raw(proxy + history, {cookie: h.cookie, 'accept-encoding': coding});
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-encoding'], coding);
    assert.deepEqual(result.decoded, original.decoded);
  }
  const controller = new AbortController();
  const stream = await fetch(proxy + '/api/events', {headers: {cookie: h.cookie, 'quotum-stream': '1', 'accept-encoding': 'br'}, signal: controller.signal});
  assert.equal(stream.headers.get('content-encoding'), null);
  const reader = stream.body!.getReader();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    let text = '';
    while (!text.includes('event: snapshot')) {const part = await reader.read(); assert.ok(!part.done); text += Buffer.from(part.value).toString();}
    assert.match(text, /event: hello/);
  } finally {clearTimeout(timeout); controller.abort();}
});

test('compression HTTP overhead on identical overview and history projections', async t => {
  const h = await fixture(t, false, NOW - 121 * 60_000 - 1000);
  // Dense captured history, using the same production store and read projection.
  const sources = h.store.sources(h.board);
  for (let n = 120; n >= 0; n--) for (const source of sources) {
    assert.equal(h.store.record(source.id, {observedAt: NOW - n * 60_000 - 1000, plan: 'pro', staleAfterMs: 204_000, resets: null,
      windows: [{id: 'weekly', kind: 'weekly', remaining: 60 + n % 30, used: 40 - n % 30, label: null, resetAt: NOW + 86_400_000, minutes: 10080}]}).accepted, true);
  }
  const cell = 300_000, from = Math.floor((NOW - 3 * 3_600_000) / cell) * cell;
  const paths = ['/api/overview', `/api/history?board=${h.board}&cell=${cell}&from=${from}&to=${NOW}`];
  const percentile = (values: number[], p: number) => values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  for (const route of paths) for (const concurrency of [1, 4]) {
    const baseline = await raw(h.base + route, {cookie: h.cookie, 'accept-encoding': 'identity'});
    assert.equal(baseline.status, 200);
    for (const coding of ['identity', 'br', 'gzip']) {
      for (let i = 0; i < 5; i++) await raw(h.base + route, {cookie: h.cookie, 'accept-encoding': coding});
      const delay = monitorEventLoopDelay({resolution: 10}); delay.enable();
      const cpu = process.cpuUsage(), start = performance.now(), latencies: number[] = [];
      let wire = 0;
      await Promise.all(Array.from({length: concurrency}, async () => {
        for (let i = 0; i < 40; i++) {
          const began = performance.now(), response = await raw(h.base + route, {cookie: h.cookie, 'accept-encoding': coding});
          assert.deepEqual(response.decoded, baseline.decoded);
          wire = response.wire.length;
          latencies.push(performance.now() - began);
        }
      }));
      delay.disable(); const used = process.cpuUsage(cpu);
      t.diagnostic(JSON.stringify({route: route.split('?')[0], coding, concurrency, requests: latencies.length, decoded: baseline.decoded.length, wire,
        wallMs: +(performance.now() - start).toFixed(2), cpuMs: +((used.user + used.system) / 1000).toFixed(2),
        latencyP50Ms: +percentile(latencies, .5).toFixed(2), latencyP95Ms: +percentile(latencies, .95).toFixed(2),
        eventLoopP95Ms: +(delay.percentile(95) / 1e6).toFixed(2)}));
    }
  }
});
