import assert from 'node:assert/strict';
import {request} from 'node:http';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import Fastify from 'fastify';
import {responseCompression} from '../compression.js';
import {fixture, NEGOTIATION, NOW, raw} from './compressionHarness.js';

test('real server overview negotiation preserves decoded projections and explicit exclusions', async t => {
  const h = await fixture(t);
  const baseline = await raw(h.base + '/api/overview', {cookie: h.cookie, 'accept-encoding': 'identity'});
  assert.equal(baseline.status, 200);
  assert.ok(baseline.wire.length > 1024);
  for (const [header, coding] of NEGOTIATION) {
    const headers = {cookie: h.cookie, ...(header === undefined ? {} : {'accept-encoding': header})};
    const result = await raw(h.base + '/api/overview', headers);
    assert.equal(result.status, baseline.status, header);
    assert.equal(result.headers['content-encoding'], coding, header);
    assert.deepEqual(result.decoded, baseline.decoded, header);
    assert.match(String(result.headers.vary), /accept-encoding/i, header);
    assert.equal(result.headers['cache-control'], baseline.headers['cache-control']);
    if (coding) {
      assert.equal(result.headers['content-length'], undefined, 'the asynchronous encoder drops unencoded length');
      assert.ok(result.wire.length < baseline.wire.length / 2);
    }
  }
});

test('serialized history and long-poll JSON compress while SSE remains immediate and unencoded', async t => {
  const h = await fixture(t);
  const cell = 300_000, from = Math.floor((NOW - 86_400_000) / cell) * cell, to = Math.ceil(NOW / cell) * cell;
  const url = `${h.base}/api/history?board=${h.board}&cell=${cell}&from=${from}&to=${to}`;
  const baseline = await raw(url, {cookie: h.cookie, 'accept-encoding': 'identity'});
  assert.equal(baseline.status, 200);
  for (const coding of ['br', 'gzip']) {
    const result = await raw(url, {cookie: h.cookie, 'accept-encoding': coding});
    assert.equal(result.headers['content-encoding'], coding);
    assert.deepEqual(result.decoded, baseline.decoded);
  }
  const headers = {cookie: h.cookie, 'quotum-stream': '1', 'accept-encoding': 'br'};
  const poll = await raw(h.base + '/api/events?mode=poll', headers);
  assert.equal(poll.status, 200);
  assert.equal(poll.headers['content-encoding'], 'br');
  assert.deepEqual(JSON.parse(poll.decoded.toString()).events.map((e: {type: string}) => e.type), ['hello','snapshot','filters']);
  await new Promise<void>((resolve, reject) => {
    const req = request(h.base + '/api/events', {headers}, res => {
      assert.equal(res.headers['content-encoding'], undefined);
      assert.match(res.headers['content-type']!, /text\/event-stream/);
      let text = '';
      res.on('data', chunk => {text += chunk; if (text.includes('event: snapshot')) {req.destroy(); resolve();}});
      res.on('error', error => {if (!text.includes('event: snapshot')) reject(error);});
    });
    req.on('error', reject);
    req.setTimeout(1500, () => {req.destroy(); reject(new Error('SSE did not send its baseline'));});
    req.end();
  });
});

test('local, excluded routes, denied projections and compressed requests retain their contracts', async t => {
  for (const local of [false, true]) {
    const h = await fixture(t, local);
    const headers = {cookie: h.cookie, 'accept-encoding': 'br'};
    const overview = await raw(h.base + '/api/overview', headers);
    assert.equal(overview.headers['content-encoding'], local ? undefined : 'br');
    for (const [url, method] of [['/test/json', 'GET'], ['/test/json', 'POST'], ['/api/tokens', 'GET'], ['/api/session', 'GET'], ['/health', 'GET']]) {
      const reply = await raw(h.base + url, headers, method);
      assert.equal(reply.headers['content-encoding'], undefined, `${local} ${method} ${url}`);
    }
    const denied = await raw(h.base + '/api/overview', {'accept-encoding': 'br'});
    assert.equal(denied.status, 401);
    assert.deepEqual(JSON.parse(denied.decoded.toString()), {error: 'unauthorized'});
    const compressed = await raw(h.base + '/v1/ingest', {'content-type': 'application/json', 'content-encoding': 'gzip'}, 'POST', gzipSync('{}'));
    assert.equal(compressed.headers['content-encoding'], undefined);
    assert.equal(compressed.status, 401, 'authorization still runs before any body parser');
    const authorized = await raw(h.base + '/v1/ingest', {authorization: h.authorization, 'content-type': 'application/json', 'content-encoding': 'gzip'}, 'POST', gzipSync('{}'));
    assert.equal(authorized.status, 400, 'a compressed request is never transparently decompressed');
    const head = await raw(h.base + '/api/overview', headers, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.wire.length, 0);
  }
});

test('the exact threshold, Vary composition and original header survive the route encoder', async t => {
  const app = Fastify();
  await responseCompression(app, false);
  const originals: (string | undefined)[] = [];
  app.addHook('onResponse', async request => {originals.push(request.raw.headers['accept-encoding']);});
  app.get<{Querystring: {bytes?: string; encoded?: string}}>('/api/overview', (request, reply) => {
    reply.header('vary', 'Origin');
    const payload = JSON.stringify({text: 'a'.repeat(Number(request.query.bytes ?? 1024) - 11)});
    if (request.query.encoded) return reply.type('application/json').header('content-encoding', 'gzip').send(gzipSync(payload));
    return reply.type('application/json').send(payload);
  });
  await app.listen({host: '127.0.0.1', port: 0});
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as {port: number}).port}/api/overview`;
  for (const bytes of [1023, 1024, 8192]) {
    const result = await raw(`${base}?bytes=${bytes}`, {'accept-encoding': 'gzip;q=0,*;q=1'});
    assert.equal(result.headers['content-encoding'], bytes < 1024 ? undefined : 'br');
    assert.equal(result.decoded.length, bytes);
    assert.match(String(result.headers.vary), /Origin/i);
    assert.match(String(result.headers.vary), /Accept-Encoding/i);
  }
  assert.ok(originals.every(header => header === 'gzip;q=0,*;q=1'));
  const encoded = await raw(base + '?encoded=1', {'accept-encoding': 'br'});
  assert.equal(encoded.headers['content-encoding'], 'gzip', 'an existing encoding is passed through once');
  assert.equal(encoded.decoded.length, 1024);
});

test('only allowlisted read JSON reaches the encoder, regardless of body size', async t => {
  const app = Fastify();
  await responseCompression(app, false);
  const allowed = ['/api/overview', '/api/history', '/api/events', '/api/resets', '/api/devices', '/api/projects', '/api/boards/:board/sources/:source/keys'];
  const excluded = ['/api/auth/login', '/api/session', '/api/tokens', '/api/credentials', '/api/boards/:board/catalogue'];
  for (const route of [...allowed, ...excluded]) {
    app.get(route, (request, reply) => request.headers['test-content'] ? reply.type('text/plain').send('a'.repeat(4096)) : {text: 'a'.repeat(4096)});
    app.post(route, () => ({text: 'a'.repeat(4096)}));
  }
  await app.listen({host: '127.0.0.1', port: 0});
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as {port: number}).port}`;
  for (const route of [...allowed, ...excluded]) {
    const url = base + route.replace(':board', 'board').replace(':source', 'source');
    const json = await raw(url, {'accept-encoding': 'br'});
    assert.equal(json.headers['content-encoding'], allowed.includes(route) ? 'br' : undefined, route);
    const text = await raw(url, {'accept-encoding': 'br', 'test-content': 'text'});
    assert.equal(text.headers['content-encoding'], undefined, route);
    const write = await raw(url, {'accept-encoding': 'br'}, 'POST');
    assert.equal(write.headers['content-encoding'], undefined, route);
  }
});
