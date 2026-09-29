/**
 * One measurer per subscription, whoever's devices measure it and whatever boards show
 * it. Devices check in before they measure; the hub lets
 * one of them — the one on duty — measure each subscription and asks the others to
 * wait. Duty sticks with its holder while it keeps delivering, moves to a device where
 * someone is working when the holder is idle, and passes on when the holder goes quiet.
 *
 * Kept in memory: after a restart the first devices to check in simply take duty again.
 */

import {CLOCK_TOLERANCE_MS} from './domain/ingest.js';

/** A holder that has not delivered yet keeps duty this long; one told to measure, at most this long while it does. */
const FIRST_LEASE_MS = 5 * 60_000;
/** How long a waiting device sleeps before asking again: sooner where someone works. */
const WAIT_ACTIVE_MS = 60_000;
const WAIT_IDLE_MS = 10 * 60_000;
/** Duty moves to a working device only when its holder has been idle this long. */
const HANDOVER_IDLE_MS = 10 * 60_000;

/**
 * `askedAt`: when the holder was last told to measure, until it answers.
 * `answering`: false once it asked again leaving a command unanswered; until it answers
 * one, being told to measure keeps it no duty. Asking again, it is no longer measuring.
 */
type Holder = {device: string; until: number; activeAt: number; askedAt: number | null; answering: boolean};

/**
 * How long a holder keeps duty: until its measurement goes stale, and while it measures one
 * it was told to. It asks nothing meanwhile, so its lease might otherwise run out halfway
 * through its providers and pass to a device that would measure the same again.
 */
const leaseOf = (holder: Holder) => Math.max(holder.until, holder.askedAt !== null && holder.answering ? holder.askedAt + FIRST_LEASE_MS : 0);
const measuring = (holder: Holder, now: number) => holder.askedAt !== null && holder.answering && holder.askedAt + FIRST_LEASE_MS > now;

/** Whether something taken at `at` answers what the holder was told to measure (the pace's rule, spec). */
const answers = (holder: Holder, at: number) => holder.askedAt !== null && at >= holder.askedAt - CLOCK_TOLERANCE_MS;

export type Directive = {measure: boolean; until: number};

export class Duty {
  private readonly holders = new Map<string, Holder>();

  /** A device asks whether it should measure a subscription now. */
  claim(subscription: string, device: string, active: boolean, now: number): Directive {
    const holder = this.holders.get(subscription);
    const mine = holder?.device === device;
    const activeAt = active ? now : mine ? holder!.activeAt : 0;

    if (!holder || mine || leaseOf(holder) <= now) {
      // Asking again does not extend a lease: only delivering does. A holder that asks is no
      // longer measuring what it was told to, answered or not. Left unanswered, the command
      // keeps it on duty no longer than the devices waiting were told: past its measurement
      // going stale, until the five minutes end, as it might otherwise take a new lease
      // before they come back.
      // A command on record is one it left unanswered, asking: it answers no longer, until an
      // answer to it comes, however late.
      const answering = !mine || holder!.askedAt === null;
      const askedAt = mine ? holder!.askedAt : null;
      this.holders.set(
        subscription,
        mine && leaseOf(holder!) > now
          ? {...holder!, until: holder!.until > now ? holder!.until : leaseOf(holder!), activeAt, askedAt, answering}
          : {device, until: now + FIRST_LEASE_MS, activeAt, askedAt, answering},
      );
      return {measure: true, until: now};
    }
    // Nor does a device where someone works take over halfway through the holder's measuring.
    if (active && now - holder.activeAt > HANDOVER_IDLE_MS && !measuring(holder, now)) {
      this.holders.set(subscription, {device, until: now + FIRST_LEASE_MS, activeAt: now, askedAt: null, answering: true});
      return {measure: true, until: now};
    }
    // Come back when its measurement goes stale, as if it were not measuring: it may ask
    // again first without answering. Only then, while it measures, when the five minutes end.
    const lease = holder.until > now ? holder.until : leaseOf(holder);
    return {measure: false, until: Math.min(lease, now + (active ? WAIT_ACTIVE_MS : WAIT_IDLE_MS))};
  }

  /** The holder was told to measure: it keeps duty while it does, as a new holder does until it delivers. */
  asked(subscription: string, device: string, now: number) {
    const holder = this.holders.get(subscription);
    if (holder?.device === device) this.holders.set(subscription, {...holder, askedAt: now});
  }

  /** The holder failed to measure: done measuring, it keeps duty only as long as its last measurement. */
  failed(subscription: string, device: string, at: number) {
    const holder = this.holders.get(subscription);
    if (holder?.device === device && answers(holder, at)) this.holders.set(subscription, {...holder, askedAt: null, answering: true});
  }

  /** A measurement arrived: its sender holds duty until the measurement goes stale. */
  delivered(subscription: string, device: string, observedAt: number, staleAfterMs: number, now: number) {
    const holder = this.holders.get(subscription);
    if (holder && holder.device !== device && leaseOf(holder) > now) return;
    const mine = holder?.device === device;
    const activeAt = mine ? holder.activeAt : 0;
    // An older measurement, sent late, does not answer what the holder is measuring now.
    const late = mine && !answers(holder, observedAt);
    const [askedAt, answering] = late ? [holder.askedAt, holder.answering] : [null, true];
    this.holders.set(subscription, {device, until: Math.max(observedAt + staleAfterMs, now + 30_000), activeAt, askedAt, answering});
  }

  holder(subscription: string): string | null {
    return this.holders.get(subscription)?.device ?? null;
  }

  /** When the holder's lease runs out. */
  until(subscription: string): number | null {
    const holder = this.holders.get(subscription);
    return holder ? leaseOf(holder) : null;
  }

  /** When the holder last said its client is in use. */
  activeAt(subscription: string): number | null {
    return this.holders.get(subscription)?.activeAt || null;
  }
}
