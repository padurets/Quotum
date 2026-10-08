import type {HistoryScope} from '../domain/history.js';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {config} from '../config.js';
import {providers, sourceId, type Provider, type Source} from '../domain/sources.js';
import type {Measurement, SourceState} from '../domain/quota.js';
import {cellsOf, workFrom, type CellSamples} from '../domain/cells.js';
import {tileOf, type Chunk, type HistoryMeta} from '../domain/history.js';
import type {MeasureIntervalMs} from '../domain/frequency.js';
import type {PlanChange, SeriesSample} from '../domain/forecast.js';
import type {Origin} from '../domain/ingest.js';
import type {Stretch} from '../domain/work.js';
import {members, projectGroups, type ProjectGroup} from '../domain/projects.js';
import {tell, type Touches} from '../touches.js';
import {migrate} from './schema.js';
import type {QuotaObservation, MeterMeasurement} from '../domain/meters.js';
import {MeterStore} from './meters.js';
import type {MeterSelection} from '../domain/meterHistory.js';
import {DEFAULT_CURRENCY} from '../domain/currency.js';
import {providerOf, quotaMeter, budgetMeter, supportsBudget} from '../domain/providers.js';
import {CurrencyStore} from './currencies.js';
import {importLegacyCurrencies} from './legacyCurrencies.js';

/** A session credited with work (server/sessions.ts): its names as reported, '' for none. */
export type WorkContext = {source: string; origin: Origin; startedAt: number; project: string; folder: string};
export type WorkKey = WorkContext & {identity: {kind: 'legacy'; ordinal: number} | {kind: 'stable'; sessionId: string}};

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
  readonly meters: MeterStore;
  readonly currencies:CurrencyStore;
  private monetaryRecords=new Set<(source:string)=>void>();
  private currencyChanges=new Set<(owner:string)=>void>();
  /** When this database was made. */
  private readonly created: number;
  private observer: Touches | null = null;
  private pruned = 0;

  constructor(file: string, now = Date.now()) {
    this.db = new DatabaseSync(file);
    migrate(this.db, now);
    this.currencies=new CurrencyStore(this.db);
    this.currencies.onChange=owner=>{if(owner){for(const listener of this.currencyChanges)listener(owner);tell(this.observer,o=>o.touchUser(owner));}};
    importLegacyCurrencies(this.db,this.currencies);
    this.meters = new MeterStore(this.db,this.currencies);
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
    const oldest = (this.db.prepare('SELECT min(at) AS at FROM (SELECT min(at) AS at FROM samples WHERE at>=? UNION ALL SELECT min(at) AS at FROM readings WHERE at>=?)').get(kept, kept) as {at: number | null}).at;
    return oldest === null ? this.created : Math.min(this.created, oldest);
  }

  /** Tells `observer` what every change touches (events of open dashboards). */
  setObserver(observer: Touches) {
    this.observer = observer;
  }
  onMonetaryRecord(listener:(source:string)=>void){this.monetaryRecords.add(listener);return()=>{this.monetaryRecords.delete(listener);};}
  onCurrencyChange(listener:(owner:string)=>void){this.currencyChanges.add(listener);return()=>{this.currencyChanges.delete(listener);};}
  currencyReaders(source:string):string[] {
    return (this.db.prepare('SELECT user_id FROM holders WHERE source_id=? UNION SELECT m.user_id FROM shares s JOIN members m ON m.board_id=s.board_id WHERE s.source_id=?').all(source,source) as {user_id:string}[]).map(r=>r.user_id).filter(user=>this.currencies.preference(user).id!==DEFAULT_CURRENCY);
  }
  currencyReaderChanged(owner:string){tell(this.observer,o=>o.touchUser(owner));}
  currencyChanged(source:string,since:number){tell(this.observer,o=>{o.touchSources([source]);o.history(source,since,['budget']);});}

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
    const key = JSON.stringify([this.agentWorkSince(), this.sources(board).map(s => s.id), [...shown].map(([id, s]) => [id, s.since, s.holders]), names.names]);
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
    this.db.prepare('INSERT INTO sources (id, provider, account, created_at) VALUES (?, ?, ?, ?)').run(id, provider, account, now);
    return id;
  }

  measureInterval(id: string): MeasureIntervalMs {
    const row = this.db.prepare('SELECT measure_interval_ms FROM sources WHERE id = ?').get(id) as {measure_interval_ms: MeasureIntervalMs} | undefined;
    return row?.measure_interval_ms ?? null;
  }

  /** Equal writes leave the current plan and events alone. */
  setMeasureInterval(id: string, intervalMs: MeasureIntervalMs): boolean {
    return this.db.prepare('UPDATE sources SET measure_interval_ms = ? WHERE id = ? AND measure_interval_ms IS NOT ?').run(intervalMs, id, intervalMs).changes > 0;
  }

  /** A person's device measures a source: it is theirs to see and share from now on. */
  hold(source: string, userId: string, now: number) {
    if (this.db.prepare('INSERT OR IGNORE INTO holders VALUES (?, ?, ?)').run(source, userId, now).changes) {
      // It comes to their personal board, and its owners change where it is shared.
      tell(this.observer, o => {
        o.touchBoards(this.boardsOf(source));
        o.touchUser(userId);
      });
    }
  }

  release(source:string,userId:string) {
    const boards=this.boardsOf(source);
    if(!this.db.prepare('DELETE FROM holders WHERE source_id=? AND user_id=?').run(source,userId).changes)return;
    for(const {board_id} of this.db.prepare('SELECT board_id FROM shares WHERE source_id=?').all(source) as {board_id:string}[])this.unshareOrphans(board_id);
    tell(this.observer,o=>{o.touchBoards(boards);o.touchUser(userId);});
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
      if(providerOf(this.state(source).provider)?.measuredBy==='hub')continue;
      const shown = this.observer ? this.boardsOf(source) : [];
      if (!this.db.prepare('DELETE FROM holders WHERE source_id = ? AND user_id = ?').run(source, userId).changes) continue;
      tell(this.observer, o => {
        o.touchBoards(shown);
        o.touchUser(userId);
      });
      const shared = this.db.prepare('SELECT board_id FROM shares WHERE source_id = ?').all(source) as {board_id: string}[];
      for (const {board_id: board} of shared) this.unshareOrphans(board);
    }
  }

  // ---------- sharing ----------

  share(board: string, source: string, userId: string, now: number) {
    if (this.db.prepare('INSERT OR IGNORE INTO shares VALUES (?, ?, ?, ?)').run(board, source, userId, now).changes) {
      tell(this.observer, o => o.touchBoards([board]));
    }
  }

  unshare(board: string, source: string): boolean {
    const removed = this.db.prepare('DELETE FROM shares WHERE board_id = ? AND source_id = ?').run(board, source).changes > 0;
    if (removed) {
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
      tell(this.observer, o => o.touchBoards([board]));
    }
  }

  /** Forgets what a deleted board showed; the sources stay with their people (Directory.deleteBoard does the rest). */
  removeBoard(board: string) {
    this.db.prepare('DELETE FROM shares WHERE board_id = ?').run(board);
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

  attentionCycle(source: string, window: string): number | null {
    const row = this.db.prepare('SELECT cycle FROM attention_windows WHERE source_id = ? AND window_id = ?').get(source, window) as {cycle: number} | undefined;
    return row?.cycle ?? null;
  }

  /**
   * Stores a measurement: a sample per window, the new state of the source, free resets
   * granted since the last one, and its plan when that is new. A savepoint keeps it whole
   * on its own and inside a batch's transaction alike.
   *
   * Besides free resets granted, `events` keeps a subscription's plan (kind `plan`,
   * detail: its name) from each moment it was reported otherwise, the first one included:
   * a forecast's history begins anew after a change (domain/forecast.ts, `planSince`).
   */
  quotaObservation(id:string,observation:QuotaObservation,measurement?:MeterMeasurement) {
    this.db.exec('SAVEPOINT quota_observation');
    let accepted=false,since=observation.observedAt;
    try {
      this.db.prepare('UPDATE state SET payload=payload WHERE source_id=?').run(id);
      const previous=this.state(id);
      if(observation.observedAt>(previous.quota?.observedAt??-Infinity)) {
        if(measurement&&(measurement.observedAt!==observation.observedAt||JSON.stringify(measurement.meters.map(m=>m.id).sort())!==JSON.stringify([...observation.receivedIds].sort())))throw new Error('invalid_quota_observation');
        if(!measurement&&observation.receivedIds.length)throw new Error('invalid_quota_observation');
        const result=this.meters.observeQuota(id,previous,observation);
        if(measurement)since=Math.min(since,this.meters.record(id,result.state,measurement).since??since);
        accepted=true;
      }
      this.db.exec('RELEASE quota_observation');
    }catch(error){this.db.exec('ROLLBACK TO quota_observation');this.db.exec('RELEASE quota_observation');throw error;}
    if(accepted)tell(this.observer,o=>{o.touchSources([id]);o.history(id,since,['quota']);});
    return accepted;
  }

  record(id: string, measurement: Measurement) {
    const previous = this.state(id);
    if ('meters' in measurement) {
      this.db.exec('SAVEPOINT record');
      let since: number|null;
      try {
        // A sparse heartbeat reads before it writes. Reserve the writer first so a
        // concurrent connection cannot invalidate that read snapshot in WAL mode.
        this.db.prepare('UPDATE state SET payload=payload WHERE source_id=?').run(id);
        const current=this.state(id);
        if(measurement.observedAt<=Math.max(current.successAt??-Infinity,current.balanceStatus?.at??-Infinity)) {this.db.exec('RELEASE record');return;}
        since = this.meters.record(id, current, measurement).since;
        this.db.exec('RELEASE record');
      } catch (error) {
        this.db.exec('ROLLBACK TO record');
        this.db.exec('RELEASE record');
        throw error;
      }
      tell(this.observer, o => o.touchSources([id]));
      if(since!==null)tell(this.observer, o => o.history(id, since!, [...new Set<HistoryScope>([...measurement.meters,...(previous.meters??[])].flatMap<HistoryScope>(m=>quotaMeter(providerOf(previous.provider),m.id)?['quota']:budgetMeter(providerOf(previous.provider),m.id)?['budget']:[]).concat(supportsBudget(providerOf(previous.provider))?['budget']:[]))]));
      for(const listener of this.monetaryRecords)listener(id);
      return;
    }
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
      // Measurements come in time order (only newer than the last are recorded), and so do the plans.
      if (measurement.plan !== '' && measurement.plan !== this.lastPlan(id)) {
        this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?)').run(id, measurement.observedAt, 'plan', measurement.plan);
      }
      this.db.exec('RELEASE record');
    } catch (error) {
      this.db.exec('ROLLBACK TO record');
      this.db.exec('RELEASE record');
      throw error;
    }
    tell(this.observer, o => o.touchSources([id]));
    tell(this.observer, o => o.history(id, measurement.observedAt, ['quota']));
  }

  /** Records a failed attempt; the last good values stay on screen. */
  fail(id: string, error: string) {
    this.db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(id, JSON.stringify({...this.state(id), error}));
    tell(this.observer, o => o.touchSources([id]));
  }

  /** Remembers which source a device last delivered for a provider; its failures for the provider are over. */
  seenDevice(device: string, provider: Provider, source: string, at: number) {
    const changed = this.deviceSource(device, provider) !== source;
    this.db.prepare('INSERT INTO device_sources (device_id,provider,source_id,seen_at) VALUES (?,?,?,?) ON CONFLICT(device_id,provider) DO UPDATE SET source_id=excluded.source_id,seen_at=excluded.seen_at').run(device, provider, source, at);
    this.db.prepare('DELETE FROM device_failures WHERE device_id = ? AND provider = ?').run(device, provider);
    if (changed) {
      const owner = this.db.prepare('SELECT user_id FROM devices WHERE id=?').get(device) as {user_id: string} | undefined;
      if (owner) tell(this.observer, o => o.touchUser(owner.user_id));
    }
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

  /** The board's known work thresholds, independent of the tiles read. */
  historyKnown(shown: Shown): HistoryMeta['known'] {
    return {work: this.agentWorkSince(), sources: Object.fromEntries([...shown].map(([id, value]) => [id, value.since]))};
  }

  /** Complete cells of every measured window, read once through a run of missing tiles. */
  cells(board: string, cellMs: number, from: number, to: number, {now = Date.now(), shown = this.shown(board, []), meters, scope}: {now?: number; shown?: Shown; meters?: MeterSelection; scope?: HistoryScope} = {}): Chunk<number>[] {
    const sources = this.sources(board);
    // Subscription caps accompany native windows; wallet selections retain their cheaper read.
    const withWindows=scope ? scope==='quota' : !meters||meters.ids.some(([id])=>sources.some(source=>source.id===id&&providerOf(source.provider)?.funding==='subscription'));
    if(scope==='budget') {
      const chunks=cellsOf([],[],{},cellMs,from,to,this.historyKnown(shown));
      if(meters) {
        const groups=this.meters.groups(meters,from,to).map(group=>({...group,retainedFrom:now-config.retention.sampleDays*86_400_000}));
        for(const chunk of chunks)chunk.meterSeries=this.meters.cells(meters,chunk.from,chunk.to,cellMs,groups);
      }
      return chunks;
    }
    // Skip through window names on the primary key; testing time inside the recursive
    // step would scan the source's whole retained history for every missing name.
    const windows = this.db.prepare(
      'WITH RECURSIVE windows(w) AS (SELECT min(window_id) FROM samples WHERE source_id = ?' +
      ' UNION ALL SELECT (SELECT min(window_id) FROM samples WHERE source_id = ? AND window_id > w) FROM windows WHERE w IS NOT NULL)' +
      ' SELECT w FROM windows WHERE w IS NOT NULL AND EXISTS (SELECT 1 FROM samples WHERE source_id = ? AND window_id = w AND at >= ? AND at < ?)',
    );
    const read = this.db.prepare(
      'SELECT at, used, reset_at, stale_after_ms FROM samples WHERE source_id = ? AND window_id = ? AND at < ? AND at >= ' +
      '(SELECT coalesce(max(at), ?) FROM samples WHERE source_id = ? AND window_id = ? AND at < ?) ORDER BY at',
    );
    read.setReturnArrays(true);
    const groups: CellSamples[] = [];
    for (const {id} of withWindows?sources:[]) for (const {w} of windows.all(id, id, id, from, to) as {w: string}[]) {
      const rows = read.all(id, w, to, from, id, w, from) as unknown as [number, number, number | null, number][];
      groups.push({source: id, window: w, samples: rows.map(([at, used, resetAt, staleAfterMs]) => ({at, used, resetAt, staleAfterMs}))});
    }
    const known = this.historyKnown(shown);
    const readFrom = workFrom(groups, from);
    const holders = new Map([...shown].map(([source, value]) => [source, new Map(value.holders.map(h => [h.user, Math.max(h.from, value.since, known.work)]))]));
    const stretches: Stretch[] = [];
    for (const s of shown.size ? this.agentWork(readFrom, Math.min(to, now), [...shown.keys()]) : []) {
      const after = holders.get(s.source)?.get(s.user);
      if (after === undefined || s.to <= after) continue;
      stretches.push(s.from < after ? {...s, from: after} : s);
    }
    const devices = Object.fromEntries((this.db.prepare('SELECT id, COALESCE(label, name) AS name FROM devices WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...new Set(stretches.map(s => s.device))])) as {id: string; name: string}[]).map(d => [d.id, d.name]));
    const chunks = cellsOf(groups, stretches, devices, cellMs, from, to, known);
    const grants = this.db.prepare("SELECT source_id, at, detail FROM events WHERE source_id IN (SELECT value FROM json_each(?)) AND kind = 'resets_granted' AND at >= ? AND at < ?")
      .all(JSON.stringify(sources.map(s => s.id)), from, to) as {source_id: string; at: number; detail: string}[];
    for (const event of grants) chunks[tileOf(event.at, cellMs) - tileOf(from, cellMs)].grants.push([event.source_id, event.at, Number(event.detail)]);
    if (meters) {
      const groups=this.meters.groups(meters,from,to).map(group=>({...group,retainedFrom:now-config.retention.sampleDays*86_400_000}));
      for (const chunk of chunks) chunk.meterSeries = this.meters.cells(meters,chunk.from,chunk.to,cellMs,groups);
    }
    return chunks;
  }

  private lastPlan(source: string): string | null {
    const row = this.db.prepare("SELECT detail FROM events WHERE source_id = ? AND kind = 'plan' ORDER BY at DESC LIMIT 1").get(source) as {detail: string} | undefined;
    return row?.detail ?? null;
  }

  /** The plans a subscription was reported with up to `upTo`, each from when it was new, oldest first. */
  planChanges(source: string, upTo: number): PlanChange[] {
    const rows = this.db.prepare("SELECT at, detail FROM events WHERE source_id = ? AND kind = 'plan' AND at <= ? ORDER BY at").all(source, upTo) as {at: number; detail: string}[];
    return rows.map(r => ({at: r.at, plan: r.detail}));
  }

  /**
   * A window's samples from `from` up to `to`, and the last one before `from`, oldest
   * first: what a forecast reads. Weeks of samples every two minutes are read as arrays,
   * a few times faster than as objects.
   */
  seriesSamples(source: string, window: string, from: number, to: number): SeriesSample[] {
    const read = this.db.prepare(
      'SELECT at, used, reset_at, minutes FROM samples WHERE source_id = ? AND window_id = ? AND at <= ? AND at >= ' +
        '(SELECT coalesce(max(at), ?) FROM samples WHERE source_id = ? AND window_id = ? AND at < ?) ORDER BY at',
    );
    read.setReturnArrays(true);
    const rows = read.all(source, window, to, from, source, window, from) as unknown as [number, number, number | null, number | null][];
    return rows.map(([at, used, resetAt, minutes]) => ({at, used, resetAt, minutes}));
  }

  /** Whether a window has a sample after `after` up to `upTo`. */
  sampled(source: string, window: string, after: number, upTo: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM samples WHERE source_id = ? AND window_id = ? AND at > ? AND at <= ? LIMIT 1').get(source, window, after, upTo);
  }

  /** A window's sample at `at` and the next one: when each was taken and how long it held. */
  sampleAndNext(source: string, window: string, at: number): {at: number; staleAfterMs: number}[] {
    const rows = this.db
      .prepare('SELECT at, stale_after_ms FROM samples WHERE source_id = ? AND window_id = ? AND at >= ? ORDER BY at LIMIT 2')
      .all(source, window, at) as {at: number; stale_after_ms: number}[];
    return rows.map(r => ({at: r.at, staleAfterMs: r.stale_after_ms}));
  }

  /** What was kept under `key` (server/forecasts.ts: a series' forecast memory), as JSON; null when nothing. */
  kept(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as {value: string} | undefined;
    return row?.value ?? null;
  }

  /** Keeps values under their keys, in one transaction. */
  keep(entries: [string, string][]) {
    const put = this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');
    this.db.exec('SAVEPOINT keep');
    try {
      for (const [key, value] of entries) put.run(key, value);
      this.db.exec('RELEASE keep');
    } catch (error) {
      this.db.exec('ROLLBACK TO keep');
      this.db.exec('RELEASE keep');
      throw error;
    }
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
      'INSERT INTO agent_sessions (device_id, source_id, origin, started_at, project, folder, ordinal, producer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    );
    const legacy = this.db.prepare(
      'SELECT id FROM agent_sessions WHERE device_id = ? AND source_id = ? AND started_at = ? AND origin = ? AND project = ? AND folder = ? AND ordinal = ? AND producer_id IS NULL',
    );
    const stable = this.db.prepare(
      'SELECT id FROM agent_sessions WHERE device_id = ? AND producer_id = ? AND source_id = ? AND origin = ? AND project = ? AND folder = ?',
    );
    // Each contextual row has non-overlapping stretches, so its last start ends latest.
    const latest = this.db.prepare('SELECT to_at AS at FROM agent_work WHERE session_id = ? ORDER BY from_at DESC LIMIT 1');
    const highWater = this.db.prepare(
      'SELECT max((SELECT to_at FROM agent_work WHERE session_id = s.id ORDER BY from_at DESC LIMIT 1)) AS at FROM agent_sessions s WHERE device_id = ? AND producer_id = ?',
    );
    const floors = this.db.prepare(
      'SELECT producer_id IS NULL AS legacy, max((SELECT to_at FROM agent_work WHERE session_id = s.id ORDER BY from_at DESC LIMIT 1)) AS at FROM agent_sessions s WHERE device_id = ? GROUP BY producer_id IS NULL',
    );
    const extend = this.db.prepare('UPDATE agent_work SET to_at = ? WHERE session_id = ? AND to_at = ?');
    const begin = this.db.prepare('INSERT INTO agent_work VALUES (?, ?, ?) ON CONFLICT (session_id, from_at) DO UPDATE SET to_at = max(to_at, excluded.to_at)');
    const credited = new Map<string, number>();
    this.db.exec('SAVEPOINT credit');
    try {
      // Snapshot before writes: mixed packets must not clip one namespace against the
      // other namespace's parallel credit from this same call.
      const opposite = new Map((floors.all(device) as {legacy: number; at: number | null}[]).map(row => [row.legacy, row.at ?? from]));
      for (const {source, origin, startedAt, project, folder, identity} of keys) {
        const producer = identity.kind === 'stable' ? identity.sessionId : null;
        const ordinal = identity.kind === 'legacy' ? identity.ordinal : 0;
        add.run(device, source, origin, startedAt, project, folder, ordinal, producer);
        const {id} = (producer === null
          ? legacy.get(device, source, startedAt, origin, project, folder, ordinal)
          : stable.get(device, producer, source, origin, project, folder)) as {id: number};
        const own = producer === null ? latest.get(id) : highWater.get(device, producer);
        const start = Math.max(from, (own as {at: number | null} | undefined)?.at ?? from, opposite.get(producer === null ? 0 : 1) ?? from);
        if (until <= start) continue;
        if (!extend.run(until, id, start).changes) begin.run(id, start, until);
        credited.set(source, Math.min(credited.get(source) ?? start, start));
      }
      this.db.exec('RELEASE credit');
    } catch (error) {
      this.db.exec('ROLLBACK TO credit');
      this.db.exec('RELEASE credit');
      throw error;
    }
    for (const [source, start] of credited) tell(this.observer, o => o.history(source, start, ['quota']));
  }

  /** Retained credit of an identified session on its current subscription; legacy identity is unknown. */
  worked(device: string, keys: WorkKey[]): (number | null)[] {
    if (!keys.length) return [];
    const read = this.db.prepare(
      'SELECT COALESCE(sum(w.to_at - w.from_at), 0) AS ms FROM agent_sessions s JOIN agent_work w ON w.session_id = s.id' +
        ' WHERE s.device_id = ? AND s.producer_id = ? AND s.source_id = ?',
    );
    return keys.map(({source, identity}) => identity.kind === 'legacy' ? null : (read.get(device, identity.sessionId, source) as {ms: number}).ms);
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

  /** Retention can remove the predecessor of a cell far beyond the retention edge. */
  get retentionRevision() {return this.pruned;}

  /**
   * Forgets samples, events, announcements, agents' work and forecasts' memory older than
   * the retention period; corrected project names stay until undone, and so does the plan
   * a subscription has while it has it.
   */
  prune(now: number) {
    this.db.prepare('DELETE FROM attention_windows WHERE source_id NOT IN (SELECT id FROM sources)').run();
    const cutoff = now - config.retention.sampleDays * 86_400_000;
    // Each successful deletion counts immediately: a later statement may fail.
    if (this.db.prepare('DELETE FROM samples WHERE at < ?').run(cutoff).changes) this.pruned++;
    if (this.meters.prune(cutoff)) this.pruned++;
    if (this.db.prepare('DELETE FROM agent_work WHERE to_at < ?').run(cutoff).changes) this.pruned++;
    // A session without work is not needed; one still running is made again when credited.
    this.db.prepare('DELETE FROM agent_sessions WHERE NOT EXISTS (SELECT 1 FROM agent_work WHERE session_id = agent_sessions.id)').run();
    if (this.db
      .prepare(
        "DELETE FROM events WHERE at < ? AND NOT (kind = 'plan' AND at = (SELECT max(at) FROM events e WHERE e.source_id = events.source_id AND e.kind = 'plan' AND e.at < ?))",
      )
      .run(cutoff, cutoff).changes) this.pruned++;
    this.db.prepare('DELETE FROM announcements WHERE at < ?').run(cutoff);
    // What a forecast kept is read as JSON: anything else is forgotten too.
    this.db
      .prepare("DELETE FROM meta WHERE key LIKE 'forecast:%' AND CASE WHEN json_valid(value) THEN coalesce(json_extract(value, '$.asOf') < ?, 1) ELSE 1 END")
      .run(cutoff);
  }

  close() {
    this.db.close();
  }
}
