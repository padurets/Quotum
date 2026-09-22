import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildApp} from '../api.js';
import {config} from '../config.js';
import {Duty} from '../duty.js';
import {Ingest} from '../ingest.js';
import {Pairing} from '../pairing.js';
import {ResetFeed} from '../sources/resets.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';
import {hashPassword, normalizeUserCode, verifyPassword} from '../domain/auth.js';

const iso = (ms: number) => new Date(ms).toISOString();

async function hub() {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-api-')), 'db.sqlite'));
  const directory = new Directory(store.db);
  const ingest = new Ingest(store, directory, [], new Duty());
  const app = await buildApp({store, directory, resets: new ResetFeed(() => {}), ingest, pairing: new Pairing(directory)});
  const cookies = new Map<string, string>();
  const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, options: {as?: string; body?: object; headers?: Record<string, string>} = {}) => {
    const response = await app.inject({
      method,
      url,
      payload: options.body,
      headers: {...(options.as && cookies.get(options.as) ? {cookie: cookies.get(options.as)!} : {}), ...options.headers},
    });
    const set = response.headers['set-cookie'];
    if (options.as && typeof set === 'string') cookies.set(options.as, set.split(';')[0]);
    const json = String(response.headers['content-type'] ?? '').includes('json');
    return {status: response.statusCode, body: json ? JSON.parse(response.body) : response.body, cookie: set};
  };
  return {app, call};
}

const snapshot = (at: number) => ({
  provider: 'codex',
  account: 'a1b2c3d4e5f6a1b2c3d4e5f6',
  observedAt: iso(at),
  via: 'codex/app-server',
  staleAfterMs: 204_000,
  windows: [{id: 'weekly', kind: 'weekly', minutes: 10080, usedPercent: 8, resetsAt: iso(at + 86_400_000)}],
});
const machine = (id: string) => ({id, name: 'build-01', os: 'linux', arch: 'x86_64'});
const batch = (id: string) => ({version: 1, agent: 'quotum/0.1.0', machine: machine(id), sentAt: iso(Date.now()), snapshots: [snapshot(Date.now() - 1000)]});

test('passwords are salted scrypt hashes; typed codes are forgiving', async () => {
  const stored = await hashPassword('correct horse');
  assert.match(stored, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(stored, await hashPassword('correct horse'));
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('wrong horse', stored), false);
  assert.equal(normalizeUserCode('bcdf ghjk'), 'BCDF-GHJK');
  assert.equal(normalizeUserCode('BCDF-GHJ0'), null, 'zero is not in the alphabet');
});

test('the first person to sign up owns the default board; later ones need an invite', async () => {
  const {call} = await hub();
  assert.deepEqual((await call('GET', '/api/session')).body.signup, {first: true, open: true});
  assert.equal((await call('GET', '/api/overview')).status, 401);

  const signup = await call('POST', '/api/auth/signup', {as: 'alice', body: {email: 'Alice@Example.com', name: 'Alice', password: 'correct horse'}});
  assert.equal(signup.status, 200);
  assert.match(String(signup.cookie), /quotum_session=qt_s_.+; Path=\/; HttpOnly; SameSite=Lax/);
  assert.deepEqual(signup.body.boards.map((b: any) => [b.id, b.role]), [['default', 'owner']]);
  assert.equal(signup.body.user.role, 'admin');

  assert.equal((await call('POST', '/api/auth/signup', {as: 'bob', body: {email: 'bob@example.com', name: 'Bob', password: 'correct horse'}})).body.error, 'signup_closed');

  const team = await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}});
  const invite = await call('POST', `/api/boards/${team.body.id}/invites`, {as: 'alice'});
  const secret = invite.body.url.split('/invite/')[1];
  assert.equal((await call('GET', `/api/invites/${secret}`)).body.board.name, 'Team');
  const bob = await call('POST', '/api/auth/signup', {as: 'bob', body: {email: 'bob@example.com', name: 'Bob', password: 'correct horse', invite: secret}});
  assert.deepEqual(bob.body.boards.map((b: any) => [b.name, b.personal]), [['', true], ['Team', false]]);
  assert.equal((await call('GET', '/api/overview?board=default', {as: 'bob'})).status, 404, "bob cannot read alice's board");

  assert.equal((await call('POST', '/api/auth/login', {body: {email: 'alice@example.com', password: 'wrong'}})).status, 401);
  assert.equal((await call('POST', '/api/auth/login', {as: 'alice2', body: {email: 'alice@example.com', password: 'correct horse'}})).status, 200);
  await call('POST', '/api/auth/logout', {as: 'alice2'});
  assert.equal((await call('GET', '/api/session', {as: 'alice2'})).body.user, null);
});

test('a board token lets any number of machines deliver; revoking it disconnects them', async () => {
  const {call} = await hub();
  await call('POST', '/api/auth/signup', {as: 'alice', body: {email: 'alice@example.com', name: 'Alice', password: 'correct horse'}});
  const token = await call('POST', '/api/boards/default/tokens', {as: 'alice', body: {name: 'Dev images'}});
  assert.match(token.body.secret, /^qt_b_/);
  assert.equal((await call('GET', '/api/boards/default/tokens', {as: 'alice'})).body[0].secret, undefined, 'shown once');

  const auth = {authorization: `Bearer ${token.body.secret}`};
  for (const id of ['machine-one-0123456789', 'machine-two-0123456789']) {
    const delivered = await call('POST', '/v1/ingest', {body: batch(id), headers: auth});
    assert.deepEqual([delivered.status, delivered.body.accepted + delivered.body.duplicates, delivered.body.device.owner], [200, 1, 'Alice']);
  }
  const devices = (await call('GET', '/api/boards/default/devices', {as: 'alice'})).body;
  const overview = (await call('GET', '/api/overview', {as: 'alice'})).body;
  const [codex] = overview.sources;
  assert.deepEqual([overview.sources.length, codex.provider, codex.windows[0].remaining, codex.owners], [1, 'codex', 92, ['Alice']]);
  assert.deepEqual(devices.map((d: any) => [d.via, d.sources.map((s: any) => s.source)]), [['token', [codex.id]], ['token', [codex.id]]]);

  await call('DELETE', `/api/boards/default/tokens/${token.body.id}`, {as: 'alice'});
  assert.equal((await call('POST', '/v1/ingest', {body: batch('machine-one-0123456789'), headers: auth})).status, 401);
  assert.deepEqual((await call('GET', '/api/boards/default/devices', {as: 'alice'})).body, []);
});

test('a machine connects with a one-time code approved by a signed-in person', async () => {
  const {call} = await hub();
  await call('POST', '/api/auth/signup', {as: 'alice', body: {email: 'alice@example.com', name: 'Alice', password: 'correct horse'}});
  const started = await call('POST', '/v1/device/code', {body: {machine: machine('laptop-0123456789ab'), agent: 'quotum/0.1.0'}});
  assert.match(started.body.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(started.body.verificationUriComplete, `http://localhost:80/device?code=${started.body.userCode}`);
  const poll = () => call('POST', '/v1/device/token', {body: {deviceCode: started.body.deviceCode}});
  assert.equal((await poll()).body.error, 'authorization_pending');
  assert.equal((await poll()).body.error, 'slow_down');

  const typed = started.body.userCode.toLowerCase().replace('-', ' ');
  const pending = await call('GET', `/api/device?code=${encodeURIComponent(typed)}`, {as: 'alice'});
  assert.deepEqual([pending.body.machine.name, pending.body.boards.map((b: any) => b.id)], ['build-01', ['default']]);
  assert.equal((await call('POST', '/api/device/approve', {as: 'alice', body: {code: typed, board: 'nope'}})).status, 400);
  assert.equal((await call('POST', '/api/device/approve', {as: 'alice', body: {code: typed, board: 'default'}})).status, 200);

  const connected = await call('POST', '/v1/device/token', {body: {deviceCode: started.body.deviceCode}});
  assert.match(connected.body.token, /^qt_d_/);
  assert.deepEqual([connected.body.board.id, connected.body.device.owner], ['default', 'Alice']);
  assert.equal((await poll()).body.error, 'expired_token', 'a code gives one device');

  const delivered = await call('POST', '/v1/ingest', {body: batch('laptop-0123456789ab'), headers: {authorization: `Bearer ${connected.body.token}`}});
  assert.equal(delivered.status, 200);
  const [device] = (await call('GET', '/api/boards/default/devices', {as: 'alice'})).body;
  assert.deepEqual([device.via, device.owner, device.ownerUserId !== null], ['code', 'Alice', true]);
  await call('DELETE', `/api/boards/default/devices/${device.id}`, {as: 'alice'});
  assert.equal((await call('POST', '/v1/ingest', {body: batch('laptop-0123456789ab'), headers: {authorization: `Bearer ${connected.body.token}`}})).status, 401);
});

test('changes from another origin, unknown hosts and other methods are refused', async () => {
  const {call} = await hub();
  await call('POST', '/api/auth/signup', {as: 'alice', body: {email: 'alice@example.com', name: 'Alice', password: 'correct horse'}});
  assert.equal((await call('POST', '/api/boards', {as: 'alice', body: {name: 'x'}, headers: {origin: 'https://evil.example'}})).status, 403);
  assert.equal((await call('POST', '/api/boards', {as: 'alice', body: {name: 'x'}, headers: {origin: 'http://localhost:80'}})).status, 200);
  assert.equal((await call('GET', '/api/session', {headers: {host: 'evil.example'}})).status, 403);
  assert.equal((await call('DELETE', '/v1/ingest')).status, 405);
  assert.equal((await call('POST', '/v1/ingest', {body: batch('x-0123456789abcdef')})).status, 401);
  if (existsSync(path.join(config.clientRoot, 'index.html'))) {
    assert.equal((await call('GET', '/device')).status, 200, 'client pages are served by the single-page client');
  }
  assert.equal((await call('GET', '/api/nothing')).status, 404);
});
