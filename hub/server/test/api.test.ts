import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {buildApp} from '../api.js';
import {config} from '../config.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Ingest} from '../ingest.js';
import {Pairing} from '../pairing.js';
import {ResetFeed} from '../resets.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';
import {KEEP_MS} from '../sessions.js';
import {hashPassword, normalizeUserCode, verifyPassword} from '../domain/auth.js';
import {Setup} from '../setup.js';
import {legacyLayout, MAX_ROWS, ordered, placesOf, settle, widened, withPlaces} from '../../ui/lib/grid.js';
import {MAX_ROWS as HUB_MAX_ROWS} from '../domain/view.js';

const iso = (ms: number) => new Date(ms).toISOString();
const ORIGIN = 'http://localhost';
const SETUP = 'BCDF-GHJK';
const EMPTY = {layout: {columns: 6, places: {}}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};

async function hub() {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-api-')), 'db.sqlite'));
  const directory = new Directory(store.db);
  const app = await buildApp({
    store,
    directory,
    resets: new ResetFeed(undefined, () => {}),
    ingest: new Ingest(store, directory, new Duty(), new Cadence()),
    pairing: new Pairing(directory),
    setup: new Setup(true, SETUP),
    local: null,
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
  return {app, call, person, store};
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

test('a machine token lets any number of machines deliver as its person; revoking it disconnects them and tells them so', async () => {
  const {call, person, store} = await hub();
  await person('alice');
  const token = await call('POST', '/api/tokens', {as: 'alice', body: {name: 'Dev images'}});
  assert.match(token.body.secret, /^qt_m_/);
  const listed = (await call('GET', '/api/tokens', {as: 'alice'})).body;
  assert.deepEqual([listed[0].secret, listed[0].name, listed[0].userId], [undefined, 'Dev images', undefined], 'shown once, no user ids');

  const auth = {authorization: `Bearer ${token.body.secret}`};
  for (const id of ['machine-one-0123456789', 'machine-two-0123456789']) {
    const delivered = await call('POST', '/v1/ingest', {body: batch(id), headers: auth});
    assert.deepEqual([delivered.status, delivered.body.accepted + delivered.body.duplicates], [200, 1]);
  }
  const devices = (await call('GET', '/api/devices', {as: 'alice'})).body;
  const overview = (await call('GET', '/api/overview', {as: 'alice'})).body;
  const [codex] = overview.sources;
  assert.deepEqual([overview.sources.length, codex.provider, codex.windows[0].remaining, codex.windows[0].kind, codex.owners], [1, 'codex', 92, 'weekly', ['Alice']]);
  // A weekly window measured just now has no hour of history to go by yet.
  assert.deepEqual(Object.keys(overview.forecast), [codex.id]);
  assert.equal(overview.forecast[codex.id].weekly.state, 'needData');
  assert.ok(overview.forecast[codex.id].weekly.basis.hours < 1);
  assert.ok(store.kept(`forecast:${codex.id}:weekly`), 'what it worked out is kept for a restart');
  assert.deepEqual(devices.map((d: any) => [d.via, d.sources.map((s: any) => s.source)]), [['token', [codex.id]], ['token', [codex.id]]]);
  assert.equal(devices[0].machineId, undefined, 'machine ids stay on the hub');

  await call('DELETE', `/api/tokens/${token.body.id}`, {as: 'alice'});
  const refused = await call('POST', '/v1/ingest', {body: batch('machine-one-0123456789'), headers: auth});
  assert.deepEqual([refused.status, refused.body.error], [403, 'device_revoked'], 'the agent hears it and stops');
  assert.deepEqual((await call('GET', '/api/devices', {as: 'alice'})).body, []);
});

test('people see and manage only their own machines and tokens; a device is named on the hub', async () => {
  const {call, person} = await hub();
  await person('alice');
  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await person('bob', (await call('POST', `/api/boards/${team}/invites`, {as: 'alice'})).body.url.split('/invite/')[1]);
  const alices = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  assert.equal(alices.name, '', 'no name: the dashboard shows a default in its language');
  await call('POST', '/v1/ingest', {body: batch('alices-box-0123456789'), headers: {authorization: `Bearer ${alices.secret}`}});
  const [box] = (await call('GET', '/api/devices', {as: 'alice'})).body;
  assert.deepEqual([box.name, box.reported], ['build-01', 'build-01']);

  assert.deepEqual((await call('GET', '/api/devices', {as: 'bob'})).body, []);
  assert.deepEqual((await call('GET', '/api/tokens', {as: 'bob'})).body, []);
  assert.equal((await call('DELETE', `/api/tokens/${alices.id}`, {as: 'bob'})).status, 404);
  assert.equal((await call('DELETE', `/api/devices/${box.id}`, {as: 'bob'})).status, 404);
  assert.equal((await call('POST', `/api/devices/${box.id}`, {as: 'bob', body: {name: 'mine'}})).status, 404);

  assert.equal((await call('POST', `/api/devices/${box.id}`, {as: 'alice', body: {name: 'Build server'}})).status, 200);
  assert.deepEqual((await call('GET', '/api/devices', {as: 'alice'})).body.map((d: any) => [d.name, d.reported]), [['Build server', 'build-01']]);
  await call('POST', '/v1/ingest', {body: batch('alices-box-0123456789'), headers: {authorization: `Bearer ${alices.secret}`}});
  assert.equal((await call('GET', '/api/devices', {as: 'alice'})).body[0].name, 'Build server', 'the machine reporting its name again does not undo it');
  await call('POST', `/api/devices/${box.id}`, {as: 'alice', body: {name: ''}});
  assert.equal((await call('GET', '/api/devices', {as: 'alice'})).body[0].name, 'build-01', 'an empty name gives back the reported one');
  assert.equal((await call('DELETE', `/api/devices/${box.id}`, {as: 'alice'})).status, 200);
});

test('a disconnected machine takes along what only it measured, from every board', async () => {
  const {call, person} = await hub();
  await person('alice');
  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  const laptop = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  const images = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  await call('POST', '/v1/ingest', {body: batch('alices-laptop-0123456789'), headers: {authorization: `Bearer ${laptop.secret}`}});
  await call('POST', '/v1/ingest', {body: batch('alices-image-0123456789'), headers: {authorization: `Bearer ${images.secret}`}});
  const [source] = (await call('GET', '/api/overview', {as: 'alice'})).body.sources;
  await call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source: source.id}});
  const shown = async () => [
    (await call('GET', '/api/overview', {as: 'alice'})).body.sources.length,
    (await call('GET', `/api/overview?board=${team}`, {as: 'alice'})).body.sources.length,
  ];

  await call('DELETE', `/api/tokens/${laptop.id}`, {as: 'alice'});
  assert.deepEqual(await shown(), [1, 1], 'another machine of hers still measures it');
  const [image] = (await call('GET', '/api/devices', {as: 'alice'})).body;
  await call('DELETE', `/api/devices/${image.id}`, {as: 'alice'});
  assert.deepEqual(await shown(), [0, 0], 'no machine does any more: gone from her board and the team');

  await call('POST', '/v1/ingest', {body: batch('alices-laptop-0123456789'), headers: {authorization: `Bearer ${(await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret}`}});
  assert.deepEqual(await shown(), [1, 0], 'measured again, it is hers again; sharing it is up to her');
});

test('people share their subscriptions with a shared board; its owner arranges, names, hides and takes them off', async () => {
  const {call, person, store} = await hub();
  const alices = await person('alice');
  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await person('bob', (await call('POST', `/api/boards/${team}/invites`, {as: 'alice'})).body.url.split('/invite/')[1]);
  const bobs = (await call('POST', '/api/tokens', {as: 'bob', body: {}})).body.secret;
  await call('POST', '/v1/ingest', {body: batch('bobs-laptop-0123456789'), headers: {authorization: `Bearer ${bobs}`}});

  assert.equal((await call('GET', '/api/overview', {as: 'bob'})).body.sources.length, 1, 'on his own board at once');
  assert.deepEqual((await call('GET', `/api/overview?board=${team}`, {as: 'bob'})).body.sources, [], 'on a shared board only when shared');
  const offer = (await call('GET', `/api/boards/${team}/shares`, {as: 'bob'})).body;
  const source = offer.mine[0].source;
  assert.deepEqual([offer.shared, offer.mine[0].shared], [[], false]);
  assert.equal((await call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source}})).status, 404, 'only those who measure it share it');
  assert.equal((await call('POST', `/api/boards/${team}/shares`, {as: 'bob', body: {source}})).status, 200);
  const shared = (await call('GET', `/api/overview?board=${team}`, {as: 'alice'})).body;
  assert.deepEqual(shared.sources.map((s: any) => [s.id, s.owners]), [[source, ['Bob']]]);
  assert.deepEqual((await call('GET', `/api/boards/${team}/shares`, {as: 'alice'})).body.shared, [{source, provider: 'codex', sharedBy: 'Bob', mine: false}]);

  store.db.prepare('INSERT OR REPLACE INTO views VALUES (?, ?, ?, ?)').run(team, JSON.stringify({order: ['history'], sizes: {history: 3}}), 'alice', Date.now());
  const old = (await call('GET', `/api/overview?board=${team}`, {as: 'bob'})).body.view;
  assert.deepEqual(old, {...EMPTY, order: ['history'], sizes: {history: 3}}, 'stored legacy views are returned for the page to translate');
  assert.deepEqual(shared.view, EMPTY, 'nothing arranged yet');
  const view = {...EMPTY, layout: {columns: 6, places: {history: {x: 0, y: 0, w: 6}, [`source:${source}`]: {x: 0, y: 0, w: 3}}}, names: {[source]: 'Bob’s Codex'}, hidden: ['forecast'], shown: ['agents'], windows: [`${source}/weekly`], plans: {[source]: [50, 50, 0, 0, 0, 0, 0]}, unplanned: [source], colors: {[source]: '#1fa89c'}, columns: {agents: ['machine', 'origin']}, shownColumns: {agents: ['state']}};
  assert.deepEqual((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: view})).body, view);
  assert.deepEqual((await call('GET', `/api/overview?board=${team}`, {as: 'bob'})).body.view, view);
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'bob', body: EMPTY})).status, 403, 'a member only looks');
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, plans: {[source]: [50, 60, 0, 0, 0, 0, 0]}}})).status, 400);
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, colors: {[source]: 'red; background: url(x)'}}})).status, 400, 'a colour is a hex colour');
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, columns: {agents: ['<b>']}}})).status, 400, 'a column is a short name');
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, shownColumns: {agents: ['<b>']}}})).status, 400);
  const {shownColumns: _, ...older} = view;
  assert.deepEqual((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: older})).body.shownColumns, {});
  for (const layout of [
    {columns: 12, places: {}},
    ...[{x: 1, y: 0, w: 3}, {x: 0, y: 0, w: 5}, {x: 4, y: 0, w: 3}, {x: 0, y: -1, w: 3}, {x: 0, y: 1.5, w: 3}, {x: 0, y: 100000, w: 3}, {x: 0, y: 0, w: 3, z: 1}].map(p => ({columns: 6, places: {history: p}})),
    ...[0, -1, 1.5, MAX_ROWS + 1, null, '7', true].map(h => ({columns: 6, places: {history: {x: 0, y: 0, w: 3, h}}})),
    {columns: 6, places: {history: {x: 0, y: 0, w: 3, h: 7, z: 1}}},
  ]) assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, layout}})).status, 400, JSON.stringify(layout));
  // A height the owner chose goes with its place; none while the widget follows its content.
  assert.equal(HUB_MAX_ROWS, MAX_ROWS, 'the page and the hub hold a height to the same most');
  for (const h of [1, 8, MAX_ROWS]) {
    const tall = {...view, layout: {columns: 6, places: {...view.layout.places, history: {x: 0, y: 0, w: 6, h}}}};
    assert.deepEqual((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: tall})).body, tall, `h ${h}`);
    assert.deepEqual((await call('GET', `/api/overview?board=${team}`, {as: 'bob'})).body.view, tall, 'a member sees the chosen height');
  }
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'bob', body: {...view, layout: {columns: 6, places: {history: {x: 0, y: 0, w: 6, h: 9}}}}})).status, 403, 'only the owner chooses a height');
  assert.equal((await call('POST', `/api/boards/${alices}/view`, {as: 'bob', body: {...view, layout: {columns: 6, places: {history: {x: 0, y: 0, w: 6, h: 9}}}}})).status, 404);
  const {layout: omitted, ...legacy} = view;
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: legacy})).status, 400, 'old pages cannot erase a grid');
  const large = {columns: 6, places: Object.fromEntries(Array.from({length: 401}, (_, i) => [String(i).padEnd(120, 'x'), {x: 0, y: i, w: 6}]))};
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, layout: large}})).status, 200);
  const clean = await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, order: ['history'], sizes: {history: 3}}});
  assert.deepEqual(clean.body, view, 'POST discards the old format');
  assert.deepEqual((await call('GET', `/api/overview?board=${team}`, {as: 'bob'})).body.view, view);

  await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: view});

  assert.equal((await call('DELETE', `/api/boards/${team}/shares/${source}`, {as: 'alice'})).status, 200, 'the owner takes anything off');
  assert.deepEqual((await call('GET', `/api/overview?board=${team}`, {as: 'bob'})).body.sources, []);
  assert.equal((await call('GET', '/api/overview', {as: 'bob'})).body.sources.length, 1, 'it stays on his own board');

  assert.equal((await call('POST', `/api/boards/${team}`, {as: 'bob', body: {name: 'Mine now'}})).status, 403, 'only the owner renames');
  assert.equal((await call('POST', `/api/boards/${team}`, {as: 'alice', body: {name: ''}})).status, 400, 'a shared board needs a name');
  const personal = (await call('GET', '/api/session', {as: 'bob'})).body.boards.find((b: any) => b.personal).id;
  assert.equal((await call('POST', `/api/boards/${personal}`, {as: 'bob', body: {name: 'Work'}})).body.name, 'Work');
  assert.equal((await call('POST', `/api/boards/${personal}`, {as: 'bob', body: {name: ''}})).body.name, '', 'a personal board gets its default name back');
  assert.equal((await call('GET', `/api/boards/${personal}/shares`, {as: 'bob'})).status, 403, 'a personal board shows everything of its person by itself');
});

test('a migrated view can save new neighbours after 400 retained places, within the byte limit', async t => {
  const {app, call, person, store} = await hub();
  t.after(() => app.close());
  const board = await person('alice');
  const legacy = {
    order: Array.from({length: 200}, (_, i) => `source:o${i}`),
    sizes: Object.fromEntries(Array.from({length: 200}, (_, i) => [`source:s${i}`, 4])),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(legacy)) < 16 * 1024, 'the old route could store this view');
  store.db.prepare('INSERT OR REPLACE INTO views VALUES (?, ?, ?, ?)').run(board, JSON.stringify(legacy), 'alice', Date.now());
  const old = (await call('GET', `/api/overview?board=${board}`, {as: 'alice'})).body.view;
  const ids = ['source:s0', 'source:new'];
  const migrated = legacyLayout(old, {cards: ids, analytics: []}, []);
  assert.equal(Object.keys(migrated.layout.places).length, 400);
  const origin = settle(ordered(migrated.layout, ids).map(item => ({...item, h: 7})), 6);
  const changed = withPlaces(migrated, placesOf(widened(origin, 'source:s0', 4, 6)));
  assert.equal(Object.keys(changed.layout.places).length, 401);
  assert.deepEqual(changed.layout.places['source:s0'], {x: 0, y: 0, w: 4});
  assert.deepEqual(changed.layout.places['source:new'], {x: 2, y: 7, w: 3}, 'the neighbour moves down, not sideways');
  assert.ok(Object.keys(migrated.layout.places).every(id => Object.hasOwn(changed.layout.places, id)), 'all retained settings survive');
  assert.equal((await call('POST', `/api/boards/${board}/view`, {as: 'alice', body: changed})).status, 200);
  assert.deepEqual((await call('GET', `/api/overview?board=${board}`, {as: 'alice'})).body.view.layout, changed.layout);

  const tooLarge = {...changed, layout: {columns: 6, places: Object.fromEntries(
    Array.from({length: 800}, (_, i) => [String(i).padEnd(120, 'x'), {x: 0, y: i, w: 6}]),
  )}};
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) > 64 * 1024);
  assert.equal((await call('POST', `/api/boards/${board}/view`, {as: 'alice', body: tooLarge})).status, 413);
  const tooManyNames = {...changed, names: Object.fromEntries(Array.from({length: 201}, (_, i) => [String(i), 'Name']))};
  assert.equal((await call('POST', `/api/boards/${board}/view`, {as: 'alice', body: tooManyNames})).status, 400, 'other maps keep their count limits');
});

test('a full view request fits the browser keepalive byte budget', async t => {
  const {app, call, person} = await hub();
  t.after(() => app.close());
  const board = await person('alice');
  // Places with chosen heights count as any other part of the view.
  const places = Object.fromEntries(Array.from({length: 50}, (_, i) => [`source:${i}`, {x: 0, y: i * 10, w: 6, h: i % 2 ? MAX_ROWS : 1}]));
  for (const unit of ['x', 'я']) {
    const empty = {...EMPTY, layout: {columns: 6, places}, padding: ''};
    const room = 65536 - Buffer.byteLength(JSON.stringify(empty));
    const unitBytes = Buffer.byteLength(unit);
    // An ignored field fills the request without changing any validated view settings.
    const exact = {...empty, padding: unit.repeat(Math.floor(room / unitBytes)) + 'x'.repeat(room % unitBytes)};
    assert.equal(Buffer.byteLength(JSON.stringify(exact)), 65536);
    const saved = await call('POST', `/api/boards/${board}/view`, {as: 'alice', body: exact});
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.layout.places, places);
    const over = {...exact, padding: exact.padding + 'x'};
    assert.equal(Buffer.byteLength(JSON.stringify(over)), 65537);
    assert.equal((await call('POST', `/api/boards/${board}/view`, {as: 'alice', body: over})).status, 413);
  }
});

test('the owner removes people and resets invite links; what someone shared leaves with them; deleting a board keeps the data', async () => {
  const {call, person} = await hub();
  const personal = await person('alice');
  const board = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  const invite = async () => (await call('POST', `/api/boards/${board}/invites`, {as: 'alice'})).body.url.split('/invite/')[1];
  const bob = await person('bob', await invite());
  const link = await invite();
  await person('carol', link);
  const bobs = (await call('POST', '/api/tokens', {as: 'bob', body: {}})).body.secret;
  await call('POST', '/v1/ingest', {body: batch('machine-bob-0123456789'), headers: {authorization: `Bearer ${bobs}`}});
  const source = (await call('GET', `/api/boards/${board}/shares`, {as: 'bob'})).body.mine[0].source;
  await call('POST', `/api/boards/${board}/shares`, {as: 'bob', body: {source}});
  const members = (await call('GET', `/api/boards/${board}/members`, {as: 'alice'})).body;
  const bobId = members.find((m: any) => m.name === 'Bob').id;

  assert.equal((await call('DELETE', `/api/boards/${board}/members/${bobId}`, {as: 'carol'})).status, 403, 'only the owner removes people');
  assert.equal((await call('DELETE', `/api/boards/${board}/members/${bobId}`, {as: 'alice'})).status, 200);
  assert.equal((await call('GET', `/api/overview?board=${board}`, {as: 'bob'})).status, 404);
  assert.deepEqual((await call('GET', `/api/overview?board=${board}`, {as: 'alice'})).body.sources, [], 'what he shared left with him');
  assert.equal((await call('GET', '/api/overview', {as: 'bob'})).body.sources.length, 1, 'and stays his');
  void bob;

  assert.deepEqual((await call('DELETE', `/api/boards/${board}/invites`, {as: 'alice'})).body, {revoked: 2});
  assert.equal((await call('GET', `/api/invites/${link}`)).status, 404, 'links given out stop working');

  assert.equal((await call('POST', `/api/boards/${board}/leave`, {as: 'alice'})).status, 403, 'the owner deletes it instead');
  assert.equal((await call('POST', `/api/boards/${board}/leave`, {as: 'carol'})).status, 200);
  assert.equal((await call('DELETE', `/api/boards/${personal}`, {as: 'alice'})).status, 403, 'a personal board stays');
  assert.equal((await call('DELETE', `/api/boards/${board}`, {as: 'alice'})).status, 200);
  assert.deepEqual((await call('GET', '/api/session', {as: 'carol'})).body.boards.map((b: any) => b.personal), [true]);
  assert.equal((await call('GET', '/api/overview', {as: 'bob'})).body.sources.length, 1, 'measurements belong to their people, not to boards');
});

test('a person changes their name freely, their email and password only with the current password', async () => {
  const {call, person} = await hub();
  await person('alice');
  await call('POST', '/api/auth/login', {as: 'alice-phone', body: {email: 'alice@example.com', password: 'correct horse'}});
  assert.equal((await call('POST', '/api/account', {as: 'alice', body: {name: 'Alice L.'}})).body.user.name, 'Alice L.');
  const wrong = await call('POST', '/api/account', {as: 'alice', body: {email: 'al@example.com', currentPassword: 'wrong'}});
  assert.deepEqual([wrong.status, wrong.body.error], [403, 'wrong_password']);
  const changed = await call('POST', '/api/account', {as: 'alice', body: {email: 'AL@example.com', password: 'battery staple', currentPassword: 'correct horse'}});
  assert.equal(changed.body.user.email, 'al@example.com');
  assert.equal((await call('GET', '/api/session', {as: 'alice'})).body.user?.name, 'Alice L.', 'this session stays');
  assert.equal((await call('GET', '/api/session', {as: 'alice-phone'})).body.user, null, 'the other ones end with the old password');
  assert.equal((await call('POST', '/api/auth/login', {body: {email: 'al@example.com', password: 'battery staple'}})).status, 200);
});

test('only failed sign-ins count against the limit', async () => {
  const {call, person} = await hub();
  await person('alice');
  const signIn = (password: string) => call('POST', '/api/auth/login', {body: {email: 'alice@example.com', password}});
  for (let i = 0; i < 12; i++) assert.equal((await signIn('correct horse')).status, 200, 'a team behind one address signs in freely');
  for (let i = 0; i < 10; i++) assert.equal((await signIn('wrong horse')).status, 401);
  assert.equal((await signIn('correct horse')).status, 429);
});

test('a device shows the failures it reports until it delivers again', async () => {
  const {call, person} = await hub();
  await person('alice');
  const token = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  const auth = {authorization: `Bearer ${token.secret}`};
  const failure = {provider: 'claude', observedAt: iso(Date.now()), error: 'not_logged_in', detail: 'run claude and /login'};
  await call('POST', '/v1/ingest', {body: {...batch('machine-one-0123456789', [failure]), snapshots: []}, headers: auth});
  const [device] = (await call('GET', '/api/devices', {as: 'alice'})).body;
  assert.deepEqual(device.failures.map((f: any) => [f.provider, f.error, f.detail]), [['claude', 'not_logged_in', 'run claude and /login']]);
});

test('a machine connects with a one-time code approved by a signed-in person, and becomes theirs', async () => {
  const {call, person} = await hub();
  await person('alice');
  const started = await call('POST', '/v1/device/code', {body: {machine: machine('laptop-0123456789ab'), agent: 'quotum/0.2.0'}});
  assert.match(started.body.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(started.body.verificationUriComplete, `${ORIGIN}/device?code=${started.body.userCode}`);
  const poll = () => call('POST', '/v1/device/token', {body: {deviceCode: started.body.deviceCode}});
  assert.equal((await poll()).body.error, 'authorization_pending');
  assert.equal((await poll()).body.error, 'slow_down');

  const typed = started.body.userCode.toLowerCase().replace('-', ' ');
  const pending = await call('GET', `/api/device?code=${encodeURIComponent(typed)}`, {as: 'alice'});
  assert.equal(pending.body.machine.name, 'build-01');
  assert.equal((await call('POST', '/api/device/approve', {as: 'alice', body: {code: 'BCDF-GHJK'}})).status, 400);
  assert.equal((await call('POST', '/api/device/approve', {as: 'alice', body: {code: typed}})).status, 200);

  const connected = await call('POST', '/v1/device/token', {body: {deviceCode: started.body.deviceCode}});
  assert.match(connected.body.token, /^qt_d_/);
  assert.deepEqual([connected.body.account, connected.body.device.name, connected.body.board], [{name: 'Alice'}, 'build-01', undefined]);
  assert.equal((await poll()).body.error, 'expired_token', 'a code gives one device');

  const device = {authorization: `Bearer ${connected.body.token}`};
  assert.equal((await call('POST', '/v1/ingest', {body: batch('laptop-0123456789ab'), headers: device})).status, 200);
  // A machine token cannot take over the machine connected with a code.
  const machines = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret;
  const takeover = await call('POST', '/v1/ingest', {body: batch('laptop-0123456789ab'), headers: {authorization: `Bearer ${machines}`}});
  assert.deepEqual([takeover.status, takeover.body.error], [403, 'device_conflict']);

  const [listed] = (await call('GET', '/api/devices', {as: 'alice'})).body;
  assert.equal(listed.via, 'code');
  await call('DELETE', `/api/devices/${listed.id}`, {as: 'alice'});
  const removed = await call('POST', '/v1/ingest', {body: batch('laptop-0123456789ab'), headers: device});
  assert.deepEqual([removed.status, removed.body.error], [403, 'device_revoked']);
  assert.equal((await call('POST', '/v1/checkin', {body: {version: 1}, headers: device})).status, 403);
});

test('agents get errors in the spec’s terms', async () => {
  const {call, person} = await hub();
  await person('alice');
  const auth = {authorization: `bearer ${(await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret}`};
  const checkin = await call('POST', '/v1/checkin', {body: {version: 1, agent: 'quotum/0.2.0', machine: machine('m-0123456789ab')}, headers: auth});
  assert.deepEqual([checkin.status, checkin.body.subscriptions], [200, []], 'the scheme is case-insensitive');
  const bad = await call('POST', '/v1/checkin', {body: {version: 1, agent: 'quotum/0.2.0', machine: machine('m-0123456789ab'), subscriptions: [{provider: 'claude', account: 'someone@example.com'}]}, headers: auth});
  assert.deepEqual([bad.status, bad.body], [400, {error: 'invalid_request', detail: 'account'}], 'accounts are pseudonyms, never raw ids');
  const broken = await call('POST', '/v1/ingest', {body: '{"version": 1,', headers: auth});
  assert.deepEqual([broken.status, broken.body], [400, {error: 'invalid_batch'}]);
  const wrong = await call('POST', '/v1/ingest', {body: {...batch('m-0123456789ab'), version: 2}, headers: auth});
  assert.deepEqual([wrong.status, wrong.body], [400, {error: 'invalid_batch', detail: 'version'}]);
});

test('a device following the hub’s pace is told when to ask again, and the card says when it measures next', async () => {
  const {call, person} = await hub();
  await person('alice');
  const headers = {authorization: `Bearer ${(await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret}`};
  const checkin = (paced: unknown, change: object = {}) =>
    call('POST', '/v1/checkin', {
      body: {version: 1, agent: 'quotum/0.4.0', paced, machine: machine('m-0123456789ab'), subscriptions: [{provider: 'codex', account: 'a1b2c3d4e5f6a1b2c3d4e5f6', active: false, ...change}]},
      headers,
    });
  const cadence = async () => {
    const board = (await call('GET', '/api/overview', {as: 'alice'})).body;
    return board.cadence[board.sources[0]?.id];
  };

  const first = (await checkin(true)).body.subscriptions[0];
  assert.deepEqual([first.measure, first.onDuty, first.askInMs, first.nextInMs], [true, true, 15_000, 240_000]);
  const measured = Date.now() - 1000;
  await call('POST', '/v1/ingest', {body: {...batch('m-0123456789ab'), snapshots: [{...snapshot(measured), staleAfterMs: 240_000 * 1.2 + 60_000}]}, headers});
  const waiting = (await checkin(true)).body.subscriptions[0];
  assert.deepEqual([waiting.measure, waiting.onDuty, waiting.nextInMs], [false, true, undefined]);
  assert.ok(waiting.askInMs > 0 && waiting.askInMs <= 15_000);
  assert.deepEqual(await cadence(), {next: measured + 120_000, why: 'idle'});

  const plain = (await checkin(false)).body.subscriptions[0];
  assert.deepEqual(Object.keys(plain), ['provider', 'measure', 'until'], 'without the pace, the answer is as before');
  const bad = await checkin(true, {minIntervalMs: 30_000});
  assert.deepEqual([bad.status, bad.body], [400, {error: 'invalid_request', detail: 'minIntervalMs'}]);
  assert.deepEqual((await checkin('yes')).body, {error: 'invalid_request', detail: 'paced'});
});

test('an agent request without a valid token is refused before its body arrives', async t => {
  const {app, call, person} = await hub();
  await person('alice');
  const revokedToken = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  await call('DELETE', `/api/tokens/${revokedToken.id}`, {as: 'alice'});
  const started = (await call('POST', '/v1/device/code', {body: {machine: machine('laptop-0123456789ab'), agent: 'quotum/0.2.0'}})).body;
  await call('POST', '/api/device/approve', {as: 'alice', body: {code: started.userCode}});
  const revokedDevice = (await call('POST', '/v1/device/token', {body: {deviceCode: started.deviceCode}})).body.token;
  const [device] = (await call('GET', '/api/devices', {as: 'alice'})).body;
  await call('DELETE', `/api/devices/${device.id}`, {as: 'alice'});

  /** Sends the start of a body that never ends; before the fix such a request waited for the rest for ever. */
  const hanging = async (url: string, headers: Record<string, string>) => {
    const body = new PassThrough();
    t.after(() => body.destroy());
    body.write('{"version": 1,');
    const answer = app.inject({method: 'POST', url, payload: body, headers: {'content-type': 'application/json', ...headers}});
    const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${url} waited for the body`)), 1000).unref());
    const response = await Promise.race([answer, late]);
    return [response.statusCode, JSON.parse(response.body).error];
  };
  for (const url of ['/v1/checkin', '/v1/sessions', '/v1/ingest']) {
    assert.deepEqual(await hanging(url, {}), [401, 'unauthorized'], `${url} without a token`);
    assert.deepEqual(await hanging(url, {authorization: 'Bearer qt_m_someone-elses-token-0123456789'}), [401, 'unauthorized'], `${url} with an unknown token`);
    assert.deepEqual(await hanging(url, {authorization: `Bearer ${revokedToken.secret}`}), [403, 'device_revoked'], `${url} with a revoked token`);
    assert.deepEqual(await hanging(url, {authorization: `Bearer ${revokedDevice}`}), [403, 'device_revoked'], `${url} from a removed device`);
  }
  assert.deepEqual(await hanging('/v1/ingest', {host: 'evil.example'}), [403, 'forbidden_host'], 'the host is checked first');
});

test('a device removed or a token revoked while its body arrives delivers nothing, nor does its old secret once it is connected anew', async t => {
  const {app, call, person} = await hub();
  await person('alice');
  /** Connects a machine with a one-time code; returns its secret. */
  const pair = async (id: string) => {
    const started = (await call('POST', '/v1/device/code', {body: {machine: machine(id), agent: 'quotum/0.2.0'}})).body;
    await call('POST', '/api/device/approve', {as: 'alice', body: {code: started.userCode}});
    return (await call('POST', '/v1/device/token', {body: {deviceCode: started.deviceCode}})).body.token as string;
  };
  const removeDevice = async () => {
    const [device] = (await call('GET', '/api/devices', {as: 'alice'})).body;
    await call('DELETE', `/api/devices/${device.id}`, {as: 'alice'});
  };
  /** Sends the headers and half of a batch, lets `meanwhile` happen, then sends the rest. */
  const midway = async (secret: string, id: string, meanwhile: () => Promise<unknown>) => {
    const body = new PassThrough();
    t.after(() => body.destroy());
    const text = JSON.stringify(batch(id));
    body.write(text.slice(0, text.length / 2));
    const answer = app.inject({method: 'POST', url: '/v1/ingest', payload: body, headers: {'content-type': 'application/json', authorization: `Bearer ${secret}`}});
    await new Promise(resolve => setTimeout(resolve, 50));
    await meanwhile();
    body.end(text.slice(text.length / 2));
    const response = await answer;
    return [response.statusCode, JSON.parse(response.body).error];
  };

  const device = await pair('laptop-0123456789ab');
  assert.deepEqual(await midway(device, 'laptop-0123456789ab', removeDevice), [403, 'device_revoked']);
  const token = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  assert.deepEqual(await midway(token.secret, 'build-0123456789ab', () => call('DELETE', `/api/tokens/${token.id}`, {as: 'alice'})), [403, 'device_revoked']);
  assert.deepEqual((await call('GET', '/api/devices', {as: 'alice'})).body, [], 'no device comes back or joins');
  assert.deepEqual((await call('GET', '/api/overview', {as: 'alice'})).body.sources, [], 'nothing was kept');

  // A secret a device was disconnected for never works again, even when it comes back meanwhile.
  const old = await pair('desk-0123456789abcd');
  assert.deepEqual(await midway(old, 'desk-0123456789abcd', () => removeDevice().then(() => pair('desk-0123456789abcd'))), [401, 'unauthorized'], 'connected with a new code');
  const again = await pair('desk-0123456789abcd');
  const joining = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret;
  const join = async () => {
    await removeDevice();
    const joined = await call('POST', '/v1/checkin', {body: {version: 1, agent: 'quotum/0.2.0', machine: machine('desk-0123456789abcd')}, headers: {authorization: `Bearer ${joining}`}});
    assert.equal(joined.status, 200);
  };
  assert.deepEqual(await midway(again, 'desk-0123456789abcd', join), [401, 'unauthorized'], 'joined with a machine token');
  assert.deepEqual((await call('GET', '/api/overview', {as: 'alice'})).body.sources, [], 'nothing was kept');
});

test('a request is given 30 seconds to arrive, and one that takes longer is answered in the spec’s terms', async () => {
  const {app} = await hub();
  // Node keeps the checking interval on the server, but its types do not declare it.
  const server = app.server as typeof app.server & {connectionsCheckingInterval: number};
  assert.equal(server.requestTimeout, 30_000);
  // Once the headers are in, Node holds a request to the longer of the two limits.
  assert.ok(server.headersTimeout <= server.requestTimeout, `headersTimeout ${server.headersTimeout}`);
  assert.equal(server.connectionsCheckingInterval, 5_000);

  const answered = (code: string, answering = false) => {
    let written = '';
    const socket = Object.assign(new PassThrough(), {writable: true, _httpMessage: answering ? {headersSent: true} : null});
    socket.write = (chunk: string) => ((written += chunk), true);
    // The hub closes it with the error, as Node does.
    socket.on('error', () => {});
    server.emit('clientError', Object.assign(new Error(code), {code}), socket);
    return {written, destroyed: socket.destroyed};
  };
  const late = answered('ERR_HTTP_REQUEST_TIMEOUT');
  assert.ok(late.destroyed, 'the connection is closed');
  const [head, body] = late.written.split('\r\n\r\n');
  assert.match(head, /^HTTP\/1\.1 408 Request Timeout\r\n/);
  assert.match(head, /\r\nContent-Type: application\/json\r\n/);
  assert.match(head, new RegExp(`\r\nContent-Length: ${body.length}\r\n`));
  assert.match(head, /\r\nConnection: close$/);
  assert.deepEqual(JSON.parse(body), {error: 'request_timeout'});
  assert.deepEqual(JSON.parse(answered('HPE_HEADER_OVERFLOW').written.split('\r\n\r\n')[1]), {error: 'headers_too_large'});
  assert.deepEqual(JSON.parse(answered('HPE_INVALID_METHOD').written.split('\r\n\r\n')[1]), {error: 'invalid_request'});
  assert.equal(answered('ECONNRESET').written, '', 'a reset connection has no one to answer');
  const midway = answered('HPE_INVALID_METHOD', true);
  assert.deepEqual([midway.written, midway.destroyed], ['', true], 'an answer on its way is cut short, not spliced with another');
});

test('history reads a period selected on the chart, up to a month, on a grid fine enough for it', async () => {
  const {call, person} = await hub();
  await person('alice');
  const now = Date.now();
  const read = (query: string) => call('GET', `/api/history?${query}`, {as: 'alice'});
  const minute = 60_000;
  const hour = await read(`from=${now - 3_600_000}&to=${now - 1_800_000}`);
  assert.deepEqual(
    [hour.status, hour.body.since, hour.body.to, hour.body.cellMs],
    [200, Math.floor((now - 3_600_000) / minute) * minute, Math.ceil((now - 1_800_000) / minute) * minute, minute],
    'out to whole cells',
  );
  const nearly = await read(`from=${now - 3_600_000 + 1}&to=${now - 1_800_000 - 1}`);
  assert.deepEqual([nearly.body.since, nearly.body.to], [hour.body.since, hour.body.to], 'less than a cell apart: one answer');
  const week = await read(`from=${now - 7 * 86_400_000}&to=${now}`);
  assert.equal(week.body.cellMs, 30 * 60_000, 'as dense as the ranges ending now');
  const month = await read(`from=${now - 31 * 86_400_000 + 3_600_000}&to=${now}`);
  assert.equal(month.body.cellMs, 2 * 3_600_000, 'a day over a month keeps the grid of a month');
  const ahead = await read(`from=${now - 3_600_000}&to=${now + 86_400_000}`);
  assert.ok(ahead.body.to <= Date.now(), 'it ends now at the latest');
  const fixed = await read('range=24h');
  assert.equal(fixed.body.to, fixed.body.now, 'a period of the list ends now');
  for (const query of [`from=${now - 600_000}&to=${now}`, `from=${now - 40 * 86_400_000}&to=${now}`, `from=${now - 100 * 86_400_000}&to=${now - 90 * 86_400_000}`, `from=${now - 3_600_000}`, 'from=abc&to=def']) {
    assert.equal((await read(query)).status, 400, query);
  }
});

test('a costly history is reused a while after new data, says when a newer one is ready, and never outlives a change of sources', async () => {
  const {call, person} = await hub();
  await person('alice');
  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  const token = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret;
  const ingest = (at: number) =>
    call('POST', '/v1/ingest', {body: {...batch('alices-laptop-0123456789'), snapshots: [snapshot(at)]}, headers: {authorization: `Bearer ${token}`}});
  await ingest(Date.now() - 60_000);
  const [source] = (await call('GET', '/api/overview', {as: 'alice'})).body.sources;
  await call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source: source.id}});
  const read = async () => (await call('GET', `/api/history?board=${team}&range=30d`, {as: 'alice'})).body;
  // Every answer costly, however small the board (the settings are read-only only to the type checker).
  const history = config.history as {costlyMs: number};
  const costly = history.costlyMs;
  history.costlyMs = 0;
  try {
    const first = await read();
    assert.equal(first.refreshInMs, null);
    await ingest(Date.now() - 1_000);
    const kept = await read();
    assert.ok(kept.refreshInMs > 0, 'reused, and it says when a newer one is ready');
    assert.equal(kept.series[0].samples, first.series[0].samples);
    await call('DELETE', `/api/boards/${team}/shares/${source.id}`, {as: 'alice'});
    assert.deepEqual((await read()).series, [], 'a source taken off the board is gone at once');
  } finally {
    history.costlyMs = costly;
  }
});

/**
 * A shared board with one subscription measured by Alice, Bob and Carol, and agent work
 * written straight into the hub (as the hub credits it: see server/sessions.ts), hours
 * before `now`: Alice's before the subscription came to the board and after, Bob's before
 * he joined it and after, Carol's.
 */
async function worked() {
  const {call, person, store} = await hub();
  const alices = await person('alice');
  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  const invite = async () => (await call('POST', `/api/boards/${team}/invites`, {as: 'alice'})).body.url.split('/invite/')[1];
  const bobs = await person('bob', await invite());
  await person('carol', await invite());
  for (const who of ['alice', 'bob', 'carol']) {
    const secret = (await call('POST', '/api/tokens', {as: who, body: {}})).body.secret;
    await call('POST', '/v1/ingest', {body: batch(`${who}-laptop-0123456789`), headers: {authorization: `Bearer ${secret}`}});
    // Alice measures a second subscription, which comes to the board later.
    const other = {...batch(`${who}-laptop-0123456789`), snapshots: [{...snapshot(Date.now() - 1000), account: 'ffffffffffffffffffffffff'}]};
    if (who === 'alice') await call('POST', '/v1/ingest', {body: other, headers: {authorization: `Bearer ${secret}`}});
  }
  const [source, later] = ((await call('GET', `/api/boards/${team}/shares`, {as: 'alice'})).body.mine as {source: string}[]).map(m => m.source);
  await call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source}});
  await call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source: later}});

  const now = Date.now();
  const hour = 3_600_000;
  const ago = (hours: number) => now - hours * hour;
  // How agents worked is known for a day; the subscription came to the board five hours ago, Bob two hours ago.
  store.db.prepare("UPDATE meta SET value = ? WHERE key = 'agentWorkSince'").run(String(ago(24)));
  store.db.prepare('UPDATE shares SET shared_at = ? WHERE board_id = ?').run(ago(5), team);
  store.db.prepare('UPDATE shares SET shared_at = ? WHERE board_id = ? AND source_id = ?').run(ago(3), team, later);
  store.db.prepare('UPDATE members SET joined_at = ? WHERE board_id = ?').run(ago(6), team);
  const bob = (await call('GET', `/api/boards/${team}/members`, {as: 'alice'})).body.find((m: any) => m.name === 'Bob').id;
  store.db.prepare('UPDATE members SET joined_at = ? WHERE board_id = ? AND user_id = ?').run(ago(2), team, bob);
  const device = (who: string) => (store.db.prepare('SELECT id FROM devices WHERE machine_id = ?').get(`${who}-laptop-0123456789`) as {id: string}).id;
  const work = (who: string, from: number, to: number, project: string, on = source) =>
    store.creditWork(device(who), ago(from), ago(to), [{source: on, origin: 'terminal', startedAt: ago(from), project, folder: '', ordinal: 0}]);
  work('alice', 6, 5.5, 'early');
  work('alice', 4, 3, 'quotum');
  // On her second subscription after the first came to the board, but before it did itself.
  work('alice', 4, 3.5, 'secret', later);
  work('bob', 3, 1, 'billing');
  work('carol', 1.5, 0.5, 'quotum');
  // Whose agents' work the board shows and under which names: when it changes, open pages hear of it (events.ts).
  const workKey = () => store.workKey(team, store.shown(team, new Directory(store.db).view(team).hidden));
  return {call, store, team, alices, bobs, source, later, invite, now, hour, ago, device: device('alice'), workKey};
}

test('a range ending minutes ago says when to ask again, and is read anew once the work up to its end is credited', async t => {
  const {call, store, team, source, device} = await worked();
  const minute = 60_000;
  const to = Date.now() - minute;
  const read = async () => (await call('GET', `/api/history?board=${team}&from=${to - 15 * minute}&to=${to}`, {as: 'alice'})).body;
  const first = await read();
  assert.ok(first.refreshInMs > 3 * minute && first.refreshInMs <= KEEP_MS, 'not all of its work is credited yet');
  // The machine's last list, credited with its next one, minutes later.
  store.creditWork(device, to - 2 * minute, to, [{source, origin: 'terminal', startedAt: to - 2 * minute, project: 'quotum', folder: '', ordinal: 0}]);
  assert.deepEqual((await read()).activity, first.activity, 'meanwhile the answer read is reused');
  // Its end is where the grid ends it, a cell's end.
  t.mock.timers.enable({apis: ['Date'], now: first.to + KEEP_MS});
  const settled = await read();
  assert.equal(settled.refreshInMs, null);
  assert.equal(settled.activity.activeMs - first.activity.activeMs, 2 * minute, 'read anew, with the work credited since');
  assert.equal((await call('GET', `/api/history?board=${team}&from=${to - 30 * minute}&to=${to - 15 * minute}`, {as: 'alice'})).body.refreshInMs, null, 'a range ended long enough ago');
});

test('a machine gone quiet has its last list credited by the time a range ending after it is read in full', async t => {
  const {call, person} = await hub();
  await person('alice');
  const token = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret;
  const headers = {authorization: `Bearer ${token}`};
  await call('POST', '/v1/ingest', {body: batch('alices-laptop-0123456789'), headers});
  const board = (await call('GET', '/api/overview', {as: 'alice'})).body.board.id;
  const minute = 60_000;
  // On the minute, after the hub began: the range is read on a grid of minutes.
  const end = Math.ceil((Date.now() + 20 * minute) / minute) * minute;
  const codex = {provider: 'codex', account: 'a1b2c3d4e5f6a1b2c3d4e5f6', origin: 'terminal', project: 'quotum', startedAt: iso(end - 10 * minute), working: true};
  t.mock.timers.enable({apis: ['Date'], now: end - 4 * minute});
  const report = (at: number) => {
    t.mock.timers.setTime(at);
    return call('POST', '/v1/sessions', {body: {version: 1, agent: 'quotum/0.3.0', machine: machine('alices-laptop-0123456789'), sentAt: iso(at), sessions: [codex]}, headers});
  };
  // Two lists two minutes apart, then the lid closes: nothing reports after.
  await report(end - 4 * minute);
  await report(end - 2 * minute);
  t.mock.timers.setTime(end + KEEP_MS);
  const answer = (await call('GET', `/api/history?board=${board}&from=${end - 15 * minute}&to=${end}`, {as: 'alice'})).body;
  assert.equal(answer.refreshInMs, null, 'all there is of the range');
  assert.equal(answer.activity.activeMs, 4 * minute, 'the last list counts too, up to the end of the range');
});

/** Hours of each group of a dimension, one decimal. */
const hoursBy = (history: any, dimension: string) =>
  Object.fromEntries(history.activity.by[dimension].map((g: any) => [g.name ?? g.key, Math.round(g.agentMs / 360_000) / 10]));

/**
 * What always holds of work in a history: the windows of a subscription share its hours,
 * which are its group's in the activity (no group where they are none), and the parts of
 * a cell add up exactly to its agent time. A subscription with no measurement in a range has no window
 * there, though its agents' work is in the activity.
 */
function assertWork(history: any) {
  for (const line of history.series) {
    if (!line.work || line.work.ms === null) continue;
    assert.equal(history.activity.by.source.find((g: any) => g.key === line.sourceId)?.activeMs ?? 0, line.work.ms, `${line.sourceId} ${line.windowId}`);
    assert.equal(history.activity.by.source.find((g: any) => g.key === line.sourceId)?.agentMs ?? 0, line.work.agentMs);
  }
  for (const dimension of ['source', 'project', 'device']) {
    for (const [cell, , agentMs] of history.activity.cells) {
      const parts = history.activity.by[dimension].flatMap((g: any) => g.cells.filter(([at]: number[]) => at === cell).map(([, ms]: number[]) => ms));
      assert.equal(parts.reduce((a: number, b: number) => a + b, 0), agentMs, `${dimension} ${cell}`);
    }
  }
}

test('a shared board shows the work of its members on its subscriptions, from their joining and its sharing on; a personal board all of one\'s own', async () => {
  const {call, team, bobs, source, later, ago, hour} = await worked();
  const history = (await call('GET', `/api/history?board=${team}&range=24h`, {as: 'bob'})).body;
  assert.deepEqual(hoursBy(history, 'project'), {quotum: 2, billing: 1}, "neither Alice's work before the sharing nor Bob's before he joined, nor hers on a subscription before it came");
  assert.deepEqual([history.activity.activeMs / hour, history.activity.agentMs / hour], [2.5, 3], "Bob's and Carol's half hour together counts once in the work");
  assert.deepEqual([history.activity.agents, history.activity.barMs], [3, hour], 'three agents, drawn in hours over a day');
  assert.deepEqual(history.activity.known, {from: ago(5), to: history.now}, 'known from the sharing on, up to now');
  assert.equal(history.activity.since, ago(5));
  const line = (id: string) => history.series.find((l: any) => l.sourceId === id).work;
  assert.deepEqual([line(source).from, line(source).ms / hour, line(source).agentMs / hour], [ago(5), 2.5, 3]);
  const group = history.activity.by.source.find((g: any) => g.key === source);
  assert.deepEqual([group.agentMs / hour, group.activeMs / hour, group.agents], [3, 2.5, 3]);
  assert.deepEqual([line(later).from, line(later).ms, line(later).agentMs], [ago(3), 0, 0], 'known from its own sharing on: none of the spending before is set against the hours');
  assertWork(history);

  const own = (await call('GET', `/api/history?board=${bobs}&range=24h`, {as: 'bob'})).body;
  assert.deepEqual(hoursBy(own, 'project'), {billing: 2}, 'all of his own, and nobody else’s');
  assert.equal(own.activity.since, ago(24));
  assertWork(own);
});

test('the work a board shows follows its cards, members and names at once, a costly answer as well', async () => {
  const history = config.history as {costlyMs: number};
  const costly = history.costlyMs;
  for (const costlyMs of [costly, 0]) {
    history.costlyMs = costlyMs;
    try {
      const {call, team, source, device, invite, workKey: key} = await worked();
      const read = async () => (await call('GET', `/api/history?board=${team}&range=24h`, {as: 'alice'})).body;
      const first = await read();
      const before = key();
      assert.equal(key(), before, 'the same while nothing changes');

      // A hidden card: its work is not on the board, and comes back once it is shown again.
      await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...EMPTY, hidden: [`source:${source}`]}});
      const hidden = await read();
      assert.deepEqual([hidden.activity.activeMs, hidden.activity.by.source, hidden.series[0].work], [0, [], null], `hidden, costlyMs ${costlyMs}`);
      assert.notEqual(key(), before);
      await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: EMPTY});
      assert.deepEqual(hoursBy(await read(), 'project'), hoursBy(first, 'project'), 'shown again');
      assert.equal(key(), before);

      // Names given to projects and machines show in the next answer.
      await call('POST', '/api/projects', {as: 'alice', body: {groups: ['quotum'], name: 'Quotum hub'}});
      assert.deepEqual(hoursBy(await read(), 'project'), {'Quotum hub': 1, quotum: 1, billing: 1}, "Alice's name for her project; Carol's stays hers");
      await call('POST', '/api/projects/restore', {as: 'alice', body: {reported: ['quotum']}});
      assert.deepEqual(hoursBy(await read(), 'project'), {quotum: 2, billing: 1});
      await call('POST', `/api/devices/${device}`, {as: 'alice', body: {name: 'Desk'}});
      assert.ok('Desk' in hoursBy(await read(), 'device'), 'the name a machine is given');

      // Someone who leaves takes their work along, and coming back brings only what comes after.
      await call('POST', `/api/boards/${team}/leave`, {as: 'carol'});
      await call('POST', `/api/invites/${await invite()}/accept`, {as: 'carol'});
      const back = await read();
      assert.deepEqual(hoursBy(back, 'project'), {quotum: 1, billing: 1});
      assertWork(back);
    } finally {
      history.costlyMs = costly;
    }
  }
});

test('project names containing separators cannot alias other names in the history cache', async () => {
  const {call, store, team, device, workKey: key} = await worked();
  const {user_id: user} = store.db.prepare('SELECT user_id FROM devices WHERE id = ?').get(device) as {user_id: string};
  const rename = async (group: string, name: string) => {
    const response = await call('POST', '/api/projects', {as: 'alice', body: {groups: [group], name}});
    assert.equal(response.status, 200);
  };
  const read = async () => (await call('GET', `/api/history?board=${team}&range=24h`, {as: 'alice'})).body;
  // One name must not encode a second project's entry in the key.
  const joined = `A\u001f${user}\u001esecret\u001eB`;
  await rename('quotum', joined);
  const before = key();
  assert.deepEqual(hoursBy(await read(), 'project'), {[joined]: 1, quotum: 1, billing: 1});
  await rename(joined, 'A');
  await rename('secret', 'B');
  assert.notEqual(key(), before, 'different names have different keys');
  assert.deepEqual(hoursBy(await read(), 'project'), {A: 1, quotum: 1, billing: 1}, 'the cached answer is not reused after renaming');
});

test('a board’s history is read under a key of what the board shows, which names off the board leave as it is', async () => {
  const {call, team, later, workKey: key} = await worked();
  // Alice's second subscription leaves the board: the project she worked on only there is off it.
  await call('DELETE', `/api/boards/${team}/shares/${later}`, {as: 'alice'});
  const before = key();
  await call('POST', '/api/projects', {as: 'alice', body: {groups: ['secret'], name: 'Hidden'}});
  assert.equal(key(), before, 'a project renamed off the board');
  // A machine that measures but has no agents on the board's subscriptions.
  const secret = (await call('POST', '/api/tokens', {as: 'bob', body: {}})).body.secret;
  await call('POST', '/v1/ingest', {body: batch('bob-desk-0123456789'), headers: {authorization: `Bearer ${secret}`}});
  assert.equal(key(), before, 'a machine added with no agents on the board');
  // A name the board shows changes the key.
  await call('POST', '/api/projects', {as: 'alice', body: {groups: ['quotum'], name: 'Quotum hub'}});
  assert.notEqual(key(), before);
});

test('the work of a period is of its known part: a range reads its own, and one before the hub kept work reads none', async () => {
  const {call, store, team, ago, hour} = await worked();
  const range = (from: number, to: number) => call('GET', `/api/history?board=${team}&from=${from}&to=${to}`, {as: 'alice'}).then(r => r.body);
  const middle = await range(ago(3.5), ago(2.5));
  assert.equal(middle.activity.activeMs, ago(3) - middle.since, "Alice's work within it, out to whole cells; Bob's is before he joined");
  assert.equal(Math.round(middle.activity.activeMs / hour * 10) / 10, 0.5);
  assertWork(middle);
  const before = await range(ago(12), ago(8));
  assert.equal(before.activity.known, null, 'before the subscription came to the board, nothing of it is known');
  store.db.prepare("UPDATE meta SET value = ? WHERE key = 'agentWorkSince'").run(String(ago(1)));
  const early = await range(ago(4), ago(2));
  assert.equal(early.activity.known, null, 'before the hub kept work');
  assert.equal(early.activity.since, ago(1));
  assert.deepEqual(
    early.series.map((line: any) => [line.work.from, line.work.ms]),
    early.series.map(() => [ago(1), null]),
  );
});

test('agents report the coding agents running on their machines; the cards of their subscriptions show them', async () => {
  const {call, person} = await hub();
  await person('alice');
  const token = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret;
  const headers = {authorization: `Bearer ${token}`};
  await call('POST', '/v1/ingest', {body: batch('alices-laptop-0123456789'), headers});
  const report = (sessions: object[]) =>
    call('POST', '/v1/sessions', {body: {version: 1, agent: 'quotum/0.3.0', machine: machine('alices-laptop-0123456789'), sentAt: iso(Date.now()), sessions}, headers});
  const started = iso(Date.now() - 3_600_000);
  const codex = {provider: 'codex', account: 'a1b2c3d4e5f6a1b2c3d4e5f6', origin: 'terminal', project: 'quotum', startedAt: started, working: true};
  const unknown = {...codex, account: 'ffffffffffffffffffffffff'};
  const guessed = {provider: 'codex', origin: 'editor', startedAt: started, working: false};
  const answer = await report([codex, unknown, guessed]);
  assert.deepEqual([answer.status, answer.body], [200, {accepted: 2}], 'a subscription the hub does not know is left out');
  const shown = async () => {
    const board = (await call('GET', '/api/overview', {as: 'alice'})).body;
    return board.sessions[board.sources[0].id];
  };
  const [first, second] = await shown();
  assert.deepEqual([first.origin, first.project, first.folder, first.working, first.device.name, first.startedAt], ['terminal', 'quotum', null, true, 'build-01', Date.parse(started)]);
  assert.equal(second.lastWorkedAt, null, 'an older agent omits the date');
  assert.equal(second.origin, 'editor', 'without an account: the subscription this machine delivers');
  assert.deepEqual(Object.keys(first).sort(), ['device', 'folder', 'lastWorkedAt', 'origin', 'project', 'startedAt', 'working'], 'nothing of how the hub tells sessions apart');
  assert.equal((await report([])).status, 200);
  assert.deepEqual(await shown(), [], 'an empty list: none runs');
  const long = await report([{...codex, project: 'x'.repeat(300), folder: 'y'.repeat(300)}]);
  assert.equal(long.body.accepted, 1, 'long names are cut, not refused');
  assert.deepEqual([(await shown())[0].project, (await shown())[0].folder], ['x'.repeat(120), 'y'.repeat(120)]);
  // Boards show the project, and the folder where the agent tells one; an older agent tells only the project.
  await report([
    {...codex, folder: 'quotum.feat-18', startedAt: iso(Date.now() - 4_000_000)},
    {...codex, startedAt: iso(Date.now() - 3_000_000)},
    {...codex, project: undefined, folder: 'scratch', startedAt: iso(Date.now() - 2_000_000)},
    {...codex, project: undefined, startedAt: iso(Date.now() - 1_000_000)},
  ]);
  assert.deepEqual(
    (await shown()).map((s: {project: string | null; folder: string | null}) => [s.project, s.folder]),
    [
      ['quotum', 'quotum.feat-18'],
      ['quotum', null],
      [null, 'scratch'],
      [null, null],
    ],
  );

  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await person('bob', (await call('POST', `/api/boards/${team}/invites`, {as: 'alice'})).body.url.split('/invite/')[1]);
  const bobs = (await call('POST', '/api/tokens', {as: 'bob', body: {}})).body.secret;
  const borrowed = await call('POST', '/v1/sessions', {
    body: {version: 1, agent: 'quotum/0.3.0', machine: machine('bobs-laptop-0123456789'), sentAt: iso(Date.now()), sessions: [codex]},
    headers: {authorization: `Bearer ${bobs}`},
  });
  assert.equal(borrowed.body.accepted, 0, "naming someone else's account shows nothing on it");

  const invalidTime = await report([{...guessed, lastWorkedAt: 'never'}]);
  assert.deepEqual([invalidTime.status, invalidTime.body], [400, {error: 'invalid_request', detail: 'lastWorkedAt'}]);
  const wrong = await report([{...codex, origin: 'browser'}]);
  assert.deepEqual([wrong.status, wrong.body], [400, {error: 'invalid_request', detail: 'origin'}]);
  // As many as a list may hold, every name at its longest, in the widest script or escaped in JSON, fit in one request.
  for (const char of ['🚀', '\u0001']) {
    const name = char.repeat(120);
    const longest = {...guessed, provider: 'antigravity', accountName: name, project: name, folder: name};
    const full = await call('POST', '/v1/sessions', {
      body: {version: 1, agent: 'quotum/0.3.0', machine: {...machine('alices-laptop-0123456789'), name}, sentAt: iso(Date.now()), sessions: Array.from({length: 200}, () => longest)},
      headers,
    });
    assert.equal(full.status, 200, JSON.stringify(full.body));
  }
  assert.equal((await call('POST', '/v1/sessions', {body: {version: 1}})).status, 401);
});

test('every period ending now is drawn on the finest cell that keeps it within about 360 cells, as a range as long moved back is', async () => {
  const {call, person} = await hub();
  await person('alice');
  const minute = 60_000;
  const cells: Record<string, number> = {'1h': 1, '3h': 1, '6h': 1, '12h': 5, '24h': 5, '3d': 15, '7d': 30, '14d': 60, '30d': 120};
  assert.deepEqual(Object.keys(cells), Object.keys(config.history.ranges), 'every period the hub offers');
  for (const [range, cell] of Object.entries(cells)) {
    const live = await call('GET', `/api/history?range=${range}`, {as: 'alice'});
    const durationMs = config.history.ranges[range];
    assert.deepEqual([live.status, live.body.cellMs, live.body.to - live.body.since], [200, cell * minute, durationMs], range);
    assert.ok(durationMs / live.body.cellMs <= 378, range);
    const now = Date.now();
    const moved = await call('GET', `/api/history?from=${now - durationMs * 1.5}&to=${now - durationMs / 2}`, {as: 'alice'});
    assert.equal(moved.body.cellMs, live.body.cellMs, `${range} moved back`);
  }
  for (const range of ['2h', '1y', 'toString']) assert.equal((await call('GET', `/api/history?range=${range}`, {as: 'alice'})).status, 400, range);
});

test('past resets for everyone are listed over the history kept, not only the last month', async () => {
  const {call, store} = await hub();
  const now = Date.now();
  const old = {at: now - 40 * 86_400_000, url: 'https://example.com/old', text: 'A reset for everyone'};
  store.announce('codex', old);
  store.announce('codex', {...old, at: now - 100 * 86_400_000});
  assert.deepEqual((await call('GET', '/api/resets')).body.past, {codex: [old]});
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
  assert.equal((await call('GET', '/health', {headers: {host: 'evil.example'}})).status, 200, 'the health check answers any host');
  if (existsSync(path.join(config.clientRoot, 'index.html'))) {
    assert.equal((await call('GET', '/device')).status, 200, 'client pages are served by the single-page client');
  }
  assert.equal((await call('GET', '/api/nothing')).status, 404);
});
