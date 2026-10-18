import {safeRoute, matches, splitLinks, suggestion, type LinkRoute, type LinkInput, type Attribution} from './domain/links.js';
import {createHmac, randomBytes} from 'node:crypto';
import type {SessionEvidence} from './domain/sessionEvidence.js';
import type {Origin} from './domain/ingest.js';
import type {Store, WorkKey} from './store/store.js';
import {admitted,fundingOf,type WorkAccess} from './domain/workAccess.js';
import {afterCommit} from './touches.js';

/** A running coding agent as its machine reported it, on the subscription it spends. */
export type LiveSession = SessionEvidence & {
  clientId?: string;
  source?: string | null;
  sessionId: string | null;
  device: {id: string; name: string};
  origin: Origin;
  project: string | null;
  folder: string | null;
  /** On the hub's clock. */
  startedAt: number;
  /** As the agent sent it: the correction for its clock differs from request to request, so this tells the session. */
  sentStartedAt: number;
  lastWorkedAt: number | null;
  working: boolean;
};

/**
 * A running coding agent as a board shows it, on the card of the subscription it spends:
 * its project as its person named it («My machines» → «Projects»), and its folder where
 * that is another (a worktree, a folder inside the repository), so agents of one project
 * stay apart; and how long it has worked, as credited by its machine's lists so far.
 */
export type BoardSession = {
  sourceStatus?:'notProvided';
  presenceKey?: string;
  currentPresence?: {working: boolean; startedAt: number};
  clientId?: string;
  route?: LinkRoute;
  device: {id: string; name: string};
  origin: Origin;
  project: string | null;
  folder: string | null;
  startedAt: number;
  lastWorkedAt: number | null;
  working: boolean;
  workedMs: number | null;
};

/** A machine's sessions, by the subscription they spend, as its agent last reported them, and when. */
type StoredSession = LiveSession & {clientId: string; source: string | null};
type Machine = {at: number; user: string; sessions: StoredSession[]};

/** A machine's list is kept this long after its last report (its agent reports at least every two minutes). */
export const KEEP_MS = 5 * 60_000;
/**
 * A list counts as true until the next one, but for at most this long: an agent with
 * anything running reports at least every two minutes (later by a look's 15 s and a
 * measurement it waits for, up to a minute), so a machine quiet for longer stopped
 * working, and is not credited for its silence. A hub slow to answer the calls around
 * that measurement can stretch a gap past this; the few seconds over are not counted.
 */
export const CREDIT_MS = 200_000;

/**
 * What each of a machine's sessions is credited under, by subscription, in the list's
 * order (Store.creditWork). Sessions alike in everything (started together by a script)
 * retain the released working-only ordinal. Stable IDs use their own namespace; a
 * working stable session still consumes the ordinal an older hub would assign it.
 */
function keysOf(machine: Machine): WorkKey[] {
  const alike = new Map<string, number>();
  return machine.sessions.map(session => {
    const key = {client: session.clientId, source: session.source, origin: session.origin, startedAt: session.sentStartedAt, project: session.project ?? '', folder: session.folder ?? ''};
    const fingerprint = JSON.stringify(key);
    const ordinal = alike.get(fingerprint) ?? 0;
    if (session.working) alike.set(fingerprint, ordinal + 1);
    return {...key, accountBy: session.accountBy, route: session.route,
      identity: session.sessionId ? {kind: 'stable' as const, sessionId: session.sessionId} : {kind: 'legacy' as const, ordinal}};
  });
}

/**
 * The coding agents running on people's machines right now (spec: Reporting running
 * agents). Only the latest list of each machine is kept, in memory: after a restart the
 * agents send theirs again within minutes. When each session worked, as the lists said,
 * is kept (Store.creditWork); how long agents worked is worked out from that when read
 * (domain/work.ts).
 */
export class Sessions {
  private readonly machines = new Map<string, Machine>();
  private readonly presenceSecret = randomBytes(32);

  constructor(private readonly store: Store) {
    store.setCurrentFunding((device,owner,source,now)=>{const machine=this.machines.get(device);return !!machine&&machine.user===owner&&now<=machine.at+KEEP_MS&&machine.sessions.some(session=>session.source===source||this.store.links.context(owner,device).links.some(link=>link.sourceId===source&&matches(link,{...session,deviceId:device},safeRoute(session.route,true).route,link.from)));});
  }

  /** A machine's new list, from its person `user`, each session filed under its subscription. */
  report(device: string, user: string, sessions: (LiveSession & {source: string | null})[], now: number) {
    if(this.requiresIntervals(device))return;
    this.sweep(now);
    const before = this.machines.get(device);
    if (before) this.credit(device, before, Math.min(now, before.at + CREDIT_MS));
    const normalized = sessions.map(s => ({...s, clientId: s.clientId ?? s.source?.split(':')[0] ?? 'unknown'}));
    const next = {at: now, user, sessions: normalized};
    const evidence = this.store.observeWork(device, keysOf(next));
    next.sessions = normalized.map((session, i) => ({...session, accountBy: evidence[i].accountBy, route: evidence[i].route}));
    if (normalized.length) this.machines.set(device, next);
    else this.machines.delete(device);
    this.store.clientSessionsChanged(user,device);

  }

  /** Close the released writer before its durable barrier, without publishing uncommitted presence. */
  settleLegacy(device:string,now:number) {
    const before=this.machines.get(device);
    if(before)this.credit(device,before,Math.min(now,before.at+CREDIT_MS));
  }

  /** Captured presence never strengthens history evidence or credits receipt-time work. */
  observed(device:string,user:string,sessions:(LiveSession&{source:string|null})[],at:number) {
    const next:Machine={at,user,sessions:sessions.map(s=>({...s,clientId:s.clientId??'unknown'}))};
    afterCommit(()=>{
      const old=this.machines.get(device);
      if(old&&old.at>=at)return;
      if(next.sessions.length)this.machines.set(device,next);else this.machines.delete(device);
      this.store.clientSessionsChanged(user,device);
    });
  }

  private requiresIntervals(device:string):boolean {
    return !!this.store.db.prepare('SELECT 1 FROM device_activity WHERE device_id=? AND requires_intervals=1').get(device);
  }

  /** Forgets machines gone quiet, crediting their last list as a new one would have. */
  sweep(now: number) {
    for (const [device, machine] of this.machines) {
      if (now - machine.at <= KEEP_MS) continue;
      this.credit(device, machine, machine.at + CREDIT_MS);
      this.machines.delete(device);
      this.store.clientSessionsChanged(machine.user,device);
    }
  }

  /** Devices taken off the hub stop showing at once. */
  forget(devices: string[]) {
    for (const device of devices) {
      const before = this.machines.get(device);
      this.machines.delete(device);
      if (before) this.store.clientSessionsChanged(before.user,device);
    }
  }

  /** The subscriptions a machine's list shows agents on. */
  sourcesOf(device: string, now = Date.now()): string[] {
    const machine = this.machines.get(device);
    if (!machine || now - machine.at > KEEP_MS) return [];
    return [...new Set(this.store.resolveSessions(machine.user, device, keysOf(machine), now).flatMap(s => s.source ? [s.source] : []))];
  }

  /** An opaque join key for the same stable context in authorized stream and period projections. */
  binding(device:string, client:string, source:string|null, producer:string|null, origin:Origin, project:string|null, folder:string|null) {
    if(!producer)return undefined;
    return createHmac('sha256',this.presenceSecret).update(JSON.stringify([device,client,source,producer,origin,project??'',folder??''])).digest('base64url').slice(0,16);
  }

  /** Only a producer's stable identity can enrich a retained context with current presence. */
  presence(device:string, client:string, source:string|null, producer:string|null, origin:Origin, project:string|null, folder:string|null, now:number) {
    return this.presenceIn(this.machines,device,client,source,producer,origin,project,folder,now);
  }

  /** Reports replace these lists, so a retained map keeps one request's presence cut. */
  presenceSnapshot(reserve:(bytes:number)=>void,include:(device:string,user:string,source:string|null)=>boolean):Sessions['presence'] {
    const machines=new Map<string,Machine>();
    for(const [id,machine] of this.machines){
      let sessions:StoredSession[]|undefined;
      for(const session of machine.sessions)if(include(id,machine.user,session.source)){
        const bytes=768+2*(session.project?.length??0)+2*(session.folder?.length??0)+2*session.device.name.length;
        reserve(bytes+(sessions?0:128));(sessions??=[]).push(session);
      }
      if(sessions)machines.set(id,{...machine,sessions});
    }
    return (...args)=>this.presenceIn(machines,...args);
  }
  private presenceIn(machines:ReadonlyMap<string,Machine>,device:string,client:string,source:string|null,producer:string|null,origin:Origin,project:string|null,folder:string|null,now:number) {
    if(!producer)return undefined;
    const machine=machines.get(device);
    if(!machine||now>machine.at+KEEP_MS)return undefined;
    const session=machine.sessions.find(s=>s.clientId===client&&s.source===source&&s.sessionId===producer&&s.origin===origin&&(s.project??'')===(project??'')&&(s.folder??'')===(folder??''));
    return session?{working:session.working&&now<machine.at+CREDIT_MS,through:machine.at+KEEP_MS+1,workingThrough:machine.at+CREDIT_MS,startedAt:session.startedAt}:undefined;
  }

  /**
   * The sessions running on a subscription on the machines of `people` (those on the
   * board read who measure it, whoever brought it there), by machine name and then by age,
   * each with how long it has worked as credited so far: up to its machine's latest list.
   */
  of(source: string, people: string[], now: number): BoardSession[] {
    const found: BoardSession[] = [];
    for (const [id, machine] of this.machines) {
      if (now - machine.at > KEEP_MS || !people.includes(machine.user)) continue;
      if (!this.store.holds(machine.user, source)) continue;
      const keys = keysOf(machine);
      const resolved = this.store.resolveSessions(machine.user, id, keys, now);
      const selected = machine.sessions.flatMap((s, i) => resolved[i].source === source ? [{s, key: keys[i]}] : []);
      const worked = this.store.worked(id, selected.map(s => s.key), 0, now);
      const present = this.presenter(machine.user,id,now);
      selected.forEach(({s}, i) => found.push(present(s, worked[i])));

    }
    return found.sort((a, b) => a.device.name.localeCompare(b.device.name) || a.device.id.localeCompare(b.device.id) || a.startedAt - b.startedAt);
  }

  /** One admitted collection is split once into disjoint subscription and fallback slices. */
  board(access:WorkAccess,now:number) {
    const sessions=new Map<string,BoardSession[]>(),unattributedSessions:BoardSession[]=[],ends:number[]=[];
    for(const [id,machine] of this.machines){
      const scope=admitted(access,id,machine.user);if(!scope||now-machine.at>KEEP_MS)continue;
      const keys=keysOf(machine),resolved=this.store.resolveSessions(machine.user,id,keys,now,access.attribution),worked=this.store.worked(id,keys,access.owner===null?scope.from:0,now,access.attribution),present=this.presenter(machine.user,id,now);
      machine.sessions.forEach((s,i)=>{const funding=fundingOf(access,machine.user,resolved[i].source),row={...present(s,worked[i]),...(funding.sourceStatus?{sourceStatus:funding.sourceStatus}:{})};
        if(funding.source===null)unattributedSessions.push(row);else {let list=sessions.get(funding.source);if(!list)sessions.set(funding.source,list=[]);list.push(row);}
      });
      ends.push(...this.deadlines(machine,now,()=>true));
      const boundary=this.deadline(now,KEEP_MS,m=>m===machine);if(boundary!==null)ends.push(boundary);
    }
    const sort=(a:BoardSession,b:BoardSession)=>a.device.name.localeCompare(b.device.name)||a.device.id.localeCompare(b.device.id)||a.startedAt-b.startedAt;
    for(const list of sessions.values())list.sort(sort);unattributedSessions.sort(sort);
    return {sessions,unattributedSessions,changesAt:ends.length?Math.min(...ends):null};
  }

  /** When a current list stops confirming work or presence without another report. */
  ofChangesAt(source: string, people: string[], now: number): number | null {
    return this.deadline(now, KEEP_MS, machine => people.includes(machine.user) && this.store.holds(machine.user, source), source);
  }

  /** Whether an agent works on a subscription on any machine, by lists that still count as true. */
  working(source: string, now: number): boolean {
    for (const [device, machine] of this.machines) {
      if (now - machine.at > CREDIT_MS || !this.store.holds(machine.user, source)) continue;
      const resolved = this.store.resolveSessions(machine.user, device, keysOf(machine), now);
      if (machine.sessions.some((s, i) => s.working && resolved[i].source === source)) return true;
    }
    return false;
  }

  /** When `working` may answer otherwise with no new list: a list that says an agent works stops counting. */
  workingChangesAt(source: string, now: number): number | null {
    return this.deadline(now, CREDIT_MS, machine => this.store.holds(machine.user, source) && machine.sessions.some(s => s.working), source);
  }

  /** Unknown and unheld work is private to the owner's personal board. */
  own(user: string, board: string, now: number): BoardSession[] {
    if (this.store.privateOwner(board) !== user) return [];
    return this.privateSessions(user, now);
  }

  privateSessions(user: string, now: number, device?: string): BoardSession[] {
    const found: BoardSession[] = [];
    for (const [id, machine] of this.machines) {
      if (machine.user !== user || now - machine.at > KEEP_MS || device !== undefined && id !== device) continue;
      const keys = keysOf(machine);
      const resolved = this.store.resolveSessions(user, id, keys, now);
      const selected = machine.sessions.flatMap((s, i) => resolved[i].source === null ? [{s, key: keys[i]}] : []);
      const worked = this.store.worked(id, selected.map(s => s.key),0,now);
      const present = this.presenter(user,id,now);
      selected.forEach(({s}, i) => found.push(present(s, worked[i])));
    }
    return found.sort((a, b) => a.device.name.localeCompare(b.device.name) || a.device.id.localeCompare(b.device.id) || a.startedAt - b.startedAt);
  }

  deviceSessions(user: string, device: string, now: number): (BoardSession & {source: string | null})[] {
    const machine = this.machines.get(device);
    if (!machine || machine.user !== user || now - machine.at > KEEP_MS) return [];
    const worked = this.store.worked(device, keysOf(machine),0,now);
    const present = this.presenter(user, device, now, false);
    const resolved=this.store.resolveSessions(user,device,keysOf(machine),now);
    return machine.sessions.map((session,i)=>({...present(session,worked[i]),source:resolved[i].source}));
  }

  /** Owner-device presence is independent of the board currently open, including hidden sources. */
  devices(user: string, now: number) {
    return [...this.machines].filter(([, machine]) => machine.user === user && now-machine.at <= KEEP_MS)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([device]) => ({device, sessions: this.deviceSessions(user, device, now)}));
  }

  suggestions(user: string, now: number): LinkInput[] {
    const context = this.store.links.batch([user]), found = new Map<string, LinkInput>();
    for (const [device, machine] of this.machines) {
      if (machine.user !== user || now - machine.at > KEEP_MS) continue;
      for (const s of machine.sessions) {
        const input = {...s, clientId: s.clientId, deviceId: device};
        const candidate = suggestion(input, context(user, device, s.clientId), now, s.startedAt);
        if (!candidate) continue;
        const key = JSON.stringify([device, s.clientId, candidate.route]);
        const old = found.get(key); if (old) old.from = Math.min(old.from, candidate.from); else found.set(key, candidate);
      }
    }
    return [...found.values()];
  }

  /** Detailed evidence has its own owner endpoint, never a shared session field. */
  attributions(user: string, now: number): (Attribution & {deviceId: string; clientId: string; startedAt: number; project: string | null; accountSourceId: string | null; host?: string})[] {
    const context = this.store.links.batch([user]), result = [];
    for (const [deviceId, machine] of this.machines) {
      if (machine.user !== user || now - machine.at > KEEP_MS) continue;
      const keys = keysOf(machine), resolved = this.store.resolveSessions(user, deviceId, keys, now);
      for (let i = 0; i < machine.sessions.length; i++) {
        const s = machine.sessions[i], policy = context(user, deviceId, s.clientId);
        result.push({...resolved[i], deviceId, clientId: s.clientId, startedAt: s.startedAt, project: s.project, accountSourceId: s.source && policy.held.has(s.source) ? s.source : null,
          ...(policy.routeEnabled && s.route?.host ? {host: s.route.host} : {})});
      }
    }
    return result;
  }

  devicesChangesAt(user: string, now: number): number | null {
    return this.deadline(now, KEEP_MS, machine => machine.user === user);
  }

  ownChangesAt(user: string, board: string, now: number): number | null {
    if (this.store.privateOwner(board) !== user) return null;
    return this.deadline(now, KEEP_MS, machine => machine.user === user);
  }

  /** Future link boundaries use the same hub clock as presence expiry. */
  private deadline(now: number, keep: number, eligible: (machine: Machine) => boolean, source?: string): number | null {
    const machines = [...this.machines].filter(([, machine]) => now - machine.at <= keep && eligible(machine));
    if (!machines.length) return null;
    const contexts = this.store.links.batch([...new Set(machines.map(([, machine]) => machine.user))]);
    let next = Infinity;
    for (const [device, machine] of machines) {
      for (const s of machine.sessions) {
        const context = contexts(machine.user, device, s.clientId), input = {...s, clientId: s.clientId, deviceId: device};
        if (source !== undefined && (keep === CREDIT_MS && !s.working || !splitLinks(input, context, now, machine.at + keep + 1).some(part => part.source === source))) continue;
        next = Math.min(next, machine.at + keep + 1);
        const route = safeRoute(s.route, context.routeEnabled).route;
        for (const link of context.links) if (matches(link, input, route, link.from)) {
          if (link.from > now) next = Math.min(next, link.from);
          if (link.to !== null && link.to > now) next = Math.min(next, link.to);
        }
      }
    }
    return Number.isFinite(next) ? next : null;
  }

  /** Renewals move the hub's timer, not the board's unchanged presence. */
  private deadlines(machine: Machine, now: number, selected: (session: StoredSession) => boolean): number[] {
    return [machine.at + KEEP_MS + 1, ...(now < machine.at + CREDIT_MS && machine.sessions.some(s => selected(s) && s.working) ? [machine.at + CREDIT_MS] : [])];
  }

  private presenter(user: string, id: string, now: number, includePresence = true): (session: StoredSession, workedMs: number | null) => BoardSession {
    const names = this.store.projectNames(user);
    const alias = this.store.db.prepare('SELECT COALESCE(label,name) AS name FROM devices WHERE id=?').get(id) as {name:string} | undefined;
    const contexts=this.store.links.batch([user]);
    const workingUntil=this.machines.get(id)!.at+CREDIT_MS;
    return ({clientId, source, sessionId, device, origin, project, folder, startedAt, lastWorkedAt, working,route}, workedMs) => {
      const presenceKey=includePresence?this.binding(id,clientId,source,sessionId,origin,project,folder):undefined;
      const evidence=presenceKey?this.presence(id,clientId,source,sessionId,origin,project,folder,now):undefined;
      const currentPresence=evidence?{working:evidence.working,startedAt:evidence.startedAt}:undefined;
      const safe=safeRoute(route,contexts(user,id,clientId).routeEnabled).route;
      const shown = project === null ? null : (names.get(project) ?? project);
      return {...(presenceKey?{presenceKey,currentPresence}:{}),clientId,...(safe?{route:safe}:{}), device: alias ? {...device,name:alias.name} : device, origin, project: shown, folder: folder ?? (shown !== project ? project : null), startedAt, lastWorkedAt, working:includePresence?working&&now<workingUntil:working, workedMs};
    };
  }

  /**
   * Credits the working sessions of a machine's list with the time from its report to
   * `until`; the store leaves out what a clock set back would credit twice.
   */
  private credit(device: string, machine: Machine, until: number) {
    if(this.requiresIntervals(device))return;
    const from = machine.at;
    if (until <= from) return;
    const keys = keysOf(machine);
    const working = machine.sessions.flatMap((session, i) => session.working ? [keys[i]] : []);
    this.store.creditWork(device, from, until, working);
  }
}
