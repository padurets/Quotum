import {DatabaseSync} from 'node:sqlite';
import {config} from '../config.js';
import {DEFAULT_BOARD, providers, sourceId, type Provider, type Source} from '../domain/sources.js';
import {bucketize, kindOf, series, type Measurement, type Sample, type SourceState} from '../domain/quota.js';
import {migrate} from './schema.js';

export {DEFAULT_BOARD};

export type HistorySeries = {
  sourceId: string;
  provider: Provider;
  bucket: string;
  label: string;
  minutes: number | null;
  kind: ReturnType<typeof kindOf>;
  consumed: number;
  coveredMs: number;
  samples: number;
  points: (readonly [number, number, number])[];
};

type SampleRow = {
  source_id: string;
  provider: Provider;
  bucket: string;
  at: number;
  label: string;
  used: number;
  reset_at: number | null;
  minutes: number | null;
  stale_after_ms: number | null;
};

/**
 * Sources, their last state and every measured value, in one SQLite file (WAL, one
 * writer, prepared statements). People and devices live in the same file, see
 * directory.ts.
 */
export class Store {
  readonly db: DatabaseSync;
  readonly collectionStart: number;
  /** Changes whenever something the dashboard shows changes; history is cached by it. */
  revision = Date.now();

  constructor(file: string, now = Date.now()) {
    this.db = new DatabaseSync(file);
    migrate(this.db, now);
    this.collectionStart = Number((this.db.prepare('SELECT value FROM meta WHERE key = ?').get('collectionStart') as {value: string}).value);
  }

  /** The sources of a board: by provider, then in the order they appeared. */
  sources(board: string): Source[] {
    const rows = this.db.prepare('SELECT id, provider, account FROM sources WHERE board_id = ? ORDER BY created_at, rowid').all(board) as Source[];
    return rows.filter(s => providers.includes(s.provider)).sort((a, b) => providers.indexOf(a.provider) - providers.indexOf(b.provider));
  }

  /** The source of a subscription on a board, created the first time it is seen. */
  source(board: string, provider: Provider, account: string, now: number): string {
    const row = this.db.prepare('SELECT id FROM sources WHERE board_id = ? AND provider = ? AND account = ?').get(board, provider, account) as
      | {id: string}
      | undefined;
    if (row) return row.id;
    const id = sourceId(board, provider, account);
    this.db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?)').run(id, board, provider, account, now);
    this.revision++;
    return id;
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
    if (!row) return {id, provider, plan: '', successAt: null, attemptAt: 0, error: 'waiting', windows: []};
    return {...(JSON.parse(row.payload) as SourceState), id, provider};
  }

  /** Stores a measurement: a sample per window and the new state of the source. */
  record(id: string, measurement: Measurement) {
    const {provider} = this.state(id);
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO samples (source_id, bucket, at, label, used, reset_at, minutes, stale_after_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const state: SourceState = {
      id,
      provider,
      plan: measurement.plan,
      successAt: measurement.sourceAt,
      attemptAt: measurement.sourceAt,
      error: null,
      windows: measurement.windows,
      staleAfterMs: measurement.staleAfterMs ?? null,
      resets: measurement.resets ?? null,
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const w of measurement.windows) {
        insert.run(id, w.id, measurement.sourceAt, w.label, w.used, w.resetAt, w.minutes, measurement.staleAfterMs ?? null);
      }
      this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(id, JSON.stringify(state));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.revision++;
  }

  /** Records a failed attempt; the last good values stay on screen. */
  fail(id: string, error: string, at: number) {
    const previous = this.state(id);
    this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(id, JSON.stringify({...previous, attemptAt: at, error}));
    this.revision++;
  }

  /** Remembers which source a device last delivered for a provider (its failures go there). */
  seenDevice(device: string, provider: Provider, source: string, at: number) {
    this.db.prepare('INSERT OR REPLACE INTO device_sources VALUES (?, ?, ?, ?)').run(device, provider, source, at);
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

  /** Every source/window series since `from` on a shared grid, ready for the chart and the table. */
  history(board: string, from: number, bucketMs: number): HistorySeries[] {
    const rows = this.db
      .prepare(
        'SELECT samples.*, sources.provider FROM samples JOIN sources ON sources.id = samples.source_id' +
          ' WHERE sources.board_id = ? AND samples.at >= ? ORDER BY samples.source_id, samples.bucket, samples.at',
      )
      .all(board, from) as SampleRow[];

    const groups = new Map<string, Sample[]>();
    for (const row of rows) {
      const key = `${row.source_id} ${row.bucket}`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = []));
      group.push({
        sourceId: row.source_id,
        provider: row.provider,
        id: row.bucket,
        label: row.label,
        sourceAt: row.at,
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
          bucket: last.id,
          label: last.label,
          minutes: last.minutes,
          kind: kindOf(last.minutes, last.label),
          ...summary,
          points: bucketize(points, bucketMs).map(p => [p.at, Math.round(p.remaining * 100) / 100, p.segment] as const),
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
