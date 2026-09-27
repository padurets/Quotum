import type {ConnectionStatus, HubEvent, PageEvent} from './board';

/**
 * The page's connection to the hub's events (spec/dashboard-v1.md): one board at a time, a
 * stream read with `fetch` (EventSource does not tell the status of an answer), long polls
 * where a proxy holds the stream back, and every event into the page's dispatch. Every
 * connection starts with the board as it is, so a dropped one, a sleep, a restart of the
 * hub or a hidden tab shown again lose nothing.
 *
 * What it does in each state is the table in docs/architecture.md, "The page's
 * connection"; the code names its rows. Times of its own timers are the page's
 * (`Date.now()`); when the connection was lost is the hub's (`hubNow`), as the header
 * counts it.
 */

/** Where a stream that does not work goes: long polls, for this long, then a stream again. */
const POLL_FOR = 10 * 60_000;
/** How long an answer's headers, or its `hello` and `snapshot`, may take. */
const START_MS = 10_000;
/** A long poll the hub holds for 25 s at most: given up after this. */
const POLL_MS = 35_000;
/** Silence this many heartbeats long: the stream is dead. */
const SILENCE = 2.5;
/** The first `ping` comes one heartbeat after the snapshot, or a proxy holds small frames back. */
const FIRST_PING_SLACK = 10_000;
/** A timer this late was held up by a sleep. */
const LATE = 5_000;
/** A tab hidden this long lets its connection go. */
const HIDDEN_MS = 30_000;
/** Streams in a row that end before their first ping, and the page goes to long polls. */
const SHORT_LIVED = 3;
const BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Let go for a newer reader: not sooner than this, or two tabs would push each other out. */
const LIMIT_MS = 30_000;

type Timer = 'attempt' | 'firstPing' | 'watchdog' | 'retry' | 'hide';

export type LiveEnv = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The page's clock. */
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  random(): number;
  visible(): boolean;
  /** The hub's clock as the page reckons it (lib/clock.ts), and what it heard of it. */
  hubNow(at?: number): number;
  heard(now: number, at?: number): void;
  dispatch(event: PageEvent): void;
  /** The session ended: the page asks who is signed in. */
  unauthorized(): void;
  /** The board is gone: the page reads its session again. */
  gone(): void;
  /** The path of the page's own entry script; null when not known. */
  script: string | null;
  reload(): void;
  /** Where the page notes it reloaded for a new build; may throw (no storage). */
  storage(): Pick<Storage, 'getItem' | 'setItem'>;
};

type Hello = {epoch: string; now: number; client: string | null; heartbeatMs: number};

/**
 * Reads text/event-stream: lines end at CR LF, LF or CR only (U+2028 inside JSON is no
 * end of line), `event:` and `data:` fields, an empty line ends an event. Chunks may cut
 * anywhere; `push` takes them as they come, already decoded.
 */
export function sseParser(onEvent: (type: string, data: string) => void) {
  let buffer = '';
  let type = '';
  let data: string[] = [];
  let skipLF = false;
  const line = (text: string) => {
    if (!text) {
      if (data.length) onEvent(type || 'message', data.join('\n'));
      type = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? '' : text.slice(colon + (text[colon + 1] === ' ' ? 2 : 1));
    if (field === 'event') type = value;
    else if (field === 'data') data.push(value);
  };
  return (chunk: string) => {
    // A CR that ended the last chunk and an LF that starts this one are one end of line.
    buffer += skipLF && chunk.startsWith('\n') ? chunk.slice(1) : chunk;
    skipLF = false;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      line(buffer.slice(start, i));
      if (c === 13) {
        if (i + 1 === buffer.length) skipLF = true;
        else if (buffer.charCodeAt(i + 1) === 10) i++;
      }
      start = i + 1;
    }
    buffer = buffer.slice(start);
  };
}

export class Live {
  private board: string | null = null;
  private status: ConnectionStatus | 'stopped' = 'stopped';
  private mode: 'stream' | 'poll' = 'stream';
  private pollUntil = 0;
  private lostAt: number | null = null;
  private lastByteAt = 0;
  /** When the tab was hidden, by the page's clock; null while it shows. */
  private hiddenAt: number | null = null;
  /** Streams in a row that ended before their first ping, not by the page nor with `bye`. */
  private short = 0;
  private backoff = 0;
  private heartbeatMs = 25_000;
  /** Each connection is numbered: what an earlier one says is not heard. */
  private attempt = 0;
  private abort: AbortController | null = null;
  private lease: string | null = null;
  /** Of the current connection: whether its `hello`, `snapshot` and first `ping` came. */
  private hello = false;
  private pinged = false;
  /** The earliest a retry after `bye` may come, however the page wakes. */
  private retryFloor = 0;
  private readonly timers = new Map<Timer, {handle: unknown; at: number}>();

  constructor(private readonly env: LiveEnv) {}

  /**
   * Row 1: another board (or the first). A tab hidden meanwhile keeps counting (row 18); one
   * hidden for 30 s already would let the connection go at once, so it asks nothing until shown.
   */
  open(board: string) {
    this.drop();
    this.board = board;
    this.env.dispatch({type: 'board-open', id: board});
    if (!this.env.visible() && this.hiddenAt !== null && this.env.now() - this.hiddenAt >= HIDDEN_MS) {
      this.clear('hide');
      return this.enter('paused');
    }
    this.connect();
    if (!this.env.visible()) this.hidden();
  }

  /** The page leaves the board: nothing more is asked or heard, and nothing of it is kept. */
  close() {
    this.drop();
    this.clear('hide');
    this.board = null;
    this.status = 'stopped';
    this.lostAt = null;
    this.env.dispatch({type: 'board-close'});
  }

  /** The tab was shown or hidden. When it was hidden is kept even with no board open: one opened later counts from then (row 18). */
  visibility() {
    if (this.env.visible()) this.hiddenAt = null;
    else this.hiddenAt ??= this.env.now();
    if (this.status === 'stopped') return;
    if (!this.env.visible()) return this.hidden();
    this.clear('hide');
    // Row 2.
    if (this.status === 'paused') return this.connect();
    this.wake();
  }

  /**
   * The page woke (online, shown, focused, a timer of its own late by a sleep): what the
   * connection was doing may have died meanwhile. Rows 15, 15a and 16.
   */
  wake() {
    const now = this.env.now();
    switch (this.status) {
      case 'live':
        if (now - this.lastByteAt > SILENCE * this.heartbeatMs) this.reconnect(this.env.hubNow(this.lastByteAt));
        return;
      case 'connecting':
      case 'polling': {
        const due = this.timers.get('attempt')?.at;
        if (due !== undefined && due <= now) this.reconnect(this.status === 'polling' ? this.env.hubNow(this.lastByteAt) : null);
        return;
      }
      case 'retrying':
        if (Math.max(now, this.retryFloor) <= now) this.retryNow();
        else this.after('retry', this.retryFloor - now, () => this.retryNow());
        return;
      default:
        return;
    }
  }

  // ---------- states ----------

  /**
   * Enters a state. `lostAt`: entering `connecting` or `retrying` while connected sets it
   * to now (hub time), unless a row says when the connection was lost; `live` and
   * `polling` clear it; `paused` leaves it.
   */
  private enter(status: ConnectionStatus, lostAt?: number | null) {
    this.status = status;
    if (status === 'live' || status === 'polling') this.lostAt = null;
    else if (status !== 'paused' && this.lostAt === null) this.lostAt = lostAt ?? this.env.hubNow();
    this.env.dispatch({type: 'connection', status, lostAt: this.lostAt});
  }

  /** Opens the board's events, as a stream or a lease of long polls by `mode`. */
  private connect(lostAt?: number | null) {
    this.drop();
    this.enter('connecting', lostAt);
    this.attempt++;
    this.hello = false;
    this.pinged = false;
    if (this.mode === 'stream') void this.stream(this.attempt);
    else {
      this.lease = null;
      void this.poll(this.attempt);
    }
  }

  /** Rows 15 and 15a: dropped, and opened again at once in the same mode. */
  private reconnect(lostAt: number | null) {
    this.connect(lostAt);
  }

  /** Stops whatever is under way: the request, and every timer but the hidden tab's. */
  private drop() {
    this.attempt++;
    this.abort?.abort();
    this.abort = null;
    for (const name of ['attempt', 'firstPing', 'watchdog', 'retry'] as const) this.clear(name);
  }

  /** Rows 9, 9a, 14: tried again after a while, longer each time. */
  private retry(lostAt?: number | null) {
    const delay = BACKOFF[Math.min(this.backoff, BACKOFF.length - 1)] * (0.8 + 0.4 * this.env.random());
    this.backoff++;
    this.retryFloor = 0;
    this.later(delay, lostAt);
  }

  private later(delay: number, lostAt?: number | null) {
    this.drop();
    this.enter('retrying', lostAt);
    this.after('retry', delay, () => this.retryNow());
  }

  /** Row 16: the time to try again came. */
  private retryNow() {
    if (this.env.now() >= this.pollUntil) this.mode = 'stream';
    this.connect();
  }

  /** Too many short streams (rows 9a, 14), or none that shows its events in time (rows 4a, 5): long polls for a while. */
  private toPolls() {
    this.mode = 'poll';
    this.pollUntil = this.env.now() + POLL_FOR;
    this.short = 0;
  }

  /** Row 18: hidden for 30 s since it was hidden, the connection goes; the tab shown again connects anew. */
  private hidden() {
    const now = this.env.now();
    this.hiddenAt ??= now;
    if (this.status === 'paused' || this.timers.has('hide')) return;
    this.after('hide', Math.max(0, this.hiddenAt + HIDDEN_MS - now), () => {
      if (this.env.visible() || this.status === 'stopped') return;
      this.drop();
      this.enter('paused');
    });
  }

  /** Rows 7, 11: the session is over. */
  private unauthorized() {
    this.close();
    this.env.unauthorized();
  }

  /** Rows 8, 11: the board is gone, or the reader off it. */
  private gone() {
    const board = this.board;
    this.close();
    if (board) this.env.dispatch({type: 'board-gone', id: board});
    this.env.gone();
  }

  /** Rows 11–13. */
  private bye(reason: string) {
    if (reason === 'unauthorized') return this.unauthorized();
    if (reason === 'gone') return this.gone();
    const delay = reason === 'limit' ? LIMIT_MS + 5_000 * this.env.random() : 1_000 + 4_000 * this.env.random();
    this.later(delay, this.env.hubNow());
    this.retryFloor = this.env.now() + delay;
  }

  // ---------- timers ----------

  private after(name: Timer, ms: number, run: () => void) {
    this.clear(name);
    const at = this.env.now() + ms;
    const handle = this.env.setTimeout(() => {
      if (this.timers.get(name)?.handle !== handle) return;
      this.timers.delete(name);
      // Held up by a sleep: the page woke, which decides what to do (rows 4a, 15a).
      if ((name === 'attempt' || name === 'firstPing') && this.env.now() - at > LATE) {
        this.timers.set(name, {handle: null, at});
        this.wake();
        if (this.timers.get(name)?.handle === null) this.timers.delete(name);
        return;
      }
      run();
    }, ms);
    this.timers.set(name, {handle, at});
  }

  private clear(name: Timer) {
    const timer = this.timers.get(name);
    if (!timer) return;
    this.env.clearTimeout(timer.handle);
    this.timers.delete(name);
  }

  /** Row 15: no byte for longer than SILENCE heartbeats. */
  private watch() {
    this.after('watchdog', SILENCE * this.heartbeatMs + 1, () => {
      if (this.status !== 'live') return;
      if (this.env.now() - this.lastByteAt > SILENCE * this.heartbeatMs) this.reconnect(this.env.hubNow(this.lastByteAt));
      else this.watch();
    });
  }

  // ---------- a stream ----------

  private async stream(attempt: number) {
    const controller = new AbortController();
    this.abort = controller;
    const current = () => attempt === this.attempt;
    // Row 5: no answer in time.
    this.after('attempt', START_MS, () => this.slowStart());
    let response: Response;
    try {
      response = await this.env.fetch(`/api/events?board=${encodeURIComponent(this.board!)}`, {
        headers: {'Quotum-Stream': '1'},
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch {
      if (current()) this.retry();
      return;
    }
    if (!current()) return void response.body?.cancel().catch(() => {});
    if (response.status === 401) return this.unauthorized();
    if (response.status === 404 && (await boardNotFound(response))) return current() ? this.gone() : undefined;
    if (!current()) return;
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
      void response.body?.cancel().catch(() => {});
      return this.retry();
    }
    // Row 3: the answer came; its hello and snapshot must too.
    this.after('attempt', START_MS, () => this.slowStart());
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let broken = false;
    const push = sseParser((type, data) => {
      if (!current() || broken) return;
      try {
        this.frame(type, JSON.parse(data));
      } catch {
        broken = true;
      }
    });
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (!current()) return void reader.cancel().catch(() => {});
        if (done) break;
        this.lastByteAt = this.env.now();
        if (this.status === 'live') this.watch();
        push(decoder.decode(value, {stream: true}));
        if (broken) break;
      }
    } catch {
      /* the connection broke: as if it ended */
    }
    if (current()) this.ended();
  }

  /** Row 5: the stream did not start in time: long polls. */
  private slowStart() {
    if (this.status !== 'connecting') return;
    this.toPolls();
    this.connect();
  }

  /** Rows 9a and 14: the stream ended, not by the page nor with `bye`. */
  private ended() {
    const live = this.status === 'live';
    if (!this.pinged && ++this.short >= SHORT_LIVED) this.toPolls();
    this.retry(live ? this.env.hubNow(this.lastByteAt) : undefined);
  }

  /** An event of the current stream. */
  private frame(type: string, data: unknown) {
    switch (type) {
      case 'hello':
        this.hello = true;
        this.greeted(data as Hello);
        return;
      case 'snapshot':
        if (!this.hello || this.status !== 'connecting') return;
        // Row 4.
        this.clear('attempt');
        this.backoff = 0;
        this.enter('live');
        this.env.dispatch({type: 'hub', event: {type: 'snapshot', data} as HubEvent});
        this.watch();
        this.after('firstPing', this.heartbeatMs + FIRST_PING_SLACK, () => this.noPing());
        return;
      case 'ping':
        this.env.heard((data as {now: number}).now);
        if (!this.pinged) {
          this.pinged = true;
          this.short = 0;
          this.clear('firstPing');
        }
        return;
      case 'bye':
        return this.bye((data as {reason: string}).reason);
      default:
        if (this.status === 'live') this.env.dispatch({type: 'hub', event: {type, data} as HubEvent});
    }
  }

  /** Row 4a: the snapshot came, the first ping did not: a proxy holds small frames back. */
  private noPing() {
    if (this.status !== 'live' || this.pinged) return;
    const lost = this.env.hubNow(this.lastByteAt);
    this.toPolls();
    this.connect(lost);
  }

  /** What `hello` says: the hub's clock, its heartbeat, and whether this page is of the build it serves. */
  private greeted(hello: Hello) {
    this.heartbeatMs = hello.heartbeatMs;
    this.env.heard(hello.now);
    if (!hello.client || !this.env.script || hello.client === this.env.script) return;
    // Another build: reloaded once for this start of the hub, never without a place to note it.
    try {
      const storage = this.env.storage();
      if (storage.getItem('quotum:reloaded') === hello.epoch) return;
      storage.setItem('quotum:reloaded', hello.epoch);
    } catch {
      return;
    }
    this.env.reload();
  }

  // ---------- long polls ----------

  private async poll(attempt: number) {
    const controller = new AbortController();
    this.abort = controller;
    const current = () => attempt === this.attempt;
    // Row 9: a poll not answered in time is given up.
    this.after('attempt', POLL_MS, () => {
      controller.abort();
      this.retry();
    });
    let answer: {lease: string; now: number; events: {type: string; data: unknown}[]};
    try {
      const lease = this.lease ? `&lease=${encodeURIComponent(this.lease)}` : '';
      const response = await this.env.fetch(`/api/events?board=${encodeURIComponent(this.board!)}&mode=poll${lease}`, {
        headers: {'Quotum-Stream': '1'},
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!current()) return;
      if (response.status === 401) return this.unauthorized();
      if (response.status === 404 && (await boardNotFound(response))) return current() ? this.gone() : undefined;
      if (response.status !== 200) throw new Error(String(response.status));
      answer = await response.json();
      if (!current()) return;
      if (typeof answer?.lease !== 'string' || !Array.isArray(answer.events)) throw new Error('format');
    } catch {
      if (current()) this.retry();
      return;
    }
    this.clear('attempt');
    this.lastByteAt = this.env.now();
    this.env.heard(answer.now);
    this.lease = answer.lease;
    for (const {type, data} of answer.events) {
      if (type === 'bye') return this.bye((data as {reason: string}).reason);
      if (type === 'hello') this.greeted(data as Hello);
      else if (type === 'snapshot') {
        // Row 6, and a lease the hub started anew: the board as it is.
        if (this.status === 'connecting') {
          this.backoff = 0;
          this.enter('polling');
        }
        this.env.dispatch({type: 'hub', event: {type, data} as HubEvent});
      } else if (this.status === 'polling') this.env.dispatch({type: 'hub', event: {type, data} as HubEvent});
    }
    // A first answer without the board is not the hub's.
    if (this.status === 'connecting') return this.retry();
    // Row 17: at once again, or a stream again when the time for polls is over.
    if (this.env.now() >= this.pollUntil) {
      this.mode = 'stream';
      return this.connect();
    }
    this.attempt++;
    void this.poll(this.attempt);
  }
}

/** Row 8: a `404` is the hub's word that the board is gone only when it says so; a proxy's, or a hub's that knows no events, is not. */
async function boardNotFound(response: Response): Promise<boolean> {
  const body = await response.json().catch(() => null);
  return (body as {error?: unknown} | null)?.error === 'board_not_found';
}

const inBrowser = typeof window !== 'undefined';

/** The page's one connection, once the page knows its script and how to ask for a session. */
export function startLive(env: Pick<LiveEnv, 'dispatch' | 'unauthorized' | 'gone' | 'script' | 'hubNow' | 'heard'>): Live {
  const live = new Live({
    ...env,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    random: Math.random,
    visible: () => document.visibilityState === 'visible',
    reload: () => location.reload(),
    storage: () => sessionStorage,
  });
  if (inBrowser) {
    document.addEventListener('visibilitychange', () => live.visibility());
    for (const event of ['online', 'pageshow', 'focus']) window.addEventListener(event, () => live.wake());
  }
  return live;
}
