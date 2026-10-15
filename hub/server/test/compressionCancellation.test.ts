import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {request, type ClientRequest} from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import zlib from 'node:zlib';
import Fastify from 'fastify';
import {responseCompression} from '../compression.js';
import {raw} from './compressionHarness.js';

type Codec = ReturnType<typeof zlib.createGzip> | ReturnType<typeof zlib.createBrotliCompress>;

test('HEAD describes the encoded representation without allocating a codec', async t => {
  const gzip = t.mock.method(zlib, 'createGzip'), brotli = t.mock.method(zlib, 'createBrotliCompress');
  syncBuiltinESMExports();
  const app = Fastify();
  t.after(async () => {await app.close(); t.mock.restoreAll(); syncBuiltinESMExports();});
  await responseCompression(app, false);
  app.get('/api/overview', (_req, reply) => reply.type('application/json').header('content-length', 5000).send('a'.repeat(5000)));
  await app.listen({host: '127.0.0.1', port: 0});
  const base = `http://127.0.0.1:${(app.server.address() as {port: number}).port}/api/overview`;
  for (const coding of ['br', 'gzip']) {
    const response = await raw(base, {'accept-encoding': coding}, 'HEAD');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], coding);
    assert.match(String(response.headers.vary), /Accept-Encoding/i);
    assert.equal(response.headers['content-length'], undefined);
    assert.equal(response.wire.length, 0);
  }
  assert.equal(gzip.mock.callCount(), 0);
  assert.equal(brotli.mock.callCount(), 0);
  const identity = await raw(base, {'accept-encoding': 'identity'}, 'HEAD');
  assert.equal(identity.headers['content-encoding'], undefined);
  assert.equal(identity.headers['content-length'], '5000');
  assert.equal(identity.wire.length, 0);
});

test('native codec errors preserve the ordinary HTTP error before headers and abort after headers', {timeout: 10_000}, async t => {
  const payload = JSON.stringify({text: randomBytes(4 * 1024 * 1024).toString('base64')});
  for (const coding of ['br', 'gzip']) await t.test(coding, async t => {
    let codec: Codec | undefined, source: Readable | undefined, fault = '', errors = 0;
    const gzip = zlib.createGzip, brotli = zlib.createBrotliCompress, from = Readable.from;
    const record = (stream: Codec) => {
      codec = stream;
      if (fault === 'before') queueMicrotask(() => stream.destroy(new Error('synthetic codec failure')));
      return stream;
    };
    t.mock.method(zlib, 'createGzip', (options?: zlib.ZlibOptions) => record(gzip(options)));
    t.mock.method(zlib, 'createBrotliCompress', (options?: zlib.BrotliOptions) => record(brotli(options)));
    t.mock.method(Readable, 'from', (iterable: Iterable<unknown> | AsyncIterable<unknown>, options?: Parameters<typeof from>[1]) => (source = from(iterable, options)));
    syncBuiltinESMExports();
    const app = Fastify();
    t.after(async () => {app.server.closeAllConnections(); await app.close(); t.mock.restoreAll(); syncBuiltinESMExports();});
    app.addHook('onSend', async (req, _reply, body) => {fault = (req.query as {fault?: string}).fault ?? ''; return body;});
    await responseCompression(app, false);
    app.setErrorHandler((_error, _req, reply) => {errors++; reply.code(500).send({error: 'internal_error'});});
    app.get('/api/overview', (_req, reply) => reply.type('application/json').send(payload));
    await app.listen({host: '127.0.0.1', port: 0});
    const base = `http://127.0.0.1:${(app.server.address() as {port: number}).port}/api/overview`;
    const early = await raw(base + '?fault=before', {'accept-encoding': coding});
    assert.equal(early.status, 500);
    assert.equal(early.headers['content-encoding'], undefined, 'the replacement error is identity JSON');
    assert.deepEqual(JSON.parse(early.decoded.toString()), {error: 'internal_error'});
    assert.equal(errors, 1);
    assert.equal(codec?.destroyed, true);
    assert.equal(source?.destroyed, true);
    await new Promise<void>((resolve, reject) => {
      const req = request(base + '?fault=after', {headers: {'accept-encoding': coding}}, res => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-encoding'], coding);
        res.once('data', () => codec!.destroy(new Error('synthetic codec failure')));
        res.once('aborted', resolve);
        res.on('error', () => {});
        res.once('end', () => reject(new Error('a codec failure must abort the partial representation')));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(errors, 1, 'an error after headers does not create another HTTP response');
    assert.equal(codec?.destroyed, true);
    assert.equal(source?.destroyed, true);
    const normal = await raw(base, {'accept-encoding': coding});
    assert.equal(normal.status, 200);
    assert.equal(normal.decoded.toString(), payload);
  });
});

test('a paused HTTP reader applies backpressure to the native encoder', {timeout: 10_000}, async t => {
  const payload = JSON.stringify({text: randomBytes(8 * 1024 * 1024).toString('base64')});
  for (const coding of ['br', 'gzip']) await t.test(coding, async t => {
    let codec: Codec | undefined, produced = 0;
    const gzip = zlib.createGzip, brotli = zlib.createBrotliCompress;
    const record = (stream: Codec) => {
      codec = stream;
      const push = stream.push;
      stream.push = (chunk: Buffer | null, encoding?: BufferEncoding) => {
        produced += chunk?.length ?? 0;
        return push.call(stream, chunk, encoding);
      };
      return stream;
    };
    t.mock.method(zlib, 'createGzip', (options?: zlib.ZlibOptions) => record(gzip(options)));
    t.mock.method(zlib, 'createBrotliCompress', (options?: zlib.BrotliOptions) => record(brotli(options)));
    syncBuiltinESMExports();
    const app = Fastify();
    t.after(async () => {codec?.destroy(); app.server.closeAllConnections(); await app.close(); t.mock.restoreAll(); syncBuiltinESMExports();});
    await responseCompression(app, false);
    app.get('/api/overview', (_req, reply) => reply.type('application/json').send(payload));
    await app.listen({host: '127.0.0.1', port: 0});
    const base = `http://127.0.0.1:${(app.server.address() as {port: number}).port}/api/overview`;
    let req: ClientRequest;
    await new Promise<void>((resolve, reject) => {
      req = request(base, {headers: {'accept-encoding': coding}}, res => {
        res.pause();
        res.on('error', () => {});
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
    let previous = -1, stable = 0;
    for (let n = 0; n < 40 && stable < 3; n++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      stable = produced === previous ? stable + 1 : 0;
      previous = produced;
    }
    assert.equal(stable, 3, 'the encoder pauses while its socket cannot drain');
    assert.ok(codec);
    assert.equal(codec.readableEnded, false, 'the paused response still has unread encoded output');
    assert.ok(codec.readableLength >= codec.readableHighWaterMark, 'the native readable queue is applying backpressure');
    assert.ok(codec.readableLength <= codec.readableHighWaterMark + 16 * 1024, 'native output remains bounded');
    assert.ok(produced > 0);
    req!.destroy();
    await new Promise<void>(resolve => codec!.once('close', resolve));
    const stopped = produced;
    await app.close();
    assert.equal(produced, stopped);
    assert.equal((codec as Codec & {_handle: unknown})._handle, null);
  });
});

test('HTTP cancellation closes the native codec and its source before headers and after data', {timeout: 15_000}, async t => {
  const payload = JSON.stringify({text: randomBytes(4 * 1024 * 1024).toString('base64')});
  for (const coding of ['br', 'gzip']) for (const phase of ['complete', 'before-headers', 'first-data']) {
    await t.test(`${coding} ${phase}`, async t => {
      // Retain native streams so these assertions require explicit teardown, without GC.
      const codecs = new Map<string, {stream: Codec; produced: number; closed: boolean}>();
      const sources = new Map<string, Readable>();
      const requests = new Map<string, ClientRequest>();
      const closed = new Map<string, Promise<void>>();
      let creating = '';
      const record = (stream: Codec) => {
        const id = creating, entry = {stream, produced: 0, closed: false};
        codecs.set(id, entry);
        // Observe native output without adding a data listener or changing readable flow.
        const push = stream.push;
        stream.push = (chunk: Buffer | null, encoding?: BufferEncoding) => {
          entry.produced += chunk?.length ?? 0;
          return push.call(stream, chunk, encoding);
        };
        stream.once('close', () => {entry.closed = true;});
        if (phase === 'before-headers' && id.startsWith('abort')) queueMicrotask(() => requests.get(id)!.destroy());
        return stream;
      };
      const gzip = zlib.createGzip, brotli = zlib.createBrotliCompress, from = Readable.from;
      t.mock.method(zlib, 'createGzip', (options?: zlib.ZlibOptions) => record(gzip(options)));
      t.mock.method(zlib, 'createBrotliCompress', (options?: zlib.BrotliOptions) => record(brotli(options)));
      t.mock.method(Readable, 'from', (iterable: Iterable<unknown> | AsyncIterable<unknown>, options?: Parameters<typeof from>[1]) => {
        const source = from(iterable, options);
        sources.set(creating, source);
        return source;
      });
      syncBuiltinESMExports();
      const app = Fastify();
      t.after(async () => {
        for (const {stream} of codecs.values()) stream.destroy();
        for (const source of sources.values()) source.destroy();
        app.server.closeAllConnections();
        await app.close();
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      app.addHook('onRequest', async (req, reply) => {
        closed.set((req.query as {id: string}).id, new Promise(resolve => reply.raw.once('close', resolve)));
      });
      app.addHook('onSend', async (req, _reply, body) => {creating = (req.query as {id: string}).id; return body;});
      await responseCompression(app, false);
      app.get('/api/overview', (_req, reply) => reply.type('application/json').send(payload));
      await app.listen({host: '127.0.0.1', port: 0});
      const base = `http://127.0.0.1:${(app.server.address() as {port: number}).port}/api/overview`;
      const abort = (id: string) => new Promise<void>((resolve, reject) => {
        let receivedHeaders = false, receivedData = false;
        const req = request(`${base}?id=${id}`, {headers: {'accept-encoding': coding}}, res => {
          receivedHeaders = true;
          res.on('error', () => {});
          res.once('data', () => {receivedData = true; req.destroy();});
        });
        requests.set(id, req);
        req.on('error', error => {if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);});
        req.once('close', () => {
          try {
            assert.equal(receivedHeaders, phase === 'first-data');
            assert.equal(receivedData, phase === 'first-data');
            resolve();
          } catch (error) {reject(error);}
        });
        req.end();
      });
      const pending = phase === 'complete' ? [] : ['abort0', 'abort1', 'abort2'].map(abort);
      const normal = raw(`${base}?id=normal`, {'accept-encoding': coding});
      // A failed lifecycle assertion still owns and closes the concurrent request.
      void normal.catch(() => {});
      await Promise.all(pending);
      for (const id of requests.keys()) {
        assert.ok(closed.has(id), 'the aborted request reached the real encoder');
        await closed.get(id);
        const entry = codecs.get(id)!;
        assert.ok(entry, 'the real native codec was created');
        assert.equal(entry.stream.destroyed, true, `${id}: socket close destroys the native codec`);
        assert.equal((entry.stream as Codec & {_handle: unknown})._handle, null, `${id}: native handle closes without GC`);
        assert.equal(sources.get(id)?.destroyed, true, `${id}: pipeline source closes too`);
        assert.equal(entry.closed, true, `${id}: native close event has fired`);
      }
      const produced = [...codecs].filter(([id]) => id.startsWith('abort')).map(([id, entry]) => [id, entry.produced] as const);
      const complete = await normal;
      assert.equal(complete.headers['content-encoding'], coding);
      assert.equal(complete.decoded.toString(), payload, 'a concurrent reader finishes unchanged');
      await closed.get('normal');
      const normalCodec = codecs.get('normal')!;
      assert.equal(normalCodec.produced, complete.wire.length);
      assert.equal(normalCodec.stream.destroyed, true, 'normal completion closes the native codec');
      assert.equal(normalCodec.closed, true);
      assert.equal(sources.get('normal')?.destroyed, true);
      for (const [id, bytes] of produced) assert.equal(codecs.get(id)!.produced, bytes, `${id}: no output after native close`);
      await app.close();
    });
  }
});
