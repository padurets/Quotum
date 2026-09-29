import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildApp} from '../api.js';
import {Cadence} from '../cadence.js';
import {config} from '../config.js';
import {Duty} from '../duty.js';
import {Events, type Clock, type EventsOptions, type Frame, type Reader} from '../events.js';
import {hourShift} from '../forecasts.js';
import {Ingest, type Credential} from '../ingest.js';
import {Pairing} from '../pairing.js';
import {Projection} from '../projection.js';
import {ResetFeed} from '../resets.js';
import {Setup} from '../setup.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';

const S = 1000;
const MIN = 60_000;
const SETUP = 'BCDF-GHJK';
const iso = (ms: number) => new Date(ms).toISOString();
const ACCOUNT = 'a1b2c3d4e5f6a1b2c3d4e5f6';
/** The page asks for events with this header (spec: `GET /api/events`). */
const STREAM = {'quotum-stream': '1'};

/** A clock tests move by hand: timers run, in order, as it passes them. */
class ManualClock implements Clock {
  private timers: {at: number; run: () => void}[] = [];
  constructor(public t: number) {}
  now() {
    return this.t;
  }
  after(ms: number, run: () => void) {
    const timer = {at: this.t + ms, run};
    this.timers.push(timer);
    return () => void (this.timers = this.timers.filter(t => t !== timer));
  }
  /** Moves the clock on, running every timer due on the way. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter(t => t !== next);
      this.t = Math.max(this.t, next.at);
      next.run();
    }
    this.t = end;
  }
}

type Event = {type: string; data: any};

/** Every stream a test opened, let go before its hub is closed: a hub that will not stop fails its own test, not the file's run. */
const streams = new Set<() => void>();
const letGo = () => {
  for (const close of streams) close();
  streams.clear();
};

/** A stream of events read as the page reads it: what came, in order, and what comes next. */
async function open(base: string, cookie: string | undefined, board?: string, headers: Record<string, string> = STREAM) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events${board ? `?board=${board}` : ''}`, {headers: {...(cookie ? {cookie} : {}), ...headers}, signal: controller.signal});
  if (response.headers.get('content-type') !== 'text/event-stream; charset=utf-8')
    return {status: response.status, body: await response.json(), headers: response.headers};
  const events: Event[] = [];
  const waiting = new Set<() => void>();
  let ended = false;
  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  void (async () => {
    let text = '';
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        text += decoder.decode(value, {stream: true});
        let at: number;
        while ((at = text.indexOf('\n\n')) >= 0) {
          const block = text.slice(0, at);
          text = text.slice(at + 2);
          const type = block.match(/^event: (.*)$/m)?.[1] ?? 'message';
          const data = block.match(/^data: (.*)$/m)?.[1] ?? '';
          events.push({type, data: JSON.parse(data)});
        }
        for (const wake of waiting) wake();
      }
    } catch {
      /* aborted */
    }
    ended = true;
    for (const wake of waiting) wake();
  })();
  streams.add(() => void reader.cancel().catch(() => undefined));
  let read = 0;
  /** The next event but pings, within `ms`. */
  const next = async (ms = 2000): Promise<Event> => {
    const until = Date.now() + ms;
    for (;;) {
      while (read < events.length) {
        const event = events[read++];
        if (event.type !== 'ping') return event;
      }
      if (ended) throw new Error('the stream ended');
      const left = until - Date.now();
      if (left <= 0) throw new Error(`no event in ${ms} ms`);
      await new Promise<void>(resolve => {
        const wake = () => {
          waiting.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, left);
        waiting.add(wake);
      });
    }
  };
  /** Every event but pings that comes within `ms`. */
  const within = async (ms = 400): Promise<Event[]> => {
    const found: Event[] = [];
    const until = Date.now() + ms;
    for (;;) {
      try {
        found.push(await next(Math.max(1, until - Date.now())));
      } catch {
        return found;
      }
    }
  };
  return {
    status: response.status,
    headers: response.headers,
    body: null as any,
    events,
    next,
    within,
    types: async (ms?: number) => (await within(ms)).map(e => e.type),
    get ended() {
      return ended;
    },
    close: () => void reader.cancel().catch(() => undefined),
  };
}

type Stream = Awaited<ReturnType<typeof open>> & {next: (ms?: number) => Promise<Event>};

async function hub(options: Partial<EventsOptions> = {}, clock?: Clock) {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-events-')), 'db.sqlite'));
  const directory = new Directory(store.db);
  const ingest = new Ingest(store, directory, new Duty(), new Cadence());
  // Trackers nobody runs, on this machine: asked, they fail at once, and no test goes out to the network.
  const resets = new ResetFeed(undefined, () => {}, {...config.resets, enabled: false, codexApi: 'http://127.0.0.1:1/codex', claudeApi: 'http://127.0.0.1:1/claude'});
  const events = new Events({store, directory, ingest, resets}, {...config.events, recheckMs: 0, ...options}, clock, '/assets/index-test.js');
  const app = await buildApp({store, directory, resets, ingest, pairing: new Pairing(directory), setup: new Setup(true, SETUP), local: null, events});
  await app.listen({host: '127.0.0.1', port: 0});
  const base = `http://127.0.0.1:${(app.server.address() as {port: number}).port}`;
  const cookies = new Map<string, string>();
  const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, options: {as?: string; body?: object; token?: string; headers?: Record<string, string>} = {}) => {
    const response = await app.inject({
      method,
      url,
      payload: options.body,
      headers: {
        ...(options.as && cookies.get(options.as) ? {cookie: cookies.get(options.as)!} : {}),
        ...(options.token ? {authorization: `Bearer ${options.token}`} : {}),
        ...options.headers,
      },
    });
    const set = response.headers['set-cookie'];
    if (options.as && typeof set === 'string') cookies.set(options.as, set.split(';')[0]);
    return {status: response.statusCode, body: String(response.headers['content-type'] ?? '').includes('json') ? JSON.parse(response.body) : response.body};
  };
  /** Signs someone up (the first with the setup code, others with an invite); their personal board. */
  const person = async (as: string, invite?: string) => {
    const signup = await call('POST', '/api/auth/signup', {
      as,
      body: {email: `${as}@example.com`, name: as[0].toUpperCase() + as.slice(1), password: 'correct horse', invite, setupCode: SETUP},
    });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    return signup.body.boards.find((b: any) => b.personal).id as string;
  };
  const token = async (as: string) => (await call('POST', '/api/tokens', {as, body: {name: 'machines'}})).body.secret as string;
  const machine = (id: string) => ({id: `${id}-0123456789`, name: id, os: 'linux', arch: 'x86_64'});
  const measure = (secret: string, at: number, options: {used?: number; staleAfterMs?: number; account?: string; device?: string} = {}) =>
    call('POST', '/v1/ingest', {
      token: secret,
      body: {
        version: 1,
        agent: 'quotum/0.4.0',
        machine: machine(options.device ?? 'laptop'),
        sentAt: iso(Date.now()),
        snapshots: [
          {
            provider: 'codex',
            account: options.account ?? ACCOUNT,
            plan: 'pro',
            observedAt: iso(at),
            via: 'codex/app-server',
            staleAfterMs: options.staleAfterMs ?? 30 * MIN,
            windows: [{id: '5h', kind: 'session', minutes: 300, usedPercent: options.used ?? 50, resetsAt: null}],
          },
        ],
        failures: [],
      },
    });
  const stream = (as: string, board?: string, headers?: Record<string, string>) => open(base, cookies.get(as), board, headers) as Promise<Stream>;
  const invite = async (as: string, board: string) => (await call('POST', `/api/boards/${board}/invites`, {as})).body.url.split('/invite/')[1] as string;
  return {app, base, store, directory, ingest, resets, events, call, person, token, machine, measure, stream, invite, cookies};
}

/** Opens a stream and reads its `hello` and `snapshot`. */
async function reading(h: Awaited<ReturnType<typeof hub>>, as: string, board?: string) {
  const s = await h.stream(as, board);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const hello = await s.next();
  const snapshot = await s.next();
  assert.deepEqual([hello.type, snapshot.type], ['hello', 'snapshot']);
  return Object.assign(s, {hello: hello.data, snapshot: snapshot.data});
}

test('a stream starts with hello and the board as the reader sees it, the same as the projection puts it together and /api/overview answers', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  const board = await h.person('alice');
  const secret = await h.token('alice');
  await h.measure(secret, Date.now() - MIN);
  const s = await reading(h, 'alice');
  t.after(s.close);
  assert.deepEqual(Object.keys(s.hello), ['epoch', 'now', 'client', 'heartbeatMs']);
  assert.equal(s.hello.client, '/assets/index-test.js');
  assert.equal(s.hello.heartbeatMs, 25_000);
  assert.ok(Math.abs(s.hello.now - Date.now()) < 5 * S);
  const alice = h.directory.credentials('alice@example.com')!.user.id;
  assert.deepEqual(s.snapshot, JSON.parse(JSON.stringify(new Projection(h).snapshot(alice, board, Date.now()))));
  assert.deepEqual(s.snapshot, (await h.call('GET', `/api/overview?board=${board}`, {as: 'alice'})).body);
  assert.equal(s.snapshot.sources.length, 1);
  for (const header of ['cache-control', 'x-accel-buffering', 'content-security-policy', 'referrer-policy', 'x-content-type-options'])
    assert.ok(s.headers.get(header), header);
  assert.equal(s.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await s.types(300), [], 'nothing changed: nothing more');
});

test('a change goes out once, only as the part it changed, in one event however many touches it took', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  await h.person('alice');
  const secret = await h.token('alice');
  await h.measure(secret, Date.now() - 3 * MIN);
  const s = await reading(h, 'alice');
  t.after(s.close);
  const sessions = s.snapshot.sessions;

  // Three measurements in a row: one card, one history.
  await h.measure(secret, Date.now() - 2 * MIN, {used: 51});
  await h.measure(secret, Date.now() - MIN, {used: 52});
  await h.measure(secret, Date.now() - 1000, {used: 53});
  const changed = await s.within();
  assert.deepEqual(
    changed.map(e => e.type),
    ['card', 'history'],
  );
  assert.equal(changed[0].data.windows[0].used, 53);
  assert.equal(changed[1].data.sources.length, 1);
  assert.ok(changed[1].data.since <= Date.now() - 2 * MIN);

  // The same numbers again change nothing a reader sees.
  await h.measure(secret, Date.now() - 500, {used: 53});
  assert.deepEqual(await s.types(), ['card', 'history'], 'a newer measurement: when it was taken changed');
  assert.deepEqual(sessions, s.snapshot.sessions);
});

test("the board's own events and each reader's own go apart: its owner and a member hear different boards and sources of their own", async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  await h.person('alice');
  const team = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await h.person('bob', await h.invite('alice', team));
  const secret = await h.token('alice');
  await h.measure(secret, Date.now() - MIN);
  const source = h.store.sources((await h.call('GET', '/api/session', {as: 'alice'})).body.boards[0].id)[0].id;
  const alice = await reading(h, 'alice', team);
  const bob = await reading(h, 'bob', team);
  t.after(() => (alice.close(), bob.close()));
  assert.deepEqual([alice.snapshot.boards.find((b: any) => b.id === team).role, bob.snapshot.boards.find((b: any) => b.id === team).role], ['owner', 'member']);

  await h.call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source}});
  const [ofAlice, ofBob] = await Promise.all([alice.within(), bob.within()]);
  // Whose agents' work the board shows changed with it: all of its history reads otherwise.
  assert.deepEqual(
    ofAlice.map(e => e.type),
    ['card', 'sessions', 'cadence', 'forecast', 'lineup', 'mine', 'history'],
  );
  assert.deepEqual(ofAlice.at(-2)!.data, {sources: [source]});
  assert.deepEqual(ofAlice.at(-1)!.data, {sources: [source], since: 0});
  assert.deepEqual(
    ofBob.map(e => e.type),
    ['card', 'sessions', 'cadence', 'forecast', 'lineup', 'history'],
    "not Bob's: no mine for him",
  );
  for (const event of ofBob) assert.ok(!JSON.stringify(event.data).includes('"role"'), 'no role in what the board tells everyone');
});

test('a source taken off and back comes back whole, before the lineup; a reader who comes meanwhile never sees it', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  const personal = await h.person('alice');
  const team = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await h.measure(await h.token('alice'), Date.now() - MIN);
  const source = h.store.sources(personal)[0].id;
  await h.call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source}});
  const s = await reading(h, 'alice', team);
  t.after(s.close);

  await h.call('DELETE', `/api/boards/${team}/shares/${source}`, {as: 'alice'});
  assert.deepEqual(await s.types(), ['lineup', 'mine'], 'no history of no sources to read again');
  const later = await reading(h, 'alice', team);
  later.close();
  assert.deepEqual([later.snapshot.sources, later.snapshot.sessions, later.snapshot.cadence], [[], {}, {}]);

  await h.call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source}});
  assert.deepEqual(await s.types(), ['card', 'sessions', 'cadence', 'forecast', 'lineup', 'mine', 'history'], 'with no measurement in between, its work shown again');
});

test('a reader coming while changes wait to go out has them in the snapshot and hears of them no more', async t => {
  const h = await hub({smoothMs: 300});
  t.after(() => (letGo(), h.app.close()));
  await h.person('alice');
  const secret = await h.token('alice');
  await h.measure(secret, Date.now() - 2 * MIN);
  const first = await reading(h, 'alice');
  t.after(first.close);
  await h.measure(secret, Date.now() - MIN, {used: 70});
  const s = await reading(h, 'alice');
  t.after(s.close);
  assert.equal(s.snapshot.sources[0].windows[0].used, 70);
  assert.deepEqual(await s.types(600), [], 'in the snapshot, and the page reads its history after a snapshot anyway');
  assert.deepEqual(await first.types(100), ['card', 'history'], 'sent to the one reading already, when the new one came');
});

/** A hub on a clock tests move, with Alice, her token and a stream of her personal board. */
async function timed(t: TestContext, options: Partial<EventsOptions> = {}) {
  const clock = new ManualClock(Date.now());
  const h = await hub(options, clock);
  // Closed after the test, even when signing up fails: a hub left open would hold the file's run.
  t.after(() => (letGo(), h.app.close()));
  const board = await h.person('alice');
  const secret = await h.token('alice');
  const credential = h.ingest.authenticate(`Bearer ${secret}`) as Credential;
  const agent = {version: 1, agent: 'quotum/0.4.0', machine: h.machine('laptop')};
  const deliver = (at: number, staleAfterMs: number) =>
    h.ingest.accept(
      credential,
      {
        ...agent,
        sentAt: iso(clock.now()),
        snapshots: [
          {
            provider: 'codex',
            account: ACCOUNT,
            plan: 'pro',
            observedAt: iso(at),
            via: 'codex/app-server',
            staleAfterMs,
            windows: [{id: '5h', kind: 'session', minutes: 300, usedPercent: 50, resetsAt: null}],
          },
        ],
        failures: [],
      },
      clock.now(),
    );
  return {...h, clock, board, credential, agent, deliver};
}

test('what changes with time alone goes out when it does, with nothing told to the hub', async t => {
  const h = await timed(t);
  h.deliver(h.clock.now() - MIN, 3 * MIN);
  const s = await reading(h, 'alice');
  t.after(s.close);
  assert.equal(s.snapshot.sources[0].stale, false);

  // The card goes stale two minutes on.
  h.clock.advance(2 * MIN + S);
  const stale = await s.next();
  assert.deepEqual([stale.type, stale.data.stale], ['card', true]);

  // A machine's list of agents stops showing five minutes after it was told.
  h.ingest.sessions(
    h.credential,
    {
      ...h.agent,
      sentAt: iso(h.clock.now()),
      sessions: [{provider: 'codex', account: ACCOUNT, origin: 'app', startedAt: iso(h.clock.now() - MIN), lastWorkedAt: null, working: false}],
    },
    h.clock.now(),
  );
  h.clock.advance(200);
  assert.equal((await s.next()).data.sessions.length, 1);
  h.clock.advance(5 * MIN + S);
  assert.deepEqual((await s.next()).data.sessions, []);

  // A holder following the pace: its plan shows while it asks, and goes when it falls silent.
  h.ingest.checkin(h.credential, {...h.agent, paced: true, subscriptions: [{provider: 'codex', account: ACCOUNT, active: false}]}, h.clock.now());
  h.clock.advance(200);
  h.deliver(h.clock.now() - 100, 3 * MIN);
  h.clock.advance(200);
  const told = await s.within(300);
  assert.ok(
    told.some(e => e.type === 'cadence' && e.data.cadence !== null),
    JSON.stringify(told),
  );
  h.clock.advance(2 * MIN + S);
  const silent = (await s.within(300)).find(e => e.type === 'cadence');
  assert.equal(silent?.data.cadence, null, 'a holder quiet for over two minutes');

  // A reset for everyone falls out of the list as it falls out of the history.
  const kept = config.retention.sampleDays * 86_400_000;
  h.store.announce('codex', {at: h.clock.now() - kept + 10 * S, url: 'https://example.com', text: 'reset'});
  h.clock.advance(200);
  assert.equal((await s.next()).data.past.codex.length, 1);
  h.clock.advance(11 * S);
  assert.deepEqual((await s.next()).data.past, {});
});

test("a weekly window's forecast goes out after the source's cadence, the same on every board and in /api/overview, and again on the hour after a sample", async t => {
  const h = await timed(t);
  const HOUR = 60 * MIN;
  const start = h.clock.now() - 3 * 86_400_000;
  const deliver = (at: number) =>
    h.ingest.accept(
      h.credential,
      {
        ...h.agent,
        sentAt: iso(h.clock.now()),
        snapshots: [
          {
            provider: 'codex',
            account: ACCOUNT,
            plan: 'pro',
            observedAt: iso(at),
            via: 'codex/app-server',
            staleAfterMs: 20 * MIN,
            windows: [{id: 'weekly', kind: 'weekly', minutes: 10080, usedPercent: Math.round((0.5 * (at - start)) / HOUR), resetsAt: iso(start + 7 * 86_400_000)}],
          },
        ],
        failures: [],
      },
      h.clock.now(),
    );
  let last = start + HOUR;
  for (; last + 10 * MIN < h.clock.now() - MIN; last += 10 * MIN) deliver(last);
  deliver(last);
  const source = h.store.sources(h.board)[0].id;
  const team = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await h.call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source}});
  // Just past the hour this subscription's forecasts are worked out on, with a sample after it.
  const shift = hourShift(source);
  const hour = Math.floor((h.clock.now() - shift) / HOUR) * HOUR + HOUR;
  // Measured every ten minutes up to then, whatever minute the test starts at: no gap for the hub to work out at once.
  for (last += 10 * MIN; last < hour + shift; last += 10 * MIN) {
    h.clock.advance(last + S - h.clock.now());
    deliver(last);
  }
  h.clock.advance(hour + shift + 30 * S - h.clock.now());
  const latest = h.clock.now() - 10 * S;
  deliver(latest);

  let read = 0;
  const samples = h.store.seriesSamples.bind(h.store);
  h.store.seriesSamples = (...args) => (read++, samples(...args));
  const own = await reading(h, 'alice');
  t.after(own.close);
  const shared = await reading(h, 'alice', team);
  t.after(shared.close);
  const forecast = own.snapshot.forecast[source];
  assert.deepEqual(Object.keys(forecast), ['weekly']);
  // The first since the hub started, on the latest sample.
  assert.equal(forecast.weekly.asOf, latest);
  assert.equal(forecast.weekly.state, 'lasts');
  assert.deepEqual(shared.snapshot.forecast[source], forecast);
  assert.equal(JSON.parse(h.store.kept(`forecast:${source}:weekly`)!).asOf, latest, 'kept for a restart');
  const overview = (await h.call('GET', `/api/overview?board=${team}`, {as: 'alice'})).body;
  assert.deepEqual(overview.forecast[source], forecast);
  assert.equal(read, 1, 'worked out once for both boards and the overview');

  // A sample in the same hour: the card changes, the forecast does not.
  h.clock.advance(MIN);
  deliver(h.clock.now() - S);
  h.clock.advance(200);
  assert.ok(!(await own.types()).includes('forecast'));
  assert.equal(read, 1);

  // The next hour, with nothing told: the forecast after the sample, the same on both boards.
  h.clock.advance(hour + HOUR + shift - h.clock.now() + S);
  const next = (await own.within()).filter(e => e.type === 'forecast');
  assert.equal(next.length, 1);
  assert.deepEqual(next[0].data.id, source);
  assert.equal(next[0].data.forecast.weekly.asOf, hour + HOUR);
  const other = (await shared.within()).find(e => e.type === 'forecast');
  assert.deepEqual(other?.data, next[0].data);
  assert.equal(read, 2);
});

test('every watched board is worked out in full now and then: a change no touch told of arrives all the same', async t => {
  const h = await timed(t, {recheckMs: 25_000});
  const s = await reading(h, 'alice');
  t.after(s.close);
  // Behind the hub's back: no touch.
  h.store.db.prepare('UPDATE boards SET name = ? WHERE id = ?').run('Secret', h.board);
  h.clock.advance(25_000 + 200);
  const event = await s.next();
  assert.deepEqual([event.type, event.data.board.name], ['board', 'Secret']);
});

test('a deadline months off waits for its day: while a reset for everyone stays in the list, an open board costs nothing', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  await h.person('alice');
  h.store.announce('codex', {at: Date.now() - 86_400_000, url: 'https://example.com', text: 'reset'});
  let asked = 0;
  const announcements = h.store.announcements.bind(h.store);
  h.store.announcements = (since: number) => (asked++, announcements(since));
  const warnings: string[] = [];
  const warned = (warning: Error) => warnings.push(warning.name);
  process.on('warning', warned);
  t.after(() => process.off('warning', warned));
  const s = await reading(h, 'alice');
  t.after(s.close);
  assert.equal(s.snapshot.resets.past.codex.length, 1);
  asked = 0;
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.deepEqual({asked, warnings}, {asked: 0, warnings: []});
});

test('a board the hub cannot work out fails alone: its readers start over, a new one is refused with an error and leaves nothing behind, and the hub goes on', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  const personal = await h.person('alice');
  const team = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await h.call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {layout: {columns: 6, places: {history: {x: 0, y: 0, w: 6}}}}});
  const own = await reading(h, 'alice', personal);
  const broken = await reading(h, 'alice', team);
  t.after(() => [own, broken].forEach(s => s.close()));

  // Its view spoilt behind the hub's back, then both boards touched at once, the broken one
  // first: the timer's work fails on it, and the other is worked out all the same.
  h.store.db.prepare('UPDATE views SET payload = ? WHERE board_id = ?').run('{not json', team);
  await h.call('POST', `/api/boards/${team}`, {as: 'alice', body: {name: 'Crew'}});
  await h.call('POST', `/api/boards/${personal}`, {as: 'alice', body: {name: 'Home'}});
  assert.deepEqual((await broken.next()).data, {reason: 'restart'});
  assert.deepEqual(await own.types(), ['board', 'boards'], 'the other board goes on');

  const refused = await h.stream('alice', team);
  assert.equal(refused.status, 500);
  const polled = await h.call('GET', `/api/events?mode=poll&board=${team}`, {as: 'alice', headers: STREAM});
  assert.equal(polled.status, 500);
  assert.equal(h.events.readers, 1, 'nothing is left of the readers refused');
  await h.call('POST', `/api/boards/${personal}`, {as: 'alice', body: {name: 'Mine'}});
  assert.deepEqual(await own.types(), ['board', 'boards']);
});

test('a stream its reader stopped reading is let go once it falls too far behind, through the route', async t => {
  const h = await hub({smoothMs: 5, bufferBytes: 64 * 1024});
  t.after(() => (letGo(), h.app.close()));
  const board = await h.person('alice');
  const {port} = new URL(h.base);
  const socket = net.connect(Number(port), '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`GET /api/events?board=${board} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${h.cookies.get('alice')}\r\nQuotum-Stream: 1\r\n\r\n`);
  socket.pause();
  for (let waited = 0; !h.events.readers && waited < 5 * S; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.events.readers, 1, 'the stream opened');
  // A board changing fast, with a large view: what waits for the reader grows past what the socket holds.
  for (let i = 0; i < 600 && h.events.readers; i++) {
    const order = Array.from({length: 120}, (_, k) => `source:${i}-${k}-`.padEnd(120, 'x'));
    assert.equal((await h.call('POST', `/api/boards/${board}/view`, {as: 'alice', body: {layout: {columns: 6, places: Object.fromEntries(order.map((id, y) => [id, {x: 0, y, w: 6}]))}}})).status, 200);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.equal(h.events.readers, 0);
});

test('what is a reader’s own or the hub’s that cannot be worked out: a new reader is refused, one reading is sent it whole later, and the rest goes out', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  const personal = await h.person('alice');
  const team = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  const {projection} = h.events as unknown as {projection: Projection};
  /** The `nth` call of it from now fails, as reading the disk may. */
  const fail = (on: object, name: string, nth = 1) => {
    const methods = on as Record<string, (...args: unknown[]) => unknown>;
    const real = methods[name].bind(on);
    let calls = 0;
    methods[name] = (...args: unknown[]) => {
      if (++calls === nth) throw new Error('disk I/O error');
      return real(...args);
    };
  };

  // The hub's news, her boards or her own sources cannot be read for her first stream: its
  // snapshot would miss them, so it is refused, leaving nothing behind; asked again, it opens.
  for (const [on, name] of [
    [h.store, 'announcements'],
    [projection, 'boards'],
    [projection, 'mine'],
  ] as const) {
    fail(on, name);
    assert.equal((await h.stream('alice', personal)).status, 500, name);
    assert.equal(h.events.readers, 0, name);
  }
  const s = await reading(h, 'alice', personal);
  t.after(s.close);
  assert.ok(s.snapshot.resets);
  assert.deepEqual(s.snapshot.boards.map((b: {id: string}) => b.id).sort(), [personal, team].sort());

  // The hub's news cannot be read as another stream opens: the news known goes in its snapshot.
  fail(h.store, 'announcements');
  const other = await reading(h, 'alice', team);
  t.after(other.close);
  assert.deepEqual(other.snapshot.resets, s.snapshot.resets);

  // Nor as a board is renamed: the rename goes out all the same.
  fail(h.store, 'announcements');
  await h.call('POST', `/api/boards/${personal}`, {as: 'alice', body: {name: 'Home'}});
  h.resets.onChange();
  assert.deepEqual(await s.types(), ['board', 'boards']);
  assert.deepEqual(await other.types(), ['boards']);

  // Her own sources cannot be read for one of her streams as a board is renamed: a stream
  // before it is told her boards now; that one and those after it, whole, when she is
  // touched next. Her second stream, then her first.
  fail(projection, 'mine', 2);
  await h.call('POST', `/api/boards/${team}`, {as: 'alice', body: {name: 'Crew'}});
  assert.deepEqual([await s.types(), await other.types()], [['boards'], ['board']]);
  await h.call('POST', `/api/boards/${team}`, {as: 'alice', body: {name: 'Crew'}});
  assert.deepEqual(
    [await s.types(), await other.types()],
    [
      ['mine', 'boards'],
      ['mine', 'boards'],
    ],
  );
  fail(projection, 'mine');
  await h.call('POST', `/api/boards/${team}`, {as: 'alice', body: {name: 'Band'}});
  assert.deepEqual([await s.types(), await other.types()], [[], ['board']]);
  await h.call('POST', `/api/boards/${team}`, {as: 'alice', body: {name: 'Band'}});
  const told = await other.within();
  assert.deepEqual(
    [await s.types(), told.map(e => e.type)],
    [
      ['mine', 'boards'],
      ['mine', 'boards'],
    ],
  );
  assert.equal(told[1].data.boards.find((b: {id: string}) => b.id === team).name, 'Band');
});

test('her boards cannot be worked out as her own sources and the board change: the board’s change reaches everyone, and what is hers comes whole next time', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  await h.person('alice');
  const team = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await h.person('bob', await h.invite('alice', team));
  const alice = h.directory.credentials('alice@example.com')!.user.id;
  const bob = h.directory.credentials('bob@example.com')!.user.id;
  const source = h.store.source('codex', ACCOUNT, Date.now());
  h.store.hold(source, bob, Date.now());
  h.store.share(team, source, bob, Date.now());
  const a = await reading(h, 'alice', team);
  const b = await reading(h, 'bob', team);
  t.after(() => [a, b].forEach(s => s.close()));
  assert.deepEqual(a.snapshot.mine, []);

  const {projection} = h.events as unknown as {projection: Projection};
  const real = projection.boards.bind(projection);
  let failing = true;
  projection.boards = (user: string) => {
    if (failing && user === alice) {
      failing = false;
      throw new Error('disk I/O error');
    }
    return real(user);
  };
  // Her devices measure it now too: the card changes, and so do her own sources.
  h.store.hold(source, alice, Date.now());
  const [heard, told] = [await a.types(), await b.types()];
  assert.equal(failing, false, 'her boards failed');
  assert.ok(told.includes('card'), `bob hears the card: ${told}`);
  assert.ok(heard.includes('card'), `alice hears the card: ${heard}`);
  assert.ok(!heard.includes('mine'), `nothing of hers half told: ${heard}`);

  // Touched next: what is hers comes whole, with the source her devices now measure.
  await h.call('POST', `/api/boards/${team}`, {as: 'alice', body: {name: 'Team'}});
  const later = await a.within();
  assert.deepEqual(later.find(e => e.type === 'mine')?.data.sources, [source], `alice later: ${later.map(e => e.type)}`);
});

test('a ping finds out what nobody told: a session gone or a place on the board lost behind the hub’s back', async t => {
  const h = await timed(t);
  const s = await reading(h, 'alice');
  t.after(s.close);
  h.store.db.prepare('DELETE FROM sessions').run();
  h.clock.advance(25_000 + 100);
  assert.deepEqual((await s.next()).data, {reason: 'unauthorized'});

  await h.call('POST', '/api/auth/login', {as: 'alice', body: {email: 'alice@example.com', password: 'correct horse'}});
  const again = await reading(h, 'alice');
  t.after(again.close);
  h.store.db.prepare('DELETE FROM members').run();
  h.clock.advance(25_000 + 100);
  assert.deepEqual((await again.next()).data, {reason: 'gone'});
});

test('signing out, a new password, being removed and a board deleted end the streams they concern with bye, and nothing else', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  await h.person('alice');
  const team = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await h.person('bob', await h.invite('alice', team));
  await h.call('POST', '/api/auth/login', {as: 'alice2', body: {email: 'alice@example.com', password: 'correct horse'}});

  const bobs = await reading(h, 'bob', team);
  const bobsOwn = await reading(h, 'bob');
  const other = await reading(h, 'alice2');
  const own = await reading(h, 'alice');
  t.after(() => [bobs, bobsOwn, other, own].forEach(s => s.close()));

  // A rolled-back removal lets nobody go.
  assert.throws(() =>
    h.directory.transaction(() => {
      h.directory.removeMember(team, h.directory.credentials('bob@example.com')!.user.id);
      throw new Error('rolled back');
    }),
  );
  assert.deepEqual(await bobs.types(300), [], 'still on the board');

  await h.call('POST', `/api/boards/${team}/leave`, {as: 'bob'});
  assert.deepEqual((await bobs.next()).data, {reason: 'gone'});
  assert.deepEqual(await bobsOwn.types(), ['boards'], 'his other stream hears his boards changed');

  // A new password ends the other sessions, not this one.
  await h.call('POST', '/api/account', {as: 'alice', body: {currentPassword: 'correct horse', password: 'better horse staple'}});
  assert.deepEqual((await other.next()).data, {reason: 'unauthorized'});
  assert.deepEqual(await own.types(300), [], 'the session that changed it goes on');

  const deleted = await reading(h, 'alice', team);
  await h.call('DELETE', `/api/boards/${team}`, {as: 'alice'});
  assert.deepEqual((await deleted.next()).data, {reason: 'gone'});
  assert.deepEqual(await own.types(), ['boards']);

  await h.call('POST', '/api/auth/logout', {as: 'alice'});
  assert.deepEqual((await own.next()).data, {reason: 'unauthorized'});
  await new Promise(resolve => setTimeout(resolve, 100));
  for (const s of [bobs, other, own, deleted]) assert.equal(s.ended, true, 'and the stream ends');
  assert.equal(h.events.readers, 1, "only Bob's own board is read still");
});

test('only the hub’s own page opens events: without its header, from another origin or site, or with HEAD, nothing starts', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  await h.person('alice');
  const cookie = h.cookies.get('alice');
  const refused = [
    await open(h.base, cookie, undefined, {}),
    await open(h.base, cookie, undefined, {...STREAM, origin: 'https://evil.example.com'}),
    await open(h.base, cookie, undefined, {...STREAM, 'sec-fetch-site': 'same-site'}),
  ];
  assert.deepEqual(
    refused.map(r => [r.status, r.body]),
    Array(3).fill([403, {error: 'forbidden_origin'}]),
  );
  for (const url of ['/api/events?mode=poll', '/api/events?mode=poll&lease=x']) {
    assert.deepEqual(await h.call('GET', url, {as: 'alice'}), {status: 403, body: {error: 'forbidden_origin'}});
  }
  assert.equal(h.events.readers, 0, 'no lease, nobody let go');
  assert.equal((await open(h.base, undefined)).status, 401);
  assert.equal((await open(h.base, undefined, 'nope', {})).status, 401, 'no session is told so first');
  assert.deepEqual((await open(h.base, cookie, 'nope')).body, {error: 'board_not_found'});
  assert.deepEqual((await open(h.base, cookie, 'nope', {})).body, {error: 'forbidden_origin'}, 'another page learns nothing of which boards there are');
  assert.equal(
    (await fetch(`${h.base}/api/events`, {method: 'HEAD', headers: {cookie: cookie!, ...STREAM}, signal: AbortSignal.timeout(3000)})).headers
      .get('content-type')
      ?.includes('event-stream') ?? false,
    false,
  );
  const same = await open(h.base, cookie, undefined, {...STREAM, 'sec-fetch-site': 'same-origin', origin: h.base});
  assert.equal(same.status, 200);
  (same as Stream).close();
});

test('too many streams: a new one takes the place of the oldest of its session, then of its person; past the hub’s limit, another person is refused', async t => {
  const h = await hub({perSession: 2, perUser: 3, maxStreams: 3});
  t.after(() => (letGo(), h.app.close()));
  await h.person('alice');
  const team = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await h.person('bob', await h.invite('alice', team));
  const a1 = await reading(h, 'alice');
  const a2 = await reading(h, 'alice');
  const a3 = await reading(h, 'alice');
  assert.deepEqual((await a1.next()).data, {reason: 'limit'}, 'the oldest of the session');
  await h.call('POST', '/api/auth/login', {as: 'alice2', body: {email: 'alice@example.com', password: 'correct horse'}});
  const b1 = await reading(h, 'alice2');
  const b2 = await reading(h, 'alice2');
  assert.deepEqual((await a2.next()).data, {reason: 'limit'}, 'the oldest of the person, from another session');
  const refused = await h.stream('bob');
  assert.deepEqual([refused.status, refused.body], [429, {error: 'too_many_streams'}], 'Bob has no stream to give up');
  b1.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const bob = await reading(h, 'bob');
  await h.call('POST', '/api/auth/login', {as: 'alice3', body: {email: 'alice@example.com', password: 'correct horse'}});
  const c1 = await reading(h, 'alice3');
  assert.deepEqual((await a3.next()).data, {reason: 'limit'}, 'past the hub’s limit, someone with streams gives up their oldest');
  for (const s of [a1, a2, a3, b2, bob, c1]) s.close();
});

test('a reader too far behind is let go', () => {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-events-')), 'db.sqlite'));
  const directory = new Directory(store.db);
  const ingest = new Ingest(store, directory, new Duty(), new Cadence());
  const clock = new ManualClock(Date.now());
  const events = new Events(
    {store, directory, ingest, resets: new ResetFeed(undefined, () => {}, {...config.resets, enabled: false})},
    {...config.events, recheckMs: 0},
    clock,
    null,
  );
  events.attach();
  const user = directory.createUser('alice@example.com', 'Alice', 'x', clock.now());
  directory.createSession('qt_s_secret', user.id, clock.now(), MIN);
  const board = directory.boards(user.id)[0].id;
  const got: string[] = [];
  const reader: Reader = {
    user: user.id,
    secret: 'qt_s_secret',
    board,
    kind: 'stream',
    send: frames => got.push(...frames.map((f: Frame) => f.type)),
    backlog: () => 300 * 1024,
    end: reason => got.push(`bye ${reason}`),
  };
  assert.notEqual(events.open(reader), 'limit');
  directory.renameBoard(board, 'Mine');
  clock.advance(200);
  assert.deepEqual(got, ['board', 'boards', 'bye limit']);
  assert.equal(events.readers, 0);
});

test('long polls carry the same events: a lease starts with hello and snapshot, waits for news, and one unknown starts over', async t => {
  const h = await hub({pollMs: 400, leaseMs: 1000});
  t.after(() => (letGo(), h.app.close()));
  await h.person('alice');
  const secret = await h.token('alice');
  await h.measure(secret, Date.now() - 2 * MIN);
  const poll = async (lease?: string, as = 'alice') => (await h.call('GET', `/api/events?mode=poll${lease ? `&lease=${lease}` : ''}`, {as, headers: STREAM})).body;
  const first = await poll();
  assert.deepEqual(
    first.events.map((e: Event) => e.type),
    ['hello', 'snapshot'],
  );
  const started = Date.now();
  const empty = await poll(first.lease);
  assert.deepEqual(empty.events, []);
  assert.ok(Date.now() - started >= 350, 'held while nothing happened');

  const waiting = poll(first.lease);
  await h.measure(secret, Date.now() - MIN, {used: 60});
  const news = await waiting;
  assert.deepEqual(
    news.events.map((e: Event) => e.type),
    ['card', 'history'],
  );
  assert.equal(news.lease, first.lease);

  await new Promise(resolve => setTimeout(resolve, 1200));
  const expired = await poll(first.lease);
  assert.notEqual(expired.lease, first.lease, 'forgotten a while after its last answer');
  assert.deepEqual(
    expired.events.map((e: Event) => e.type),
    ['hello', 'snapshot'],
  );
  await h.call('POST', '/api/auth/login', {as: 'alice2', body: {email: 'alice@example.com', password: 'correct horse'}});
  assert.notEqual((await poll(expired.lease, 'alice2')).lease, expired.lease, "another session's lease is not this one's");
});

test('a lease is of its board, and holds no more than a reader may fall behind: past that it starts over', async t => {
  const h = await hub({pollMs: 300, bufferBytes: 64});
  t.after(() => (letGo(), h.app.close()));
  const personal = await h.person('alice');
  const team = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  const poll = async (board: string, lease?: string) =>
    (await h.call('GET', `/api/events?mode=poll&board=${board}${lease ? `&lease=${lease}` : ''}`, {as: 'alice', headers: STREAM})).body;
  const first = await poll(personal);
  const other = await poll(team, first.lease);
  assert.notEqual(other.lease, first.lease, 'asked for another board, it is another lease');
  assert.equal(other.events[1].data.board.id, team);

  // Renamed until what waits for the lease is more than it may hold.
  for (const name of ['Crew', 'Band', 'Gang']) await h.call('POST', `/api/boards/${team}`, {as: 'alice', body: {name}});
  await new Promise(resolve => setTimeout(resolve, 200));
  const behind = await poll(team, other.lease);
  assert.notEqual(behind.lease, other.lease);
  assert.deepEqual(
    behind.events.map((e: Event) => e.type),
    ['hello', 'snapshot'],
  );
  assert.equal(behind.events[1].data.board.name, 'Gang');
});

test('a lease let go for a newer reader says so once, then is forgotten', async t => {
  const h = await hub({perSession: 1, pollMs: 300});
  t.after(() => (letGo(), h.app.close()));
  await h.person('alice');
  const poll = async (lease?: string) => (await h.call('GET', `/api/events?mode=poll${lease ? `&lease=${lease}` : ''}`, {as: 'alice', headers: STREAM})).body;
  const held = await poll();
  const waiting = poll(held.lease);
  const s = await reading(h, 'alice');
  t.after(s.close);
  assert.deepEqual((await waiting).events, [{type: 'bye', data: {reason: 'limit'}}], 'a request waiting hears it at once');

  const idle = await poll();
  assert.deepEqual((await s.next()).data, {reason: 'limit'});
  const again = await reading(h, 'alice');
  t.after(again.close);
  assert.deepEqual((await poll(idle.lease)).events, [{type: 'bye', data: {reason: 'limit'}}], 'a lease asked on later hears it once');
  assert.deepEqual(
    (await poll(idle.lease)).events.map((e: Event) => e.type),
    ['hello', 'snapshot'],
  );
});

test('a hub with open streams and a held poll stops at once, telling them it restarts', async t => {
  const h = await hub({pollMs: 10_000});
  let s: Stream | undefined;
  const polling = new AbortController();
  // Let go after the test, its readers first, even when it fails early: a hub left open would hold the file's run.
  t.after(() => (s?.close(), polling.abort(), h.app.close()));
  await h.person('alice');
  const stream = (s = await reading(h, 'alice'));
  const lease = (await h.call('GET', '/api/events?mode=poll', {as: 'alice', headers: STREAM})).body.lease;
  const held = fetch(`${h.base}/api/events?mode=poll&lease=${lease}`, {headers: {cookie: h.cookies.get('alice')!, ...STREAM}, signal: polling.signal});
  await new Promise(resolve => setTimeout(resolve, 100));
  const started = Date.now();
  await Promise.race([h.app.close(), new Promise((_, stuck) => setTimeout(() => stuck(new Error('the hub did not stop')), 3000).unref())]);
  assert.ok(Date.now() - started < 1000, `closed in ${Date.now() - started} ms`);
  assert.deepEqual((await stream.next()).data, {reason: 'restart'});
  const answer = await held;
  assert.deepEqual((await answer.json()).events, [{type: 'bye', data: {reason: 'restart'}}]);
});

test('a stream outlives the time a request is given to arrive', async t => {
  const http = config.http as {requestTimeoutMs: number; checkMs: number};
  const saved = {...http};
  Object.assign(http, {requestTimeoutMs: 300, checkMs: 100});
  t.after(() => Object.assign(http, saved));
  const h = await hub({heartbeatMs: 200});
  t.after(() => (letGo(), h.app.close()));
  await h.person('alice');
  const s = await reading(h, 'alice');
  t.after(s.close);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(s.ended, false);
  assert.ok(s.events.filter(e => e.type === 'ping').length >= 3, 'pinged all along');
});

test('every change a reader sees is told: what each request touches reaches the streams of the boards it is on, and no other', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  const personal = await h.person('alice');
  const team = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await h.person('bob', await h.invite('alice', team));
  const secret = await h.token('alice');
  await h.measure(secret, Date.now() - 20 * MIN);
  const source = h.store.sources(personal)[0].id;
  await h.call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source}});
  const devices = (await h.call('GET', '/api/devices', {as: 'alice'})).body;

  const own = await reading(h, 'alice', personal);
  const shared = await reading(h, 'alice', team);
  const bobs = await reading(h, 'bob');
  t.after(() => [own, shared, bobs].forEach(s => s.close()));
  const agent = {version: 1, agent: 'quotum/0.4.0', machine: h.machine('laptop')};
  const session = {
    provider: 'codex',
    account: ACCOUNT,
    origin: 'app',
    project: 'quotum',
    folder: null,
    startedAt: iso(Date.now() - MIN),
    lastWorkedAt: null,
    working: false,
  };

  type Row = [string, () => Promise<unknown>, string[], string[], string[]];
  const rows: Row[] = [
    ['a measurement', () => h.measure(secret, Date.now() - 10 * MIN, {used: 60}), ['card', 'history'], ['card', 'history'], []],
    // Measured long enough ago: told to measure now, the card says a measurement is under way.

    [
      'a check-in at the pace',
      () => h.call('POST', '/v1/checkin', {token: secret, body: {...agent, paced: true, subscriptions: [{provider: 'codex', account: ACCOUNT, active: false}]}}),
      ['cadence'],
      ['cadence'],
      [],
    ],
    [
      'a list of agents',
      () => h.call('POST', '/v1/sessions', {token: secret, body: {...agent, sentAt: iso(Date.now()), sessions: [session]}}),
      ['sessions'],
      ['sessions'],
      [],
    ],
    ['a project renamed', () => h.call('POST', '/api/projects', {as: 'alice', body: {groups: ['quotum'], name: 'Quotum'}}), ['sessions'], ['sessions'], []],
    ['a project given its name back', () => h.call('POST', '/api/projects/restore', {as: 'alice', body: {reported: ['quotum']}}), ['sessions'], ['sessions'], []],
    ['a view saved', () => h.call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {layout: {columns: 6, places: {history: {x: 0, y: 0, w: 6}}}}}), [], ['view'], []],
    ['a board renamed', () => h.call('POST', `/api/boards/${team}`, {as: 'alice', body: {name: 'Crew'}}), ['boards'], ['board', 'boards'], ['boards']],
    ['a board made', () => h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Solo'}}), ['boards'], ['boards'], []],
    ['a name changed', () => h.call('POST', '/api/account', {as: 'alice', body: {name: 'Alicia'}}), ['card'], ['card'], []],
    ['a source taken off', () => h.call('DELETE', `/api/boards/${team}/shares/${source}`, {as: 'alice'}), [], ['lineup', 'mine'], []],
    ['a device renamed', () => h.call('POST', `/api/devices/${devices[0].id}`, {as: 'alice', body: {name: 'Book'}}), [], [], []],
    ['a device disconnected', () => h.call('DELETE', `/api/devices/${devices[0].id}`, {as: 'alice'}), ['lineup', 'mine'], [], []],
  ];
  for (const [what, act, onOwn, onShared, onBobs] of rows) {
    const done = await act();
    assert.ok((done as {status: number}).status < 300, `${what}: ${JSON.stringify(done)}`);
    const [a, b, c] = await Promise.all([own.types(), shared.types(), bobs.types()]);
    assert.deepEqual({own: a, shared: b, bobs: c}, {own: onOwn, shared: onShared, bobs: onBobs}, what);
  }
});

test('all of a board’s history is news when whose agents’ work it shows, or under which names, changes: a card hidden, a project or a machine renamed', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  const board = await h.person('alice');
  const secret = await h.token('alice');
  await h.measure(secret, Date.now() - 10 * MIN);
  const source = h.store.sources(board)[0].id;
  // Two lists of a working agent: the time between them is credited, so the laptop and its project worked on the board.
  const session = {provider: 'codex', account: ACCOUNT, origin: 'app', project: 'quotum', folder: null, startedAt: iso(Date.now() - 5 * MIN), lastWorkedAt: null, working: true};
  const report = () => h.call('POST', '/v1/sessions', {token: secret, body: {version: 1, agent: 'quotum/0.4.0', machine: h.machine('laptop'), sentAt: iso(Date.now()), sessions: [session]}});
  await report();
  await new Promise(resolve => setTimeout(resolve, 5));
  await report();
  const laptop = (await h.call('GET', '/api/devices', {as: 'alice'})).body[0].id;
  const s = await reading(h, 'alice', board);
  t.after(s.close);
  const all = {sources: [source], since: 0};
  const history = async () => (await s.within()).filter(e => e.type === 'history').map(e => e.data);

  await h.call('POST', `/api/boards/${board}/view`, {as: 'alice', body: {layout: {columns: 6, places: {}}, hidden: [`source:${source}`]}});
  assert.deepEqual(await history(), [all], 'a card hidden: its work is off the board');
  await h.call('POST', `/api/boards/${board}/view`, {as: 'alice', body: {layout: {columns: 6, places: {}}}});
  assert.deepEqual(await history(), [all], 'and shown again');
  await h.call('POST', '/api/projects', {as: 'alice', body: {groups: ['quotum'], name: 'Quotum'}});
  assert.deepEqual(await history(), [all], 'a project renamed');
  await h.call('POST', `/api/devices/${laptop}`, {as: 'alice', body: {name: 'Book'}});
  assert.deepEqual(await history(), [all], 'a machine renamed');
  await h.call('POST', `/api/boards/${board}/view`, {as: 'alice', body: {layout: {columns: 6, places: {history: {x: 0, y: 0, w: 6}}}}});
  assert.deepEqual(await history(), [], 'the widgets moved: the work it shows is the same');
});

test('what each change of data touches reaches the boards it shows on: people joining and leaving, subscriptions held and let go, agents gone with their machine, the trackers', async t => {
  const h = await hub();
  t.after(() => (letGo(), h.app.close()));
  const personal = await h.person('alice');
  const team = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  const bobs = await h.person('bob', await h.invite('alice', team));
  const other = (await h.call('POST', '/api/boards', {as: 'alice', body: {name: 'Other'}})).body.id;
  await h.person('carol', await h.invite('alice', other));
  const id = (who: string) => h.directory.credentials(`${who}@example.com`)!.user.id;
  const secret = await h.token('alice');
  const desk = await h.token('alice');
  const bobsSecret = await h.token('bob');
  await h.measure(secret, Date.now() - 20 * MIN);
  // The same subscription from a second machine: the first can go and the subscription stays.
  await h.measure(desk, Date.now() - 19 * MIN, {device: 'desk'});
  await h.measure(bobsSecret, Date.now() - 20 * MIN, {account: 'b0b0b0b0b0b0b0b0b0b0b0b0', device: 'bobs'});
  await h.call('POST', `/api/boards/${team}/shares`, {as: 'bob', body: {source: h.store.sources(bobs)[0].id}});
  const agent = (device: string) => ({version: 1, agent: 'quotum/0.4.0', machine: h.machine(device)});
  const session = {
    provider: 'codex',
    account: ACCOUNT,
    origin: 'app',
    project: 'quotum',
    folder: null,
    startedAt: iso(Date.now() - MIN),
    lastWorkedAt: null,
    working: false,
  };
  const agents = (device: string, sessions: object[]) =>
    h.call('POST', '/v1/sessions', {token: device === 'desk' ? desk : secret, body: {...agent(device), sentAt: iso(Date.now()), sessions}});
  await agents('laptop', [session]);
  const laptop = (await h.call('GET', '/api/devices', {as: 'alice'})).body.find((d: {name: string}) => d.name === 'laptop').id;

  const own = await reading(h, 'alice', personal);
  const shared = await reading(h, 'alice', team);
  const carols = await reading(h, 'carol');
  t.after(() => [own, shared, carols].forEach(s => s.close()));

  // Each change made alone, as the store and the directory make it, so no other touch hides a missing one.
  type Row = [string, () => unknown, string[], string[], string[]];
  const rows: Row[] = [
    ['someone joins a board', () => h.directory.addMember(team, id('carol'), Date.now()), [], [], ['boards']],
    // Whose agents' work the board shows changes too: its history reads otherwise.
    ['someone leaves it, what they shared left behind for now: they no longer own it there', () => h.directory.removeMember(team, id('bob')), [], ['card', 'history'], []],
    ['what nobody on the board holds leaves it, and no source with it', () => h.store.unshareOrphans(team), [], ['lineup'], []],
    [
      'a subscription measured for the first time',
      () => h.measure(desk, Date.now() - MIN, {account: 'c0c0c0c0c0c0c0c0c0c0c0c0', device: 'box'}),
      // Sent whole as it comes; the page reads its history for the new lineup, all of it.
      ['card', 'sessions', 'cadence', 'forecast', 'lineup', 'mine', 'history'],
      [],
      [],
    ],
    ['the machine that told of agents is disconnected', () => h.call('DELETE', `/api/devices/${laptop}`, {as: 'alice'}), ['sessions'], [], []],
    ['a machine tells of its agents', () => agents('desk', [session]), ['sessions'], [], []],
    ['and then of none', () => agents('desk', []), ['sessions'], [], []],
    ['the trackers asked', () => h.resets.round(), ['resets'], ['resets'], ['resets']],
  ];
  for (const [what, act, onOwn, onShared, onCarols] of rows) {
    const done = await act();
    if (done && typeof done === 'object' && 'status' in done) assert.ok((done as {status: number}).status < 300, `${what}: ${JSON.stringify(done)}`);
    const [a, b, c] = await Promise.all([own.types(), shared.types(), carols.types()]);
    assert.deepEqual({own: a, shared: b, carols: c}, {own: onOwn, shared: onShared, carols: onCarols}, what);
  }
});
