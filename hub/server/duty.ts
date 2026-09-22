/**
 * One measurer per subscription. Devices check in before they measure; the hub lets
 * one of them — the one on duty — measure each subscription and asks the others to
 * wait. Duty sticks with its holder while it keeps delivering, moves to a device where
 * someone is working when the holder is idle, and passes on when the holder goes quiet.
 *
 * Kept in memory: after a restart the first devices to check in simply take duty again.
 */

/** A holder that has not delivered yet keeps duty this long. */
const FIRST_LEASE_MS = 5 * 60_000;
/** How long a waiting device sleeps before asking again: sooner where someone works. */
const WAIT_ACTIVE_MS = 60_000;
const WAIT_IDLE_MS = 10 * 60_000;
/** Duty moves to a working device only when its holder has been idle this long. */
const HANDOVER_IDLE_MS = 10 * 60_000;

type Holder = {device: string; until: number; activeAt: number};

export type Directive = {measure: boolean; until: number};

export class Duty {
  private readonly holders = new Map<string, Holder>();

  private key(board: string, subscription: string) {
    return `${board}\n${subscription}`;
  }

  /** A device asks whether it should measure a subscription now. */
  claim(board: string, subscription: string, device: string, active: boolean, now: number): Directive {
    const key = this.key(board, subscription);
    const holder = this.holders.get(key);
    const mine = holder?.device === device;
    const activeAt = active ? now : mine ? holder!.activeAt : 0;

    if (!holder || mine || holder.until <= now) {
      // Asking again does not extend a lease: only delivering does.
      const until = mine && holder!.until > now ? holder!.until : now + FIRST_LEASE_MS;
      this.holders.set(key, {device, until, activeAt});
      return {measure: true, until: now};
    }
    if (active && now - holder.activeAt > HANDOVER_IDLE_MS) {
      this.holders.set(key, {device, until: now + FIRST_LEASE_MS, activeAt: now});
      return {measure: true, until: now};
    }
    return {measure: false, until: Math.min(holder.until, now + (active ? WAIT_ACTIVE_MS : WAIT_IDLE_MS))};
  }

  /** A measurement arrived: its sender holds duty until the measurement goes stale. */
  delivered(board: string, subscription: string, device: string, observedAt: number, staleAfterMs: number, now: number) {
    const key = this.key(board, subscription);
    const holder = this.holders.get(key);
    if (holder && holder.device !== device && holder.until > now) return;
    const activeAt = holder?.device === device ? holder.activeAt : 0;
    this.holders.set(key, {device, until: Math.max(observedAt + staleAfterMs, now + 30_000), activeAt});
  }

  holder(board: string, subscription: string): string | null {
    return this.holders.get(this.key(board, subscription))?.device ?? null;
  }
}
