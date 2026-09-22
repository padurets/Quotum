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
  points: (readonly [number, number, number])[];
};

export type DeviceFailure = {device: string; provider: Provider; error: string; detail: string | null; at: number};

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

/**
 * Sources, their last state and every measured value, in one SQLite file (WAL, one
 * writer, prepared statements). People and devices live in the same file, see
 * directory.ts.
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

  private changed(board: string) {
    this.revisions.set(board, this.revision(board) + 1);
  }

  private boardOf(source: string): string {
    return (this.db.prepare('SELECT board_id FROM sources WHERE id = ?').get(source) as {board_id: string}).board_id;
  }

  /** The sources of a board: by provider, then in the order they appeared. */
  sources(board: string): Source[] {
    const rows = this.db.prepare('SELECT id, provider, account FROM sources WHERE board_id = ? ORDER BY created_at, rowid').all(board) as Source[];
    return rows.sort((a, b) => providers.indexOf(a.provider) - providers.indexOf(b.provider));
  }

  /** The source of a subscription on a board, created the first time it is seen. */
  source(board: string, provider: Provider, account: string, now: number): string {
    const row = this.db.prepare('SELECT id FROM sources WHERE board_id = ? AND provider = ? AND account = ?').get(board, provider, account) as
      | {id: string}
      | undefined;
    if (row) return row.id;
    const id = sourceId(board, provider, account);
    this.db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?)').run(id, board, provider, account, now);
    this.changed(board);
    return id;
  }

  /** Removes a source of a board with everything measured for it; false if there is none. */
  removeSource(board: string, id: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = this.db.prepare('DELETE FROM sources WHERE id = ? AND board_id = ?').run(id, board).changes > 0;
      if (removed) {
        for (const table of ['state', 'samples', 'device_sources']) this.db.prepare(`DELETE FROM ${table} WHERE source_id = ?`).run(id);
      }
      this.db.exec('COMMIT');
      if (removed) this.changed(board);
      return removed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

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

  /** Stores a measurement: a sample per window and the new state of the source. */
  record(id: string, measurement: Measurement) {
    const {provider} = this.state(id);
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const w of measurement.windows) {
        insert.run(id, w.id, measurement.observedAt, w.kind, w.label, w.used, w.resetAt, w.minutes, measurement.staleAfterMs);
      }
      this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(id, JSON.stringify(state));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.changed(this.boardOf(id));
  }

  /** Records a failed attempt; the last good values stay on screen. */
  fail(id: string, error: string) {
    this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(id, JSON.stringify({...this.state(id), error}));
    this.changed(this.boardOf(id));
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

  /** Which sources each device of a board delivers to. */
  deviceSources(board: string): {device: string; provider: Provider; source: string; seenAt: number}[] {
    const rows = this.db
      .prepare('SELECT d.device_id, d.provider, d.source_id, d.seen_at FROM device_sources d JOIN sources s ON s.id = d.source_id WHERE s.board_id = ?')
      .all(board) as {device_id: string; provider: Provider; source_id: string; seen_at: number}[];
    return rows.map(r => ({device: r.device_id, provider: r.provider, source: r.source_id, seenAt: r.seen_at}));
  }

  /** The last failure a device reported for a provider, kept until it delivers for it again. */
  deviceFailed(device: string, provider: Provider, error: string, detail: string | null, at: number) {
    this.db.prepare('INSERT OR REPLACE INTO device_failures VALUES (?, ?, ?, ?, ?)').run(device, provider, error, detail, at);
  }

  deviceFailures(board: string): DeviceFailure[] {
    const rows = this.db
      .prepare('SELECT f.* FROM device_failures f JOIN devices d ON d.id = f.device_id WHERE d.board_id = ?')
      .all(board) as {device_id: string; provider: Provider; error: string; detail: string | null; at: number}[];
    return rows.map(r => ({device: r.device_id, provider: r.provider, error: r.error, detail: r.detail, at: r.at}));
  }

  /** Every source/window series since `from` on a shared grid, ready for the chart and the table. */
  history(board: string, from: number, cellMs: number): HistorySeries[] {
    const rows = this.db
      .prepare(
        'SELECT samples.*, sources.provider FROM samples JOIN sources ON sources.id = samples.source_id' +
          ' WHERE sources.board_id = ? AND samples.at >= ? ORDER BY samples.source_id, samples.window_id, samples.at',
      )
      .all(board, from) as SampleRow[];

    const groups = new Map<string, Sample[]>();
    for (const row of rows) {
      const key = `${row.source_id} ${row.window_id}`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = []));
      group.push({
        sourceId: row.source_id,
        provider: row.provider,
        id: row.window_id,
        kind: row.kind,
        label: row.label,
        at: row.at,
        used: row.used,
        remaining: 100 - row.used,
        resetAt: row.reset_at,
        minutes: row.minutes,
        staleAfterMs: row.stale_after_ms,
      });
    }

    // Series follow the cards: sources in board order, windows in the order the source reports them.
    const states = this.states(board);
    const rank = (sample: Sample) => {
      const source = states.findIndex(s => s.id === sample.sourceId);
      const window = states[source]?.windows.findIndex(w => w.id === sample.id) ?? -1;
      return (source < 0 ? states.length : source) * 100 + (window < 0 ? 99 : window);
    };

    return [...groups.values()]
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
          ...summary,
          points: onGrid(points, cellMs).map(p => [p.at, Math.round(p.remaining * 100) / 100, p.segment] as const),
        };
      });
  }

  /** Forgets samples older than the retention period. */
  prune(now: number) {
    this.db.prepare('DELETE FROM samples WHERE at < ?').run(now - config.retention.sampleDays * 86_400_000);
  }

  close() {
    this.db.close();
  }
}
