import {DatabaseSync} from 'node:sqlite';
import {config} from '../config.js';
import {providers, sourceId, type Provider, type Source} from '../domain/sources.js';
import {onGrid, series, type Kind, type Measurement, type Sample, type SourceState} from '../domain/quota.js';
import {migrate} from './schema.js';

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
};

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
/** A drop of at least this many points before the window's reset time is a reset, not a correction. */
const RESET_DROP = 5;

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
  /** Since when history is kept: the creation of this database. */
  readonly historyStart: number;
  private readonly revisions = new Map<string, number>();
  private readonly started = Date.now();

  constructor(file: string, now = Date.now()) {
    this.db = new DatabaseSync(file);
    migrate(this.db, now);
    this.historyStart = Number((this.db.prepare("SELECT value FROM meta WHERE key = 'historyStart'").get() as {value: string}).value);
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

  holds(userId: string, source: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM holders WHERE user_id = ? AND source_id = ?').get(userId, source);
  }

  /** The source of a subscription, created the first time anyone measures it. */
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
      if (!this.db.prepare('DELETE FROM holders WHERE source_id = ? AND user_id = ?').run(source, userId).changes) continue;
      const personal = this.db.prepare('SELECT id FROM boards WHERE created_by = ? AND personal = 1').get(userId) as {id: string} | undefined;
      if (personal) this.changed(personal.id);
      const shared = this.db.prepare('SELECT board_id FROM shares WHERE source_id = ?').all(source) as {board_id: string}[];
      for (const {board_id: board} of shared) this.unshareOrphans(board);
    }
  }

  // ---------- sharing ----------

  share(board: string, source: string, userId: string, now: number) {
    if (this.db.prepare('INSERT OR IGNORE INTO shares VALUES (?, ?, ?, ?)').run(board, source, userId, now).changes) this.changed(board);
  }

  unshare(board: string, source: string): boolean {
    const removed = this.db.prepare('DELETE FROM shares WHERE board_id = ? AND source_id = ?').run(board, source).changes > 0;
    if (removed) this.changed(board);
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
    if (removed) this.changed(board);
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
  }

  /** Records a failed attempt; the last good values stay on screen. */
  fail(id: string, error: string) {
    this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(id, JSON.stringify({...this.state(id), error}));
    this.changed(...this.boardsOf(id));
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

  /** Every source/window series from `from` to `to` on a shared grid, ready for the chart and the table, and what happened meanwhile. */
  history(board: string, from: number, cellMs: number, to = Number.MAX_SAFE_INTEGER): {series: HistorySeries[]; events: SourceEvent[]} {
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

    const lines = [...groups.values()]
      .sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(samples => {
        const last = samples.at(-1)!;
        const {points, ...summary} = series(samples);
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
        };
      });
    return {series: lines, events: [...earlyResets([...groups.values()]), ...this.grants(ids, from, to)].sort((a, b) => a.at - b.at)};
  }

  private grants(ids: string, from: number, to: number): SourceEvent[] {
    const rows = this.db
      .prepare("SELECT source_id, at, detail FROM events WHERE source_id IN (SELECT value FROM json_each(?)) AND kind = 'resets_granted' AND at BETWEEN ? AND ?")
      .all(ids, from, to) as {source_id: string; at: number; detail: string}[];
    return rows.map(r => ({sourceId: r.source_id, at: r.at, kind: 'resets_granted', count: Number(r.detail)}));
  }

  /** Keeps a reset the trackers reported; the same one reported again is kept once. */
  announce(provider: string, announcement: Announcement) {
    this.db.prepare('INSERT OR IGNORE INTO announcements VALUES (?, ?, ?, ?)').run(provider, announcement.at, announcement.url, announcement.text);
  }

  /** Resets the trackers reported since `from`, by provider, oldest first. */
  announcements(from: number): Record<string, Announcement[]> {
    const rows = this.db.prepare('SELECT * FROM announcements WHERE at >= ? ORDER BY at').all(from) as ({provider: string} & Announcement)[];
    const byProvider: Record<string, Announcement[]> = {};
    for (const {provider, at, url, text} of rows) (byProvider[provider] ??= []).push({at, url, text});
    return byProvider;
  }

  /** Forgets samples, events and announcements older than the retention period. */
  prune(now: number) {
    const cutoff = now - config.retention.sampleDays * 86_400_000;
    this.db.prepare('DELETE FROM samples WHERE at < ?').run(cutoff);
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
      if (a.resetAt !== null && b.at < a.resetAt - 60_000 && b.used < a.used - RESET_DROP) found.push({sourceId: b.sourceId, at: b.at, window: b.id});
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
