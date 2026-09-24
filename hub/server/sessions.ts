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

/** A machine's sessions, by the subscription they spend, as its agent last reported them. */
type Machine = {at: number; user: string; sources: Map<string, LiveSession[]>};

/** A machine's list is kept this long after its last report (its agent reports at least every two minutes). */
export const KEEP_MS = 5 * 60_000;
/**
 * A list counts as true until the next one, but for at most this long: an agent with
 * anything running reports at least every two minutes, so a machine quiet for longer
 * stopped working, and is not credited for its silence.
 */
export const CREDIT_MS = 150_000;
/** How far back the time any agent worked on a subscription is remembered, to count overlaps once. */
const BUSY_MEMORY_MS = 2 * 3_600_000;

/**
 * The coding agents running on people's machines right now (spec: Reporting running
 * agents). Only the latest list of each machine is kept, in memory: after a restart the
 * agents send theirs again within minutes. What the lists said is added up as time
 * agents worked on each subscription (Store.addWork): agent time adds up across
 * machines, the time any of them worked counts overlaps once.
 */
export class Sessions {
  private readonly machines = new Map<string, Machine>();
  /** Recently credited stretches of time any agent worked, per subscription. */
  private readonly busy = new Map<string, [number, number][]>();

  constructor(private readonly store: Store) {}

  /** A machine's new list, from its person `user`, each session filed under its subscription. */
  report(device: string, user: string, sessions: (LiveSession & {source: string})[], now: number) {
    this.sweep(now);
    const before = this.machines.get(device);
    if (before) this.credit(before, Math.min(now, before.at + CREDIT_MS));
    const sources = new Map<string, LiveSession[]>();
    for (const {source, ...session} of sessions) sources.set(source, [...(sources.get(source) ?? []), session]);
    if (sources.size) this.machines.set(device, {at: now, user, sources});
    else this.machines.delete(device);
  }

  /** Forgets machines gone quiet, crediting their last list as a new one would have. */
  sweep(now: number) {
    for (const [device, machine] of this.machines) {
      if (now - machine.at <= KEEP_MS) continue;
      this.credit(machine, machine.at + CREDIT_MS);
      this.machines.delete(device);
    }
    for (const [source, stretches] of this.busy) {
      const recent = stretches.filter(([, to]) => to > now - BUSY_MEMORY_MS);
      if (recent.length) this.busy.set(source, recent);
      else this.busy.delete(source);
    }
  }

  /** Devices taken off the hub stop showing at once. */
  forget(devices: string[]) {
    for (const device of devices) this.machines.delete(device);
  }

  /**
   * The sessions running on a subscription on the machines of `people` (those who show
   * it on the board read), by machine name and then by age.
   */
  of(source: string, people: string[], now: number): LiveSession[] {
    const found: LiveSession[] = [];
    for (const machine of this.machines.values()) {
      if (now - machine.at > KEEP_MS || !people.includes(machine.user)) continue;
      found.push(...(machine.sources.get(source) ?? []));
    }
    return found.sort((a, b) => a.device.name.localeCompare(b.device.name) || a.device.id.localeCompare(b.device.id) || a.startedAt - b.startedAt);
  }

  /** Credits a machine's list from its report to `until`. */
  private credit(machine: Machine, until: number) {
    const from = machine.at;
    if (until <= from) return;
    for (const [source, sessions] of machine.sources) {
      const agents = sessions.filter(s => s.working).length;
      if (!agents) continue;
      this.store.addWork(source, from, until, agents);
      // Only what no other machine was credited for already.
      const stretches = this.busy.get(source) ?? [];
      let pieces: [number, number][] = [[from, until]];
      for (const [start, end] of stretches) {
        pieces = pieces.flatMap(([a, b]): [number, number][] =>
          end <= a || start >= b ? [[a, b]] : ([[a, start], [end, b]] as [number, number][]).filter(([x, y]) => y > x),
        );
      }
      for (const [a, b] of pieces) this.store.addBusy(source, a, b);
      stretches.push([from, until]);
      this.busy.set(source, stretches);
    }
  }
}
