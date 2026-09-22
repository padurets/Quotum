import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {config} from '../config.js';
import {DEFAULT_ACCOUNT, DEFAULT_BOARD, describeSource, hash, parseSourceId, providers, sourceId, type Provider, type Source} from '../domain/sources.js';
import {
  bucketize,
  kindOf,
  series,
  type Confidence,
  type Measurement,
  type Sample,
  type SourceState,
} from '../domain/quota.js';
import {migrate} from './schema.js';

export type Guard = {scope: string; confidence: Confidence};

export {DEFAULT_BOARD};

/** A provider's default account is listed before its other accounts. */
const accountOrder = (source: Source) => (source.accountKey === DEFAULT_ACCOUNT ? 0 : 1);

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

/**
 * All persistence in one place: measurements, per-source state, identity guards and
 * failed attempts. One writer, prepared statements, WAL.
 */
export class Store {
  readonly db: DatabaseSync;
  readonly collectionStart: number;

  /**
   * `legacyDefaults`: the built-in collector feeds the default board, so that board
   * always lists every provider's default source, even before its first measurement.
   */
  constructor(
    file: string,
    now = Date.now(),
    private readonly options: {legacyDefaults?: boolean} = {},
  ) {
    this.db = new DatabaseSync(file);
    migrate(this.db, now);
    this.collectionStart = Number((this.db.prepare('SELECT value FROM meta WHERE key = ?').get('collectionStart') as any).value);
  }

  /** The sources of a board, in provider order. */
  sources(board = DEFAULT_BOARD): Source[] {
    const rows = this.db.prepare('SELECT id FROM sources WHERE board_id = ?').all(board) as {id: string}[];
    const legacy = board === DEFAULT_BOARD && this.options.legacyDefaults ? providers.map(p => sourceId(p)) : [];
    const ids = new Set([...legacy, ...rows.map(r => r.id)]);
    return [...ids]
      .map(id => {
        const parsed = parseSourceId(id);
        return parsed ? describeSource(parsed.provider, parsed.accountKey) : null;
      })
      .filter((s): s is Source => s !== null)
      .sort((a, b) => providers.indexOf(a.provider) - providers.indexOf(b.provider) || accountOrder(a) - accountOrder(b) || a.accountKey.localeCompare(b.accountKey));
  }

  register(source: Source, now: number, board = DEFAULT_BOARD) {
    this.db
      .prepare('INSERT OR IGNORE INTO sources (id, provider, account_key, created_at, board_id) VALUES (?, ?, ?, ?, ?)')
      .run(source.id, source.provider, source.accountKey, now, board);
  }

  states(board = DEFAULT_BOARD): SourceState[] {
    return this.sources(board).map(source => this.stateOf(source));
  }

  state(id: string): SourceState {
    const parsed = parseSourceId(id)!;
    return this.stateOf(describeSource(parsed.provider, parsed.accountKey));
  }

  private stateOf(source: Source): SourceState {
    const row = this.db.prepare('SELECT payload FROM state WHERE source_id = ?').get(source.id) as {payload: string} | undefined;
    if (!row) {
      return {
        id: source.id,
        provider: source.provider,
        accountKey: source.accountKey,
        plan: '',
        confidence: 'unknown' as Confidence,
        scope: '',
        successAt: null,
        attemptAt: 0,
        error: 'waiting',
        windows: [],
      };
    }
    return {...(JSON.parse(row.payload) as SourceState), id: source.id, provider: source.provider, accountKey: source.accountKey};
  }

  /**
   * Which identity segment a measurement belongs to. A verified provider account wins;
   * otherwise unchanged credential metadata keeps the previous segment and any change
   * starts a new one, so two accounts never merge into one history.
   */
  scope(id: string, identity: string | null, signature: string | null): Guard {
    if (identity) return {scope: identity, confidence: 'provider'};
    if (!signature) return {scope: randomUUID(), confidence: 'unknown'};
    const row = this.db.prepare('SELECT * FROM guards WHERE source_id = ?').get(id) as {signature: string; scope: string} | undefined;
    if (row?.signature === signature) return {scope: row.scope, confidence: 'credential-boundary'};
    const scope = randomUUID();
    this.db.prepare('INSERT OR REPLACE INTO guards VALUES (?, ?, ?)').run(id, signature, scope);
    return {scope, confidence: 'credential-boundary'};
  }

  /** Stores a measurement; returns false when the source merely repeated itself. */
  record(id: string, measurement: Measurement, observedAt: number, guard: Guard): boolean {
    const previous = this.state(id);
    if (previous.scope === guard.scope && previous.successAt !== null && measurement.sourceAt <= previous.successAt) {
      this.fail(id, 'stale_source', observedAt);
      return false;
    }
    const parsed = parseSourceId(id)!;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Sources the built-in collector writes need no explicit registration.
      this.db
        .prepare('INSERT OR IGNORE INTO sources (id, provider, account_key, created_at, board_id) VALUES (?, ?, ?, ?, ?)')
        .run(id, parsed.provider, parsed.accountKey, observedAt, DEFAULT_BOARD);
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO samples' +
          ' (provider, scope, bucket, source_at, observed_at, label, used, reset_at, minutes, source_id, stale_after_ms)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const w of measurement.windows) {
        insert.run(
          parsed.provider, guard.scope, w.id, measurement.sourceAt, observedAt,
          w.label, w.used, w.resetAt, w.minutes, id, measurement.staleAfterMs ?? null,
        );
      }
      const state: SourceState = {
        id,
        provider: parsed.provider,
        accountKey: parsed.accountKey,
        plan: measurement.plan,
        ...guard,
        successAt: measurement.sourceAt,
        attemptAt: observedAt,
        error: null,
        windows: measurement.windows,
        staleAfterMs: measurement.staleAfterMs ?? null,
      };
      this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(id, JSON.stringify(state));
      this.db.prepare('INSERT INTO attempts (source_id, at, error) VALUES (?, ?, NULL)').run(id, observedAt);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Records a failed attempt; the last successful values stay on screen. */
  /**
   * The source a subscription account of a board is stored under, created on first
   * sight. On the default board the first account of a provider takes the provider's
   * default source when `useDefault` is set (no collector writes there), so existing
   * history and preferences carry on. Other ids are stable hashes of board and account.
   */
  agentSource(board: string, provider: Provider, account: string, useDefault: boolean, now: number): string {
    const row = this.db
      .prepare('SELECT source_id FROM agent_accounts WHERE board_id = ? AND provider = ? AND account = ?')
      .get(board, provider, account) as {source_id: string} | undefined;
    if (row) return row.source_id;
    const fallback = sourceId(provider);
    const taken = this.db.prepare('SELECT 1 FROM agent_accounts WHERE source_id = ?').get(fallback);
    const id = board === DEFAULT_BOARD && useDefault && !taken ? fallback : sourceId(provider, hash(`${board}\n${account}`).slice(0, 8));
    this.db.prepare('INSERT INTO agent_accounts VALUES (?, ?, ?, ?, ?)').run(board, provider, account, id, now);
    const parsed = parseSourceId(id)!;
    this.register(describeSource(parsed.provider, parsed.accountKey), now, board);
    return id;
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
    return (
      this.db
        .prepare(
          'SELECT d.device_id, d.provider, d.source_id, d.seen_at FROM device_sources d JOIN sources s ON s.id = d.source_id WHERE s.board_id = ?',
        )
        .all(board) as {device_id: string; provider: Provider; source_id: string; seen_at: number}[]
    ).map(r => ({device: r.device_id, provider: r.provider, source: r.source_id, seenAt: r.seen_at}));
  }

  fail(id: string, error: string, at: number) {
    const previous = this.state(id);
    this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(id, JSON.stringify({...previous, attemptAt: at, error}));
    this.db.prepare('INSERT INTO attempts (source_id, at, error) VALUES (?, ?, ?)').run(id, at, error);
  }

  /** Every source/window series since `from` on a shared grid, ready for the chart and the table. */
  history(board: string, from: number, bucketMs: number): HistorySeries[] {
    const rows = this.db
      .prepare(
        'SELECT samples.* FROM samples JOIN sources ON sources.id = samples.source_id' +
          ' WHERE sources.board_id = ? AND samples.source_at >= ? ORDER BY samples.source_id, samples.bucket, samples.source_at',
      )
      .all(board, from) as any[];

    const groups = new Map<string, Sample[]>();
    for (const row of rows) {
      const id = row.source_id || row.provider;
      const key = `${id} ${row.bucket}`;
      const group = groups.get(key) ?? [];
      if (!group.length) groups.set(key, group);
      group.push({
        sourceId: id,
        provider: row.provider,
        scope: row.scope,
        id: row.bucket,
        label: row.label,
        sourceAt: row.source_at,
        observedAt: row.observed_at,
        used: row.used,
        remaining: 100 - row.used,
        resetAt: row.reset_at,
        minutes: row.minutes,
        staleAfterMs: row.stale_after_ms,
      });
    }

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

  prune(now: number) {
    const cutoff = now - config.retention.sampleDays * 86_400_000;
    this.db.prepare('DELETE FROM samples WHERE source_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM attempts WHERE at < ?').run(cutoff);
  }

  close() {
    this.db.close();
  }
}
