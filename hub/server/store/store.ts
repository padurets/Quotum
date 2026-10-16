import {mergeEvidence, type SessionEvidence} from '../domain/sessionEvidence.js';
import type {HistoryScope} from '../domain/history.js';
import {createHash, randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {config} from '../config.js';
import {providers, sourceId, type Provider, type Source} from '../domain/sources.js';
import {deliveryOf, type Measurement, type SourceState} from '../domain/quota.js';
import {cellsOf, workFrom, type CellSamples} from '../domain/cells.js';
import {tileOf,planRowBytes, type PlanRow, type Chunk, type HistoryMeta} from '../domain/history.js';
import type {MeasureIntervalMs} from '../domain/frequency.js';
import type {PlanChange, SeriesSample} from '../domain/forecast.js';
import type {AgentSnapshot, Origin, SessionRoute} from '../domain/ingest.js';
import type {Stretch} from '../domain/work.js';
import {members, projectGroups, type ProjectGroup} from '../domain/projects.js';
import {afterCommit, transaction, tell, trouble, type Touches} from '../touches.js';
import {bootstrapAttentionCycles, nextAttentionCycle} from './attention.js';
import {migrate} from './schema.js';
import type {QuotaObservation, MeterMeasurement} from '../domain/meters.js';
import {MeterStore} from './meters.js';
import type {MeterSelection} from '../domain/meterHistory.js';
import {DEFAULT_CURRENCY} from '../domain/currency.js';
import {providerOf,quotaMeter,supportsBudget,supportsQuota,sourceCounterOf} from '../domain/providers.js';
import {packMoneyWork,sourceWorkEligible} from '../domain/moneyWork.js';
import {budgetAccess, type BudgetAccess} from '../domain/resources.js';
import {exactDecimal} from '../domain/amount.js';
import {CurrencyStore} from './currencies.js';
import {importLegacyCurrencies} from './legacyCurrencies.js';
import {LinkStore} from './links.js';
import {CoverageStore} from './coverage.js';
import {UsageWithoutWork} from '../usageWork.js';
import {resolveLink, splitLinks, type AttributionInput, type Attribution} from '../domain/links.js';

import {MeasurementPolicies} from './measurementPolicies.js';
import {admitted,fundingOf,sessionsKnownFrom,sourceWorkFrom,workFundingKey,type WorkAccess} from '../domain/workAccess.js';

/** A session credited with work (server/sessions.ts): its names as reported, '' for none. */
export type WorkContext = SessionEvidence & {client?: string; source: string | null; origin: Origin; startedAt: number; project: string; folder: string};
export type WorkKey = WorkContext & {identity: {kind: 'legacy'; ordinal: number} | {kind: 'stable'; sessionId: string}};

/**
 * Whose work a board shows on each of its subscriptions but those of hidden cards: the
 * people on the board who hold it, each from when (`from`), and since when the
 * subscription is on the board (`since`). A shared board shows a holder's work from the
 * later of their joining it and the subscription coming to it; a personal board shows all
 * of it.
 */
export type Shown = Map<string, {since: number; holders: {user: string; from: number}[]}>;
export type WorkRead = ((from: number, to: number) => Stretch[]) & {access?:WorkAccess;authority?:string;reserve?:(bytes:number)=>void;release?:(bytes:number)=>void;ensureAccess?:()=>WorkAccess};
export type SessionDevice = {id:string;name:string;disconnected:boolean;enabled:boolean;since:number|null;revision:string};

/** Settings, admission and funding use the same connected or retained device inventory. */
const sessionDeviceWhere='(d.revoked_at IS NULL OR EXISTS(SELECT 1 FROM agent_sessions s JOIN agent_work w ON w.session_id=s.id WHERE s.device_id=d.id))';

export type DeviceFailure = {device: string; provider: Provider; error: string; detail: string | null; at: number};

/** A reset for everyone as a community tracker reported it. */
export type Announcement = {at: number; url: string; text: string};

/** A source as a board shows it: with the people who measure it and whether they shared it here. */
export type BoardSource = Source & {holders: string[]; sharedBy: string | null; budget?: BudgetAccess};

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
  readonly links: LinkStore;
  readonly coverage: CoverageStore;
  readonly usageWork: UsageWithoutWork;
  private workGeneration=0;
  workRevision():number {return this.workGeneration;}

  readonly measurementPolicies: MeasurementPolicies;
  private monetaryRecords=new Set<(source:string,state:SourceState)=>void>();
  private currencyChanges=new Set<(owner:string)=>void>();
  /** When this database was made. */
  private readonly created: number;
  private observer: Touches | null = null;
  private currentFunding:(device:string,owner:string,source:string,now:number)=>boolean=()=>false;
  private pruned = 0;
  private readonly attentionCyclesReady: boolean;

  constructor(file: string, now = Date.now()) {
    this.db = new DatabaseSync(file);
    migrate(this.db, now);
    this.measurementPolicies = new MeasurementPolicies(this.db);
    this.attentionCyclesReady = bootstrapAttentionCycles(this.db);
    if (!this.attentionCyclesReady) trouble(new Error('invalid_attention_cycle'));
    this.links = new LinkStore(this.db);
    this.coverage = new CoverageStore(this.db);
    this.usageWork = new UsageWithoutWork(this);
    this.links.onChange = owner => {
      const sources = this.held(owner).map(s => s.id);
      tell(this.observer, o => {
        o.touchSources(sources);
        o.touchBoards([...new Set(sources.flatMap(source => this.boardsOf(source)))]);
        o.touchUser(owner); o.touchClientSessions?.(owner); o.clientHistory?.(owner, 0);
      });
    };
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
    const oldest = (this.db.prepare('SELECT min(at) AS at FROM (SELECT min(at) AS at FROM samples WHERE at>=? UNION ALL SELECT min(at) AS at FROM readings WHERE pair_anchor=0 AND at>=?)').get(kept, kept) as {at: number | null}).at;
    return oldest === null ? this.created : Math.min(this.created, oldest);
  }

  /** Tells `observer` what every change touches (events of open dashboards). */
  setObserver(observer: Touches) {
    this.observer = observer;
  }
  /** Current source facts stay in the session service; no second roster is retained. */
  setCurrentFunding(read:Store['currentFunding']){this.currentFunding=read;}

  private fundingBoards(source:string,user?:string,board?:string):string[]{
    const found=new Set<string>(),now=Date.now(),known=Math.max(this.agentWorkSince(),Number(this.db.prepare("SELECT value FROM meta WHERE key='workRetentionFrom'").get()?.value??0));
    const quota=supportsQuota(providerOf(source.split(':')[0]));
    const captured=this.db.prepare('SELECT 1 FROM agent_sessions s JOIN devices d ON d.id=s.device_id WHERE s.device_id=? AND (s.source_id=? OR EXISTS(SELECT 1 FROM client_links l WHERE l.user_id=d.user_id AND l.client=s.client AND (l.device_id IS NULL OR l.device_id=s.device_id) AND l.source_id=?)) AND EXISTS(SELECT 1 FROM agent_work w WHERE w.session_id=s.id AND w.to_at>?) LIMIT 1');
    const provided=this.db.prepare('SELECT 1 FROM shares WHERE board_id=? AND source_id=?');
    const rows=this.db.prepare('SELECT b.id,b.personal,d.id AS device,d.user_id,m.joined_at,p.enabled_since,p.revision FROM boards b JOIN members m ON m.board_id=b.id JOIN devices d ON d.user_id=m.user_id LEFT JOIN board_device_sessions p ON p.board_id=b.id AND p.device_id=d.id WHERE '+sessionDeviceWhere+' AND (? IS NULL OR m.user_id=?) AND (? IS NULL OR b.id=?)').iterate(user??null,user??null,board??null,board??null);
    for(const row of rows){
      const id=String(row.id);if(found.has(id)||!row.personal&&row.revision!==null&&row.enabled_since===null)continue;
      const owner=String(row.user_id);if(user===undefined&&!this.holds(owner,source))continue;
      const from=row.personal?known:Math.max(known,Number(row.joined_at),row.revision===null?0:Number(row.enabled_since));
      if(quota&&(row.personal||board!==undefined||provided.get(id,source))||captured.get(String(row.device),source,source,from)||this.currentFunding(String(row.device),owner,source,now))found.add(id);
    }
    return [...found];
  }
  private fundingChanged(boards:readonly string[]){
    const write=this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for(const board of boards)write.run(workFundingKey(board),randomBytes(16).toString('hex'));
  }
  onMonetaryRecord(listener:(source:string,state:SourceState)=>void){this.monetaryRecords.add(listener);return()=>{this.monetaryRecords.delete(listener);};}
  onCurrencyChange(listener:(owner:string)=>void){this.currencyChanges.add(listener);return()=>{this.currencyChanges.delete(listener);};}
  currencyReaders(source:string):string[] {
    return (this.db.prepare('SELECT user_id FROM holders WHERE source_id=? UNION SELECT m.user_id FROM shares s JOIN members m ON m.board_id=s.board_id WHERE s.source_id=? AND (s.budget_since IS NOT NULL)').all(source,source) as {user_id:string}[]).map(r=>r.user_id).filter(user=>this.state(source).provider==='codex'||this.currencies.preference(user).id!==DEFAULT_CURRENCY);
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
            .prepare("SELECT s.id, s.provider, s.account, NULL AS shared_by, NULL AS budget_since, NULL AS budget_anchor_at, '' AS budget_revision FROM holders h JOIN sources s ON s.id = h.source_id WHERE h.user_id = ? ORDER BY h.since, s.rowid")
            .all(kind.created_by)
        : this.db
            .prepare('SELECT s.id, s.provider, s.account, sh.shared_by, sh.budget_since, sh.budget_anchor_at, sh.budget_revision FROM shares sh JOIN sources s ON s.id = sh.source_id WHERE sh.board_id = ? ORDER BY sh.shared_at, s.rowid')
            .all(board)
    ) as {id: string; provider: Provider; account: string; shared_by: string | null;budget_since:number|null;budget_anchor_at:number|null;budget_revision:string}[];
    const holders = this.db.prepare('SELECT user_id FROM holders WHERE source_id = ? ORDER BY since, user_id');
    return rows
      .map(r => ({
        id: r.id,
        provider: r.provider,
        account: r.account,
        sharedBy: r.shared_by,
        budget: budgetAccess(r.provider,!!kind.personal,r),
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
   * Work continuity follows device admission, funding disclosure and retained names.
   * Card visibility and financial policy have their own resource authority.
   */
  workKey(board: string, _shown?: Shown, access=this.workAccess(board),reserve?:(bytes:number)=>void,release?:(bytes:number)=>void): string {
    const scratch=512+access.devices.size*512+access.sources.size*256+[...access.sources.values()].reduce((sum,source)=>sum+source.holders.size*128,0);
    reserve?.(scratch);
    try{
    const ids=[...access.devices.keys()];
    const names=this.db.prepare('SELECT user_id,reported,name FROM project_names n WHERE n.user_id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM devices d WHERE d.id IN (SELECT value FROM json_each(?)) AND d.user_id=n.user_id AND EXISTS(SELECT 1 FROM agent_sessions s WHERE s.device_id=d.id AND s.project=n.reported)) ORDER BY user_id,reported').iterate(JSON.stringify([...new Set([...access.devices.values()].map(device=>device.owner))]),JSON.stringify(ids));
    const devices=this.db.prepare('SELECT id,COALESCE(label,name) AS name FROM devices WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').iterate(JSON.stringify(ids));
    const coverage=[...access.sources].filter(([id,s])=>s.holders.size>0&&supportsQuota(providerOf(id.split(':')[0]))).map(([id,s])=>[id,s.since,[...s.holders].sort()]);
    const hash=createHash('sha256').update(JSON.stringify([access.knownFrom,[...access.devices],access.fundingRevision??'',access.attributionRevision??'',coverage]).slice(0,-1));
    // Names cover retained work beyond this read's range. Hash the same JSON a row
    // at a time, with room for escaping, instead of retaining the whole collection.
    for(const rows of [names,devices]){
      hash.update(',[');let first=true;
      for(const row of rows){
        const bytes=512+Object.values(row).reduce<number>((sum,value)=>sum+(typeof value==='string'?value.length*24:32),0);
        reserve?.(bytes);
        try{if(!first)hash.update(',');hash.update(JSON.stringify(row));first=false;}
        finally{release?.(bytes);}
      }
      hash.update(']');
    }
    return hash.update(']').digest('base64url').slice(0,16);
    }finally{release?.(scratch);}
  }

  privateOwner(board: string): string | null {
    const row = this.db.prepare('SELECT created_by AS owner FROM boards WHERE id=? AND personal=1').get(board) as {owner: string} | undefined;
    return row?.owner ?? null;
  }

  /** Sparse policies inherit ON from membership; saved OFF survives reconnection. */
  sessionDevices(board:string,user:string):SessionDevice[] {
    const member=this.db.prepare('SELECT m.joined_at FROM members m JOIN boards b ON b.id=m.board_id WHERE m.board_id=? AND m.user_id=? AND b.personal=0').get(board,user);
    if(!member)return [];
    const rows=this.db.prepare('SELECT d.id,COALESCE(d.label,d.name) AS name,d.revoked_at,p.enabled_since,p.revision FROM devices d LEFT JOIN board_device_sessions p ON p.board_id=? AND p.device_id=d.id WHERE d.user_id=? AND '+sessionDeviceWhere+' ORDER BY d.last_seen_at DESC,d.id').all(board,user);
    return rows.map(r=>{const since=r.revision===null?Number(member.joined_at):r.enabled_since===null?null:Math.max(Number(member.joined_at),Number(r.enabled_since));return {id:String(r.id),name:String(r.name),disconnected:r.revoked_at!==null,enabled:since!==null,since,revision:r.revision===null?this.defaultSessionRevision(board,String(r.id),user,Number(member.joined_at)):String(r.revision)};});
  }

  private defaultSessionRevision(board:string,device:string,owner:string,joined:number) {
    return createHash('sha256').update(JSON.stringify(['device-sessions-default-on',board,device,owner,joined])).digest('hex').slice(0,32);
  }

  setDeviceSessions(board:string,device:string,user:string,enabled:boolean,revision:string,now:number):SessionDevice {
    return transaction(this.db,()=>{
      const policy=this.sessionDevices(board,user).find(d=>d.id===device);
      if(!policy)throw new Error('not_found');
      if(policy.revision!==revision)throw new Error('share_conflict');
      if(policy.enabled===enabled)return policy;
      const next={...policy,enabled,since:enabled?now:null,revision:randomBytes(16).toString('hex')};
      this.db.prepare('INSERT INTO board_device_sessions VALUES (?,?,?,?) ON CONFLICT(board_id,device_id) DO UPDATE SET enabled_since=excluded.enabled_since,revision=excluded.revision').run(board,device,next.since,next.revision);
      this.db.prepare('INSERT INTO account_revisions(user_id,revision) VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1').run(user);
      tell(this.observer,o=>{o.touchBoards([board]);o.touchUser(user);});
      return next;
    });
  }

  /** One immutable snapshot supplies every session projection in a read. */
  workAccess(board:string,_now=Date.now(),reserve?:(bytes:number)=>void):WorkAccess {
    const owner=this.privateOwner(board),knownFrom=Math.max(this.agentWorkSince(),Number(this.db.prepare("SELECT value FROM meta WHERE key='workRetentionFrom'").get()?.value??0));
    const devices=new Map<string,{owner:string;from:number;revision:string}>();
    reserve?.(512);
    const rows=this.db.prepare('SELECT d.id,d.user_id,m.joined_at,p.enabled_since,p.revision FROM members m JOIN devices d ON d.user_id=m.user_id LEFT JOIN board_device_sessions p ON p.board_id=m.board_id AND p.device_id=d.id WHERE m.board_id=? AND '+sessionDeviceWhere+' ORDER BY d.id').iterate(board);
    for(const r of rows)if(owner!==null||r.revision===null||r.enabled_since!==null){reserve?.(512);const user=String(r.user_id),id=String(r.id),joined=Number(r.joined_at);devices.set(id,{owner:user,from:owner!==null?knownFrom:Math.max(knownFrom,joined,r.revision===null?joined:Number(r.enabled_since)),revision:owner!==null?'personal':r.revision===null?this.defaultSessionRevision(board,id,user,joined):String(r.revision)});}
    const holders=new Map<string,ReadonlySet<string>>();
    for(const user of new Set([...devices.values()].map(d=>d.owner))){const sources=new Set<string>();reserve?.(128);for(const row of this.db.prepare('SELECT source_id FROM holders WHERE user_id=?').iterate(user)){reserve?.(128);sources.add(String(row.source_id));}holders.set(user,sources);}
    const sources=new Map<string,{since:number;holders:Set<string>}>();
    reserve?.(128*holders.size);
    const admittedOwners=JSON.stringify([...holders.keys()]);
    const provided=owner!==null?this.db.prepare('SELECT selected.source_id,0 AS since,h.user_id FROM holders selected LEFT JOIN holders h ON h.source_id=selected.source_id AND h.user_id IN (SELECT value FROM json_each(?)) WHERE selected.user_id=? ORDER BY selected.source_id,h.user_id').iterate(admittedOwners,owner):this.db.prepare('SELECT s.source_id,s.shared_at AS since,h.user_id FROM shares s LEFT JOIN holders h ON h.source_id=s.source_id AND h.user_id IN (SELECT value FROM json_each(?)) WHERE s.board_id=? ORDER BY s.source_id,h.user_id').iterate(admittedOwners,board);
    for(const row of provided){const id=String(row.source_id);let source=sources.get(id);if(!source){reserve?.(256+id.length*2);sources.set(id,source={since:Number(row.since),holders:new Set()});}if(row.user_id!==null){reserve?.(128);source.holders.add(String(row.user_id));}}
    const fundingRevision=String(this.db.prepare('SELECT value FROM meta WHERE key=?').get(workFundingKey(board))?.value??'');
    const attribution=this.links.batch([...holders.keys()],reserve,_now);
    return {owner,knownFrom,devices,holdings:holders,sources,fundingRevision,attribution,attributionRevision:attribution.revision};
  }

  displaySource(owner: string, source: string | null): string | null {
    return source !== null && this.holds(owner, source) ? source : null;
  }

  clientSessionsChanged(user:string,device?:string) {tell(this.observer,o=>o.touchClientSessions?.(user,device));}

  resolveSessions(owner: string, device: string, keys: WorkKey[], now: number, captured?:ReturnType<LinkStore['batch']>): Attribution[] {
    const context = captured??this.links.batch([owner]);
    return keys.map(key => {
      const clientId = key.client ?? key.source?.split(':')[0] ?? 'unknown';
      return resolveLink({...key, clientId, deviceId: device}, context(owner, device, clientId), now);
    });
  }

  /** An idle report can strengthen an existing context without crediting any work. */
  observeWork(device: string, keys: WorkKey[]): WorkKey[] {
    const read = this.db.prepare("SELECT id,account_by AS accountBy,route_class AS class,route_by AS by,route_host AS host,route_provider AS provider FROM agent_sessions WHERE device_id=? AND client=? AND COALESCE(source_id,'')=COALESCE(?,'') AND source_id IS ? AND origin=? AND project=? AND folder=? AND ((producer_id IS ? AND producer_id IS NOT NULL) OR (producer_id IS NULL AND ? IS NULL AND started_at=? AND ordinal=?))");
    const save = this.db.prepare('UPDATE agent_sessions SET account_by=?,route_class=?,route_by=?,route_host=?,route_provider=? WHERE id=?');
    let changed = false;
    const result = keys.map(key => {
      const producer = key.identity.kind === 'stable' ? key.identity.sessionId : null;
      const row = read.get(device, key.client ?? key.source?.split(':')[0] ?? 'unknown', key.source, key.source, key.origin, key.project, key.folder, producer, producer, key.startedAt, key.identity.kind === 'legacy' ? key.identity.ordinal : 0) as {id: number; accountBy: SessionEvidence['accountBy']; class: SessionRoute['class']; by: SessionRoute['by'] | null; host: string | null; provider: string | null} | undefined;
      if (!row) return key;
      const before = {accountBy: row.accountBy, route: row.by ? {class: row.class, by: row.by, host: row.host, provider: row.provider} : null};
      const merged = mergeEvidence(before, key);
      if (JSON.stringify(before) !== JSON.stringify(merged)) {save.run(merged.accountBy, merged.route?.class ?? null, merged.route?.by ?? null, merged.route?.host ?? null, merged.route?.provider ?? null, row.id); changed = true;}
      return {...key, ...merged};
    });
    if (changed) {
      const owner = String(this.db.prepare('SELECT user_id FROM devices WHERE id=?').get(device)?.user_id ?? '');
      this.db.prepare("INSERT INTO meta VALUES (?,'1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run('workEvidence:' + owner);

      tell(this.observer, o => {o.touchClientSessions?.(owner); o.clientHistory?.(owner, 0); o.touchSources([...this.links.held(owner).keys()]);});
    }
    return result;
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
    return transaction(this.db,()=>{
    if (this.db.prepare('INSERT OR IGNORE INTO holders VALUES (?, ?, ?)').run(source, userId, now).changes) {

      this.fundingChanged(this.fundingBoards(source,userId));
      // It comes to their personal board, and its owners change where it is shared.
      tell(this.observer, o => {
        o.touchBoards(this.boardsOf(source));
        o.touchUser(userId);
        o.touchClientSessions?.(userId);
      });
    }
    });
  }

  release(source:string,userId:string) {
    return transaction(this.db,()=>{
    const boards=this.boardsOf(source);
    if(!this.db.prepare('DELETE FROM holders WHERE source_id=? AND user_id=?').run(source,userId).changes)return;

    this.fundingChanged(this.fundingBoards(source,userId));
    for(const {board_id} of this.db.prepare('SELECT board_id FROM shares WHERE source_id=?').all(source) as {board_id:string}[])this.unshareOrphans(board_id);
    tell(this.observer,o=>{o.touchBoards(boards);o.touchUser(userId);o.touchClientSessions?.(userId);});
    });
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
      this.release(source,userId);
    }
  }

  // ---------- sharing ----------

  share(board: string, source: string, userId: string, now: number, includeBudget = false) {
    return transaction(this.db,()=>{
    const provider = this.state(source).provider, wallet = provider === 'openrouter' || provider === 'deepseek';
    const since = wallet ? 0 : provider === 'codex' && includeBudget ? now : null;
    if (this.db.prepare('INSERT OR IGNORE INTO shares (board_id,source_id,shared_by,shared_at,budget_since,budget_anchor_at,budget_revision) VALUES (?,?,?,?,?,?,?)').run(board,source,userId,now,since,wallet?0:null,randomBytes(16).toString('hex')).changes) {
      this.fundingChanged(this.fundingBoards(source,undefined,board));
      tell(this.observer, o => o.touchBoards([board]));
    }
    });
  }

  setBudget(board:string,source:string,user:string,enabled:boolean,revision:string,now:number) {
    return transaction(this.db,()=>{
      if (!this.holds(user,source) || !this.db.prepare('SELECT 1 FROM members WHERE board_id=? AND user_id=?').get(board,user)) throw new Error('not_found');
      if (this.state(source).provider !== 'codex') throw new Error('invalid_request');
      const row=this.db.prepare('SELECT budget_since,budget_anchor_at,budget_revision FROM shares WHERE board_id=? AND source_id=?').get(board,source) as {budget_since:number|null;budget_anchor_at:number|null;budget_revision:string}|undefined;
      if(!row)throw new Error('not_found');
      if(row.budget_revision!==revision)throw new Error('share_conflict');
      if((row.budget_since!==null)===enabled)return budgetAccess('codex',false,row);
      const next={budget_since:enabled?now:null,budget_anchor_at:null,budget_revision:randomBytes(16).toString('hex')};
      this.db.prepare('UPDATE shares SET budget_since=?,budget_anchor_at=NULL,budget_revision=? WHERE board_id=? AND source_id=?').run(next.budget_since,next.budget_revision,board,source);
      tell(this.observer,o=>o.touchBoards([board]));
      return budgetAccess('codex',false,next);
    });
  }

  financialKey(board:string) {return JSON.stringify(this.sources(board).filter(s=>s.provider==='codex').map(s=>[s.id,s.budget]));}

  unshare(board: string, source: string): boolean {
    return transaction(this.db,()=>{
    const affected=this.fundingBoards(source,undefined,board);
    const removed = this.db.prepare('DELETE FROM shares WHERE board_id = ? AND source_id = ?').run(board, source).changes > 0;
    if (removed) {
      this.fundingChanged(affected);
      tell(this.observer, o => o.touchBoards([board]));
    }
    return removed;
    });
  }

  /** Takes off a board what none of its remaining members holds: someone who left takes their data along. */
  unshareOrphans(board: string) {
    return transaction(this.db,()=>{
      const rows=this.db.prepare('SELECT source_id FROM shares WHERE board_id=? AND source_id NOT IN (SELECT h.source_id FROM holders h JOIN members m ON m.user_id=h.user_id WHERE m.board_id=?)').iterate(board,board);
      for(const row of rows)this.unshare(board,String(row.source_id));
    });
  }

  /** Forgets what a deleted board showed; the sources stay with their people (Directory.deleteBoard does the rest). */
  removeBoard(board: string) {
    this.db.prepare('DELETE FROM shares WHERE board_id = ?').run(board);
    this.db.prepare('DELETE FROM meta WHERE key=?').run(workFundingKey(board));
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

  newAttentionCycle(): number {
    if (!this.attentionCyclesReady) throw new Error('invalid_attention_cycle');
    return nextAttentionCycle(this.db);
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
    return transaction(this.db, () => {
      // Reserve the writer before a sparse heartbeat reads its previous state.
      this.db.prepare('UPDATE state SET payload=payload WHERE source_id=?').run(id);
      const previous = this.state(id);
      const result = {accepted:false, windows:false, unavailable:false, resets:false, budget:false, delivery:false};
      const at = measurement.observedAt, ttl = measurement.staleAfterMs;
      let state = previous, quotaSince: number | null = null, budgetSince: number | null = null;
      if ('meters' in measurement) {
        if (at <= Math.max(previous.successAt ?? -Infinity, previous.balanceStatus?.at ?? -Infinity)) return result;
        const recorded = this.meters.record(id, previous, measurement);
        state = recorded.state;
        result.accepted = true;
        result.budget = supportsBudget(providerOf(previous.provider));
        if (measurement.meters.some(m => quotaMeter(providerOf(previous.provider), m.id))) quotaSince = recorded.since;
        if (result.budget) budgetSince = recorded.since;
      } else {
        // Freeze legacy anchors before any independent resource advances quota success.
        const legacy = previous.successAt !== null && previous.staleAfterMs !== null
          ? {status:'observed' as const,at:previous.successAt,staleAfterMs:previous.staleAfterMs,valueAt:previous.successAt,valueStaleAfterMs:previous.staleAfterMs} : null;
        const resources = {...(legacy ? {windows:legacy,...(previous.resets ? {resets:legacy} : {})} : {}),...previous.resources};
        const windowStatus = measurement.resourceStatus?.windows ?? 'observed';
        if (at > (resources.windows?.at ?? previous.successAt ?? -Infinity)) {
          resources.windows = {status:windowStatus, at, staleAfterMs:ttl};
          result.accepted = true;
          quotaSince = at;
          if (windowStatus === 'observed') {
            const insert = this.db.prepare('INSERT OR IGNORE INTO samples (source_id,window_id,at,kind,label,used,reset_at,minutes,stale_after_ms) VALUES (?,?,?,?,?,?,?,?,?)');
            for (const w of measurement.windows) insert.run(id,w.id,at,w.kind,w.label,w.used,w.resetAt,w.minutes,ttl);
            state = {...state,plan:measurement.plan,successAt:at,staleAfterMs:ttl,error:null,windows:measurement.windows};
            result.windows = true;
            if (measurement.plan !== '' && measurement.plan !== this.lastPlan(id)) {
              this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?)').run(id,at,'plan',measurement.plan);
            }
          } else {
            this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?)').run(id,at,'quota_unavailable',windowStatus);
            // The preceding sample's tile now ends at this exclusive boundary.
            quotaSince = previous.successAt ?? at;
            result.unavailable = true;
          }
        }
        const resetStatus = measurement.resourceStatus?.resets ?? (measurement.resets ? 'observed' : null);
        const resetAt = resources.resets?.at ?? (previous.resets ? previous.successAt : null);
        if (resetStatus && at > (resetAt ?? -Infinity)) {
          const continuous = (resources.resets?.status ?? 'observed') === 'observed' && resetAt !== null && at-resetAt <= (resources.resets?.staleAfterMs ?? previous.staleAfterMs ?? 0);
          const granted = continuous && measurement.resets && previous.resets ? measurement.resets.available-previous.resets.available : 0;
          if (resetStatus === 'observed') state = {...state,resets:measurement.resets};
          if (granted > 0) this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?)').run(id,at,'resets_granted',String(granted));
          resources.resets = {status:resetStatus,at,staleAfterMs:ttl,...(resetStatus==='observed'?{valueAt:at,valueStaleAfterMs:ttl}:previous.resets?{valueAt:resources.resets?.valueAt??resetAt!,valueStaleAfterMs:resources.resets?.valueStaleAfterMs??previous.staleAfterMs??ttl}:{})};
          result.accepted = result.resets = true;
          quotaSince = Math.min(quotaSince ?? at, at);
        }
        state = previous.provider==='codex'?{...state,resources}:state;
        if(previous.provider!=='codex'&&result.windows)state={...state,resets:measurement.resets};
        const balance = measurement.balances?.[0];
        if (balance && at > (previous.creditBalance?.at ?? -Infinity)) {
          const {amount: nativeAmount,...status} = balance;
          const recorded = this.meters.record(id,state,{type:'meters',observedAt:at,staleAfterMs:ttl,
            creditBalance:{...status,at,staleAfterMs:ttl},
            meters:balance.status === 'finite' ? [{id:balance.id,unit:balance.unit,kind:'balance',...exactDecimal(nativeAmount!),at,staleAfterMs:ttl,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null}] : [],
            keys:[],inventoryComplete:false,inventoryError:null});
          state = recorded.state;
          result.accepted = result.budget = true;
          budgetSince = recorded.since ?? at;
        }
      }
      if (!result.accepted) return result;
      if (at > (deliveryOf(previous)?.at ?? -Infinity)) {
        state = {...state,delivery:{at,staleAfterMs:ttl}};
        result.delivery = true;
      }
      this.db.prepare('INSERT OR REPLACE INTO state VALUES (?,?)').run(id,JSON.stringify(state));
      tell(this.observer,o => {
        o.touchSources([id]);
        if (quotaSince !== null) o.history(id,quotaSince,['quota']);
        if (budgetSince !== null) o.history(id,budgetSince,['budget']);
      });
      if (result.budget) afterCommit(() => {for (const listener of this.monetaryRecords) listener(id,state);});
      return result;
    });
  }

  /** Keep each resource's last accepted value producer separate from its latest status. */
  recordOrigins(source: string, device: string, snapshot: AgentSnapshot, previous: SourceState, at: number) {
    const origin = JSON.stringify({device, at, client: snapshot.clientEvidence ? snapshot.client : null, evidence: snapshot.clientEvidence ?? null});
    const save = (resource: string, value: boolean) => this.db.prepare('INSERT INTO resource_origins VALUES (?,?,?,?) ON CONFLICT(source_id,resource) DO UPDATE SET value_origin=CASE WHEN excluded.value_origin IS NULL THEN resource_origins.value_origin ELSE excluded.value_origin END,observation_origin=excluded.observation_origin').run(source,resource,value ? origin : null,origin);
    if (at > (previous.resources?.windows?.at ?? previous.successAt ?? -Infinity)) save('windows', (snapshot.resourceStatus?.windows ?? 'observed') === 'observed');
    const resetStatus = snapshot.resourceStatus?.resets ?? (snapshot.resets ? 'observed' : null);
    if (resetStatus && at > (previous.resources?.resets?.at ?? (previous.resets ? previous.successAt : null) ?? -Infinity)) save('resets',resetStatus === 'observed');
    if (snapshot.balances?.[0] && at > (previous.creditBalance?.at ?? -Infinity)) save('funds', snapshot.balances[0].status === 'finite');
  }

  resourceOrigins(source: string) {
    type Origin={device:string;at:number;client:string|null;evidence:'nativeHandshake'|'preLaunch'|null};
    const read=(value:string|null):Origin|null=>value ? JSON.parse(value) as Origin : null;
    return (this.db.prepare('SELECT resource,value_origin,observation_origin FROM resource_origins WHERE source_id=?').all(source) as {resource:string;value_origin:string|null;observation_origin:string}[])
      .map(row => ({resource:row.resource,valueOrigin:read(row.value_origin),observationOrigin:read(row.observation_origin)}));
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
  historyKnown(shown: Shown, _owner: string | null = null, access?:WorkAccess): HistoryMeta['known'] {
    return {work:this.agentWorkSince(),sources:Object.fromEntries([...shown].map(([id,value])=>[id,value.since])),...(access?{sessions:sessionsKnownFrom(access),sourceWork:sourceWorkFrom(access)}:{})};
  }

  admittedWork(access:WorkAccess,from:number,to:number,reserve?:(bytes:number)=>void):Stretch[] {
    if(!access.devices.size)return [];
    const rows=this.agentWork(from,to,undefined,null,reserve,[...access.devices.keys()],access.attribution);let kept=0;
    // These rows belong to this read. Apply admission without retaining a second copy.
    for(const row of rows){
      const scope=admitted(access,row.device,row.user);if(!scope||row.to<=scope.from)continue;
      const funding=fundingOf(access,row.user,row.source);
      row.source=funding.source;row.from=Math.max(row.from,scope.from);
      if(funding.sourceStatus)row.sourceStatus=funding.sourceStatus;
      if(funding.source!==null)row.quotaFrom=Math.max(scope.from,access.sources.get(funding.source)!.since);
      rows[kept++]=row;
    }
    rows.length=kept;return rows;
  }

  /** Complete cells of every measured window, read once through a run of missing tiles. */
  financialGroups(board:string,selection:MeterSelection,from:number,to:number,now:number,reserve?:(bytes:number)=>void) {
    const sources=new Map(this.sources(board).map(s=>[s.id,s]));
    return this.meters.groups(selection,from,to,reserve).map(group=>{
      const source=sources.get(group.source);
      const anchor=source?.provider==='codex' ? source.budget?.enabled ? source.budget.anchor : null : 0;
      return {...group,retainedFrom:now-config.retention.sampleDays*86_400_000,
        readings:anchor==null?[]:group.readings.filter(r=>r.at>=anchor),
        spans:anchor==null?[]:group.spans.filter(s=>s.to>=anchor).map(s=>({...s,from:Math.max(s.from,anchor),...(s.observedFrom!==undefined&&s.observedFrom<anchor?{observedFrom:undefined}:{})}))};
    });
  }

  cells(board: string, cellMs: number, from: number, to: number, {now = Date.now(), shown = this.shown(board, []), meters, scope, work,sourceWork=false,reserve}: {now?: number; shown?: Shown; meters?: MeterSelection; scope?: HistoryScope; work?: WorkRead;sourceWork?:boolean;reserve?:(bytes:number)=>void} = {}): Chunk<number>[] {
    const sources = this.sources(board);
    // Subscription caps accompany native windows; wallet selections retain their cheaper read.
    const withWindows=scope ? scope==='quota' : !meters||meters.ids.some(([id])=>sources.some(source=>source.id===id&&providerOf(source.provider)?.funding==='subscription'));
    if(scope==='budget') {
      const chunks=cellsOf([],[],{},cellMs,from,to,this.historyKnown(shown));
      if(meters) {
        const groups=this.financialGroups(board,meters,from,to,now);
        for(const chunk of chunks)chunk.meterSeries=this.meters.cells(meters,chunk.from,chunk.to,cellMs,groups);
        if(sourceWork)this.moneyWork(board,shown,meters,from,to,cellMs,now,chunks,work,reserve);
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
      groups.push({source: id, window: w, samples: this.quotaAvailability(id, rows.map(([at, used, resetAt, staleAfterMs]) => ({at, used, resetAt, staleAfterMs})))});
    }
    const access=work?.ensureAccess?.()??work?.access??this.workAccess(board,now);
    const known=this.historyKnown(shown,access.owner,access);
    const readFrom=workFrom(groups,from);
    const stretches=work?work(readFrom,Math.min(to,now)):this.admittedWork(access,readFrom,Math.min(to,now));
    const devices = Object.fromEntries((this.db.prepare('SELECT id, COALESCE(label, name) AS name FROM devices WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...new Set(stretches.map(s => s.device))])) as {id: string; name: string}[]).map(d => [d.id, d.name]));
    const chunks = cellsOf(groups,stretches,devices,cellMs,from,to,known,work?.reserve);
    const grants = this.db.prepare("SELECT source_id, at, detail FROM events WHERE source_id IN (SELECT value FROM json_each(?)) AND kind = 'resets_granted' AND at >= ? AND at < ?")
      .all(JSON.stringify(sources.map(s => s.id)), from, to) as {source_id: string; at: number; detail: string}[];
    for (const event of grants) chunks[tileOf(event.at, cellMs) - tileOf(from, cellMs)].grants.push([event.source_id, event.at, Number(event.detail)]);
    if(withWindows){
      const retention=config.retention.sampleDays*86_400_000;
      const readPlans=this.db.prepare("SELECT at,detail FROM events WHERE source_id=? AND kind='plan' AND at>=? AND at<? ORDER BY at");
      const predecessor=this.db.prepare("SELECT at,detail FROM events WHERE source_id=? AND kind='plan' AND at>=? AND at<? AND detail<>? ORDER BY at DESC");
      const valid=(name:unknown):name is string=>typeof name==='string'&&name.length>0&&name.length<=256&&!/[\u0000-\u001f]/.test(name);
      for(const [id,rights] of shown){
        const cutoff=Math.max(now-retention,rights.since);
        for(const raw of readPlans.iterate(id,Math.max(from,cutoff),to)){
          const event=raw as {at:number;detail:string};if(!valid(event.detail))continue;
          let previous:{at:number;plan:string}|null=null;
          for(const raw of predecessor.iterate(id,cutoff,event.at,event.detail)){const row=raw as {at:number;detail:string};if(valid(row.detail)){previous={at:row.at,plan:row.detail};break;}}
          const row:PlanRow=[id,event.at,event.detail,previous,event.at+retention+1];reserve?.(planRowBytes(row));
          (chunks[tileOf(event.at,cellMs)-tileOf(from,cellMs)].plans??=[]).push(row);
        }
      }
    }
    if (meters) {
      const groups=this.financialGroups(board,meters,from,to,now);
      for (const chunk of chunks) chunk.meterSeries = this.meters.cells(meters,chunk.from,chunk.to,cellMs,groups);
    }
    return chunks;
  }

  moneyWorkSources(board:string,selection:MeterSelection):string[] {
    const sources=new Map(this.sources(board).map(source=>[source.id,source.provider]));
    return [...new Set(selection.ids.filter(([source,meter])=>sourceWorkEligible(sources.get(source)??'',meter)).map(([source])=>source))];
  }

  private moneyWork(board:string,shown:Shown,selection:MeterSelection,from:number,to:number,cell:number,now:number,chunks:Chunk<number>[],shared?:WorkRead,reserve?:(bytes:number)=>void) {
    const access=shared?.ensureAccess?.()??this.workAccess(board,now),sources=this.moneyWorkSources(board,selection),known=this.historyKnown(shown,access.owner,access);
    const groups=sources.map(source=>{const counter=sourceCounterOf(this.state(source).provider)!;return {source,...this.meters.pairReadings(source,counter,from,to,reserve)};});
    let readFrom=from;
    for(const group of groups)for(let i=1;i<group.readings.length;i++){const a=group.readings[i-1],b=group.readings[i];if(b.previousAt===a.at&&b.at-a.at<=a.staleAfterMs)readFrom=Math.min(readFrom,a.at);}
    const admitted=shared?shared(readFrom,Math.min(now,to)):this.admittedWork(access,readFrom,Math.min(now,to));
    reserve?.(256+admitted.length*192);
    const work=admitted.flatMap(span=>span.source!==null&&sources.includes(span.source)&&span.to>(span.quotaFrom??known.work)?[{...span,from:Math.max(span.from,span.quotaFrom??known.work)}]:[]);
    for(const chunk of chunks)chunk.moneyWork=[];
    for(const group of groups) {
      const cutoff=Math.max(known.work,shown.get(group.source)?.since??Infinity,now-config.retention.sampleDays*86_400_000);
      reserve?.(128+work.length*8);
      const packed=packMoneyWork({source:group.source,unit:group.readings.at(-1)?.unit??'USD',knownFrom:group.knownFrom===null?null:Math.max(group.knownFrom,cutoff),readings:group.readings,spans:group.spans,work:work.filter(span=>span.source===group.source)},from,to,cell,reserve);
      reserve?.(256+packed.cells.length*256+packed.edges.length*16);
      for(const chunk of chunks)chunk.moneyWork!.push({...packed,cells:packed.cells.filter(row=>from+row[0]*cell>=chunk.from&&from+row[0]*cell<chunk.to).map(row=>[row[0]-(chunk.from-from)/cell,...row.slice(1)] as typeof row),edges:packed.edges.filter(edge=>edge[1]>=chunk.from&&edge[1]<chunk.to)});
    }
  }

  private lastPlan(source: string): string | null {
    const row = this.db.prepare("SELECT detail FROM events WHERE source_id = ? AND kind = 'plan' ORDER BY at DESC LIMIT 1").get(source) as {detail: string} | undefined;
    return row?.detail ?? null;
  }

  /** Status observations bound derived availability; original values and TTLs stay intact. */
  quotaAvailability<T extends {at: number}>(source: string, samples: T[], adjacentOnly = true, reserve?:(bytes:number)=>void): (T & {validUntil?: number})[] {
    if (!samples.length) return samples;
    const barriers:{at:number}[]=[];
    const read = this.db.prepare(
      "SELECT at FROM events WHERE source_id=? AND kind='quota_unavailable' AND at>? AND at<=coalesce(" +
      "(SELECT min(at) FROM events WHERE source_id=? AND kind='quota_unavailable' AND at>?),?) ORDER BY at",
    );
    for(const row of read.iterate(source,samples[0].at,source,samples.at(-1)!.at,samples.at(-1)!.at)){reserve?.(64);barriers.push({at:Number(row.at)});}
    let next = 0;
    return samples.map((sample, i) => {
      while (next < barriers.length && barriers[next].at <= sample.at) next++;
      const boundary = barriers[next]?.at;
      return boundary !== undefined && (!adjacentOnly || boundary <= (samples[i + 1]?.at ?? Infinity)) ? {...sample,validUntil:boundary} : sample;
    });
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
    // Forecasts may skip a sample lacking reset metadata; its availability barrier
    // must still apply to the preceding usable sample.
    return this.quotaAvailability(source, rows.map(([at, used, resetAt, minutes]) => ({at, used, resetAt, minutes})), false);
  }

  /** Whether a window has a sample after `after` up to `upTo`. */
  sampled(source: string, window: string, after: number, upTo: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM samples WHERE source_id = ? AND window_id = ? AND at > ? AND at <= ? LIMIT 1').get(source, window, after, upTo);
  }

  quotaInterrupted(source: string, after: number, upTo: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE source_id=? AND kind='quota_unavailable' AND at>? AND at<=? LIMIT 1").get(source,after,upTo);
  }

  /** A window's sample at `at` and the next one: when each was taken and how long it held. */
  sampleAndNext(source: string, window: string, at: number): {at: number; staleAfterMs: number; validUntil?: number}[] {
    const rows = this.db
      .prepare('SELECT at, stale_after_ms FROM samples WHERE source_id = ? AND window_id = ? AND at >= ? ORDER BY at LIMIT 2')
      .all(source, window, at) as {at: number; stale_after_ms: number}[];
    return this.quotaAvailability(source, rows.map(r => ({at: r.at, staleAfterMs: r.stale_after_ms})));
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
      'INSERT INTO agent_sessions (device_id, client, source_id, origin, started_at, project, folder, ordinal, producer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    );
    const legacy = this.db.prepare(
      "SELECT id FROM agent_sessions WHERE device_id = ? AND client = ? AND COALESCE(source_id,'') = COALESCE(?,'') AND source_id IS ? AND started_at = ? AND origin = ? AND project = ? AND folder = ? AND ordinal = ? AND producer_id IS NULL",
    );
    const stable = this.db.prepare(
      "SELECT id FROM agent_sessions WHERE device_id = ? AND client = ? AND producer_id = ? AND COALESCE(source_id,'') = COALESCE(?,'') AND source_id IS ? AND origin = ? AND project = ? AND folder = ?",
    );
    // Each contextual row has non-overlapping stretches, so its last start ends latest.
    const latest = this.db.prepare('SELECT to_at AS at FROM agent_work WHERE session_id = ? ORDER BY from_at DESC LIMIT 1');
    const highWater = this.db.prepare(
      'SELECT max((SELECT to_at FROM agent_work WHERE session_id = s.id ORDER BY from_at DESC LIMIT 1)) AS at FROM agent_sessions s WHERE device_id = ? AND client = ? AND producer_id = ?',
    );
    const floors = this.db.prepare(
      'SELECT producer_id IS NULL AS legacy, max((SELECT to_at FROM agent_work WHERE session_id = s.id ORDER BY from_at DESC LIMIT 1)) AS at FROM agent_sessions s WHERE device_id = ? GROUP BY producer_id IS NULL',
    );
    const extend = this.db.prepare('UPDATE agent_work SET to_at = ? WHERE session_id = ? AND to_at = ?');
    const begin = this.db.prepare('INSERT INTO agent_work VALUES (?, ?, ?) ON CONFLICT (session_id, from_at) DO UPDATE SET to_at = max(to_at, excluded.to_at)');
    const credited = new Map<string, number>();
    let changedFrom=Infinity;
    const owner = (this.db.prepare('SELECT user_id AS user FROM devices WHERE id=?').get(device) as {user: string} | undefined)?.user;
    const contexts = this.links.batch(owner ? [owner] : []);
    let changedEvidence = false;
    const evidence = this.db.prepare('SELECT account_by AS accountBy,route_class AS class,route_by AS by,route_host AS host,route_provider AS provider FROM agent_sessions WHERE id=?');
    const saveEvidence = this.db.prepare('UPDATE agent_sessions SET account_by=?,route_class=?,route_by=?,route_host=?,route_provider=? WHERE id=?');
    this.db.exec('SAVEPOINT credit');
    try {
      // Snapshot before writes: mixed packets must not clip one namespace against the
      // other namespace's parallel credit from this same call.
      const opposite = new Map((floors.all(device) as {legacy: number; at: number | null}[]).map(row => [row.legacy, row.at ?? from]));
      for (const {source, client: suppliedClient, origin, startedAt, project, folder, identity, accountBy, route} of keys) {
        const client = suppliedClient ?? source?.split(':')[0] ?? 'unknown';
        const producer = identity.kind === 'stable' ? identity.sessionId : null;
        const ordinal = identity.kind === 'legacy' ? identity.ordinal : 0;
        const created = add.run(device, client, source, origin, startedAt, project, folder, ordinal, producer).changes > 0;
        const {id} = (producer === null
          ? legacy.get(device, client, source, source, startedAt, origin, project, folder, ordinal)
          : stable.get(device, client, producer, source, source, origin, project, folder)) as {id: number};
        const row = evidence.get(id) as {accountBy: SessionEvidence['accountBy']; class: SessionRoute['class'] | null; by: SessionRoute['by'] | null; host: string | null; provider: string | null};
        const before = {accountBy: row.accountBy, route: row.by ? {class: row.class!, by: row.by, host: row.host, provider: row.provider} : null};
        const merged = mergeEvidence(before, {accountBy, route});
        if (JSON.stringify(before) !== JSON.stringify(merged)) {saveEvidence.run(merged.accountBy, merged.route?.class ?? null, merged.route?.by ?? null, merged.route?.host ?? null, merged.route?.provider ?? null, id); changedEvidence ||= !created;}
        const own = producer === null ? latest.get(id) : highWater.get(device, client, producer);
        const start = Math.max(from, (own as {at: number | null} | undefined)?.at ?? from, opposite.get(producer === null ? 0 : 1) ?? from);
        if (until <= start) continue;
        if (!extend.run(until, id, start).changes) begin.run(id, start, until);
        if (owner) for (const fragment of splitLinks({clientId: client, deviceId: device, source, ...merged}, contexts(owner, device, client), start, until)) {
          if (fragment.source !== null) credited.set(fragment.source, Math.min(credited.get(fragment.source) ?? fragment.from, fragment.from));
        }
        changedFrom=Math.min(changedFrom,start);
      }
      if (changedEvidence && owner) this.db.prepare("INSERT INTO meta VALUES (?,'1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run('workEvidence:' + owner);
      this.db.exec('RELEASE credit');
    } catch (error) {
      this.db.exec('ROLLBACK TO credit');
      this.db.exec('RELEASE credit');
      throw error;
    }
    if(credited.size||Number.isFinite(changedFrom)||changedEvidence)afterCommit(()=>{this.workGeneration++;});
    if(owner&&Number.isFinite(changedFrom))tell(this.observer,o=>o.clientHistory?.(owner,changedFrom,device,[...credited.keys()]));
    if(changedEvidence&&owner){tell(this.observer,o=>{o.touchClientSessions?.(owner,device);o.clientHistory?.(owner,0,device);o.touchSources([...contexts(owner,device,'').held.keys()]);});}
  }

  /** Retained credit resolved to the session's current source; legacy identity is unknown. */
  worked(device: string, keys: WorkKey[], from = 0, now = Date.now(),captured?:ReturnType<LinkStore['batch']>): (number | null)[] {
    if (!keys.length) return [];
    const owner = String(this.db.prepare('SELECT user_id FROM devices WHERE id=?').get(device)?.user_id ?? '');
    const context = captured??this.links.batch([owner]);
    const read = this.db.prepare("SELECT s.id,s.client,s.source_id,s.account_by,s.route_class,s.route_by,s.route_host,s.route_provider,min(w.from_at) AS from_at,max(w.to_at) AS to_at FROM agent_sessions s JOIN agent_work w ON w.session_id=s.id WHERE s.device_id=? AND s.client=? AND s.producer_id=? AND w.to_at>? GROUP BY s.id");
    const sum = this.db.prepare('SELECT COALESCE(sum(min(to_at,?)-max(from_at,?)),0) AS ms FROM agent_work WHERE session_id=? AND to_at>? AND from_at<?');
    return keys.map(key => {
      if (key.identity.kind === 'legacy') return null;
      const clientId = key.client ?? key.source?.split(':')[0] ?? 'unknown', rules = context(owner, device, clientId);
      const source = resolveLink({...key, clientId, deviceId: device}, rules, now).source;
      let ms = 0;
      for (const row of read.all(device, clientId, key.identity.sessionId,from) as {id:number;source_id: string | null; account_by: SessionEvidence['accountBy']; route_class: SessionRoute['class']; route_by: SessionRoute['by'] | null; route_host: string | null; route_provider: string | null; from_at: number; to_at: number}[]) {
        const input: AttributionInput = {clientId, deviceId: device, source: row.source_id, accountBy: row.account_by, route: row.route_by ? {class: row.route_class, by: row.route_by, host: row.route_host, provider: row.route_provider} : null};
        // Resolve a context's cuts once, then sum its raw stretches within them.
        for (const fragment of splitLinks(input, rules, Math.max(from,row.from_at), row.to_at)) if (fragment.source === source) ms += Number(sum.get(fragment.to,fragment.from,row.id,fragment.from,fragment.to)!.ms);
      }
      return ms;
    });
  }

  /** Candidate owners are selected before read-time source resolution and display cuts. */
  agentWork(from: number, to: number, sources?: string[], owner: string | null = null, reserve?:(bytes:number)=>void, devices?:readonly string[], captured?:ReturnType<LinkStore['batch']>): Stretch[] {
    // Account evidence and possible manual targets select candidates, never their
    // final source. Materialize this smaller context set once inside SQLite.
    const candidates = sources ? ' AND w.session_id IN (SELECT s.id FROM agent_sessions s JOIN devices d ON d.id=s.device_id WHERE (d.user_id=? OR d.user_id IN (SELECT user_id FROM holders WHERE source_id IN (SELECT value FROM json_each(?)))) AND (d.user_id=? OR s.source_id IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM client_links l WHERE l.user_id=d.user_id AND l.client=s.client AND (l.device_id IS NULL OR l.device_id=s.device_id) AND l.source_id IN (SELECT value FROM json_each(?)) AND l.from_at<? AND (l.to_at IS NULL OR l.to_at>?))))' : '';
    // Broad reads use each selected context's ordered primary key. Narrow reads
    // near the retained end avoid scanning that context's earlier work again.
    const day=86_400_000,window=to-from,now=Date.now();
    const tail=window<7*day&&from>(Math.max(this.agentWorkSince(),now-config.retention.sampleDays*day)+now)/2;
    const index=window<day||tail?' INDEXED BY agent_work_by_end':'';
    const read = this.db.prepare('SELECT w.session_id,w.from_at,w.to_at FROM agent_work w'+index+' WHERE w.to_at>? AND w.from_at<?'+(devices?' AND w.session_id IN (SELECT id FROM agent_sessions WHERE device_id IN (SELECT value FROM json_each(?)))':candidates)+' ORDER BY w.session_id,w.from_at');
    read.setReturnArrays(true);
    const selected=JSON.stringify(sources);
    const rows:[number,number,number][]=[];
    for(const row of read.iterate(from,to,...(devices?[JSON.stringify(devices)]:sources?[owner,selected,owner,selected,selected,to,from]:[]))) {reserve?.(256);rows.push(row as unknown as [number,number,number]);}
    const bounds=new Map<number,{from:number;to:number}>();
    let previous:number|undefined,range:{from:number;to:number}|undefined;
    for(const row of rows) {
      // Most retained stretches already fit. Clip at the two edges while finding
      // context bounds instead of calling SQLite's scalar functions for every row.
      if(row[1]<from)row[1]=from;if(row[2]>to)row[2]=to;
      const [id,start,end]=row;
      if(id!==previous) {range={from:start,to:end};bounds.set(id,range);previous=id;}
      else range!.to=Math.max(range!.to,end);
    }
    // A bulk native result can exceed the read ceiling before admission.
    const sessions:({id: number; clientId: string; accountBy: SessionEvidence['accountBy']; class: SessionRoute['class']; by: SessionRoute['by'] | null; host: string | null; provider: string | null;client:string;producer_id:string|null;raw_project:string;raw_folder:string;device_name:string} & Omit<Stretch, 'session' | 'from' | 'to'>)[]=[];
    for(const row of this.db.prepare("SELECT s.id,s.client AS clientId,s.source_id AS source,s.device_id AS device,d.user_id AS user,s.origin,COALESCE(n.name,NULLIF(s.project,'')) AS project,NULLIF(s.folder,'') AS folder,s.started_at AS startedAt,s.account_by AS accountBy,s.route_class AS class,s.route_by AS by,s.route_host AS host,s.route_provider AS provider,s.client,s.producer_id,s.project AS raw_project,s.folder AS raw_folder,COALESCE(d.label,d.name) AS device_name FROM agent_sessions s JOIN devices d ON d.id=s.device_id LEFT JOIN project_names n ON n.user_id=d.user_id AND n.reported=s.project WHERE s.id IN (SELECT value FROM json_each(?))").iterate(JSON.stringify([...bounds.keys()]))) {
      const session=row as unknown as typeof sessions[number];
      reserve?.(768+2*((session.project?.length??0)+(session.folder?.length??0)+session.client.length+(session.source?.length??0)+(session.producer_id?.length??0)+session.raw_project.length+session.raw_folder.length+session.device_name.length));sessions.push(session);
    }
    const contexts = captured??this.links.batch([...new Set(sessions.map(s => s.user))],reserve), allowed = sources ? new Set(sources) : null;
    const contextOf=(s:typeof sessions[number])=>({device:s.device,user:s.user,origin:s.origin,project:s.project,folder:s.folder,startedAt:s.startedAt,...(devices?{rawContext:{source:s.source,client:s.client,producer:s.producer_id,project:s.raw_project,folder:s.raw_folder,deviceName:s.device_name,accountBy:s.accountBy,route:s.by?{class:s.class,by:s.by,host:s.host,provider:s.provider}:null}}:{})});
    // Resolve each context's timeline once, then reuse it for all its raw stretches.
    const timelines = new Map<number,{context:ReturnType<typeof contextOf>;parts:ReturnType<typeof splitLinks>;next:number}>();
    for(const s of sessions){
      const input: AttributionInput = {clientId: s.clientId, deviceId: s.device, source: s.source, accountBy: s.accountBy, route: s.by ? {class: s.class, by: s.by, host: s.host, provider: s.provider} : null};
      const bound=bounds.get(s.id)!;
      const parts=splitLinks(input, contexts(s.user, s.device, s.clientId), bound.from, bound.to,reserve).filter(part=>!allowed||part.source!==null&&allowed.has(part.source)||part.source===null&&s.user===owner);
      if(parts.length){reserve?.(256);timelines.set(s.id,{context:contextOf(s),parts,next:0});}
    }
    const result: Stretch[] = [];
    let lastId:number|undefined,lastTimeline:ReturnType<typeof timelines.get>;
    // Copying context objects into every stretch dominates dense reads.
    const append=(id:number,source:string|null,context:ReturnType<typeof contextOf>,from:number,to:number,extra=false)=>{
      // The raw row's reservation includes its first output; cuts can add more.
      if(extra)reserve?.(256);
      const span:Stretch={session:id,source,device:context.device,user:context.user,origin:context.origin,project:context.project,folder:context.folder,startedAt:context.startedAt,from,to};
      if(context.rawContext)span.rawContext=context.rawContext;
      result.push(span);
    };
    for (const [id, start, end] of rows) {
      // Rows are ordered by context, so one lookup serves all its stretches.
      const timeline=id===lastId?lastTimeline:timelines.get(id);lastId=id;lastTimeline=timeline;
      if(!timeline)continue;
      if(timeline.parts.length===1&&timeline.parts[0].from<=start&&timeline.parts[0].to>=end){
        append(id,timeline.parts[0].source,timeline.context,start,end);
        continue;
      }
      while (timeline.next < timeline.parts.length && timeline.parts[timeline.next].to <= start) timeline.next++;
      let emitted=false;
      for (let n = timeline.next; n < timeline.parts.length && timeline.parts[n].from < end; n++) {
        const part = timeline.parts[n];
        append(id,part.source,timeline.context,Math.max(start,part.from),Math.min(end,part.to),emitted);emitted=true;
      }
    }
    return result;
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
      o.touchClientSessions?.(user);
      o.clientHistory?.(user, 0);
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
    const cutoff = now - config.retention.sampleDays * 86_400_000;
    this.db.prepare('DELETE FROM attention_windows WHERE last_at < ? OR source_id NOT IN (SELECT id FROM sources)').run(cutoff);
    // Each successful deletion counts immediately: a later statement may fail.
    if (this.db.prepare('DELETE FROM samples WHERE at < ?').run(cutoff).changes) this.pruned++;
    if (this.meters.prune(cutoff)) this.pruned++;
    this.coverage.prune(cutoff);
    this.db.prepare('DELETE FROM quota_anchors WHERE at<?').run(cutoff);
    if (this.db.prepare('DELETE FROM agent_work WHERE to_at < ?').run(cutoff).changes) {this.pruned++;this.db.prepare("INSERT INTO meta VALUES ('workRetentionFrom',?) ON CONFLICT(key) DO UPDATE SET value=max(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER))").run(cutoff);}
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
