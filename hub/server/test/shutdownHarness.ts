import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';

const hubDir = fileURLToPath(new URL('../..', import.meta.url));
export const TOKEN = 'qt_m_shutdown-synthetic-token-0123456789';
export const signalOptions = {skip: process.platform === 'win32' && 'Windows has no POSIX signals'};

export async function start(t: TestContext, local = false, scenario = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'quotum-shutdown-'));
  const store = new Store(path.join(dir, 'quotum.sqlite'));
  const directory = new Directory(store.db);
  const user = directory.createUser('shutdown@example.com', 'Shutdown', '!', Date.now());
  directory.createToken(TOKEN, 'test', user.id, local ? 'Quotum app' : 'fixture', Date.now());
  store.close();
  const env = {
    PATH: process.env.PATH, QUOTUM_DATA_DIR: dir, QUOTUM_PORT: '0', QUOTUM_RESETS: 'off',
    QUOTUM_BIND: '127.0.0.1', QUOTUM_TEST_STOP: scenario,
    QUOTUM_SECRET_KEY: Buffer.alloc(32, 37).toString('base64url'),
    ...(local ? {QUOTUM_LOCAL_KEY: 'k'.repeat(43), QUOTUM_LOCAL_TOKEN: TOKEN} : {}),
    ...(process.platform === 'win32' ? {SystemRoot: process.env.SystemRoot, TEMP: tmpdir()} : {}),
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/test/fixtures/shutdown.ts'], {cwd: hubDir, env, stdio: ['pipe', 'pipe', 'pipe']});
  const exited = new Promise<{code: number | null; signal: string | null}>(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(dir, {recursive: true, force: true});
  });
  let output = '';
  child.stderr.on('data', chunk => output += chunk);
  const port = await deadline(new Promise<number>((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(line => line.startsWith('{"event":"start"'));
      if (line) resolve(JSON.parse(line).port);
    });
    child.once('error', reject);
    void exited.then(() => reject(new Error(output)));
  }), 10_000);
  return {child, exited, port, dir, output: () => output};
}

export async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);})]); }
  finally { clearTimeout(timer!); }
}

export async function partial(t: TestContext, port: number, body = '{', length = 1000) {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await new Promise<void>(resolve => socket.once('connect', resolve));
  socket.write(`POST /v1/ingest HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n${body}`);
  // Headers and the first body byte are in flight before the signal.
  await new Promise(resolve => setTimeout(resolve, 100));
  return socket;
}

export function audited(dir: string) {
  assert.equal(readFileSync(path.join(dir, 'closed'), 'utf8'), 'closed\n', 'SQLite closes exactly once');
  const db = new DatabaseSync(path.join(dir, 'quotum.sqlite'));
  try { assert.deepEqual({...db.prepare('PRAGMA quick_check').get()}, {quick_check: 'ok'}); }
  finally { db.close(); }
}
