import type {Origin} from './domain/ingest.js';
import type {Store} from './store/store.js';

/** A running coding agent as a board shows it, on the card of the subscription it spends. */
export type LiveSession = {
  device: {id: string; name: string};
  origin: Origin;
  project: string | null;
  startedAt: number;
  working: boolean;
};

/** A machine's sessions, each filed under its subscription, as its agent last reported them. */
type Machine = {at: number; sessions: (LiveSession & {source: string})[]};

/** A machine's list is kept this long after its last report (its agent reports at least every two minutes). */
export const KEEP_MS = 5 * 60_000;

/**
 * The coding agents running on people's machines right now (spec: Reporting running
 * agents). Only the latest list of each machine is kept, in memory: after a restart the
 * agents send theirs again within minutes. What the lists said is added up as time
 * agents worked on each subscription (Store.addWork): each report credits the list
 * before it for the time in between, up to `KEEP_MS`, so a machine that went quiet is
 * not credited for its silence.
 */
export class Sessions {
  private readonly machines = new Map<string, Machine>();

  constructor(private readonly store: Store) {}

  report(device: string, sessions: Machine['sessions'], now: number) {
    const before = this.machines.get(device);
    if (before) {
      const working = new Map<string, number>();
      for (const session of before.sessions) if (session.working) working.set(session.source, (working.get(session.source) ?? 0) + 1);
      for (const [source, agents] of working) this.store.addWork(source, before.at, Math.min(now, before.at + KEEP_MS), agents);
    }
    if (sessions.length) this.machines.set(device, {at: now, sessions});
    else this.machines.delete(device);
  }

  /** A device taken off the hub stops showing at once. */
  forget(device: string) {
    this.machines.delete(device);
  }

  /** The sessions running on a subscription, by machine name and then by age. */
  of(source: string, now: number): LiveSession[] {
    const found: LiveSession[] = [];
    for (const [device, machine] of this.machines) {
      if (now - machine.at > KEEP_MS) {
        this.machines.delete(device);
        continue;
      }
      for (const {source: of, ...session} of machine.sessions) if (of === source) found.push(session);
    }
    return found.sort((a, b) => a.device.name.localeCompare(b.device.name) || a.device.id.localeCompare(b.device.id) || a.startedAt - b.startedAt);
  }
}
