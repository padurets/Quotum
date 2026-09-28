import {earlyReset} from '../domain/attention.js';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {config} from '../config.js';
import {providers, sourceId, type Provider, type Source} from '../domain/sources.js';
import {onGrid, series, type Kind, type Measurement, type Sample, type SourceState} from '../domain/quota.js';
import type {Origin} from '../domain/ingest.js';
import {activity, barOf, seriesWork, union, type Activity, type SeriesWork, type Stretch} from '../domain/work.js';
import {members, projectGroups, type ProjectGroup} from '../domain/projects.js';
import {tell, type Touches} from '../touches.js';
import {migrate} from './schema.js';

/** A session credited with work (server/sessions.ts): its names as reported, '' for none. */
export type WorkKey = {source: string; origin: Origin; startedAt: number; project: string; folder: string; ordinal: number};

export type HistorySeries = {
  sourceId: string;
  provider: Provider;
  windowId: string;
  kind: Kind;
  label: string | null;
  minutes: number | null;
  consumed: number;
  coveredMs: number;
  samples: number;
  remainingAtStart: number | null;
  remainingAtEnd: number | null;
  /** How long its last value holds without a newer one before a gap begins. */
  staleAfterMs: number;
  points: (readonly [number, number, number])[];
  /** How agents worked on its subscription meanwhile; null when the board does not show whose work it is (a hidden card). */
  work: SeriesWork | null;
};

/**
 * How agents worked over a period, as the board shows it (see `Store.shown`): `since`,
 * since when that is known on the board; `known`, the part of the period that is (null
 * when none of it is).
 */
export type HistoryActivity = Activity & {since: number; known: {from: number; to: number} | null};

/**
 * Whose work a board shows on each of its subscriptions but those of hidden cards: the
 * people on the board who hold it, each from when (`from`), and since when the
 * subscription is on the board (`since`). A shared board shows a holder's work from the
 * later of their joining it and the subscription coming to it; a personal board shows all
 * of it.
 */
export type Shown = Map<string, {since: number; holders: {user: string; from: number}[]}>;

export type DeviceFailure = {device: string; provider: Provider; error: string; detail: string | null; at: number};

/** A reset for everyone as a community tracker reported it. */
export type Announcement = {at: number; url: string; text: string};

/**
 * Something that happened to a source, for the chart: its limits came back before their
 * reset time (a free reset used, or one granted to everyone), or free resets were granted.
 */
export type SourceEvent =
  | {sourceId: string; at: number; kind: 'early_reset'; windows: string[]}
  | {sourceId: string; at: number; kind: 'resets_granted'; count: number};

/** Early resets of a source's windows closer than this are one event. */
const SAME_EVENT_MS = 15 * 60_000;
/**
 * The names a board's history is keyed by (`Store.workKey`), for its people (a JSON list,
 * given twice) and its subscriptions (likewise): each project a person named that worked
 * on one of them, and each machine that did. It is read with every answer of history and
 * whenever the hub works out a watched board whole (at least every `recheckMs`), so a
 * machine's sessions are found by project (schema step 4) rather than read through.
 * Fields and entries are JSON arrays: names may themselves contain any separators.
 */
export const WORK_NAMES =
  'SELECT json_group_array(json(name)) AS names FROM (' +
  'SELECT json_array(n.user_id, n.reported, n.name) AS name FROM project_names n WHERE n.user_id IN (SELECT value FROM json_each(?))' +
  ' AND EXISTS (SELECT 1 FROM devices d JOIN agent_sessions s ON s.device_id = d.id WHERE d.user_id = n.user_id AND s.project = n.reported AND s.source_id IN (SELECT value FROM json_each(?)))' +
  ' UNION ALL SELECT json_array(d.id, COALESCE(d.label, d.name)) FROM devices d WHERE d.user_id IN (SELECT value FROM json_each(?))' +
  ' AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.device_id = d.id AND s.source_id IN (SELECT value FROM json_each(?))) ORDER BY 1)';

type SampleRow = {
  source_id: string;
  provider: Provider;
  window_id: string;
  at: number;
  kind: Kind;
  label: string | null;
  used: number;
  reset_at: number | null;
  minutes: number | null;
  stale_after_ms: number;
};

/** A source as a board shows it: with the people who measure it and whether they shared it here. */
export type BoardSource = Source & {holders: string[]; sharedBy: string | null};

/**
 * Sources, their last state and every measured value, in one SQLite file (WAL, one
 * writer, prepared statements). People, boards and devices live in the same file, see
 * directory.ts. A source is kept once; boards show sources: a personal board every
 * source its person holds (their devices measure it), a shared board those shared
 * with it.
 */
export class Store {
  readonly db: DatabaseSync;
  /** When this database was made. */
  private readonly created: number;
  private readonly revisions = new Map<string, number>();
  private readonly started = Date.now();
  private observer: Touches | null = null;

  constructor(file: string, now = Date.now()) {
    this.db = new DatabaseSync(file);
    migrate(this.db, now);
    this.created = Number((this.db.prepare("SELECT value FROM meta WHERE key = 'historyStart'").get() as {value: string}).value);
  }

  /**
   * Since when history is kept, for the whole hub: the creation of this database, or the
   * oldest sample it keeps when that is older (measurements an agent kept while the hub
   * was away and delivered to a new one). Only within the retention period: a sample
   * dated before it (a clock not set yet) is pruned soon and moves nothing meanwhile.
   * The index on time finds it at once.
   */
  historyStart(now: number): number {
    const kept = now - config.retention.sampleDays * 86_400_000;
    const oldest = (this.db.prepare('SELECT MIN(at) AS at FROM samples WHERE at >= ?').get(kept) as {at: number | null}).at;
    return oldest === null ? this.created : Math.min(this.created, oldest);
  }

  /** Tells `observer` what every change touches (events of open dashboards). */
  setObserver(observer: Touches) {
    this.observer = observer;
  }

  /** Changes whenever something a board shows changes; its history is cached by it. */
  revision(board: string): number {
    return this.revisions.get(board) ?? this.started;
  }

  /** Something on these boards changed. */
  changed(...boards: string[]) {
    for (const board of boards) this.revisions.set(board, this.revision(board) + 1);
  }

  /** The boards a source shows on: the personal boards of its holders and the boards it is shared with. */
  boardsOf(source: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT boards.id FROM holders JOIN boards ON boards.created_by = holders.user_id AND boards.personal = 1 WHERE holders.source_id = ?' +
          ' UNION SELECT board_id FROM shares WHERE source_id = ?',
      )
      .all(source, source) as {id: string}[];
    return rows.map(r => r.id);
  }

  /** What a board shows, by provider, then in the order it came to the board. */
  sources(board: string): BoardSource[] {
    const kind = this.db.prepare('SELECT personal, created_by FROM boards WHERE id = ?').get(board) as {personal: number; created_by: string} | undefined;
    if (!kind) return [];
    const rows = (
      kind.personal
        ? this.db
            .prepare('SELECT s.id, s.provider, s.account, NULL AS shared_by FROM holders h JOIN sources s ON s.id = h.source_id WHERE h.user_id = ? ORDER BY h.since, s.rowid')
            .all(kind.created_by)
        : this.db
            .prepare('SELECT s.id, s.provider, s.account, sh.shared_by FROM shares sh JOIN sources s ON s.id = sh.source_id WHERE sh.board_id = ? ORDER BY sh.shared_at, s.rowid')
            .all(board)
    ) as {id: string; provider: Provider; account: string; shared_by: string | null}[];
    const holders = this.db.prepare('SELECT user_id FROM holders WHERE source_id = ? ORDER BY since, user_id');
    return rows
      .map(r => ({
        id: r.id,
        provider: r.provider,
        account: r.account,
        sharedBy: r.shared_by,
        holders: (holders.all(r.id) as {user_id: string}[]).map(h => h.user_id),
      }))
      .sort((a, b) => providers.indexOf(a.provider) - providers.indexOf(b.provider));
  }

  /** The sources a person's devices measure. */
  held(userId: string): Source[] {
    return this.db
      .prepare('SELECT s.id, s.provider, s.account FROM holders h JOIN sources s ON s.id = h.source_id WHERE h.user_id = ? ORDER BY h.since, s.rowid')
      .all(userId) as Source[];
  }

  /** Whose work a board shows (`Shown`), but for the subscriptions of the cards `hidden` (view ids, `source:<id>`). */
  shown(board: string, hidden: readonly string[]): Shown {
    const kind = this.db.prepare('SELECT personal FROM boards WHERE id = ?').get(board) as {personal: number} | undefined;
    if (!kind) return new Map();
    const joined = new Map(
      (this.db.prepare('SELECT user_id, joined_at FROM members WHERE board_id = ?').all(board) as {user_id: string; joined_at: number}[]).map(m => [m.user_id, m.joined_at]),
    );
    const sharedAt = new Map(
      (this.db.prepare('SELECT source_id, shared_at FROM shares WHERE board_id = ?').all(board) as {source_id: string; shared_at: number}[]).map(s => [s.source_id, s.shared_at]),
    );
    const shown: Shown = new Map();
    for (const source of this.sources(board)) {
      if (hidden.includes(`source:${source.id}`)) continue;
      const since = kind.personal ? 0 : (sharedAt.get(source.id) ?? 0);
      const holders = source.holders.filter(user => joined.has(user)).map(user => ({user, from: kind.personal ? 0 : Math.max(joined.get(user)!, since)}));
      shown.set(source.id, {since, holders});
    }
    return shown;
  }

  /**
   * What the history of a board's agent work depends on besides the data: its subscriptions,
   * whose work it shows from when (`shown`), and the names their people gave the projects
   * and machines that worked on them. A change of any of these asks for the history anew, on
   * the hub and on the page. A project or machine that never worked on the board's
   * subscriptions does not; one that worked on them only before the board shows its work
   * does, as which did is found without reading when (WORK_NAMES).
   */
  workKey(board: string, shown: Shown): string {
    const people = JSON.stringify([...new Set([...shown.values()].flatMap(s => s.holders.map(h => h.user)))].sort());
    const sources = JSON.stringify([...shown.keys()]);
    const names = this.db.prepare(WORK_NAMES).get(people, sources, people, sources) as {names: string};
    const key = JSON.stringify([this.sources(board).map(s => s.id), [...shown].map(([id, s]) => [id, s.since, s.holders]), names.names]);
    return createHash('sha256').update(key).digest('base64url').slice(0, 16);
  }

  holds(userId: string, source: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM holders WHERE user_id = ? AND source_id = ?').get(userId, source);
  }

  /** The source of a subscription, created the first time anyone measures it. */
  /** The source of an account, if the hub has one. */
  findSource(provider: Provider, account: string): string | null {
    const row = this.db.prepare('SELECT id FROM sources WHERE provider = ? AND account = ?').get(provider, account) as {id: string} | undefined;
    return row?.id ?? null;
  }

  /** The account key of a source. */
  account(id: string): string | null {
    const row = this.db.prepare('SELECT account FROM sources WHERE id = ?').get(id) as {account: string} | undefined;
    return row?.account ?? null;
  }

  source(provider: Provider, account: string, now: number): string {
    const row = this.db.prepare('SELECT id FROM sources WHERE provider = ? AND account = ?').get(provider, account) as {id: string} | undefined;
    if (row) return row.id;
    const id = sourceId(provider, account);
    this.db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?)').run(id, provider, account, now);
    return id;
  }

  /** A person's device measures a source: it is theirs to see and share from now on. */
  hold(source: string, userId: string, now: number) {
    if (this.db.prepare('INSERT OR IGNORE INTO holders VALUES (?, ?, ?)').run(source, userId, now).changes) {
      const personal = this.db.prepare('SELECT id FROM boards WHERE created_by = ? AND personal = 1').get(userId) as {id: string} | undefined;
      if (personal) this.changed(personal.id);
      // It comes to their personal board, and its owners change where it is shared.
      tell(this.observer, o => {
        o.touchBoards(this.boardsOf(source));
        o.touchUser(userId);
      });
    }
  }

  /**
   * A person disconnected devices: what only those devices measured for them is no
   * longer theirs. It leaves their personal board, and the shared boards where no other
   * member measures it. Its history stays: a device that measures it again brings it back.
   */
  releaseRevoked(userId: string) {
    const orphans = this.db
      .prepare(
        'SELECT DISTINCT ds.source_id FROM device_sources ds JOIN devices d ON d.id = ds.device_id' +
          ' WHERE d.user_id = ? AND d.revoked_at IS NOT NULL AND ds.source_id NOT IN' +
          ' (SELECT ds2.source_id FROM device_sources ds2 JOIN devices d2 ON d2.id = ds2.device_id WHERE d2.user_id = ? AND d2.revoked_at IS NULL)',
      )
      .all(userId, userId) as {source_id: string}[];
    for (const {source_id: source} of orphans) {
      const shown = this.observer ? this.boardsOf(source) : [];
      if (!this.db.prepare('DELETE FROM holders WHERE source_id = ? AND user_id = ?').run(source, userId).changes) continue;
      tell(this.observer, o => {
        o.touchBoards(shown);
        o.touchUser(userId);
      });
      const personal = this.db.prepare('SELECT id FROM boards WHERE created_by = ? AND personal = 1').get(userId) as {id: string} | undefined;
      if (personal) this.changed(personal.id);
      const shared = this.db.prepare('SELECT board_id FROM shares WHERE source_id = ?').all(source) as {board_id: string}[];
      for (const {board_id: board} of shared) this.unshareOrphans(board);
    }
  }

  // ---------- sharing ----------

  share(board: string, source: string, userId: string, now: number) {
    if (this.db.prepare('INSERT OR IGNORE INTO shares VALUES (?, ?, ?, ?)').run(board, source, userId, now).changes) {
      this.changed(board);
      tell(this.observer, o => o.touchBoards([board]));
    }
  }

  unshare(board: string, source: string): boolean {
    const removed = this.db.prepare('DELETE FROM shares WHERE board_id = ? AND source_id = ?').run(board, source).changes > 0;
    if (removed) {
      this.changed(board);
      tell(this.observer, o => o.touchBoards([board]));
    }
    return removed;
  }

  /** Takes off a board what none of its remaining members holds: someone who left takes their data along. */
  unshareOrphans(board: string) {
    const removed = this.db
      .prepare(
        'DELETE FROM shares WHERE board_id = ? AND source_id NOT IN' +
          ' (SELECT h.source_id FROM holders h JOIN members m ON m.user_id = h.user_id WHERE m.board_id = ?)',
      )
      .run(board, board).changes;
    if (removed) {
      this.changed(board);
      tell(this.observer, o => o.touchBoards([board]));
    }
  }

  /** Forgets what a deleted board showed; the sources stay with their people (Directory.deleteBoard does the rest). */
  removeBoard(board: string) {
    this.db.prepare('DELETE FROM shares WHERE board_id = ?').run(board);
    this.revisions.delete(board);
  }

  // ---------- measurements ----------

  states(board: string): SourceState[] {
    return this.sources(board).map(source => this.stateOf(source.id, source.provider));
  }

  state(id: string): SourceState {
    const row = this.db.prepare('SELECT provider FROM sources WHERE id = ?').get(id) as {provider: Provider} | undefined;
    if (!row) throw new Error(`unknown source ${id}`);
    return this.stateOf(id, row.provider);
  }

  private stateOf(id: string, provider: Provider): SourceState {
    const row = this.db.prepare('SELECT payload FROM state WHERE source_id = ?').get(id) as {payload: string} | undefined;
    if (!row) return {id, provider, plan: '', successAt: null, error: 'waiting', windows: [], staleAfterMs: null, resets: null};
    return {...(JSON.parse(row.payload) as SourceState), id, provider};
  }

  /**
   * Stores a measurement: a sample per window, the new state of the source, and free
   * resets granted since the last one. A savepoint keeps it whole on its own and inside
   * a batch's transaction alike.
   */
  record(id: string, measurement: Measurement) {
    const previous = this.state(id);
    const {provider} = previous;
    // Only when both measurements report free resets: one that does not say nothing about them.
    const granted = measurement.resets && previous.resets ? measurement.resets.available - previous.resets.available : 0;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO samples (source_id, window_id, at, kind, label, used, reset_at, minutes, stale_after_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const state: SourceState = {
      id,
      provider,
      plan: measurement.plan,
      successAt: measurement.observedAt,
      error: null,
      windows: measurement.windows,
      staleAfterMs: measurement.staleAfterMs,
      resets: measurement.resets,
    };
    this.db.exec('SAVEPOINT record');
    try {
      for (const w of measurement.windows) {
        insert.run(id, w.id, measurement.observedAt, w.kind, w.label, w.used, w.resetAt, w.minutes, measurement.staleAfterMs);
      }
      this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(id, JSON.stringify(state));
      if (granted > 0 && previous.successAt !== null) {
        this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?)').run(id, measurement.observedAt, 'resets_granted', String(granted));
      }
      this.db.exec('RELEASE record');
    } catch (error) {
      this.db.exec('ROLLBACK TO record');
      this.db.exec('RELEASE record');
      throw error;
    }
    this.changed(...this.boardsOf(id));
    tell(this.observer, o => {
      o.touchSources([id]);
      o.history(id, measurement.observedAt);
    });
  }

  /** Records a failed attempt; the last good values stay on screen. */
  fail(id: string, error: string) {
    this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(id, JSON.stringify({...this.state(id), error}));
    this.changed(...this.boardsOf(id));
    tell(this.observer, o => o.touchSources([id]));
  }

  /** Remembers which source a device last delivered for a provider; its failures for the provider are over. */
  seenDevice(device: string, provider: Provider, source: string, at: number) {
    this.db.prepare('INSERT OR REPLACE INTO device_sources VALUES (?, ?, ?, ?)').run(device, provider, source, at);
    this.db.prepare('DELETE FROM device_failures WHERE device_id = ? AND provider = ?').run(device, provider);
  }

  deviceSource(device: string, provider: Provider): string | null {
    const row = this.db.prepare('SELECT source_id FROM device_sources WHERE device_id = ? AND provider = ?').get(device, provider) as
      | {source_id: string}
      | undefined;
    return row?.source_id ?? null;
  }

  /** Which sources each device of a person delivers to. */
  deviceSources(userId: string): {device: string; provider: Provider; source: string; seenAt: number}[] {
    const rows = this.db
      .prepare('SELECT d.device_id, d.provider, d.source_id, d.seen_at FROM device_sources d JOIN devices ON devices.id = d.device_id WHERE devices.user_id = ?')
      .all(userId) as {device_id: string; provider: Provider; source_id: string; seen_at: number}[];
    return rows.map(r => ({device: r.device_id, provider: r.provider, source: r.source_id, seenAt: r.seen_at}));
  }

  /** The last failure a device reported for a provider, kept until it delivers for it again. */
  deviceFailed(device: string, provider: Provider, error: string, detail: string | null, at: number) {
    this.db.prepare('INSERT OR REPLACE INTO device_failures VALUES (?, ?, ?, ?, ?)').run(device, provider, error, detail, at);
  }

  deviceFailures(userId: string): DeviceFailure[] {
    const rows = this.db
      .prepare('SELECT f.* FROM device_failures f JOIN devices d ON d.id = f.device_id WHERE d.user_id = ?')
      .all(userId) as {device_id: string; provider: Provider; error: string; detail: string | null; at: number}[];
    return rows.map(r => ({device: r.device_id, provider: r.provider, error: r.error, detail: r.detail, at: r.at}));
  }

  /**
   * Every source/window series from `from` to `to` on a shared grid, ready for the chart
   * and the table, what happened meanwhile, and how the agents the board shows (`shown`)
   * worked, up to `now` at the latest. A period up to now has no `to`: a sample an agent
   * whose clock is a little fast dated a few seconds ahead is on the chart all the same.
   */
  history(
    board: string,
    from: number,
    cellMs: number,
    {to = Number.MAX_SAFE_INTEGER, now = Date.now(), shown = this.shown(board, [])}: {to?: number; now?: number; shown?: Shown} = {},
  ): {series: HistorySeries[]; events: SourceEvent[]; activity: HistoryActivity} {
    const ids = JSON.stringify(this.sources(board).map(s => s.id));
    const states = this.states(board);
    // One window at a time: the primary key (source, window, time) finds just the period,
    // already in order. A window its source no longer reports is not shown, so not read.
    const read = this.db.prepare('SELECT at, used, reset_at, stale_after_ms FROM samples WHERE source_id = ? AND window_id = ? AND at BETWEEN ? AND ? ORDER BY at');
    const groups = new Map<string, Sample[]>();
    for (const state of states) {
      for (const window of state.windows) {
        // Only what changes from sample to sample; what a window is comes from its state.
        const rows = read.all(state.id, window.id, from, to) as Pick<SampleRow, 'at' | 'used' | 'reset_at' | 'stale_after_ms'>[];
        if (!rows.length) continue;
        const {id, kind, label, minutes} = window;
        groups.set(
          `${state.id} ${id}`,
          rows.map(row => ({
            sourceId: state.id,
            provider: state.provider,
            id,
            kind,
            label,
            at: row.at,
            used: row.used,
            remaining: 100 - row.used,
            resetAt: row.reset_at,
            minutes,
            staleAfterMs: row.stale_after_ms,
          })),
        );
      }
    }

    // Series follow the cards: sources in board order, windows in the order the source reports them.
    const rank = (sample: Sample) => {
      const source = states.findIndex(s => s.id === sample.sourceId);
      const window = states[source]?.windows.findIndex(w => w.id === sample.id) ?? -1;
      return (source < 0 ? states.length : source) * 100 + (window < 0 ? 99 : window);
    };

    const work = this.work(from, Math.min(to, now), cellMs, shown);
    const lines = [...groups.values()]
      .sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(samples => {
        const last = samples.at(-1)!;
        const {points, ...summary} = series(samples);
        const source = shown.get(last.sourceId);
        return {
          sourceId: last.sourceId,
          provider: last.provider,
          windowId: last.id,
          kind: last.kind,
          label: last.label,
          minutes: last.minutes,
          staleAfterMs: last.staleAfterMs,
          ...summary,
          points: onGrid(points, cellMs).map(p => [p.at, Math.round(p.remaining * 100) / 100, p.segment] as const),
          // Spending before the subscription came to the board is not set against work the board does not show.
          work: source ? seriesWork(samples, work.worked.get(last.sourceId) ?? [], {from: Math.max(work.from, source.since), to: work.to}) : null,
        };
      });
    return {
      series: lines,
      events: [...earlyResets([...groups.values()]), ...this.grants(ids, from, to)].sort((a, b) => a.at - b.at),
      activity: work.activity,
    };
  }

  /**
   * How the agents a board shows worked from `from` to `to`: the activity, in bars of up
   * to an hour gathered from the chart's cells `cellMs` long, and when each subscription
   * had any of them working. What is known begins with the hub keeping it
   * (`agentWorkSince`) and, on a shared board, the first subscription coming to it.
   */
  private work(from: number, to: number, cellMs: number, shown: Shown) {
    const since = Math.max(this.agentWorkSince(), ...(shown.size ? [Math.min(...[...shown.values()].map(s => s.since))] : []));
    const known = {from: Math.max(from, since), to};
    const holders = new Map([...shown].map(([id, s]) => [id, new Map(s.holders.map(h => [h.user, h.from]))]));
    // Only the work of the people the board shows each subscription for, from when it shows it.
    const stretches: Stretch[] = [];
    for (const s of known.to > known.from && shown.size ? this.agentWork(known.from, known.to, [...shown.keys()]) : []) {
      const after = holders.get(s.source)?.get(s.user);
      if (after === undefined || s.to <= after) continue;
      stretches.push(s.from < after ? {...s, from: after} : s);
    }
    const bySource = new Map<string, Stretch[]>();
    for (const s of stretches) {
      if (!bySource.has(s.source)) bySource.set(s.source, []);
      bySource.get(s.source)!.push(s);
    }
    const devices = [...new Set(stretches.map(s => s.device))];
    const names = new Map(
      (
        this.db.prepare('SELECT id, COALESCE(label, name) AS name FROM devices WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(devices)) as {
          id: string;
          name: string;
        }[]
      ).map(d => [d.id, d.name]),
    );
    const barMs = barOf(cellMs, to - from);
    const none = {barMs, workMs: 0, agentMs: 0, agents: 0, cells: [], by: {source: [], project: [], device: []}};
    return {
      ...known,
      worked: new Map([...bySource].map(([id, list]) => [id, union(list)])),
      activity: known.to > known.from ? {since, known, ...activity(stretches, known, barMs, names)} : {since, known: null, ...none},
    };
  }

  private grants(ids: string, from: number, to: number): SourceEvent[] {
    const rows = this.db
      .prepare("SELECT source_id, at, detail FROM events WHERE source_id IN (SELECT value FROM json_each(?)) AND kind = 'resets_granted' AND at BETWEEN ? AND ?")
      .all(ids, from, to) as {source_id: string; at: number; detail: string}[];
    return rows.map(r => ({sourceId: r.source_id, at: r.at, kind: 'resets_granted', count: Number(r.detail)}));
  }

  /** Keeps a reset the trackers reported; the same one reported again is kept once. */
  announce(provider: string, announcement: Announcement) {
    if (this.db.prepare('INSERT OR IGNORE INTO announcements VALUES (?, ?, ?, ?)').run(provider, announcement.at, announcement.url, announcement.text).changes) {
      tell(this.observer, o => o.touchHub());
    }
  }

  /** Resets the trackers reported since `from`, by provider, oldest first. */
  announcements(from: number): Record<string, Announcement[]> {
    const rows = this.db.prepare('SELECT * FROM announcements WHERE at >= ? ORDER BY at').all(from) as ({provider: string} & Announcement)[];
    const byProvider: Record<string, Announcement[]> = {};
    for (const {provider, at, url, text} of rows) (byProvider[provider] ??= []).push({at, url, text});
    return byProvider;
  }

  /**
   * Credits the sessions `keys` of a device with work from `from` to `until`: a stretch
   * that ends where this one starts grows, else a new one begins. A session is never
   * credited again for time before the end of its latest stretch, which a clock set back
   * would bring, even after the hub restarted or the machine went quiet in between. A
   * savepoint keeps it whole on its own (a sweep) and inside a request's transaction alike.
   */
  creditWork(device: string, from: number, until: number, keys: WorkKey[]) {
    if (until <= from || !keys.length) return;
    const add = this.db.prepare(
      'INSERT INTO agent_sessions (device_id, source_id, origin, started_at, project, folder, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    );
    const find = this.db.prepare(
      'SELECT id FROM agent_sessions WHERE device_id = ? AND source_id = ? AND started_at = ? AND origin = ? AND project = ? AND folder = ? AND ordinal = ?',
    );
    // Stretches of a session never overlap, so its last one by start ends latest.
    const latest = this.db.prepare('SELECT to_at AS at FROM agent_work WHERE session_id = ? ORDER BY from_at DESC LIMIT 1');
    const extend = this.db.prepare('UPDATE agent_work SET to_at = ? WHERE session_id = ? AND to_at = ?');
    const begin = this.db.prepare('INSERT INTO agent_work VALUES (?, ?, ?) ON CONFLICT (session_id, from_at) DO UPDATE SET to_at = max(to_at, excluded.to_at)');
    this.db.exec('SAVEPOINT credit');
    try {
      for (const {source, origin, startedAt, project, folder, ordinal} of keys) {
        add.run(device, source, origin, startedAt, project, folder, ordinal);
        const {id} = find.get(device, source, startedAt, origin, project, folder, ordinal) as {id: number};
        const start = Math.max(from, (latest.get(id) as {at: number} | undefined)?.at ?? from);
        if (until <= start) continue;
        if (!extend.run(until, id, start).changes) begin.run(id, start, until);
      }
      this.db.exec('RELEASE credit');
    } catch (error) {
      this.db.exec('ROLLBACK TO credit');
      this.db.exec('RELEASE credit');
      throw error;
    }
  }

  /** Every stretch agents worked within [from, to), of the given subscriptions or all, projects named as their people corrected them. */
  agentWork(from: number, to: number, sources?: string[]): Stretch[] {
    // A month of a busy board is tens of thousands of rows, read as arrays: half the time of objects. The
    // index on time, even for the order: else a day would go through every stretch the hub keeps.
    const read = this.db.prepare(
      'SELECT w.session_id, max(w.from_at, ?), min(w.to_at, ?) FROM agent_work w INDEXED BY agent_work_by_end JOIN agent_sessions s ON s.id = w.session_id' +
        ' WHERE w.to_at > ? AND w.from_at < ?' +
        (sources ? ' AND s.source_id IN (SELECT value FROM json_each(?))' : '') +
        ' ORDER BY w.session_id, w.from_at',
    );
    read.setReturnArrays(true);
    const rows = read.all(from, to, from, to, ...(sources ? [JSON.stringify(sources)] : [])) as unknown as [number, number, number][];
    // What is said of a session is read once rather than with each of its stretches: that takes most of the time.
    const sessions = new Map(
      (
        this.db
          .prepare(
            "SELECT s.id, s.source_id AS source, s.device_id AS device, d.user_id AS user, s.origin, COALESCE(n.name, NULLIF(s.project, '')) AS project," +
              " NULLIF(s.folder, '') AS folder, s.started_at AS startedAt FROM agent_sessions s JOIN devices d ON d.id = s.device_id" +
              ' LEFT JOIN project_names n ON n.user_id = d.user_id AND n.reported = s.project WHERE s.id IN (SELECT value FROM json_each(?))',
          )
          .all(JSON.stringify([...new Set(rows.map(([id]) => id))])) as ({id: number} & Omit<Stretch, 'session' | 'from' | 'to'>)[]
      ).map(({id, ...session}) => [id, session]),
    );
    return rows.map(([id, start, end]) => {
      const s = sessions.get(id)!;
      return {session: id, source: s.source, device: s.device, user: s.user, origin: s.origin, project: s.project, folder: s.folder, startedAt: s.startedAt, from: start, to: end};
    });
  }

  /** The projects a person's machines worked on since `since`, under the names the person gave them. */
  projectsOf(user: string, since: number): ProjectGroup[] {
    const rows = this.db
      .prepare(
        'SELECT s.project, d.id, COALESCE(d.label, d.name) AS name, max(w.to_at) AS last' +
          ' FROM devices d JOIN agent_sessions s ON s.device_id = d.id JOIN agent_work w ON w.session_id = s.id' +
          ' WHERE d.user_id = ? AND w.to_at > ? GROUP BY s.project, d.id',
      )
      .all(user, since) as {project: string; id: string; name: string; last: number}[];
    const work = rows.map(r => ({reported: r.project, machine: {id: r.id, name: r.name}, lastAt: r.last}));
    return projectGroups(work, this.projectNames(user));
  }

  /**
   * Gives every reported name gathered under the person's projects `groups` the name
   * `name`, or back its own when that is empty. Call it in a transaction: the groups are
   * worked out from what is kept as it writes.
   */
  nameProjects(user: string, groups: string[], name: string) {
    const names = this.projectNames(user);
    const sent = new Set(
      (this.db.prepare('SELECT DISTINCT s.project FROM devices d JOIN agent_sessions s ON s.device_id = d.id WHERE d.user_id = ?').all(user) as {project: string}[]).map(
        r => r.project,
      ),
    );
    const reported = new Set(groups.flatMap(group => members(group, names, sent)));
    this.restoreProjects(user, [...reported].filter(r => !name || r === name));
    const give = this.db.prepare('INSERT INTO project_names VALUES (?, ?, ?) ON CONFLICT (user_id, reported) DO UPDATE SET name = excluded.name');
    if (name) for (const r of reported) if (r !== name) give.run(user, r, name);
    this.renamed(user);
  }

  /** Reported names shown under their own name again. */
  restoreProjects(user: string, reported: string[]) {
    const remove = this.db.prepare('DELETE FROM project_names WHERE user_id = ? AND reported = ?');
    for (const r of reported) remove.run(user, r);
    this.renamed(user);
  }

  /** A person's projects are shown under new names: their agents, and the history of the boards that show them. */
  private renamed(user: string) {
    const held = this.held(user).map(s => s.id);
    tell(this.observer, o => {
      o.touchSources(held);
      o.touchBoards([...new Set(held.flatMap(id => this.boardsOf(id)))]);
    });
  }

  /** The names a person gave the projects their machines report: reported → shown. */
  projectNames(user: string): Map<string, string> {
    const rows = this.db.prepare('SELECT reported, name FROM project_names WHERE user_id = ?').all(user) as {reported: string; name: string}[];
    return new Map(rows.map(r => [r.reported, r.name]));
  }

  /** Since when the hub keeps how agents worked: before it, that is not known. */
  agentWorkSince(): number {
    return Number((this.db.prepare("SELECT value FROM meta WHERE key = 'agentWorkSince'").get() as {value: string}).value);
  }

  /** Forgets samples, events, announcements and agents' work older than the retention period; corrected project names stay until undone. */
  prune(now: number) {
    this.db.prepare('DELETE FROM attention_windows WHERE source_id NOT IN (SELECT id FROM sources)').run();
    const cutoff = now - config.retention.sampleDays * 86_400_000;
    this.db.prepare('DELETE FROM samples WHERE at < ?').run(cutoff);
    this.db.prepare('DELETE FROM agent_work WHERE to_at < ?').run(cutoff);
    // A session without work is not needed; one still running is made again when credited.
    this.db.prepare('DELETE FROM agent_sessions WHERE NOT EXISTS (SELECT 1 FROM agent_work WHERE session_id = agent_sessions.id)').run();
    this.db.prepare('DELETE FROM events WHERE at < ?').run(cutoff);
    this.db.prepare('DELETE FROM announcements WHERE at < ?').run(cutoff);
  }

  close() {
    this.db.close();
  }
}

/**
 * Windows whose used share dropped well before their reset time: the limits came back
 * early. Resets of one source close together are one event naming every window.
 */
function earlyResets(groups: Sample[][]): SourceEvent[] {
  const found: {sourceId: string; at: number; window: string}[] = [];
  for (const samples of groups) {
    for (let i = 1; i < samples.length; i++) {
      const [a, b] = [samples[i - 1], samples[i]];
      if (earlyReset(a, b)) found.push({sourceId: b.sourceId, at: b.at, window: b.id});
    }
  }
  const events: (SourceEvent & {kind: 'early_reset'})[] = [];
  for (const reset of found.sort((a, b) => a.at - b.at)) {
    const same = events.find(e => e.sourceId === reset.sourceId && reset.at - e.at <= SAME_EVENT_MS);
    if (same) {
      if (!same.windows.includes(reset.window)) same.windows.push(reset.window);
    } else events.push({sourceId: reset.sourceId, at: reset.at, kind: 'early_reset', windows: [reset.window]});
  }
  // Named the same way whatever order the windows were read in.
  for (const event of events) event.windows.sort();
  return events;
}
