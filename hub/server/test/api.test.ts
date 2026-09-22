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
import {ResetFeed} from '../resets.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';
import {hashPassword, normalizeUserCode, verifyPassword} from '../domain/auth.js';
import {Setup} from '../setup.js';

const iso = (ms: number) => new Date(ms).toISOString();
const ORIGIN = 'http://localhost';
const SETUP = 'BCDF-GHJK';
const EMPTY = {order: [], hidden: [], windows: [], plans: {}};

async function hub() {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-api-')), 'db.sqlite'));
  const directory = new Directory(store.db);
  const app = await buildApp({
    store,
    directory,
    resets: new ResetFeed(() => {}),
    ingest: new Ingest(store, directory, new Duty()),
    pairing: new Pairing(directory),
    setup: new Setup(true, SETUP),
  });
  const cookies = new Map<string, string>();
  const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, options: {as?: string; body?: object | string; headers?: Record<string, string>} = {}) => {
    const response = await app.inject({
      method,
      url,
      payload: options.body,
      headers: {
        ...(typeof options.body === 'string' ? {'content-type': 'application/json'} : {}),
        ...(options.as && cookies.get(options.as) ? {cookie: cookies.get(options.as)!} : {}),
        ...options.headers,
      },
    });
    const set = response.headers['set-cookie'];
    if (options.as && typeof set === 'string') cookies.set(options.as, set.split(';')[0]);
    const json = String(response.headers['content-type'] ?? '').includes('json');
    return {status: response.statusCode, body: json ? JSON.parse(response.body) : response.body, cookie: set};
  };
  /** Signs someone up and returns their personal board. */
  const person = async (as: string, invite?: string) => {
    const body = {email: `${as}@example.com`, name: as[0].toUpperCase() + as.slice(1), password: 'correct horse', invite, setupCode: SETUP};
    const signup = await call('POST', '/api/auth/signup', {as, body});
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    return signup.body.boards.find((b: any) => b.personal).id as string;
  };
  return {app, call, person};
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
const batch = (id: string, failures: object[] = []) => ({
  version: 1,
  agent: 'quotum/0.1.0',
  machine: machine(id),
  sentAt: iso(Date.now()),
  snapshots: [snapshot(Date.now() - 1000)],
  failures,
});

test('passwords are salted scrypt hashes; typed codes are forgiving', async () => {
  const stored = await hashPassword('correct horse');
  assert.match(stored, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(stored, await hashPassword('correct horse'));
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('wrong horse', stored), false);
  assert.equal(normalizeUserCode('bcdf ghjk'), 'BCDF-GHJK');
  assert.equal(normalizeUserCode('BCDF-GHJ0'), null, 'zero is not in the alphabet');
});

test('the first person signs up freely and gets a personal board; later ones need an invite', async () => {
  const {call} = await hub();
  assert.deepEqual((await call('GET', '/api/session')).body.signup, {first: true, open: true});
  assert.equal((await call('GET', '/api/overview')).status, 401);

  const claim = {email: 'Alice@Example.com', name: 'Alice', password: 'correct horse'};
  assert.equal((await call('POST', '/api/auth/signup', {body: claim})).body.error, 'invalid_setup_code', 'a new hub needs the code from its log');
  assert.equal((await call('POST', '/api/auth/signup', {body: {...claim, setupCode: 'BCDF-GHJJ'}})).body.error, 'invalid_setup_code');
  const signup = await call('POST', '/api/auth/signup', {as: 'alice', body: {...claim, setupCode: 'bcdf ghjk'}});
  assert.equal(signup.status, 200);
  assert.match(String(signup.cookie), /quotum_session=qt_s_.+; Path=\/; HttpOnly; SameSite=Lax/);
  assert.deepEqual(signup.body.boards.map((b: any) => [b.name, b.personal, b.role]), [['', true, 'owner']]);
  assert.equal(signup.body.user.email, 'alice@example.com');
  const alices = signup.body.boards[0].id;

  assert.equal((await call('POST', '/api/auth/signup', {as: 'bob', body: {email: 'bob@example.com', name: 'Bob', password: 'correct horse'}})).body.error, 'signup_closed');

  const team = await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}});
  assert.equal((await call('POST', `/api/boards/${alices}/invites`, {as: 'alice'})).status, 403, 'no invites to a personal board');
  const invite = await call('POST', `/api/boards/${team.body.id}/invites`, {as: 'alice'});
  const secret = invite.body.url.split('/invite/')[1];
  assert.equal((await call('GET', `/api/invites/${secret}`)).body.board.name, 'Team');
  const bob = await call('POST', '/api/auth/signup', {as: 'bob', body: {email: 'bob@example.com', name: 'Bob', password: 'correct horse', invite: secret}});
  assert.deepEqual(bob.body.boards.map((b: any) => [b.name, b.personal, b.role]), [['', true, 'owner'], ['Team', false, 'member']]);
  assert.equal(bob.body.joined, team.body.id);
  assert.equal((await call('GET', `/api/overview?board=${alices}`, {as: 'bob'})).status, 404, "bob cannot read alice's board");
  assert.equal((await call('POST', `/api/boards/${team.body.id}/invites`, {as: 'bob'})).status, 403, 'members do not invite');

  assert.equal((await call('POST', '/api/auth/login', {body: {email: 'alice@example.com', password: 'wrong'}})).status, 401);
  assert.equal((await call('POST', '/api/auth/login', {as: 'alice2', body: {email: 'alice@example.com', password: 'correct horse'}})).status, 200);
  await call('POST', '/api/auth/logout', {as: 'alice2'});
  assert.equal((await call('GET', '/api/session', {as: 'alice2'})).body.user, null);
});

test('someone with an account who signs in from an invite link joins the board', async () => {
  const {call, person} = await hub();
  await person('alice');
  const team = await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}});
  const secret = (await call('POST', `/api/boards/${team.body.id}/invites`, {as: 'alice'})).body.url.split('/invite/')[1];
  await call('POST', '/api/auth/signup', {as: 'carol', body: {email: 'carol@example.com', name: 'Carol', password: 'correct horse', invite: secret}});
  const carol = await call('POST', '/api/auth/login', {as: 'carol2', body: {email: 'carol@example.com', password: 'correct horse', invite: secret}});
  assert.equal(carol.body.joined, team.body.id);
});

test('a board token lets any number of machines deliver; revoking it disconnects them', async () => {
  const {call, person} = await hub();
  const board = await person('alice');
  const token = await call('POST', `/api/boards/${board}/tokens`, {as: 'alice', body: {name: 'Dev images'}});
  assert.match(token.body.secret, /^qt_b_/);
  const listed = (await call('GET', `/api/boards/${board}/tokens`, {as: 'alice'})).body;
  assert.deepEqual([listed[0].secret, listed[0].mine, listed[0].createdBy], [undefined, true, undefined], 'shown once, no user ids');

  const auth = {authorization: `Bearer ${token.body.secret}`};
  for (const id of ['machine-one-0123456789', 'machine-two-0123456789']) {
    const delivered = await call('POST', '/v1/ingest', {body: batch(id), headers: auth});
    assert.deepEqual([delivered.status, delivered.body.accepted + delivered.body.duplicates, delivered.body.device.owner], [200, 1, 'Alice']);
  }
  const devices = (await call('GET', `/api/boards/${board}/devices`, {as: 'alice'})).body;
  const overview = (await call('GET', '/api/overview', {as: 'alice'})).body;
  const [codex] = overview.sources;
  assert.deepEqual([overview.sources.length, codex.provider, codex.windows[0].remaining, codex.windows[0].kind, codex.owners], [1, 'codex', 92, 'weekly', ['Alice']]);
  assert.deepEqual(devices.map((d: any) => [d.via, d.mine, d.sources.map((s: any) => s.source)]), [['token', true, [codex.id]], ['token', true, [codex.id]]]);
  assert.equal(devices[0].machineId, undefined, 'machine ids stay on the hub');

  await call('DELETE', `/api/boards/${board}/tokens/${token.body.id}`, {as: 'alice'});
  assert.equal((await call('POST', '/v1/ingest', {body: batch('machine-one-0123456789'), headers: auth})).status, 401);
  assert.deepEqual((await call('GET', `/api/boards/${board}/devices`, {as: 'alice'})).body, []);
});

test('members manage their own tokens and devices; the owner manages all and removes sources', async () => {
  const {call, person} = await hub();
  await person('alice');
  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  const secret = (await call('POST', `/api/boards/${team}/invites`, {as: 'alice'})).body.url.split('/invite/')[1];
  await person('bob', secret);

  const alices = (await call('POST', `/api/boards/${team}/tokens`, {as: 'alice', body: {}})).body;
  const bobs = (await call('POST', `/api/boards/${team}/tokens`, {as: 'bob', body: {name: 'laptops'}})).body;
  assert.equal(alices.name, '', 'no name: the dashboard shows a default in its language');
  await call('POST', '/v1/ingest', {body: batch('bobs-laptop-0123456789'), headers: {authorization: `Bearer ${bobs.secret}`}});
  await call('POST', '/v1/ingest', {body: batch('alices-box-0123456789'), headers: {authorization: `Bearer ${alices.secret}`}});
  const devices = (await call('GET', `/api/boards/${team}/devices`, {as: 'bob'})).body;
  const alicesBox = devices.find((d: any) => d.owner === 'Alice');

  assert.equal((await call('DELETE', `/api/boards/${team}/tokens/${alices.id}`, {as: 'bob'})).status, 403);
  assert.equal((await call('DELETE', `/api/boards/${team}/devices/${alicesBox.id}`, {as: 'bob'})).status, 403);
  assert.equal((await call('DELETE', `/api/boards/${team}/tokens/${bobs.id}`, {as: 'bob'})).status, 200);
  assert.equal((await call('DELETE', `/api/boards/${team}/tokens/${bobs.id}`, {as: 'alice'})).status, 404, 'already revoked');

  assert.equal((await call('POST', `/api/boards/${team}`, {as: 'bob', body: {name: 'Mine now'}})).status, 403, 'only the owner renames');
  assert.equal((await call('POST', `/api/boards/${team}`, {as: 'alice', body: {name: ''}})).status, 400, 'a shared board needs a name');
  assert.equal((await call('POST', `/api/boards/${team}`, {as: 'alice', body: {name: 'Platform team'}})).body.name, 'Platform team');
  assert.equal((await call('DELETE', `/api/boards/${team}/devices/${alicesBox.id}`, {as: 'alice'})).status, 200);
});

test('the owner arranges a board, and everyone on it sees it that way', async () => {
  const {call, person} = await hub();
  await person('alice');
  const board = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await person('bob', (await call('POST', `/api/boards/${board}/invites`, {as: 'alice'})).body.url.split('/invite/')[1]);
  const token = (await call('POST', `/api/boards/${board}/tokens`, {as: 'bob', body: {}})).body.secret;
  await call('POST', '/v1/ingest', {body: batch('machine-one-0123456789'), headers: {authorization: `Bearer ${token}`}});
  const overview = (await call('GET', `/api/overview?board=${board}`, {as: 'bob'})).body;
  assert.deepEqual(overview.view, {order: [], hidden: [], windows: [], plans: {}}, 'nothing arranged yet');
  const source = overview.sources[0].id;
  const view = {order: ['history', `source:${source}`], hidden: ['history'], windows: [`${source}/weekly`], plans: {[source]: [50, 50, 0, 0, 0, 0, 0]}};
  assert.deepEqual((await call('POST', `/api/boards/${board}/view`, {as: 'alice', body: view})).body, view);
  assert.deepEqual((await call('GET', `/api/overview?board=${board}`, {as: 'bob'})).body.view, view);
  assert.equal((await call('POST', `/api/boards/${board}/view`, {as: 'bob', body: EMPTY})).status, 403, 'a member only looks');
  assert.equal((await call('POST', `/api/boards/${board}/view`, {as: 'alice', body: {...view, plans: {[source]: [50, 60, 0, 0, 0, 0, 0]}}})).status, 400);
  // A personal board can be renamed and given its default name back; a shared one needs a name.
  const personal = (await call('GET', '/api/session', {as: 'bob'})).body.boards.find((b: any) => b.personal).id;
  assert.equal((await call('POST', `/api/boards/${personal}`, {as: 'bob', body: {name: 'Work'}})).body.name, 'Work');
  assert.equal((await call('POST', `/api/boards/${personal}`, {as: 'bob', body: {name: ''}})).body.name, '');
  assert.equal((await call('POST', `/api/boards/${board}`, {as: 'alice', body: {name: ''}})).status, 400);
});

test('a person changes their name freely, their email and password only with the current password', async () => {
  const {call, person} = await hub();
  await person('alice');
  await call('POST', '/api/auth/login', {as: 'alice-phone', body: {email: 'alice@example.com', password: 'correct horse'}});
  assert.equal((await call('POST', '/api/account', {as: 'alice', body: {name: 'Alice L.'}})).body.user.name, 'Alice L.');
  assert.equal((await call('POST', '/api/account', {as: 'alice', body: {email: 'al@example.com', currentPassword: 'wrong'}})).status, 403);
  const changed = await call('POST', '/api/account', {as: 'alice', body: {email: 'AL@example.com', password: 'battery staple', currentPassword: 'correct horse'}});
  assert.equal(changed.body.user.email, 'al@example.com');
  assert.equal((await call('GET', '/api/session', {as: 'alice'})).body.user?.name, 'Alice L.', 'this session stays');
  assert.equal((await call('GET', '/api/session', {as: 'alice-phone'})).body.user, null, 'the other ones end with the old password');
  assert.equal((await call('POST', '/api/auth/login', {body: {email: 'al@example.com', password: 'battery staple'}})).status, 200);
});

test('a device shows the failures it reports until it delivers again', async () => {
  const {call, person} = await hub();
  const board = await person('alice');
  const token = (await call('POST', `/api/boards/${board}/tokens`, {as: 'alice', body: {}})).body;
  const auth = {authorization: `Bearer ${token.secret}`};
  const failure = {provider: 'claude', observedAt: iso(Date.now()), error: 'not_logged_in', detail: 'run claude and /login'};
  await call('POST', '/v1/ingest', {body: {...batch('machine-one-0123456789', [failure]), snapshots: []}, headers: auth});
  const [device] = (await call('GET', `/api/boards/${board}/devices`, {as: 'alice'})).body;
  assert.deepEqual(device.failures.map((f: any) => [f.provider, f.error, f.detail]), [['claude', 'not_logged_in', 'run claude and /login']]);
});

test('a machine connects with a one-time code approved by a signed-in person', async () => {
  const {call, person} = await hub();
  const board = await person('alice');
  const started = await call('POST', '/v1/device/code', {body: {machine: machine('laptop-0123456789ab'), agent: 'quotum/0.1.0'}});
  assert.match(started.body.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(started.body.verificationUriComplete, `${ORIGIN}/device?code=${started.body.userCode}`);
  const poll = () => call('POST', '/v1/device/token', {body: {deviceCode: started.body.deviceCode}});
  assert.equal((await poll()).body.error, 'authorization_pending');
  assert.equal((await poll()).body.error, 'slow_down');

  const typed = started.body.userCode.toLowerCase().replace('-', ' ');
  const pending = await call('GET', `/api/device?code=${encodeURIComponent(typed)}`, {as: 'alice'});
  assert.deepEqual([pending.body.machine.name, pending.body.boards.map((b: any) => b.id)], ['build-01', [board]]);
  assert.equal((await call('POST', '/api/device/approve', {as: 'alice', body: {code: typed, board: 'nope'}})).status, 400);
  const other = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Other'}})).body.id;
  const mallory = await person('mallory', (await call('POST', `/api/boards/${other}/invites`, {as: 'alice'})).body.url.split('/invite/')[1]);
  assert.equal((await call('POST', '/api/device/approve', {as: 'alice', body: {code: typed, board: mallory}})).status, 400, 'only to a board of the approver');
  assert.equal((await call('POST', '/api/device/approve', {as: 'alice', body: {code: typed, board}})).status, 200);

  const connected = await call('POST', '/v1/device/token', {body: {deviceCode: started.body.deviceCode}});
  assert.match(connected.body.token, /^qt_d_/);
  assert.deepEqual([connected.body.board.id, connected.body.device.owner], [board, 'Alice']);
  assert.equal((await poll()).body.error, 'expired_token', 'a code gives one device');

  const device = {authorization: `Bearer ${connected.body.token}`};
  assert.equal((await call('POST', '/v1/ingest', {body: batch('laptop-0123456789ab'), headers: device})).status, 200);
  // A board token cannot take over the machine connected with a code.
  const boardToken = (await call('POST', `/api/boards/${board}/tokens`, {as: 'alice', body: {}})).body.secret;
  const takeover = await call('POST', '/v1/ingest', {body: batch('laptop-0123456789ab'), headers: {authorization: `Bearer ${boardToken}`}});
  assert.deepEqual([takeover.status, takeover.body.error], [403, 'device_conflict']);

  const [listed] = (await call('GET', `/api/boards/${board}/devices`, {as: 'alice'})).body;
  assert.deepEqual([listed.via, listed.owner, listed.mine], ['code', 'Alice', true]);
  await call('DELETE', `/api/boards/${board}/devices/${listed.id}`, {as: 'alice'});
  const removed = await call('POST', '/v1/ingest', {body: batch('laptop-0123456789ab'), headers: device});
  assert.deepEqual([removed.status, removed.body.error], [403, 'device_revoked']);
  assert.equal((await call('POST', '/v1/checkin', {body: {version: 1}, headers: device})).status, 403);
});

test('agents get errors in the spec’s terms', async () => {
  const {call, person} = await hub();
  const board = await person('alice');
  const auth = {authorization: `bearer ${(await call('POST', `/api/boards/${board}/tokens`, {as: 'alice', body: {}})).body.secret}`};
  const checkin = await call('POST', '/v1/checkin', {body: {version: 1, agent: 'quotum/0.1.0', machine: machine('m-0123456789ab')}, headers: auth});
  assert.deepEqual([checkin.status, checkin.body.subscriptions], [200, []], 'the scheme is case-insensitive');
  const bad = await call('POST', '/v1/checkin', {body: {version: 1, agent: 'quotum/0.1.0', machine: machine('m-0123456789ab'), subscriptions: [{provider: 'claude', account: 'someone@example.com'}]}, headers: auth});
  assert.deepEqual([bad.status, bad.body], [400, {error: 'invalid_request', detail: 'account'}], 'accounts are pseudonyms, never raw ids');
  const broken = await call('POST', '/v1/ingest', {body: '{"version": 1,', headers: auth});
  assert.deepEqual([broken.status, broken.body], [400, {error: 'invalid_batch'}]);
  const wrong = await call('POST', '/v1/ingest', {body: {...batch('m-0123456789ab'), version: 2}, headers: auth});
  assert.deepEqual([wrong.status, wrong.body], [400, {error: 'invalid_batch', detail: 'version'}]);
});

test('changes from another origin, unknown hosts and other methods are refused', async () => {
  const {call, person} = await hub();
  await person('alice');
  assert.equal((await call('POST', '/api/boards', {as: 'alice', body: {name: 'x'}, headers: {origin: 'https://evil.example'}})).status, 403);
  assert.equal((await call('POST', '/api/boards', {as: 'alice', body: {name: 'x'}, headers: {origin: 'http://localhost:9999'}})).status, 403, 'the port is part of the origin');
  assert.equal((await call('POST', '/api/boards', {as: 'alice', body: {name: 'x'}, headers: {origin: ORIGIN}})).status, 200);
  assert.equal((await call('GET', '/api/session', {headers: {host: 'evil.example'}})).status, 403);
  assert.equal((await call('GET', '/api/session', {headers: {cookie: 'quotum_session=%E0%A4%A'}})).body.user, null, 'a malformed cookie is no session');
  assert.equal((await call('GET', '/api/history?range=1y', {as: 'alice'})).status, 400);
  assert.equal((await call('DELETE', '/v1/ingest')).status, 405);
  assert.equal((await call('POST', '/v1/ingest', {body: batch('x-0123456789abcdef')})).status, 401);
  if (existsSync(path.join(config.clientRoot, 'index.html'))) {
    assert.equal((await call('GET', '/device')).status, 200, 'client pages are served by the single-page client');
  }
  assert.equal((await call('GET', '/api/nothing')).status, 404);
});
