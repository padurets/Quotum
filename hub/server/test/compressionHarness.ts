import {request, type IncomingHttpHeaders} from 'node:http';
import type {TestContext} from 'node:test';
import {brotliDecompressSync, gunzipSync} from 'node:zlib';
import {buildApp} from '../api.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {ResetFeed} from '../resets.js';
import {Setup} from '../setup.js';

export const NOW = Date.parse('2026-10-10T12:00:00Z');
const COOKIE = 'quotum_session=qt_s_compression-fixture-0123456789';
export const NEGOTIATION: [string | undefined, string | undefined][] = [
  ['br,gzip', 'br'], ['gzip', 'gzip'], ['gzip;q=0,*;q=1', 'br'],
  ['br;q=0,gzip;q=0,*;q=1', undefined], ['*;q=0.5,gzip;q=0', 'br'],
  ['br;q=0.3,gzip;q=0.7', 'gzip'], ['identity;q=1,*;q=0.5', undefined],
  ['*;q=0,br;q=0.8', 'br'], ['x-gzip;q=0,*;q=1', 'br'],
  ['zstd', undefined], ['', undefined], [undefined, undefined],
  ['br;q=0,br;q=1,*;q=0.5', 'gzip'], ['BR;q=0.5,GZIP;q=0.5', 'br'],
  ['gzip;q=1,x-gzip;q=0,*;q=0.5', 'br'], ['br;q=invalid,gzip', undefined],
  ['br;q=1.1,gzip', undefined], ['br;q=0.1234,gzip', undefined],
  ['*;q=1,*;q=0', undefined], ['identity', undefined],
];

export function raw(url: string, headers: Record<string, string> = {}, method = 'GET', body?: Buffer) {
  return new Promise<{status: number; headers: IncomingHttpHeaders; wire: Buffer; decoded: Buffer}>((resolve, reject) => {
    const req = request(url, {method, headers}, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const wire = Buffer.concat(chunks), coding = res.headers['content-encoding'];
        try { resolve({status: res.statusCode!, headers: res.headers, wire, decoded: method === 'HEAD' ? wire : coding === 'br' ? brotliDecompressSync(wire) : coding === 'gzip' ? gunzipSync(wire) : wire}); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function fixture(t: TestContext, local = false, observedAt = NOW - 1000) {
  t.mock.method(Date, 'now', () => NOW);
  const store = new Store(':memory:', NOW), directory = new Directory(store.db);
  const user = directory.createUser('compression@example.com', 'Compression', '!', NOW);
  directory.createSession(COOKIE.split('=')[1], user.id, NOW, 86_400_000);
  const authorization = 'Bearer qt_m_compression-synthetic-token-0123456789';
  directory.createToken(authorization.slice(7), 'fixture', user.id, 'fixture', NOW);
  const board = directory.boards(user.id)[0].id;
  for (let i = 0; i < 40; i++) {
    const source = store.source('codex', i.toString(16).padStart(24, '0'), NOW);
    store.hold(source, user.id, NOW);
    store.record(source, {observedAt, plan: 'pro', staleAfterMs: 204_000, resets: null, windows: [
      {id: 'weekly', kind: 'weekly', remaining: 65, used: 35, label: null, resetAt: NOW + 86_400_000, minutes: 10080},
    ]});
  }
  const ingest = new Ingest(store, directory, new Duty(), new Cadence());
  const app = await buildApp({store, directory, ingest, resets: new ResetFeed(undefined, () => {}), pairing: new Pairing(directory), setup: new Setup(false, null), local: local ? {key: 'k'.repeat(43)} : null}, app => {
    app.get('/test/json', () => ({text: 'a'.repeat(5000)}));
    app.post('/test/json', () => ({text: 'a'.repeat(5000)}));
  });
  const received: {encoding: string | undefined; route: string}[] = [];
  app.addHook('onResponse', async request => {received.push({encoding: request.raw.headers['accept-encoding'], route: request.routeOptions.url ?? ''});});
  await app.listen({host: '127.0.0.1', port: 0});
  const base = `http://127.0.0.1:${(app.server.address() as {port: number}).port}`;
  t.after(async () => {await app.close(); store.close();});
  return {app, base, board, cookie: COOKIE, store, authorization, received};
}
