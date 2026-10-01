import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PageEvent} from '../lib/board';
import {Live, sseParser, type LiveEnv} from '../lib/live';

const S = 1000;
const MIN = 60_000;
const HEARTBEAT = 25_000;

/** Timers that run as the test moves the page's clock. */
class Timers {
  private list: {at: number; run: () => void; id: number}[] = [];
  private next = 1;
  constructor(public t: number) {}
  set = (run: () => void, ms: number) => {
    const id = this.next++;
    this.list.push({at: this.t + ms, run, id});
    return id;
  };
  clear = (id: unknown) => void (this.list = this.list.filter(timer => timer.id !== id));
  /** The clock moves on by `ms`, running what comes due on the way; `sleep`: the timers stood still meanwhile (a sleep), and run late. */
  async advance(ms: number, sleep = false) {
    const end = this.t + ms;
    if (sleep) this.t = end;
    for (;;) {
      const due = this.list.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.list = this.list.filter(timer => timer !== due);
      this.t = Math.max(this.t, due.at);
      due.run();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

/** A request the page made: the test answers it. */
type Asked = {
  url: string;
  headers: Record<string, string>;
  aborted: boolean;
  /** Answers with a stream the test writes to. */
  stream(status?: number, type?: string): {write(text: string): Promise<void>; end(): Promise<void>};
  /** Answers with JSON. */
  json(status: number, body: unknown): Promise<void>;
  fail(): Promise<void>;
};

const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const SNAPSHOT = {
  board: {id: 'b1', name: '', personal: true},
  view: {},
  historyStart: 0,
  sources: [],
  sessions: {},
  cadence: {},
  mine: [],
  boards: [],
  resets: {resets: {}, trackers: [], past: {}},
};

function harness(options: {visible?: boolean; skew?: number; script?: string | null; storage?: 'none' | Map<string, string>; random?: number} = {}) {
  const timers = new Timers(Date.parse('2026-09-26T12:00:00Z'));
  const asked: Asked[] = [];
  const events: PageEvent[] = [];
  const said: string[] = [];
  let visible = options.visible ?? true;
  const heard: number[] = [];
  const storage = options.storage ?? new Map<string, string>();
  const env: LiveEnv = {
    fetch: (url, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init.signal as AbortSignal;
        const request: Asked = {
          url,
          headers: init.headers as Record<string, string>,
          aborted: false,
          stream(status = 200, type = 'text/event-stream; charset=utf-8') {
            let control!: ReadableStreamDefaultController<Uint8Array>;
            const body = new ReadableStream<Uint8Array>({start: c => void (control = c)});
            signal.addEventListener('abort', () => {
              try {
                control.error(new DOMException('aborted', 'AbortError'));
              } catch {
                /* closed */
              }
            });
            resolve(new Response(body, {status, headers: {'content-type': type}}));
            return {
              write: async (text: string) => {
                control.enqueue(new TextEncoder().encode(text));
                await flush();
              },
              end: async () => {
                control.close();
                await flush();
              },
            };
          },
          json: async (status, body) => {
            resolve(new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}}));
            await flush();
          },
          fail: async () => {
            reject(new TypeError('network'));
            await flush();
          },
        };
        signal.addEventListener('abort', () => {
          request.aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
        asked.push(request);
      }),
    now: () => timers.t,
    setTimeout: timers.set,
    clearTimeout: timers.clear,
    random: () => options.random ?? 0.5,
    visible: () => visible,
    hubNow: (at = timers.t) => at + (options.skew ?? 0),
    heard: now => void heard.push(now),
    dispatch: event => void events.push(event),
    unauthorized: () => void said.push('unauthorized'),
    gone: () => void said.push('gone'),
    script: options.script === undefined ? '/assets/index-a.js' : options.script,
    reload: () => void said.push('reload'),
    storage: () => {
      if (storage === 'none') throw new Error('no storage');
      return {getItem: key => storage.get(key) ?? null, setItem: (key, value) => void storage.set(key, value)};
    },
  };
  const live = new Live(env);
  const last = () => asked.at(-1)!;
  const connection = () => events.filter(e => e.type === 'connection').at(-1) as Extract<PageEvent, {type: 'connection'}> | undefined;
  /** Opens the board and brings long polls live: ten seconds without an answer, then a lease with hello and snapshot. */
  const gopoll = async () => {
    live.open('b1');
    await timers.advance(10 * S);
    await last().json(200, {
      lease: 'L',
      now: timers.t,
      events: [
        {type: 'hello', data: {epoch: 'e1', now: timers.t, client: null, heartbeatMs: HEARTBEAT}},
        {type: 'snapshot', data: SNAPSHOT},
      ],
    });
    assert.equal(connection()?.status, 'polling');
  };
  /** The last request answers with a stream that brings the board live: hello and snapshot. */
  const answer = async () => {
    const stream = last().stream();
    await stream.write(frame('hello', {epoch: 'e1', now: timers.t, client: '/assets/index-a.js', heartbeatMs: HEARTBEAT}) + frame('snapshot', SNAPSHOT));
    return stream;
  };
  /** Opens the board and brings a stream live. */
  const golive = async () => {
    live.open('b1');
    await flush();
    const stream = await answer();
    assert.equal(connection()?.status, 'live');
    return stream;
  };
  return {
    live,
    timers,
    asked,
    events,
    said,
    heard,
    storage,
    last,
    connection,
    answer,
    golive,
    gopoll,
    hide: () => {
      visible = false;
      live.visibility();
    },
    show: () => {
      visible = true;
      live.visibility();
    },
    hubEvents: () => events.filter(e => e.type === 'hub').map(e => (e as Extract<PageEvent, {type: 'hub'}>).event.type),
  };
}

test('text/event-stream is read line by line however it is cut: CR LF, LF and CR end lines, U+2028 does not, a character may be cut in two', () => {
  const got: [string, string][] = [];
  const push = sseParser((type, data) => got.push([type, data]));
  push('event: card\ndata: {"a":');
  push('1}\n\n');
  push('event: x\r\ndata: 1\r\n\r');
  push('\nevent: y\rdata: " "\r\r');
  push(': a comment\n\nevent: z\ndata: 2\n\nevent: w\ndata: 3\n\n');
  assert.deepEqual(got, [
    ['card', '{"a":1}'],
    ['x', '1'],
    ['y', '" "'],
    ['z', '2'],
    ['w', '3'],
  ]);
  // A character of two bytes cut between chunks comes whole through a streaming decoder.
  const decoder = new TextDecoder('utf-8');
  const bytes = new TextEncoder().encode('event: n\ndata: "Анна"\n\n');
  const names: string[] = [];
  const read = sseParser((_type, data) => names.push(JSON.parse(data)));
  read(decoder.decode(bytes.slice(0, 18), {stream: true}));
  read(decoder.decode(bytes.slice(18), {stream: true}));
  assert.deepEqual(names, ['Анна']);
});

test('row 1, 3, 4: a board opens a stream with the header, and hello with snapshot brings it live', async () => {
  const h = harness({skew: 10 * MIN});
  h.live.open('b1');
  await h.timers.advance(0);
  assert.deepEqual(h.events[0], {type: 'board-open', id: 'b1'});
  assert.deepEqual(h.connection(), {type: 'connection', status: 'connecting', lostAt: h.timers.t + 10 * MIN}, 'lost since now, by the hub');
  assert.equal(h.last().url, '/api/events?board=b1');
  assert.equal(h.last().headers['Quotum-Stream'], '1');
  const stream = h.last().stream();
  await stream.write(frame('hello', {epoch: 'e1', now: 123, client: '/assets/index-a.js', heartbeatMs: HEARTBEAT}));
  assert.equal(h.connection()?.status, 'connecting', 'the snapshot is not there yet');
  await stream.write(frame('snapshot', SNAPSHOT) + frame('card', {id: 's1'}));
  assert.deepEqual(h.connection(), {type: 'connection', status: 'live', lostAt: null});
  assert.deepEqual(h.hubEvents(), ['hello', 'snapshot', 'card']);
  assert.deepEqual(h.heard, [123]);
});

test('row 5: no answer in 10 s, or no hello and snapshot 10 s after it: long polls', async () => {
  const h = harness();
  h.live.open('b1');
  await h.timers.advance(10 * S);
  assert.equal(h.asked[0].aborted, true);
  assert.match(h.last().url, /mode=poll$/, 'the answer never came');

  const g = harness();
  g.live.open('b1');
  await flush();
  const stream = g.last().stream();
  await stream.write(frame('hello', {epoch: 'e1', now: 1, client: null, heartbeatMs: HEARTBEAT}));
  await g.timers.advance(10 * S);
  assert.match(g.last().url, /mode=poll$/, 'hello, and no snapshot');
});

test('row 4a: hello and snapshot, and then silence until the first ping is due: a proxy holds small frames back, long polls', async () => {
  const h = harness();
  await h.golive();
  const since = h.timers.t;
  await h.timers.advance(HEARTBEAT + 10 * S);
  assert.match(h.last().url, /mode=poll$/);
  assert.deepEqual(h.connection(), {type: 'connection', status: 'connecting', lostAt: since}, 'lost since the last byte');
  // A ping in time keeps the stream.
  const g = harness();
  const stream = await g.golive();
  await g.timers.advance(HEARTBEAT);
  await stream.write(frame('ping', {now: 1}));
  assert.equal(g.heard.at(-1), 1, 'the hub’s clock as the ping tells it');
  await g.timers.advance(20 * S);
  assert.equal(g.asked.length, 1);
  assert.equal(g.connection()?.status, 'live');
});

test('row 4a, late: the first-ping timer held up by a sleep is a wake, not a proxy', async () => {
  const h = harness();
  const stream = await h.golive();
  await stream.write(frame('card', {id: 's1'}));
  // Asleep from before the first ping was due until long after: the stream is silent too long, opened again as a stream.
  await h.timers.advance(3 * MIN, true);
  assert.equal(h.asked.length, 2);
  assert.equal(h.last().url, '/api/events?board=b1');
});

test('row 6, 17: a long poll brings the board, then asks again at once, applying what comes, and back to a stream after ten minutes', async () => {
  const h = harness();
  h.live.open('b1');
  await h.timers.advance(10 * S);
  await h.last().json(200, {
    lease: 'L1',
    now: 5,
    events: [
      {type: 'hello', data: {epoch: 'e1', now: 5, client: null, heartbeatMs: HEARTBEAT}},
      {type: 'snapshot', data: SNAPSHOT},
    ],
  });
  assert.deepEqual(h.connection(), {type: 'connection', status: 'polling', lostAt: null});
  assert.match(h.last().url, /mode=poll&lease=L1$/);
  await h.last().json(200, {
    lease: 'L1',
    now: 6,
    events: [
      {type: 'card', data: {id: 's1'}},
      {type: 'cadence', data: {id: 's1', cadence: null}},
    ],
  });
  assert.deepEqual(h.hubEvents(), ['hello', 'snapshot', 'card', 'cadence']);
  // The hub holds each poll up to 25 s; ten minutes after polls began, a stream again.
  const began = h.timers.t;
  while (h.timers.t - began < 10 * MIN) {
    assert.match(h.last().url, /lease=L1$/);
    await h.timers.advance(25 * S);
    await h.last().json(200, {lease: 'L1', now: 7, events: []});
  }
  assert.equal(h.last().url, '/api/events?board=b1', 'a stream again');
  assert.equal(h.connection()?.status, 'connecting');
  for (const request of h.asked) assert.equal(request.headers['Quotum-Stream'], '1', 'in every request, polls too: the hub refuses one without');
  assert.deepEqual(h.heard.slice(0, 3), [5, 5, 6], 'the hub’s clock as each answer tells it');
});

test('rows 7, 8, 11: 401 or bye unauthorized ends it for sign-in; 404 or bye gone drops the board and reads the session', async () => {
  const h = harness();
  h.live.open('b1');
  await flush();
  await h.last().json(401, {error: 'unauthorized'});
  assert.deepEqual(h.said, ['unauthorized']);
  await h.timers.advance(MIN);
  assert.equal(h.asked.length, 1, 'nothing more');

  const g = harness();
  g.live.open('b1');
  await flush();
  await g.last().json(404, {error: 'board_not_found'});
  assert.deepEqual(g.said, ['gone']);
  assert.deepEqual(g.events.at(-1), {type: 'board-gone', id: 'b1'});

  for (const reason of ['unauthorized', 'gone']) {
    const k = harness();
    const stream = await k.golive();
    await stream.write(frame('bye', {reason}));
    assert.deepEqual(k.said, [reason]);
    await k.timers.advance(MIN);
    assert.equal(k.asked.length, 1);
  }
  // In a poll answer too; what came after bye is not applied.
  const p = harness();
  p.live.open('b1');
  await p.timers.advance(10 * S);
  await p.last().json(200, {
    lease: 'L',
    now: 1,
    events: [
      {type: 'hello', data: {epoch: 'e', now: 1, client: null, heartbeatMs: HEARTBEAT}},
      {type: 'snapshot', data: SNAPSHOT},
    ],
  });
  await p.last().json(200, {
    lease: 'L',
    now: 1,
    events: [
      {type: 'bye', data: {reason: 'gone'}},
      {type: 'card', data: {id: 's'}},
    ],
  });
  assert.deepEqual([p.said, p.hubEvents()], [['gone'], ['hello', 'snapshot']]);

  // While polling: 401 and 404 of the hub, and bye unauthorized, as in a stream.
  for (const [status, error, said] of [
    [401, 'unauthorized', 'unauthorized'],
    [404, 'board_not_found', 'gone'],
  ] as const) {
    const q = harness();
    await q.gopoll();
    const asked = q.asked.length;
    await q.last().json(status, {error});
    assert.deepEqual(q.said, [said]);
    await q.timers.advance(MIN);
    assert.equal(q.asked.length, asked, 'nothing more');
  }
  const u = harness();
  await u.gopoll();
  const asked = u.asked.length;
  await u.last().json(200, {lease: 'L', now: 1, events: [{type: 'bye', data: {reason: 'unauthorized'}}]});
  assert.deepEqual(u.said, ['unauthorized']);
  await u.timers.advance(MIN);
  assert.equal(u.asked.length, asked);
});

test('row 8: a 404 that is not the hub’s word on the board (a proxy’s, a hub without events) is any other answer, tried again later', async () => {
  const h = harness();
  h.live.open('b1');
  await flush();
  await h.last().json(404, {error: 'not_found'});
  assert.deepEqual([h.said, h.connection()?.status], [[], 'retrying']);
  await h.timers.advance(S);
  await h.last().json(404, {});
  await h.timers.advance(S);
  assert.equal(h.asked.length, 2, 'backing off: two seconds the second time');
  await h.timers.advance(S);
  assert.equal(h.asked.length, 3);

  const g = harness();
  await g.gopoll();
  await g.last().json(404, 'Not Found');
  assert.deepEqual([g.said, g.connection()?.status], [[], 'retrying']);
  assert.ok(!g.events.some(e => e.type === 'board-gone'));
});

test('closing lets the board and its connection go: signed in again later, nothing old shows', async () => {
  const h = harness();
  h.live.open('b1');
  await flush();
  await h.last().json(503, {});
  assert.notEqual(h.connection()?.lostAt, null);
  h.live.close();
  assert.deepEqual(h.events.at(-1), {type: 'board-close'});
  await h.timers.advance(10 * MIN);
  h.live.open('b1');
  await flush();
  assert.deepEqual(h.connection(), {type: 'connection', status: 'connecting', lostAt: h.timers.t}, 'lost since now, not ten minutes ago');
});

test('row 9: any other answer, a proxy’s page, the network: tried again later, longer each time, 429 included', async () => {
  const h = harness();
  h.live.open('b1');
  await flush();
  const lostAt = h.connection()!.lostAt;
  await h.last().json(429, {error: 'too_many_streams'});
  assert.deepEqual(h.connection(), {type: 'connection', status: 'retrying', lostAt});
  await h.timers.advance(999);
  assert.equal(h.asked.length, 1);
  await h.timers.advance(1);
  assert.equal(h.asked.length, 2, 'after a second');
  h.last().stream(200, 'text/html');
  await flush();
  await h.timers.advance(2 * S);
  assert.equal(h.asked.length, 3, 'a login page of a proxy: two seconds later');
  await h.last().json(407, {});
  await h.timers.advance(5 * S);
  await h.last().fail();
  await h.timers.advance(10 * S);
  assert.equal(h.asked.length, 5);
  for (const request of h.asked) assert.equal(request.url, '/api/events?board=b1', 'a stream still: 429 never means polls');
});

test('row 9a, 14: three streams in a row that end before their first ping: long polls; a ping resets the count', async () => {
  const h = harness();
  h.live.open('b1');
  await flush();
  // Backoffs of 1, 1 and 2 s (the second came live, which starts them over), each retry answered before its 10 s run out.
  for (let i = 0; i < 3; i++) {
    assert.equal(h.last().url, '/api/events?board=b1');
    const stream = h.last().stream();
    // The second comes live before it ends (row 14); the others end before their snapshot (row 9a).
    if (i === 1) await stream.write(frame('hello', {epoch: 'e', now: 1, client: null, heartbeatMs: HEARTBEAT}) + frame('snapshot', SNAPSHOT));
    await stream.end();
    assert.equal(h.connection()?.status, 'retrying');
    await h.timers.advance(6 * S);
  }
  assert.match(h.last().url, /mode=poll$/);

  const g = harness();
  const stream = await g.golive();
  await stream.write(frame('ping', {now: 1}));
  const since = g.timers.t;
  await g.timers.advance(10 * S);
  await stream.end();
  assert.deepEqual(g.connection(), {type: 'connection', status: 'retrying', lostAt: since}, 'lost since its last byte');
  for (let i = 0; i < 3; i++) {
    await g.timers.advance(6 * S);
    const next = g.last().stream();
    await next.write(frame('hello', {epoch: 'e', now: 1, client: null, heartbeatMs: HEARTBEAT}) + frame('snapshot', SNAPSHOT) + frame('ping', {now: 1}));
    await next.end();
  }
  await g.timers.advance(6 * S);
  assert.equal(g.last().url, '/api/events?board=b1', 'streams that were pinged never add up');
});

test('rows 12, 13: bye restart comes back in seconds, bye limit not before 30 s, also when the page wakes', async () => {
  const h = harness({skew: MIN});
  let stream = await h.golive();
  await h.timers.advance(5 * S);
  await stream.write(frame('ping', {now: 1}) + frame('bye', {reason: 'restart'}));
  assert.deepEqual(h.connection(), {type: 'connection', status: 'retrying', lostAt: h.timers.t + MIN}, 'lost now, by the hub');
  await h.timers.advance(3 * S);
  assert.equal(h.asked.length, 2, 'within 1–5 s');

  stream = h.last().stream();
  await stream.write(frame('hello', {epoch: 'e', now: 1, client: null, heartbeatMs: HEARTBEAT}) + frame('snapshot', SNAPSHOT) + frame('bye', {reason: 'limit'}));
  await h.timers.advance(2 * S);
  h.live.wake();
  await h.timers.advance(20 * S);
  assert.equal(h.asked.length, 2, 'focus two seconds on changes nothing');
  await h.timers.advance(15 * S);
  assert.equal(h.asked.length, 3);

  // A second at the least, however the dice fall.
  const g = harness({random: 0});
  const next = await g.golive();
  await next.write(frame('bye', {reason: 'restart'}));
  await g.timers.advance(999);
  assert.equal(g.asked.length, 1);
  await g.timers.advance(1);
  assert.equal(g.asked.length, 2);
});

test('events that come after bye in the same chunk are not heard', async () => {
  const h = harness();
  const stream = await h.golive();
  await stream.write(frame('bye', {reason: 'restart'}) + frame('card', {id: 'late'}));
  assert.deepEqual(h.hubEvents(), ['hello', 'snapshot']);
});

test('row 3: the answer came, and its hello and snapshot have ten seconds from then', async () => {
  const h = harness();
  h.live.open('b1');
  await h.timers.advance(9 * S);
  h.last().stream();
  await flush();
  await h.timers.advance(9 * S);
  assert.equal(h.asked.length, 1, 'nine seconds after the answer: still waiting');
  await h.timers.advance(S);
  assert.match(h.last().url, /mode=poll$/);
});

test('row 9: a first poll answer without the board is not the hub’s: tried again later', async () => {
  const h = harness();
  h.live.open('b1');
  await h.timers.advance(10 * S);
  await h.last().json(200, {lease: 'L', now: 1, events: []});
  assert.equal(h.connection()?.status, 'retrying');
  await h.timers.advance(S);
  assert.match(h.last().url, /mode=poll$/, 'polls still, a new lease');
});

test('row 16: once the time for polls is over, a retry opens a stream', async () => {
  const h = harness();
  h.live.open('b1');
  await h.timers.advance(10 * S);
  const began = h.timers.t;
  let back: number | null = null;
  while (h.timers.t - began < 12 * MIN) {
    if (!h.last().url.includes('mode=poll')) {
      back = h.timers.t;
      break;
    }
    await h.last().json(503, {});
    await h.timers.advance(30 * S);
  }
  assert.ok(back !== null && back - began >= 10 * MIN, `a stream again ${back === null ? 'never' : `after ${(back - began) / S} s`}`);
});

test('backoff starts over once live or polling', async () => {
  const h = harness();
  h.live.open('b1');
  await flush();
  await h.last().json(503, {});
  await h.timers.advance(S);
  await h.last().json(503, {});
  await h.timers.advance(2 * S);
  const stream = h.last().stream();
  await stream.write(frame('hello', {epoch: 'e', now: 1, client: null, heartbeatMs: HEARTBEAT}) + frame('snapshot', SNAPSHOT) + frame('ping', {now: 1}));
  await stream.end();
  const asked = h.asked.length;
  await h.timers.advance(S);
  assert.equal(h.asked.length, asked + 1, 'one second again, not five');

  const g = harness();
  g.live.open('b1');
  await g.timers.advance(10 * S);
  await g.last().json(503, {});
  await g.timers.advance(S);
  await g.last().json(503, {});
  await g.timers.advance(2 * S);
  await g.last().json(200, {
    lease: 'L',
    now: 1,
    events: [
      {type: 'hello', data: {epoch: 'e', now: 1, client: null, heartbeatMs: HEARTBEAT}},
      {type: 'snapshot', data: SNAPSHOT},
    ],
  });
  await g.last().json(503, {});
  const polled = g.asked.length;
  await g.timers.advance(S);
  assert.equal(g.asked.length, polled + 1, 'one second again after polling');
});

test('a lease let go for a newer reader: its tombstone in a poll answer keeps the page away 30 s, a focus too', async () => {
  const h = harness();
  h.live.open('b1');
  await h.timers.advance(10 * S);
  await h.last().json(200, {
    lease: 'L',
    now: 1,
    events: [
      {type: 'hello', data: {epoch: 'e', now: 1, client: null, heartbeatMs: HEARTBEAT}},
      {type: 'snapshot', data: SNAPSHOT},
    ],
  });
  await h.last().json(200, {lease: 'L', now: 1, events: [{type: 'bye', data: {reason: 'limit'}}]});
  const asked = h.asked.length;
  await h.timers.advance(2 * S);
  h.live.wake();
  await h.timers.advance(25 * S);
  assert.equal(h.asked.length, asked);
  await h.timers.advance(10 * S);
  assert.equal(h.asked.length, asked + 1);
});

test('row 15: a live stream silent for two and a half heartbeats, or found so on waking, is opened again at once', async () => {
  const h = harness();
  const stream = await h.golive();
  await stream.write(frame('ping', {now: 1}));
  const since = h.timers.t;
  await h.timers.advance(2.5 * HEARTBEAT + S);
  assert.equal(h.asked.length, 2);
  assert.equal(h.last().url, '/api/events?board=b1', 'a stream again');
  assert.deepEqual(h.connection(), {type: 'connection', status: 'connecting', lostAt: since});

  // The wall clock jumped (a sleep): the next wake finds the stream dead.
  const g = harness();
  const other = await g.golive();
  await other.write(frame('ping', {now: 1}));
  g.timers.t += 10 * MIN;
  g.live.wake();
  await flush();
  assert.equal(g.asked.length, 2);
});

test('row 15a: waking while connecting or polling reconnects only when the attempt is overdue; a focus right after being shown asks once', async () => {
  const h = harness();
  h.live.open('b1');
  await flush();
  h.live.wake();
  await flush();
  assert.equal(h.asked.length, 1, 'not overdue');
  h.timers.t += 11 * S;
  h.live.wake();
  await flush();
  assert.equal(h.asked.length, 2, 'overdue: opened again');
  assert.equal(h.last().url, '/api/events?board=b1', 'in the same mode');

  const g = harness();
  g.live.open('b1');
  await g.timers.advance(10 * S);
  await g.last().json(200, {
    lease: 'L',
    now: 1,
    events: [
      {type: 'hello', data: {epoch: 'e', now: 1, client: null, heartbeatMs: HEARTBEAT}},
      {type: 'snapshot', data: SNAPSHOT},
    ],
  });
  const polls = g.asked.length;
  g.hide();
  g.show();
  g.live.wake();
  await flush();
  assert.equal(g.asked.length, polls, 'shown, then focused: the poll waiting goes on');
  const since = g.timers.t;
  g.timers.t += 40 * S;
  g.live.wake();
  await flush();
  assert.equal(g.asked.length, polls + 1);
  assert.match(g.last().url, /mode=poll$/, 'still polls, a new lease');
  assert.deepEqual(g.connection(), {type: 'connection', status: 'connecting', lostAt: since});
});

test('row 15a: the attempt’s own timer held up by a sleep is a wake: opened again in the same mode, not long polls', async () => {
  const h = harness();
  h.live.open('b1');
  await flush();
  await h.timers.advance(20 * S, true);
  assert.equal(h.asked.length, 2);
  assert.equal(h.last().url, '/api/events?board=b1');
});

test('shown again is a wake: a stream found silent too long meanwhile is opened again', async () => {
  const h = harness();
  const stream = await h.golive();
  await stream.write(frame('ping', {now: 1}));
  h.hide();
  h.timers.t += 2 * MIN;
  h.show();
  await flush();
  assert.equal(h.asked.length, 2);
});

test('row 18: a tab hidden keeps counting from when it was hidden, when it is given another board meanwhile', async () => {
  const h = harness();
  await h.golive();
  h.hide();
  await h.timers.advance(25 * S);
  h.live.open('b2');
  await h.timers.advance(5 * S);
  assert.equal(h.connection()?.status, 'paused');
  h.show();
  await flush();
  assert.equal(h.last().url, '/api/events?board=b2');
});

test('row 18: each time the tab is hidden it counts from then, also when it was hidden and shown while no board was open', async () => {
  // Hidden, shown, and hidden again twenty seconds later: thirty seconds from the second time.
  const h = harness();
  const live = await h.golive();
  await live.write(frame('ping', {now: 1}));
  h.hide();
  await h.timers.advance(5 * S);
  h.show();
  await h.timers.advance(20 * S);
  h.hide();
  await h.timers.advance(29 * S);
  assert.equal(h.connection()?.status, 'live', 'hidden again: its own thirty seconds');

  // Signed out while hidden, shown, signed in again, hidden for a moment: nothing lets go.
  const g = harness();
  const stream = await g.golive();
  g.hide();
  await g.timers.advance(10 * S);
  await stream.write(frame('bye', {reason: 'unauthorized'}));
  g.show();
  await g.timers.advance(MIN);
  g.live.open('b1');
  await flush();
  await g.answer();
  const asked = g.asked.length;
  g.hide();
  await g.timers.advance(2 * S);
  g.show();
  await flush();
  assert.deepEqual([g.connection()?.status, g.asked.length], ['live', asked]);
});

test('row 16, 18, 2: a tab hidden for 30 s lets go; shown again, it connects anew; one loaded hidden counts from loading', async () => {
  const h = harness();
  await h.golive();
  h.hide();
  await h.timers.advance(29 * S);
  assert.equal(h.connection()?.status, 'live');
  await h.timers.advance(S);
  assert.deepEqual(h.connection(), {type: 'connection', status: 'paused', lostAt: null});
  assert.equal(h.asked[0].aborted, true);
  await h.timers.advance(10 * MIN);
  assert.equal(h.asked.length, 1, 'nothing while hidden');
  h.show();
  await flush();
  assert.equal(h.asked.length, 2);
  assert.equal(h.connection()?.status, 'connecting');

  const g = harness({visible: false});
  g.live.open('b1');
  await flush();
  await g.timers.advance(30 * S);
  assert.equal(g.connection()?.status, 'paused');

  // Retrying: shown or online, it tries at once.
  const k = harness();
  k.live.open('b1');
  await flush();
  await k.last().json(503, {});
  await k.timers.advance(S);
  await k.last().json(503, {});
  const asked = k.asked.length;
  k.live.wake();
  await flush();
  assert.equal(k.asked.length, asked + 1);
});

test('row 1 × 18: a board opened on a hidden tab lets go 30 s after it was hidden, and asks nothing if that is past; shown later, the hub is not lost', async () => {
  type H = ReturnType<typeof harness>;
  // What came before, how long before the board opens, and how long after it opens it lets go (null: at once, asking nothing).
  const cases: {name: string; before: (h: H) => Promise<void>; wait: number; left: number | null; visible?: boolean}[] = [
    {name: 'loaded hidden', visible: false, before: async () => {}, wait: 10 * S, left: 20 * S},
    {name: 'loaded hidden, for long', visible: false, before: async () => {}, wait: 5 * MIN, left: null},
    {name: 'hidden with no board open', before: async h => h.hide(), wait: 10 * S, left: 20 * S},
    {
      name: 'hidden, shown and hidden again with no board open',
      before: async h => {
        h.hide();
        await h.timers.advance(5 * MIN);
        h.show();
        await h.timers.advance(MIN);
        h.hide();
      },
      wait: 10 * S,
      left: 20 * S,
    },
    {
      name: 'a board closed on the hidden tab',
      before: async h => {
        await h.golive();
        h.hide();
        await h.timers.advance(10 * S);
        h.live.close();
      },
      wait: 5 * S,
      left: 15 * S,
    },
    {name: 'hidden with no board open, for 30 s already', before: async h => h.hide(), wait: 30 * S, left: null},
    {name: 'hidden with no board open, for long', before: async h => h.hide(), wait: 5 * MIN, left: null},
    {
      name: 'paused, given another board',
      before: async h => {
        await h.golive();
        h.hide();
      },
      wait: 5 * MIN,
      left: null,
    },
  ];
  for (const c of cases) {
    const h = harness({visible: c.visible});
    await c.before(h);
    await h.timers.advance(c.wait);
    const asked = h.asked.length;
    h.live.open('b2');
    await flush();
    if (c.left === null) {
      assert.deepEqual([h.connection(), h.asked.length], [{type: 'connection', status: 'paused', lostAt: null}, asked], c.name);
    } else {
      await h.answer();
      await h.timers.advance(c.left - S);
      assert.equal(h.connection()?.status, 'live', c.name);
      await h.timers.advance(S);
      assert.equal(h.connection()?.status, 'paused', c.name);
    }
    await h.timers.advance(60 * MIN);
    h.show();
    await flush();
    assert.deepEqual([h.last().url, h.connection()], ['/api/events?board=b2', {type: 'connection', status: 'connecting', lostAt: h.timers.t}], c.name);
  }
});

test('row 18: pausing keeps when a connection was lost, and forgets when one only began to open', async () => {
  // Opened 25 s after the tab was hidden, and not answered by the pause (a proxy holding it back).
  const h = harness();
  h.hide();
  await h.timers.advance(25 * S);
  h.live.open('b1');
  await flush();
  await h.timers.advance(5 * S);
  assert.deepEqual(h.connection(), {type: 'connection', status: 'paused', lostAt: null});

  // Long polls whose time is up 25 s after the tab was hidden: the stream they open is not answered by the pause.
  const g = harness();
  await g.gopoll();
  const until = g.timers.t + 10 * MIN;
  while (g.timers.t < until - 25 * S) {
    await g.timers.advance(Math.min(20 * S, until - 25 * S - g.timers.t));
    await g.last().json(200, {lease: 'L', now: 7, events: []});
  }
  g.hide();
  await g.timers.advance(25 * S);
  await g.last().json(200, {lease: 'L', now: 7, events: []});
  assert.equal(g.last().url, '/api/events?board=b1', 'row 17: a stream again');
  await g.timers.advance(5 * S);
  assert.deepEqual(g.connection(), {type: 'connection', status: 'paused', lostAt: null});

  // The hub failed before the pause: kept, with another board too, and shown, the header says so at once.
  const k = harness();
  k.live.open('b1');
  await flush();
  await k.last().json(503, {});
  const lost = k.connection()!.lostAt;
  assert.equal(k.connection()?.status, 'retrying');
  k.hide();
  await k.timers.advance(30 * S);
  assert.deepEqual(k.connection(), {type: 'connection', status: 'paused', lostAt: lost});
  k.live.open('b2');
  assert.deepEqual(k.connection(), {type: 'connection', status: 'paused', lostAt: lost});
  await k.timers.advance(60 * MIN);
  k.show();
  await flush();
  assert.match(k.last().url, /^\/api\/events\?board=b2/);
  assert.deepEqual(k.connection(), {type: 'connection', status: 'connecting', lostAt: lost});

  // Once connected again, or signed out, what was lost is forgotten: an opening cut short by the pause is only that.
  for (const again of ['connected', 'signed out'] as const) {
    const j = harness();
    j.live.open('b1');
    await flush();
    await j.last().json(503, {});
    if (again === 'connected') {
      await j.timers.advance(2 * S);
      await j.answer();
      assert.equal(j.connection()?.status, 'live');
      j.hide();
      await j.timers.advance(30 * S);
      j.show();
    } else {
      j.live.close();
      j.live.open('b1');
    }
    await flush();
    j.hide();
    await j.timers.advance(30 * S);
    assert.deepEqual(j.connection(), {type: 'connection', status: 'paused', lostAt: null}, again);
  }
});

test('row 18 × each row: the pause keeps lostAt once the connection was lost (retrying, or a row that says when), and clears one only opening set', async () => {
  type H = ReturnType<typeof harness>;
  const board = (h: H) => [
    {type: 'hello', data: {epoch: 'e', now: h.timers.t, client: null, heartbeatMs: HEARTBEAT}},
    {type: 'snapshot', data: SNAPSHOT},
  ];
  /** Answers each long poll until 25 s before their time is up, then hides the tab; the next answer opens a stream (row 17), held back. */
  const pollsOver = async (h: H, until: number) => {
    while (h.timers.t < until - 25 * S) {
      await h.timers.advance(Math.min(20 * S, until - 25 * S - h.timers.t));
      await h.last().json(200, {lease: 'L', now: h.timers.t, events: []});
    }
    h.hide();
    await h.timers.advance(25 * S);
    await h.last().json(200, {lease: 'L', now: h.timers.t, events: []});
    assert.equal(h.last().url, '/api/events?board=b1');
    h.last().stream();
    await h.timers.advance(6 * S);
  };
  // Each runs until the pause and gives the lostAt it keeps: when the connection was lost, or null.
  const cases: [string, (h: H) => Promise<number | null>][] = [
    [
      '4a no first ping',
      async h => {
        await h.golive();
        const last = h.timers.t;
        await h.timers.advance(10 * S);
        h.hide();
        await h.timers.advance(36 * S);
        return last;
      },
    ],
    [
      '5 no answer, polls',
      async h => {
        h.hide();
        h.live.open('b1');
        await h.timers.advance(35 * S);
        return null;
      },
    ],
    [
      '9 a 503',
      async h => {
        h.live.open('b1');
        const opened = h.timers.t;
        await flush();
        h.hide();
        await h.timers.advance(2 * S);
        await h.last().json(503, {});
        await h.timers.advance(29 * S);
        return opened;
      },
    ],
    [
      '12 bye restart',
      async h => {
        const s = await h.golive();
        h.hide();
        await h.timers.advance(28 * S);
        await s.write(frame('ping', {now: 1}) + frame('bye', {reason: 'restart'}));
        const at = h.timers.t;
        await h.timers.advance(3 * S);
        return at;
      },
    ],
    [
      '15 a silent stream',
      async h => {
        const s = await h.golive();
        await s.write(frame('ping', {now: 1}));
        const last = h.timers.t;
        await h.timers.advance(40 * S);
        h.hide();
        await h.timers.advance(31 * S);
        return last;
      },
    ],
    [
      '15a polling, asleep',
      async h => {
        await h.gopoll();
        const last = h.timers.t;
        await h.timers.advance(10 * S);
        h.hide();
        await h.timers.advance(60 * MIN, true);
        return last;
      },
    ],
    [
      '15a opening, asleep',
      async h => {
        h.hide();
        h.live.open('b1');
        await flush();
        await h.timers.advance(60 * MIN, true);
        return null;
      },
    ],
    [
      '17 polls over, the stream held back',
      async h => {
        await h.gopoll();
        await pollsOver(h, h.timers.t + 10 * MIN);
        return null;
      },
    ],
    [
      '17 after the hub restarted meanwhile',
      async h => {
        await h.gopoll();
        const until = h.timers.t + 10 * MIN;
        await h.timers.advance(5 * S);
        await h.last().json(200, {lease: 'L', now: h.timers.t, events: [{type: 'bye', data: {reason: 'restart'}}]});
        assert.equal(h.connection()?.status, 'retrying');
        await h.timers.advance(3 * S);
        await h.last().json(200, {lease: 'L', now: h.timers.t, events: board(h)});
        assert.equal(h.connection()?.status, 'polling');
        await pollsOver(h, until);
        return null;
      },
    ],
    [
      '1 another board while retrying',
      async h => {
        h.live.open('b1');
        const opened = h.timers.t;
        await flush();
        h.hide();
        await h.last().json(503, {});
        await h.timers.advance(S / 2);
        h.live.open('b2');
        await flush();
        await h.timers.advance(31 * S);
        return opened;
      },
    ],
    [
      '1 another board while opening',
      async h => {
        h.live.open('b1');
        await flush();
        h.hide();
        await h.timers.advance(3 * S);
        h.live.open('b2');
        await flush();
        await h.timers.advance(31 * S);
        return null;
      },
    ],
  ];
  for (const [name, run] of cases) {
    const h = harness();
    const kept = await run(h);
    assert.deepEqual(h.connection(), {type: 'connection', status: 'paused', lostAt: kept}, name);
  }
});

test('events of a connection the page closed never reach the page', async () => {
  const h = harness();
  const stream = await h.golive();
  h.live.open('b2');
  await flush();
  await stream.write(frame('card', {id: 'old'})).catch(() => {});
  assert.deepEqual(h.hubEvents(), ['hello', 'snapshot']);
  h.live.close();
  await h.timers.advance(10 * MIN);
  assert.equal(h.asked.length, 2);
});

test('a page of another build reloads once for a start of the hub, and never without a place to note it', async () => {
  const other = {epoch: 'e7', now: 1, client: '/assets/index-b.js', heartbeatMs: HEARTBEAT};
  const h = harness();
  h.live.open('b1');
  await flush();
  await h.last().stream().write(frame('hello', other));
  assert.deepEqual(h.said, ['reload']);
  assert.equal(h.storage instanceof Map && h.storage.get('quotum:reloaded'), 'e7');
  const again = harness({storage: h.storage});
  again.live.open('b1');
  await flush();
  await again.last().stream().write(frame('hello', other));
  assert.deepEqual(again.said, [], 'reloaded for this start already');
  const none = harness({storage: 'none'});
  none.live.open('b1');
  await flush();
  await none.last().stream().write(frame('hello', other));
  assert.deepEqual(none.said, []);
});

test('a skew of ten minutes between the page and the hub opens nothing again', async () => {
  for (const skew of [10 * MIN, -10 * MIN]) {
    const h = harness({skew});
    const stream = await h.golive();
    for (let i = 0; i < 10; i++) {
      await h.timers.advance(HEARTBEAT);
      await stream.write(frame('ping', {now: h.timers.t + skew}));
    }
    assert.equal(h.asked.length, 1, `skew ${skew}`);
  }
});
