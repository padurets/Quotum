import {HISTORY_SCOPES, type HistoryScope, type HistoryChange} from './domain/history.js';
import type {AttentionEvents, Candidate, Invalidation} from './domain/attention.js';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {config} from './config.js';
import {catalogue} from './domain/providers.js';
import type {Credentials} from './secrets/credentials.js';
import type {HubSources} from './hubSources.js';
import type {Ingest} from './ingest.js';
import type {ResetFeed} from './resets.js';
import {earliest, Projection, type HubPart} from './projection.js';
import type {Directory} from './store/directory.js';
import type {BoardSource, Store} from './store/store.js';
import {trouble, type Touches} from './touches.js';

/**
 * What open dashboards hear (spec/dashboard-v1.md): every reader of a board gets its
 * snapshot, then only what changed, as soon as it changes.
 *
 * Nothing that changes data works out events. It only tells what it touched (a source, a
 * board, a person, the whole hub); a little later the touched parts of the boards someone
 * is looking at are put together again by the projection (projection.ts) and compared with
 * what their readers last got, and only a part that differs goes out. What changes with
 * time alone has a deadline, and every watched board is worked out in full now and then,
 * so a change no touch told of arrives all the same. A board nobody looks at costs
 * nothing: its parts are neither kept nor worked out.
 *
 * Nothing is kept of the past: every connection starts with the board as it is.
 */

/** Why the hub lets a reader go: the session ended, the board is gone or theirs no more, the hub stops, too many or too slow. */
export type ByeReason = 'unauthorized' | 'gone' | 'restart' | 'limit';

/** An event as it goes out: its type, and its data already as JSON. */
export type Frame = {type: string; data: string};

/** Events as a text/event-stream carries them. */
export const sse = (frames: Frame[]) => frames.map(f => `event: ${f.type}\ndata: ${f.data}\n\n`).join('');

/** Events as a long poll answers them: `{type, data}` each. */
export const polled = (frames: Frame[]) => `[${frames.map(f => `{"type":${JSON.stringify(f.type)},"data":${f.data}}`).join(',')}]`;

const frame = (type: string, data: unknown): Frame => ({type, data: JSON.stringify(data)});
const bye = (reason: ByeReason) => frame('bye', {reason});

/** What a working out could not do: boards, readers' own parts, the hub's news. */
export type Failed = {boards: Set<string>; users: Set<string>; hub: boolean};

/** The hub's clock and timers: tests move them by hand. */
export type Clock = {now(): number; after(ms: number, run: () => void): () => void};

/** The longest a timer of Node waits: a longer one runs at once. A deadline further off is armed again when it runs. */
const LONGEST_MS = 2 ** 31 - 1;

export const realClock: Clock = {
  now: () => Date.now(),
  after(ms, run) {
    const timer = setTimeout(run, Math.min(ms, LONGEST_MS));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export type EventsOptions = Record<keyof typeof config.events, number>;

/** A reader of a board as the transport sees it: a stream it writes to, or a lease of long polls. */
export type Reader = {
  user: string;
  /** The session's secret, by which the hub checks the session still holds; in memory only. */
  secret: string;
  board: string;
  kind: 'stream' | 'lease';
  desktop?: boolean;
  /** Hands events over. */
  send(frames: Frame[]): void;
  /** How much of what was handed over has not gone out yet: a reader too far behind is let go. */
  backlog?(): number;
  /** Hands over the last event, `bye`, and lets the reader go. */
  end(reason: ByeReason): void;
};

/** A reader the hub keeps; a `fresh` one is being given its snapshot and gets no events yet. */
type Subscriber = Reader & {id: number; fresh: boolean; stopPing: () => void; seq: number; baselineAt: number; attentionKey: string; pending: Candidate[]; invalidations: Map<string, Invalidation>; pendingBytes: number; rebaseline: boolean};

/** A board someone looks at: what its readers last got of each part, and when those parts change by themselves. */
type Watched = {
  id: string;
  subscribers: Set<Subscriber>;
  /** The last part sent, as JSON, with its value (a snapshot is made of them): `board`, `view`, `lineup`, `card:<id>`, `sessions:<id>`, `cadence:<id>`, `refresh:<id>`, `forecast:<id>`. */
  base: Map<string, {json: string; value: unknown}>;
  lineup: string[];
  /** When each source's parts change by themselves. */
  changes: Map<string, number>;
  /** Whose agents' work its history shows and under which names (Projection.workKey), as last worked out; null before. */
  work: string | null;
  deadline: {at: number; cancel: () => void} | null;
  stopRecheck: () => void;
};

/** A lease of long polls: events wait here for the next request. A lease let go for a newer one stays as a tombstone to say so once. */
type Lease = {
  id: string;
  user: string;
  secret: string;
  board: string;
  subscriber: Subscriber | null;
  queue: Frame[];
  bytes: number;
  /** The request held until events come. */
  waiting: ((frames: Frame[]) => void) | null;
  /** Until it is forgotten (`leaseMs` after its last answer). */
  stopExpiry: () => void;
  tomb: ByeReason | null;
};

/** The path of the page's entry script in the built client, as `index.html` loads it; null without a build. */
export function clientScript(root = config.clientRoot): string | null {
  try {
    return readFileSync(path.join(root, 'index.html'), 'utf8').match(/<script[^>]*\bsrc="(\/[^"]+\.js)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export class Events implements Touches {
  /** The history cache hears every touch, also when no board is watched. */
  onHistory: ((source: string, since: number, scopes?: readonly HistoryScope[]) => void) | null = null;
  /** When this start of the hub began, base 36: a page tells a restart by it. */
  readonly epoch: string;
  readonly client: string | null;
  private readonly projection: Projection;
  private readonly watched = new Map<string, Watched>();
  /** Every reader, oldest first. */
  private readonly subscribers = new Map<number, Subscriber>();
  private readonly leases = new Map<string, Lease>();
  private next = 1;
  private closed = false;

  // What was touched since the last flush.
  private readonly dirtyBoards = new Set<string>();
  private readonly dirtySources = new Map<string, Set<string>>();
  private readonly dirtyUsers = new Set<string>();
  private dirtyHub = false;
  private readonly histories = new Map<string, Map<string, HistoryChange>>();
  private stopFlush: (() => void) | null = null;

  // What readers last got of what is theirs, and of the hub's news.
  private readonly mines = new Map<string, string>();
  private readonly sourceAccess=new Map<string,string>();
  private readonly currencyContexts=new Map<string,string>();
  private readonly boardLists = new Map<string, {json: string; value: unknown}>();
  private readonly connections = new Map<string, number>();
  private hub: {key: string; json: string; value: HubPart} | null = null;
  private hubDeadline: {at: number; cancel: () => void} | null = null;
  private stopHubRecheck: (() => void) | null = null;

  constructor(
    private readonly parts: {store: Store; directory: Directory; ingest: Ingest; resets: ResetFeed;credentials?:Credentials;hubSources?:HubSources},
    private readonly options: EventsOptions = config.events,
    private readonly clock: Clock = realClock,
    client = clientScript(),
  ) {
    this.projection = new Projection(parts);
    this.epoch = clock.now().toString(36);
    this.client = client;
  }

  /** Makes everything that changes data tell this of what it touched. */
  attach() {
    this.parts.store.setObserver(this);
    this.parts.directory.setObserver(this);
    this.parts.ingest.setObserver(this);
    this.parts.resets.onChange = () => this.touchHub();
  }

  /** Post-commit only. Each reader has its own observation boundary and bounded queue. */
  attention({candidates, invalidations}: AttentionEvents) {
    if (this.closed) return;
    const now = this.clock.now();
    for (const sub of this.subscribers.values()) {
      if (!sub.desktop || sub.fresh || sub.rebaseline) continue;
      let changed = false;
      const known = new Set(this.watched.get(sub.board)?.lineup);
      for (const boundary of invalidations) {
        if (!known.has(boundary.sourceId) && !sub.pending.some(c => c.kind !== 'announcement' && c.sourceId === boundary.sourceId)) continue;
        const key = JSON.stringify([boundary.sourceId, boundary.windowId]);
        const prior = sub.invalidations.get(key);
        if (prior && prior.at >= boundary.at) continue;
        sub.pending = sub.pending.filter(c => {
          const obsolete = c.kind !== 'announcement' && c.sourceId === boundary.sourceId && c.windowId === boundary.windowId && c.observedAt < boundary.at;
          if (obsolete) sub.pendingBytes -= Buffer.byteLength(JSON.stringify(c));
          return !obsolete;
        });
        sub.invalidations.set(key, boundary);
        sub.pendingBytes += Buffer.byteLength(JSON.stringify(boundary)) - (prior ? Buffer.byteLength(JSON.stringify(prior)) : 0);
        changed = true;
        if (this.attentionOverflow(sub)) break;
      }
      const visible = !sub.rebaseline && candidates.length ? this.projection.visibleCandidates(sub.board, candidates, now).filter(c =>
        c.kind === 'announcement' || (c.observedFrom >= sub.baselineAt && c.observedAt > c.observedFrom &&
          c.observedAt >= (sub.invalidations.get(JSON.stringify([c.sourceId, c.windowId]))?.at ?? -Infinity))) : [];
      sub.pendingBytes += visible.reduce((sum, c) => sum + Buffer.byteLength(JSON.stringify(c)), 0);
      if (!this.attentionOverflow(sub)) sub.pending.push(...visible);
      if (changed || visible.length) this.touchBoards([sub.board]);
    }
  }

  private attentionOverflow(sub: Subscriber): boolean {
    if (sub.pendingBytes <= this.options.bufferBytes) return false;
    sub.pending = [];
    sub.invalidations.clear();
    sub.pendingBytes = 0;
    sub.rebaseline = true;
    return true;
  }

  private attentionFrames(sub: Subscriber, baseline: boolean, now: number): {before: Frame[]; after: Frame[]} {
    const state = this.projection.attention(sub.board, now);
    const key = JSON.stringify(state);
    if (baseline) sub.baselineAt = now;
    const notifications = baseline || !sub.pending.length ? [] : this.projection.visibleCandidates(sub.board, sub.pending, now).filter(c =>
      now - c.at <= 60_000 && (c.kind === 'announcement' || (c.observedFrom >= sub.baselineAt && c.observedAt > c.observedFrom)));
    const invalidations = baseline ? [] : [...sub.invalidations.values()];
    sub.pending = [];
    sub.invalidations.clear();
    sub.pendingBytes = 0;
    sub.rebaseline = false;
    if (!baseline && key === sub.attentionKey && !notifications.length && !invalidations.length) return {before: [], after: []};
    sub.attentionKey = key;
    const packet = (notifications: Candidate[], invalidations: Invalidation[]) => frame('attention', {seq: ++sub.seq, now, baseline, state, notifications, invalidations});
    // Revoke old intents before a coalesced card can conceal the boundary. New
    // candidates follow the cards they refer to, so native visibility is current.
    if (baseline || invalidations.length) return {before: [packet([], invalidations)], after: notifications.length ? [packet(notifications, [])] : []};
    return {before: [], after: [packet(notifications, [])]};
  }

  // ---------- touches ----------

  touchSources(ids: string[]) {
    for (const watched of this.watched.values()) {
      for (const id of ids) {
        if (!watched.lineup.includes(id)) continue;
        let dirty = this.dirtySources.get(watched.id);
        if (!dirty) this.dirtySources.set(watched.id, (dirty = new Set()));
        dirty.add(id);
      }
    }
    this.schedule();
  }

  touchBoards(ids: string[]) {
    for (const id of ids) if (this.watched.has(id)) this.dirtyBoards.add(id);
    this.schedule();
  }

  touchUser(user: string) {
    if ([...this.subscribers.values()].some(s => s.user === user)) this.dirtyUsers.add(user);
    this.schedule();
  }

  touchHub() {
    if (this.subscribers.size) this.dirtyHub = true;
    this.schedule();
  }

  history(source: string, since: number, scopes: readonly HistoryScope[] = HISTORY_SCOPES) {
    try {
      this.onHistory?.(source, since, scopes);
    } catch (error) {
      trouble(error);
    }
    for (const watched of this.watched.values()) {
      if (!watched.lineup.includes(source)) continue;
      let pending = this.histories.get(watched.id);
      if (!pending) this.histories.set(watched.id, (pending = new Map()));
      for(const scope of scopes) {
        const key=JSON.stringify([source,scope]);
        pending.set(key,{source,scope,since:Math.min(pending.get(key)?.since??since,since)});
      }
    }
    this.schedule();
  }

  // Readers are let go only once the change holds: a touch inside a transaction rolled back lets nobody go.
  dropSessions(user: string) {
    process.nextTick(() => {
      const now = this.clock.now();
      for (const sub of [...this.subscribers.values()])
        if (sub.user === user && this.parts.directory.sessionUser(sub.secret, now)?.id !== user) this.end(sub, 'unauthorized');
    });
  }

  dropMember(board: string, user: string) {
    process.nextTick(() => {
      if (this.parts.directory.membership(board, user)) return;
      for (const sub of [...(this.watched.get(board)?.subscribers ?? [])]) if (sub.user === user) this.end(sub, 'gone');
    });
  }

  dropBoard(board: string) {
    process.nextTick(() => {
      if (this.parts.directory.board(board)) return;
      for (const sub of [...(this.watched.get(board)?.subscribers ?? [])]) this.end(sub, 'gone');
    });
  }

  private schedule() {
    if (this.stopFlush || this.closed) return;
    if (!this.dirtyBoards.size && !this.dirtySources.size && !this.dirtyUsers.size && !this.dirtyHub && !this.histories.size) return;
    this.stopFlush = this.later(this.options.smoothMs, () => {
      this.stopFlush = null;
      this.flush();
    });
  }

  // ---------- working out what changed ----------

  /**
   * Works out every touched part of the watched boards and sends what differs from what
   * their readers got. A board that cannot be worked out lets its readers go to start over,
   * and fails no other; a reader's own parts or the hub's that cannot, are worked out whole
   * again by the next touch or recheck. What failed is returned.
   */
  flush(): Failed {
    this.stopFlush?.();
    this.stopFlush = null;
    const now = this.clock.now();
    const whole = new Set(this.dirtyBoards);
    const sources = new Map(this.dirtySources);
    const users = new Set(this.dirtyUsers);
    const histories = new Map(this.histories);
    const hubTouched = this.dirtyHub;
    this.dirtyBoards.clear();
    this.dirtySources.clear();
    this.dirtyUsers.clear();
    this.histories.clear();
    this.dirtyHub = false;

    const heads = new Map<string, Frame[]>();
    const tails = new Map<string, Frame[]>();
    const lineups = new Map<string, BoardSource[]>();
    const failed: Failed = {boards: new Set(), users: new Set(), hub: false};
    for (const id of new Set([...whole, ...sources.keys(), ...histories.keys()])) {
      const watched = this.watched.get(id);
      if (!watched) continue;
      try {
        if (whole.has(id) || sources.has(id)) {
          const head = this.refresh(watched, whole.has(id), sources.get(id) ?? new Set(), now, lineups, histories);
          if (!head) continue;
          heads.set(id, head);
        }
      } catch (error) {
        trouble(error);
        failed.boards.add(id);
        // What its readers got may be half told: they start over with a snapshot. One still opening is refused instead.
        for (const sub of [...watched.subscribers]) if (!sub.fresh) this.end(sub, 'restart');
        continue;
      }
      if (whole.has(id)) for (const sub of watched.subscribers) users.add(sub.user);
      const pending = histories.get(id);
      if (pending?.size) {
        const changes=[...pending.values()].filter(change=>watched.lineup.includes(change.source));
        if(changes.length)tails.set(id,[frame('history',{sources:[...new Set(changes.map(change=>change.source))],since:Math.min(...changes.map(change=>change.since)),changes})]);
      }
    }
    let news: Frame[] = [];
    if (hubTouched) {
      try {
        news = this.refreshHub(now);
      } catch (error) {
        // Told again by the next touch or recheck.
        trouble(error);
        failed.hub = true;
      }
    }

    const mines = new Map<string, Frame[]>();
    const accesses=new Map<string,Frame[]>();
    const currencies=new Map<string,Frame[]>();
    const lists = new Map<string, Frame[]>();
    const connectionFrames = new Map<string, Frame[]>();
    for (const watched of this.watched.values()) {
      for (const sub of watched.subscribers) {
        let own: Frame[] = [];
        let access:Frame[]=[];
        if(users.has(sub.user)||sources.has(watched.id)||whole.has(watched.id)) {
          try {const key=sub.user+'\n'+watched.id;if(!accesses.has(key))accesses.set(key,this.refreshSourceAccess(sub.user,watched.id,lineups,now,users.has(sub.user)));access=accesses.get(key)!;}
          catch(error){trouble(error);failed.users.add(sub.user);this.sourceAccess.delete(sub.user+'\n'+watched.id);}
        }
        if (users.has(sub.user)) {
          const key = `${sub.user}\n${watched.id}`;
          try {
            if (!mines.has(key)) mines.set(key, this.refreshMine(sub.user, watched.id, lineups));
            if (!lists.has(sub.user)) lists.set(sub.user, this.refreshBoards(sub.user));
            if (!currencies.has(key)) currencies.set(key,this.refreshCurrencies(sub.user,watched.id,lineups,now));
            own = [...mines.get(key)!, ...lists.get(sub.user)!,...currencies.get(key)!];
            if (!connectionFrames.has(sub.user)) {
              const revision = this.parts.directory.connectionsRevision(sub.user);
              connectionFrames.set(sub.user, this.connections.get(sub.user) === revision ? [] : [frame('connections', {revision})]);
              this.connections.set(sub.user, revision);
            }
            own.push(...connectionFrames.get(sub.user)!);
          } catch (error) {
            // What was kept of them may be ahead of what they were sent: forgotten, it is sent whole next time.
            trouble(error);
            users.delete(sub.user);
            failed.users.add(sub.user);
            for (const key of [...this.mines.keys()]) if (key.startsWith(`${sub.user}\n`)) this.mines.delete(key);
            this.boardLists.delete(sub.user);
          }
        }
        const frames = [...(heads.get(watched.id) ?? []), ...own, ...access, ...(tails.get(watched.id) ?? []), ...news];
        if (sub.fresh) continue;
        if (sub.desktop && (sources.has(watched.id) || whole.has(watched.id) || frames.length || sub.pending.length || sub.invalidations.size || sub.rebaseline)) {
          const attention = this.attentionFrames(sub, sub.rebaseline, now);
          frames.unshift(...attention.before);
          frames.push(...attention.after);
        }
        if (!frames.length) continue;
        sub.send(frames);
        if ((sub.backlog?.() ?? 0) > this.options.bufferBytes) this.end(sub, 'limit');
      }
    }
    // What the forecasts worked out is kept together, once a round.
    this.parts.ingest.forecasts.save();
    return failed;
  }

  /** Compares a part with what was sent, keeping it when it differs: its JSON then, else null. */
  private changed(base: Watched['base'], key: string, value: unknown): string | null {
    const json = JSON.stringify(value);
    if (base.get(key)?.json === json) return null;
    base.set(key, {json, value});
    return json;
  }

  /**
   * The events of one board: its name and view when touched as a whole, then the touched
   * sources, sources new to it first, then its sources when they changed. Null once the
   * board is gone: its readers are let go. Touched as a whole, it also says whether whose
   * agents' work its history shows, or under which names, changed: then all of its
   * history is news (`histories`), from its start.
   */
  private refresh(
    watched: Watched,
    whole: boolean,
    touched: Set<string>,
    now: number,
    lineups: Map<string, BoardSource[]>,
    histories: Map<string, Map<string, HistoryChange>>,
  ): Frame[] | null {
    const {projection} = this;
    const lineup = projection.lineup(watched.id);
    lineups.set(watched.id, lineup);
    const frames: Frame[] = [];
    const {base} = watched;
    let computed = lineup.filter(s => touched.has(s.id));
    let ids: string[] | null = null;
    if (whole) {
      const part = projection.boardPart(watched.id, lineup);
      if (!part) {
        for (const sub of [...watched.subscribers]) this.end(sub, 'gone');
        return null;
      }
      // Whoever is no longer on the board is let go.
      for (const sub of [...watched.subscribers]) if (!this.parts.directory.membership(watched.id, sub.user)) this.end(sub, 'gone');
      const board = this.changed(base, 'board', part.board);
      if (board !== null) frames.push({type: 'board', data: `{"board":${board}}`});
      const view = this.changed(base, 'view', part.view);
      const revision = this.changed(base, 'viewRevision', part.viewRevision);
      if (view !== null || revision !== null) frames.push({type: 'view', data: JSON.stringify({view: part.view, revision: part.viewRevision})});
      // Sources that left take what was sent of them along: one that comes back is sent whole.
      for (const id of watched.lineup) {
        if (part.lineup.includes(id)) continue;
        for (const key of [`card:${id}`, `sessions:${id}`, `cadence:${id}`, `refresh:${id}`, `forecast:${id}`]) base.delete(key);
        watched.changes.delete(id);
      }
      ids = part.lineup;
      watched.lineup = ids;
      computed = lineup;
      const work = projection.workKey(watched.id);
      if (watched.work !== null && watched.work !== work) {
        let pending=histories.get(watched.id);if(!pending)histories.set(watched.id,(pending=new Map()));
        for(const source of ids)pending.set(JSON.stringify([source,'quota']),{source,scope:'quota',since:0});
      }
      watched.work = work;
    }
    if (computed.length) {
      const members = projection.members(watched.id);
      for (const source of computed) {
        const {value, changesAt} = projection.sourcePart(source, members, now);
        const id = JSON.stringify(source.id);
        const card = this.changed(base, `card:${source.id}`, value.card);
        if (card !== null) frames.push({type: 'card', data: card});
        const sessions = this.changed(base, `sessions:${source.id}`, value.sessions);
        if (sessions !== null) frames.push({type: 'sessions', data: `{"id":${id},"sessions":${sessions}}`});
        const cadence = this.changed(base, `cadence:${source.id}`, value.cadence);
        if (cadence !== null) frames.push({type: 'cadence', data: `{"id":${id},"cadence":${cadence}}`});
        const refresh = this.changed(base, `refresh:${source.id}`, value.refresh);
        if (refresh !== null) frames.push({type: 'refresh', data: `{"id":${id},"refresh":${refresh}}`});
        const ahead = projection.forecastPart(source.id, now);
        const forecast = this.changed(base, `forecast:${source.id}`, ahead.value);
        if (forecast !== null) frames.push({type: 'forecast', data: `{"id":${id},"forecast":${forecast}}`});
        const at = earliest(changesAt, ahead.changesAt);
        if (at === null) watched.changes.delete(source.id);
        else watched.changes.set(source.id, at);
      }
    }
    if (ids) {
      const sources = this.changed(base, 'lineup', ids);
      if (sources !== null) frames.push({type: 'lineup', data: `{"sources":${sources}}`});
    }
    this.arm(watched, now);
    return frames;
  }

  /** Which sources of a board the reader's devices measure, when it changed. */
  private refreshMine(user: string, board: string, lineups: Map<string, BoardSource[]>): Frame[] {
    let lineup = lineups.get(board);
    if (!lineup) lineups.set(board, (lineup = this.projection.lineup(board)));
    const json = JSON.stringify(this.projection.mine(user, lineup));
    const key = `${user}\n${board}`;
    if (this.mines.get(key) === json) return [];
    this.mines.set(key, json);
    return [{type: 'mine', data: `{"sources":${json}}`}];
  }
  private refreshCurrencies(user:string,board:string,lineups:Map<string,BoardSource[]>,now:number):Frame[] {
    const key=user+'\n'+board,json=JSON.stringify(this.projection.currencyContext(user,lineups.get(board)??this.projection.lineup(board),now));
    if(this.currencyContexts.get(key)===json)return [];
    this.currencyContexts.set(key,json);return [{type:'currencies',data:json}];
  }
  private refreshSourceAccess(user:string,board:string,lineups:Map<string,BoardSource[]>,now:number,force=false):Frame[] {
    const lineup=lineups.get(board)??this.projection.lineup(board);
    const key=user+'\n'+board,json=JSON.stringify(this.projection.sourceAccess(user,lineup,now));
    if(this.sourceAccess.get(key)===json&&(!force||json==='{}'))return [];
    this.sourceAccess.set(key,json);return [{type:'sourceAccess',data:json}];
  }

  /** The reader's boards with their role on each, when they changed. */
  private refreshBoards(user: string): Frame[] {
    const value = this.projection.boards(user);
    const json = JSON.stringify(value);
    if (this.boardLists.get(user)?.json === json) return [];
    this.boardLists.set(user, {json, value});
    return [{type: 'boards', data: `{"boards":${json}}`}];
  }

  /**
   * The hub's news, when it changed. When the trackers were last asked changes every
   * round and is not news: it is left out of the comparison, but kept, so a snapshot has it.
   */
  private refreshHub(now: number): Frame[] {
    const {value, changesAt} = this.projection.hubPart(now);
    const json = JSON.stringify(value);
    const key = JSON.stringify({...value, trackers: value.trackers.map(({at: _at, ...tracker}) => tracker)});
    const news = this.hub?.key !== key;
    this.hub = {key, json, value};
    this.armHub(changesAt, now);
    return news ? [{type: 'resets', data: json}] : [];
  }

  // ---------- time ----------

  /** One timer per watched board, for the first moment one of its parts changes by itself; not sooner than a second from now. */
  private arm(watched: Watched, now: number) {
    const at = earliest(...watched.changes.values());
    if (watched.deadline?.at === at) return;
    watched.deadline?.cancel();
    watched.deadline = null;
    if (at === null) return;
    watched.deadline = {
      at,
      cancel: this.later(Math.max(1000, at - now), () => {
        watched.deadline = null;
        const due = [...watched.changes].filter(([, when]) => when <= this.clock.now()).map(([id]) => id);
        if (!due.length) return this.arm(watched, this.clock.now());
        let dirty = this.dirtySources.get(watched.id);
        if (!dirty) this.dirtySources.set(watched.id, (dirty = new Set()));
        for (const id of due) dirty.add(id);
        this.schedule();
      }),
    };
  }

  private armHub(at: number | null, now: number) {
    if (this.hubDeadline?.at === at) return;
    this.hubDeadline?.cancel();
    this.hubDeadline = null;
    if (at === null) return;
    this.hubDeadline = {
      at,
      cancel: this.later(Math.max(1000, at - now), () => {
        this.hubDeadline = null;
        this.touchHub();
      }),
    };
  }

  /** Runs `run` in `ms`: trouble in it is logged, and never takes the hub down. */
  private later(ms: number, run: () => void): () => void {
    return this.clock.after(ms, () => {
      try {
        run();
      } catch (error) {
        trouble(error);
      }
    });
  }

  /** Repeats `run` every `ms` until stopped; never when `ms` is 0. */
  private every(ms: number, run: () => void): () => void {
    if (!ms) return () => {};
    let stop = () => {};
    const again = () => {
      stop = this.later(ms, () => {
        again();
        run();
      });
    };
    again();
    return () => stop();
  }

  // ---------- readers ----------

  /**
   * A new reader of a board: `hello` and the board as it is (`snapshot`), with every
   * touched part of it worked out first, and what changed sent to those already reading,
   * in the same step: nothing falls between the snapshot and the events after it. Null
   * when the board is gone; 'limit' when there is no room for another reader.
   */
  open(reader: Reader): {frames: Frame[]; close(): void} | null | 'limit' {
    const opened = this.subscribe(reader);
    if (opened === null || opened === 'limit') return opened;
    return {frames: opened.frames, close: () => this.unsubscribe(opened.sub)};
  }

  private subscribe(reader: Reader): {sub: Subscriber; frames: Frame[]} | null | 'limit' {
    const evicted = this.room(reader);
    if (evicted === 'refuse') return 'limit';
    if (evicted) this.end(evicted, 'limit');

    let watched = this.watched.get(reader.board);
    if (!watched) {
      const id = reader.board;
      watched = {
        id,
        subscribers: new Set(),
        base: new Map(),
        lineup: [],
        changes: new Map(),
        work: null,
        deadline: null,
        stopRecheck: this.every(this.options.recheckMs, () => this.touchBoards([id])),
      };
      this.watched.set(id, watched);
    }
    const sub: Subscriber = {...reader, id: this.next++, fresh: true, stopPing: () => {}, seq: 0, baselineAt: 0, attentionKey: '', pending: [], invalidations: new Map(), pendingBytes: 0, rebaseline: false};
    this.subscribers.set(sub.id, sub);
    watched.subscribers.add(sub);
    if (!this.stopHubRecheck) this.stopHubRecheck = this.every(this.options.recheckMs, () => this.touchHub());

    // Worked out now, sent to everyone but the new reader, who gets the snapshot instead.
    this.dirtyBoards.add(watched.id);
    this.dirtyUsers.add(reader.user);
    this.dirtyHub = true;
    const now = this.clock.now();
    let snapshot;
    try {
      const failed = this.flush();
      // The snapshot would miss a part: the reader is refused, as for a board that failed.
      if (failed.boards.has(reader.board) || failed.users.has(reader.user) || (failed.hub && !this.hub)) throw new Error('the board could not be worked out');
      if (!this.watched.get(reader.board)?.subscribers.has(sub)) {
        this.unsubscribe(sub);
        return null;
      }
      const value = (key: string) => watched.base.get(key)?.value;
      this.connections.set(reader.user, this.parts.directory.connectionsRevision(reader.user));
      snapshot = {
        providers: catalogue,
        sourceAccess:JSON.parse(this.sourceAccess.get(reader.user+'\n'+reader.board)??'{}'),
        currencies:JSON.parse(this.currencyContexts.get(reader.user+'\n'+reader.board)??JSON.stringify(this.projection.currencyContext(reader.user,this.projection.lineup(reader.board),now))),
        board: value('board'),
        view: value('view'),
        viewRevision: value('viewRevision'),
        historyStart: this.parts.store.historyStart(now),
        sources: watched.lineup.map(id => value(`card:${id}`)),
        sessions: Object.fromEntries(watched.lineup.map(id => [id, value(`sessions:${id}`)])),
        cadence: Object.fromEntries(watched.lineup.map(id => [id, value(`cadence:${id}`)])),
        refresh: Object.fromEntries(watched.lineup.map(id => [id, value(`refresh:${id}`)])),
        forecast: Object.fromEntries(watched.lineup.map(id => [id, value(`forecast:${id}`)])),
        mine: JSON.parse(this.mines.get(`${reader.user}\n${reader.board}`) ?? '[]'),
        boards: this.boardLists.get(reader.user)?.value ?? [],
        connectionsRevision: this.parts.directory.connectionsRevision(reader.user),
        resets: this.hub?.value,
      };
    } catch (error) {
      // Refused with an error, and nothing of it is left behind.
      this.unsubscribe(sub);
      throw error;
    }
    sub.fresh = false;
    if (sub.kind === 'stream') sub.stopPing = this.every(this.options.heartbeatMs, () => this.ping(sub));
    const hello = {epoch: this.epoch, now, client: this.client, heartbeatMs: this.options.heartbeatMs};
    const frames = [frame('hello', hello), frame('snapshot', snapshot)];
    if (sub.desktop) {
      const attention = this.attentionFrames(sub, true, now);
      frames.push(...attention.before, ...attention.after);
    }
    return {sub, frames};
  }

  /** Whether a new reader fits: the oldest to let go for it where it hits a limit, or 'refuse'. */
  private room(reader: Pick<Reader, 'user' | 'secret'>): Subscriber | 'refuse' | null {
    const all = [...this.subscribers.values()];
    const ofSession = all.filter(s => s.secret === reader.secret);
    if (ofSession.length >= this.options.perSession) return ofSession[0];
    const ofUser = all.filter(s => s.user === reader.user);
    if (ofUser.length >= this.options.perUser) return ofUser[0];
    if (all.length >= this.options.maxStreams) return ofUser[0] ?? 'refuse';
    return null;
  }

  /** Every `heartbeatMs` a stream hears the hub is there, if its session still holds and its reader is on the board. */
  private ping(sub: Subscriber) {
    const reason = this.gone(sub);
    if (reason) return this.end(sub, reason);
    sub.send([frame('ping', {now: this.clock.now()})]);
    if ((sub.backlog?.() ?? 0) > this.options.bufferBytes) this.end(sub, 'limit');
  }

  /** Why a reader can read no more, if so. */
  private gone(reader: Pick<Reader, 'user' | 'secret' | 'board'>): ByeReason | null {
    if (this.parts.directory.sessionUser(reader.secret, this.clock.now())?.id !== reader.user) return 'unauthorized';
    if (!this.parts.directory.membership(reader.board, reader.user)) return 'gone';
    return null;
  }

  /** Lets a reader go with `bye`; one still being given its snapshot is only dropped (it is refused instead). */
  private end(sub: Subscriber, reason: ByeReason) {
    if (!this.subscribers.has(sub.id)) return;
    const fresh = sub.fresh;
    this.unsubscribe(sub);
    if (!fresh) sub.end(reason);
  }

  /** A reader is gone: what was kept for it alone goes too. */
  private unsubscribe(sub: Subscriber) {
    if (!this.subscribers.delete(sub.id)) return;
    sub.stopPing();
    const watched = this.watched.get(sub.board);
    watched?.subscribers.delete(sub);
    const all = [...this.subscribers.values()];
    if (!all.some(s => s.user === sub.user && s.board === sub.board)) {this.mines.delete(`${sub.user}\n${sub.board}`);this.sourceAccess.delete(sub.user+'\n'+sub.board);this.currencyContexts.delete(sub.user+'\n'+sub.board);}
    if (!all.some(s => s.user === sub.user)) {this.boardLists.delete(sub.user);this.connections.delete(sub.user);}
    if (watched && !watched.subscribers.size) {
      watched.deadline?.cancel();
      watched.stopRecheck();
      this.watched.delete(watched.id);
      this.dirtyBoards.delete(watched.id);
      this.dirtySources.delete(watched.id);
      this.histories.delete(watched.id);
    }
    if (!all.length) {
      this.hub = null;
      this.hubDeadline?.cancel();
      this.hubDeadline = null;
      this.stopHubRecheck?.();
      this.stopHubRecheck = null;
    }
  }

  // ---------- long polls ----------

  /**
   * A long poll: a new lease starts with `hello` and `snapshot`; a known one answers with
   * what came since its last answer, or waits for it up to `pollMs`. An unknown lease (it
   * expired, fell behind, or the hub restarted) is a new one. 'limit' when there is no room.
   */
  async poll(reader: Omit<Reader, 'kind' | 'send' | 'end'>, id: string | undefined): Promise<{lease: string; now: number; frames: Frame[]} | null | 'limit'> {
    const known = id ? this.leases.get(id) : undefined;
    if (known && known.secret === reader.secret && known.board === reader.board && known.user === reader.user) {
      if (known.tomb) {
        this.forget(known);
        return {lease: known.id, now: this.clock.now(), frames: [bye(known.tomb)]};
      }
      const reason = this.gone(known);
      if (reason) {
        this.end(known.subscriber!, reason);
        return {lease: known.id, now: this.clock.now(), frames: [bye(reason)]};
      }
      known.stopExpiry();
      // One request waits at a time: an earlier one still waiting is answered empty.
      known.waiting?.([]);
      const frames = known.queue.length
        ? this.take(known)
        : await new Promise<Frame[]>(resolve => {
            const stop = this.later(this.options.pollMs, () => answer(this.take(known)));
            const answer = (frames: Frame[]) => {
              stop();
              if (known.waiting === answer) known.waiting = null;
              resolve(frames);
            };
            known.waiting = answer;
          });
      // Forgotten `leaseMs` after its last answer; a newer request waiting keeps it.
      if (this.leases.get(known.id) === known && !known.waiting) {
        known.stopExpiry();
        known.stopExpiry = this.later(this.options.leaseMs, () => this.expire(known));
      }
      return {lease: known.id, now: this.clock.now(), frames};
    }

    const lease: Lease = {...reader, id: randomBytes(16).toString('base64url'), subscriber: null, queue: [], bytes: 0, waiting: null, stopExpiry: () => {}, tomb: null};
    const opened = this.subscribe({
      ...reader,
      kind: 'lease',
      send: frames => {
        lease.queue.push(...frames);
        lease.bytes += frames.reduce((sum, f) => sum + f.data.length, 0);
        // Too far behind: dropped, and the next request starts over with a snapshot.
        if (lease.bytes > this.options.bufferBytes) {
          const waiting = lease.waiting;
          this.expire(lease);
          waiting?.([]);
        } else if (lease.waiting) lease.waiting(this.take(lease));
      },
      end: reason => {
        if (lease.waiting) {
          lease.waiting([bye(reason)]);
          this.forget(lease);
        } else if (reason === 'limit' || reason === 'restart') {
          // Nobody to tell now: the next request is, once, by a tombstone outside every limit.
          lease.tomb = reason;
          lease.subscriber = null;
        } else this.forget(lease);
      },
    });
    if (opened === null || opened === 'limit') return opened;
    lease.subscriber = opened.sub;
    this.leases.set(lease.id, lease);
    lease.stopExpiry = this.later(this.options.leaseMs, () => this.expire(lease));
    return {lease: lease.id, now: this.clock.now(), frames: opened.frames};
  }

  private take(lease: Lease): Frame[] {
    const frames = lease.queue;
    lease.queue = [];
    lease.bytes = 0;
    return frames;
  }

  /** A lease nobody asked on for `leaseMs`, or too far behind: its reader is gone. */
  private expire(lease: Lease) {
    if (lease.subscriber) this.unsubscribe(lease.subscriber);
    this.forget(lease);
  }

  private forget(lease: Lease) {
    lease.stopExpiry();
    if (this.leases.get(lease.id) === lease) this.leases.delete(lease.id);
  }

  // ---------- stopping ----------

  /** The hub stops: every reader hears `bye restart` and is let go; nothing is worked out any more. */
  close() {
    this.closed = true;
    this.stopFlush?.();
    this.stopFlush = null;
    for (const sub of [...this.subscribers.values()]) this.end(sub, 'restart');
    for (const lease of [...this.leases.values()]) {
      lease.waiting?.([bye('restart')]);
      this.forget(lease);
    }
  }

  /** How many readers there are (tests, and nothing else). */
  get readers() {
    return this.subscribers.size;
  }
}
