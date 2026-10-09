import type {SessionEvidence} from './domain/sessionEvidence.js';
import type {Origin} from './domain/ingest.js';
import type {Store, WorkKey} from './store/store.js';

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
  clientId?: string;
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

  constructor(private readonly store: Store) {}

  /** A machine's new list, from its person `user`, each session filed under its subscription. */
  report(device: string, user: string, sessions: (LiveSession & {source: string | null})[], now: number) {
    this.sweep(now);
    const before = this.machines.get(device);
    if (before) this.credit(device, before, Math.min(now, before.at + CREDIT_MS));
    const normalized = sessions.map(s => ({...s, clientId: s.clientId ?? s.source?.split(':')[0] ?? 'unknown'}));
    if (normalized.length) this.machines.set(device, {at: now, user, sessions: normalized});
    else this.machines.delete(device);
    this.store.clientSessionsChanged(user);

  }

  /** Forgets machines gone quiet, crediting their last list as a new one would have. */
  sweep(now: number) {
    for (const [device, machine] of this.machines) {
      if (now - machine.at <= KEEP_MS) continue;
      this.credit(device, machine, machine.at + CREDIT_MS);
      this.machines.delete(device);
      this.store.clientSessionsChanged(machine.user);
    }
  }

  /** Devices taken off the hub stop showing at once. */
  forget(devices: string[]) {
    for (const device of devices) {
      const before = this.machines.get(device);
      this.machines.delete(device);
      if (before) this.store.clientSessionsChanged(before.user);
    }
  }

  /** The subscriptions a machine's list shows agents on. */
  sourcesOf(device: string): string[] {
    return [...new Set((this.machines.get(device)?.sessions ?? []).flatMap(s => s.source ? [s.source] : []))];
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
      const selected = machine.sessions.flatMap((s, i) => s.source === source ? [{s, key: keys[i]}] : []);
      const worked = this.store.worked(id, selected.map(s => s.key));
      const present = this.presenter(machine.user, id);
      selected.forEach(({s}, i) => found.push(present(s, worked[i])));

    }
    return found.sort((a, b) => a.device.name.localeCompare(b.device.name) || a.device.id.localeCompare(b.device.id) || a.startedAt - b.startedAt);
  }

  /** When `of` answers otherwise with no new list: a machine's list shown now stops showing. Null when only a new list changes it. */
  ofChangesAt(source: string, people: string[], now: number): number | null {
    const ends = [...this.machines.values()].filter(m => now - m.at <= KEEP_MS && people.includes(m.user) && this.store.holds(m.user, source) && m.sessions.some(s => s.source === source)).map(m => m.at + KEEP_MS + 1);
    return ends.length ? Math.min(...ends) : null;
  }

  /** Whether an agent works on a subscription on any machine, by lists that still count as true. */
  working(source: string, now: number): boolean {
    for (const machine of this.machines.values()) {
      if (now - machine.at <= CREDIT_MS && this.store.holds(machine.user, source) && machine.sessions.some(s => s.source === source && s.working)) return true;
    }
    return false;
  }

  /** When `working` may answer otherwise with no new list: a list that says an agent works stops counting. */
  workingChangesAt(source: string, now: number): number | null {
    const ends = [...this.machines.values()].filter(m => now - m.at <= CREDIT_MS && this.store.holds(m.user, source) && m.sessions.some(s => s.source === source && s.working)).map(m => m.at + CREDIT_MS + 1);
    return ends.length ? Math.min(...ends) : null;
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
      const selected = machine.sessions.flatMap((s, i) => this.store.displaySource(user, s.source) === null ? [{s, key: keys[i]}] : []);
      const worked = this.store.worked(id, selected.map(s => s.key));
      const present = this.presenter(user, id);
      selected.forEach(({s}, i) => found.push(present(s, worked[i])));
    }
    return found.sort((a, b) => a.device.name.localeCompare(b.device.name) || a.device.id.localeCompare(b.device.id) || a.startedAt - b.startedAt);
  }

  deviceSessions(user: string, device: string, now: number): (BoardSession & {source: string | null})[] {
    const machine = this.machines.get(device);
    if (!machine || machine.user !== user || now - machine.at > KEEP_MS) return [];
    const worked = this.store.worked(device, keysOf(machine));
    const present = this.presenter(user, device);
    return machine.sessions.map((session, i) => ({...present(session, worked[i]), source: this.store.displaySource(user, session.source)}));
  }

  /** Owner-device presence is independent of the board currently open, including hidden sources. */
  devices(user: string, now: number) {
    return [...this.machines].filter(([, machine]) => machine.user === user && now-machine.at <= KEEP_MS)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([device]) => ({device, sessions: this.deviceSessions(user, device, now)}));
  }

  devicesChangesAt(user: string, now: number): number | null {
    const deadlines = [...this.machines.values()].filter(m => m.user === user && now-m.at <= KEEP_MS).map(m => m.at+KEEP_MS+1);
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  ownChangesAt(user: string, board: string, now: number): number | null {
    if (this.store.privateOwner(board) !== user) return null;
    const deadlines = [...this.machines.values()].filter(m => m.user === user && now - m.at <= KEEP_MS && m.sessions.some(s => this.store.displaySource(user, s.source) === null)).map(m => m.at + KEEP_MS + 1);
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  private presenter(user: string, id: string): (session: StoredSession, workedMs: number | null) => BoardSession {
    const names = this.store.projectNames(user);
    const alias = this.store.db.prepare('SELECT COALESCE(label,name) AS name FROM devices WHERE id=?').get(id) as {name:string} | undefined;
    return ({clientId, device, origin, project, folder, startedAt, lastWorkedAt, working}, workedMs) => {
      const shown = project === null ? null : (names.get(project) ?? project);
      return {clientId, device: alias ? {...device,name:alias.name} : device, origin, project: shown, folder: folder ?? (shown !== project ? project : null), startedAt, lastWorkedAt, working, workedMs};
    };
  }

  /**
   * Credits the working sessions of a machine's list with the time from its report to
   * `until`; the store leaves out what a clock set back would credit twice.
   */
  private credit(device: string, machine: Machine, until: number) {
    const from = machine.at;
    if (until <= from) return;
    const keys = keysOf(machine);
    const working = machine.sessions.flatMap((session, i) => session.working ? [keys[i]] : []);
    this.store.creditWork(device, from, until, working);
  }
}
