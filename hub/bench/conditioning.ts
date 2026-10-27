import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {Demo,ReportReceipt} from '../demo/index.js';
import {cards, people} from '../demo/model.js';
import type {Stand} from '../demo/setup.js';
import type {Snapshot} from '../server/projection.js';
import type {SourceState} from '../server/domain/quota.js';
import {cellOf,cellStart} from '../server/domain/history.js';
import {stillSnapshot} from './still.js';
import {ObservedWork} from './observed.js';

const DAY = 86_400_000;
export const QUOTA_COUNT = 20, QUOTA_EVERY = 3000;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
type WorkKind = 'ordinary' | 'private';
type Cut = {reportedAt: number; serverAt: number; working: boolean | null;tick?:ReportReceipt};
export type QuotaPoint = {index: number; source: string; sent: number; observedAt: number; used: number; lastId: string; ingestMs: number; accepted: number; duplicates: number; failures: number; waitUntil: number; pacedAt?: number};
type Hooks = {before?(index: number): Promise<void>; after?(at: number, index: number): Promise<void>};

/** The accepted producer facts are separate from the UI measurements taken around them. */
export class Conditioning {
  private readonly db: DatabaseSync;
  private baseline?: Snapshot;
  private baselineDepth?:ReturnType<Conditioning['depthInventory']>;
  readonly quota: QuotaPoint[] = [];
  readonly ordinary: Cut[] = [];
  readonly private: Cut[] = [];
  readonly observed: {at: number; working: boolean; acknowledgedThrough: number}[] = [];
  private observedBinding?: ReturnType<ObservedWork['binding']>;
  private observedClosed = false;
  private privateStartedAt?: number;
  private readonly source: string;
  constructor(file: string, private readonly stand: Stand) {
    this.db = new DatabaseSync(file, {readOnly: true});this.source = stand.sources.get('antigravity')!;
  }
  close() {this.db.close();}
  start(snapshot: Snapshot) {this.baseline = structuredClone(snapshot);this.baselineDepth=this.depthInventory();}
  quotaPoint(point: QuotaPoint, taken: ReturnType<typeof stillSnapshot>) {
    const state = JSON.parse(String(this.db.prepare('SELECT payload FROM state WHERE source_id=?').get(point.source)?.payload)) as SourceState;
    assert.equal(point.accepted, 1);assert.equal(point.duplicates, 0);assert.equal(point.failures, 0);
    assert.equal(state.successAt, point.observedAt);assert.equal(state.staleAfterMs, taken.staleAfterMs);
    assert.equal(state.windows.length, taken.windows.length);
    for (const window of taken.windows) {
      const actual = state.windows.find(row => row.id === window.id);assert.ok(actual);
      assert.equal(actual.used, window.usedPercent);assert.equal(actual.resetAt, window.resetsAt === null ? null : Date.parse(window.resetsAt));
      assert.equal(actual.minutes, window.minutes);assert.equal(actual.kind, window.kind);
    }
    this.quota.push(point);
  }
  cut(kind: WorkKind, reportedAt: number, working: boolean | null,tick?:ReportReceipt) {
    const machine = this.stand.agents.get('laptop')!.machine.id;
    const row = this.db.prepare('SELECT last_seen_at FROM devices WHERE machine_id=? AND revoked_at IS NULL').get(machine);
    const serverAt = Number(row?.last_seen_at);assert.ok(Number.isSafeInteger(serverAt) && serverAt >= reportedAt && serverAt <= Date.now());
    const cut={reportedAt,serverAt,working,...(tick?{tick:{...tick}}:{})};
    if(kind==='ordinary')this.scheduledOrdinal(cut);
    this[kind].push(cut);
  }
  private scheduledOrdinal(cut:Cut){
    const tick=cut.tick;
    assert.ok(tick&&tick.at===cut.reportedAt&&Number.isSafeInteger(tick.ordinal)&&tick.ordinal>0&&tick.manual===false,'ordinary work requires its accepted scheduled Demo report');
    return tick.ordinal;
  }
  privateStart(at: number) {this.privateStartedAt = at;}
  observedOpen(actor: ObservedWork) {
    const binding = actor.binding();this.observedBinding = binding;
    const row = this.db.prepare('SELECT a.floor_at,a.accepted_seq FROM device_activity a JOIN devices d ON d.id=a.device_id WHERE d.machine_id=?').get(binding.machineId);
    assert.equal(row?.floor_at, binding.floorAt);assert.equal(row?.accepted_seq, 1, 'the state-only checkpoint must be accepted');
    assert.equal(Number(this.db.prepare('SELECT count(*) n FROM agent_work w JOIN agent_sessions s ON s.id=w.session_id JOIN devices d ON d.id=s.device_id WHERE d.machine_id=?').get(binding.machineId)?.n), 0, 'the checkpoint credits no work');
  }
  observedPoint(actor: ObservedWork, at: number, working: boolean) {
    const binding = actor.binding();this.observed.push({at, working, acknowledgedThrough: binding.acknowledgedThrough});
  }
  observedClose() {this.observedClosed = true;}
  private intervals(machineId: string, sessionId: string, client: string, source: string | null, project: string, startedAt: number, from: number, to: number) {
    const rows = this.db.prepare('SELECT s.*,w.from_at,w.to_at FROM agent_sessions s JOIN devices d ON d.id=s.device_id JOIN agent_work w ON w.session_id=s.id WHERE d.machine_id=? AND s.producer_id=? AND s.client=? ORDER BY w.from_at').all(machineId, sessionId, client);
    assert.ok(rows.length, 'conditioned work must reach durable intervals');
    let end = from;
    for (const row of rows) {
      assert.equal(row.source_id, source);assert.equal(row.origin, 'terminal');assert.equal(row.project, project);assert.equal(row.folder, '');assert.equal(row.started_at, startedAt);
      assert.equal(Number(row.from_at), end, 'conditioned intervals have exact contiguous endpoints');end = Number(row.to_at);
    }
    assert.equal(end, to, 'conditioned work ends at its captured server cut');
  }
  private depthInventory() {
    assert.ok(this.baseline);
    const ids=JSON.stringify(this.baseline.sources.map(source=>source.id)),depth=this.stand.start-74*DAY;
    return {depth,limits:this.db.prepare('SELECT source_id,window_id,kind,min(at) AS first FROM samples WHERE source_id IN (SELECT value FROM json_each(?)) GROUP BY source_id,window_id HAVING min(at)<=? ORDER BY source_id,window_id').all(ids,depth).map(row=>({sourceId:String(row.source_id),windowId:String(row.window_id),kind:String(row.kind),first:Number(row.first)})),
      money:this.db.prepare('SELECT r.source_id,s.provider,min(r.at) AS first FROM readings r JOIN sources s ON s.id=r.source_id WHERE r.source_id IN (SELECT value FROM json_each(?)) GROUP BY r.source_id HAVING min(r.at)<=? ORDER BY r.source_id').all(ids,depth).map(row=>({sourceId:String(row.source_id),providerId:String(row.provider),first:Number(row.first)}))};
  }
  receipt() {return {quota:this.quota,ordinary:this.ordinary,ordinaryTickDeltas:this.ordinary.slice(1).map((row,index)=>Math.floor((row.reportedAt-this.stand.start)/15000)-Math.floor((this.ordinary[index].reportedAt-this.stand.start)/15000)),ordinaryOrdinalDeltas:this.ordinary.slice(1).map((row,index)=>row.tick&&this.ordinary[index].tick?row.tick.ordinal-this.ordinary[index].tick!.ordinal:null),private:this.private,privateStartedAt:this.privateStartedAt,observed:{binding:this.observedBinding,reports:this.observed,closed:this.observedClosed}};}
  /** Read the producer's stored projection, without trusting its own in-memory ledger. */
  async verify(frequencySource: string) {
    assert.ok(this.baseline);assert.equal(this.quota.length, QUOTA_COUNT);
    const initial = this.baseline.sources.find(source=>source.id===this.source)!.windows.find(window=>window.id==='gemini:weekly')!.used;
    this.quota.forEach((point, index) => {
      assert.equal(point.index, index);assert.equal(point.source, this.source);assert.ok(Math.abs(point.used - (initial + (index + 1) * .1)) < 1e-9);
      assert.equal(point.waitUntil, point.sent + QUOTA_EVERY);assert.ok(point.pacedAt !== undefined && point.pacedAt + 1 >= point.waitUntil, 'quota pacing cannot be shortened');
      if (index) assert.ok(point.sent >= this.quota[index - 1].waitUntil - 1, 'quota deliveries retain their three-second cadence');
    });
    assert.deepEqual(this.ordinary.map(row => row.working), [true, true, true, false]);
    const ordinals=this.ordinary.map(row=>this.scheduledOrdinal(row));
    for(let i=1;i<ordinals.length;i++)assert.ok(ordinals[i]>ordinals[i-1],'ordinary work requires distinct scheduled Demo reports');
    assert.deepEqual(this.private.map(row => row.working), [true, true, true, false, null]);
    assert.deepEqual(this.observed.map(row => row.working), [true, true, false]);
    assert.deepEqual(this.observed.map(row => row.acknowledgedThrough), [2, 3, 4]);
    const laptop = this.stand.agents.get('laptop')!.machine.id;
    this.intervals(laptop, 'f'.repeat(32), 'antigravity', this.source, 'Benchmark', this.stand.start, this.ordinary[0].serverAt, this.ordinary[3].serverAt);
    assert.ok(this.privateStartedAt !== undefined);
    this.intervals(laptop, 'd'.repeat(32), 'opencode', null, 'Private benchmark', this.privateStartedAt, this.private[0].serverAt, this.private[3].serverAt);
    const binding = this.observedBinding;assert.ok(binding && this.observedClosed);
    this.intervals(binding.machineId, binding.sessionId, 'antigravity', this.source, 'Observed benchmark', binding.floorAt, binding.floorAt, this.observed[2].at);
    const cursor = this.db.prepare('SELECT a.floor_at,a.accepted_seq,a.last_at,d.revoked_at,t.revoked_at AS token_revoked FROM device_activity a JOIN devices d ON d.id=a.device_id JOIN tokens t ON t.id=d.token_id WHERE d.machine_id=?').get(binding.machineId);
    assert.equal(cursor?.floor_at, binding.floorAt);assert.equal(cursor?.accepted_seq, 4);assert.equal(cursor?.last_at, this.observed[2].at);
    assert.ok(cursor?.revoked_at !== null && cursor?.token_revoked !== null, 'observed actor and token cleanup must be committed');
    assert.equal(this.stand.agents.get('laptop')!.clientSessionCount, 0);
    const owner = this.stand.people.get(people(this.stand.set)[0].id)!, current = await owner.get<Snapshot>('/api/overview?board=' + owner.personalBoard);
    const cohort = (snapshot: Snapshot) => JSON.stringify({sources: snapshot.sources.map(row => row.id).sort(), sessions: [...Object.entries(snapshot.sessions).flatMap(([source, rows]) => rows.map(row => [source, row.clientId, row.device.id, row.origin, row.project, row.folder, row.startedAt, row.working])), ...snapshot.unattributedSessions.map(row => [null, row.clientId, row.device.id, row.origin, row.project, row.folder, row.startedAt, row.working])].map(row => JSON.stringify(row)).sort()});
    const before = cohort(this.baseline), after = cohort(current);assert.equal(after, before, 'conditioning preserves the full admitted source and session cohort');
    for (const source of current.sources) assert.equal(source.measureIntervalMs, source.id === frequencySource ? 120000 : this.baseline.sources.find(row => row.id === source.id)!.measureIntervalMs);
    const inventory=this.depthInventory();assert.deepEqual(inventory,this.baselineDepth,'every admitted deep series retains its original history anchor');
    const {depth,limits,money}=inventory;
    const density={session:limits.filter(row=>row.kind==='session').length,weekly:limits.filter(row=>row.kind==='weekly').length,wallet:money.filter(row=>row.providerId==='openrouter').length,funds:money.filter(row=>row.providerId==='codex').length};
    assert.ok(Object.values(density).every(count=>count>=12),'conditioning retains twelve deep series of every resource family');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    return {status: 'complete', start: this.stand.start, verifiedAt: Date.now(), ...this.receipt(), frequency: {source: frequencySource, intervalMs: 120000}, density, depth, inventory, cohort: {beforeHash: hash(before), afterHash: hash(after), sources: current.sources.length}};
  }
}

/** Both composite measurement and isolated panning deliver these exact twenty observations. */
export async function quotaProducer(stand: Stand, ledger?: Conditioning, hooks?: {before(): Promise<void>; after(point: QuotaPoint): Promise<void>}) {
  const card = cards(stand.set).find(card => card.id === 'antigravity')!, source = stand.sources.get(card.id)!, agent = stand.agents.get(card.machines[0])!;
  const overview = await stand.people.get(people(stand.set)[0].id)!.get<Snapshot>('/api/overview');ledger?.start(overview);
  const initial = overview.sources.find(row => row.id === source)!.windows.find(row => row.id === 'gemini:weekly')!.used;
  for (let index = 0; index < QUOTA_COUNT; index++) {
    await hooks?.before();
    const taken = stillSnapshot(card, stand.start, Date.now()), used = initial + (index + 1) * .1;
    const windows = taken.windows.map(window => window.id === 'gemini:weekly' ? {...window, usedPercent: used} : window);
    const sent = Date.now(), reply = await agent.ingest([{...taken, windows}], [], sent), ingestMs = Date.now() - sent;
    const point: QuotaPoint = {index, source, sent, observedAt: Date.parse(taken.observedAt), used, ingestMs, ...reply, lastId: `${cellStart(Date.parse(taken.observedAt),cellOf(DAY))}:${Math.round((100 - used) * 100) / 100}`, waitUntil: sent + QUOTA_EVERY};
    await hooks?.after(point);
    ledger?.quotaPoint(point, {...taken, windows});
    let pacedAt = Date.now();
    while (pacedAt < point.waitUntil) {await pause(point.waitUntil - pacedAt);pacedAt = Date.now();}
    point.pacedAt = pacedAt;
  }
}

export async function ordinaryProducer(demo: Demo, ledger?: Conditioning, hooks?: Hooks) {
  demo.work(true);const started = await demo.nextReport('laptop');ledger?.cut('ordinary', started, true,demo.reportReceipt('laptop',started));await pause(1000);
  try {
    for (let index = 0; index < 3; index++) {
      await hooks?.before?.(index);if (index === 2) demo.work(false);
      const at = await demo.nextReport('laptop');ledger?.cut('ordinary', at, index < 2,demo.reportReceipt('laptop',at));await pause(1000);await hooks?.after?.(at, index);
    }
  } finally {demo.work(false);}
}

export async function observedProducer(stand: Stand, ledger?: Conditioning, hooks?: Hooks & {ready(actor: ObservedWork): Promise<void>}) {
  const owner = stand.people.get(people(stand.set)[0].id)!, actor = await ObservedWork.open(owner, cards(stand.set).find(card => card.id === 'antigravity')!);
  let failed = false;
  try {
    ledger?.observedOpen(actor);await pause(1000);await hooks?.ready(actor);
    for (let index = 0; index < 3; index++) {await hooks?.before?.(index);const at = await actor.report(index < 2);ledger?.observedPoint(actor, at, index < 2);await pause(1000);await hooks?.after?.(at, index);}
  } catch (error) {failed = true;throw error;
  } finally {
    try {await actor.close();ledger?.observedClose();} catch (error) {if (!failed) throw error;}
    await pause(1000);
  }
}

export async function privateProducer(demo: Demo, stand: Stand, ledger?: Conditioning, hooks?: Hooks) {
  const agent = stand.agents.get('laptop')!, start = Date.now();ledger?.privateStart(start);
  const session = {clientId: 'opencode', sessionId: 'd'.repeat(32), source: null, origin: 'terminal', project: 'Private benchmark', startedAt: new Date(start).toISOString(), working: true};
  agent.trackClients([session], []);const started = await demo.reportNow('laptop');ledger?.cut('private', started, true);await pause(1000);
  let failed = false;
  try {
    for (let index = 0; index < 3; index++) {
      await hooks?.before?.(index);if (index === 2) agent.trackClients([{...session, working: false}], []);
      const at = await demo.reportNow('laptop');ledger?.cut('private', at, index < 2);await pause(1000);await hooks?.after?.(at, index);
    }
  } catch (error) {failed = true;throw error;
  } finally {
    agent.trackClients([], []);
    try {const at = await demo.reportNow('laptop');ledger?.cut('private', at, null);} catch (error) {if (!failed) throw error;}
  }
}
