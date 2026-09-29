/**
 * When a subscription is measured, while its holder follows the hub's pace (spec: Asking
 * whether to measure). Duty decides who measures; this decides when, from what the hub
 * sees of the subscription everywhere: how much is left, whether it is in use on any
 * machine, whether its numbers just changed, when a window resets, whether the holder's
 * measurements fail. The holder asks every 15 seconds without starting its client and
 * measures only when told.
 *
 * Pure: the caller passes the time and the signals. Kept in memory next to duty: after a
 * restart the first holder to ask measures at once.
 */

import type {Win} from './domain/quota.js';
import {CLOCK_TOLERANCE_MS} from './domain/ingest.js';
import {REFRESH_KEEP_MS, REFRESH_WAIT_MS, type Refresh, type RefreshRequest} from './domain/refresh.js';

/** How often a holder asks while it waits for its next measurement. */
export const ASK_EVERY_MS = 15_000;
/** A holder's `active` counts as use for this long. */
export const ACTIVE_WITHIN_MS = 120_000;
const BASE_INTERVAL_MS = 120_000;
const IDLE_CAP_MS = 15 * 60_000;
/** Percent left in a window at or below which a subscription is measured more often. */
const LOW_LEFT = 10;
const RESET_GRACE_MS = 30_000;
/** The board shows no plan of a holder that has not asked for this long. */
const SILENT_AFTER_MS = 120_000;
/** The least interval a device may ask for, and the longest gap a measurement stays representative over (spec: `nextInMs`). */
const MIN_INTERVAL_MS = 60_000;
export const MAX_GAP_MS = (24 * 3_600_000 - 60_000) / 1.2;
/** When to tell again to measure after a `measure: true` nothing came back for: the first time, then each time after that. */
const UNANSWERED_MS = [90_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 15 * 60_000];
/** A measurement under way takes at most this long (the agent kills a client then): meanwhile the next one is the one being taken. */
const MEASURING_MS = 60_000;

/** Why the next measurement comes when it does, as the board says it. */
export type Why = 'low' | 'inUse' | 'changed' | 'idle' | 'reset';

/** What the hub knows of a subscription right now. */
export type Signals = {windows: Win[]; inUse: boolean};

/** The answer to a paced holder: measure now, or ask again in `askInMs`; `nextInMs` promises the next measurement after this one. */
export type Answer = {measure: boolean; onDuty: boolean; askInMs: number; nextInMs?: number};

type Pace = {
  /** How many times the idle interval has doubled: 1, 2, 4, 8. */
  stretch: number;
  /** The used percent of each window at the last measurement, and whether it differed from the one before. */
  signature: string | null;
  changed: boolean;
  /** When the last measurement was taken, and no later than when the next one is due by its own staleness. */
  lastAt: number | null;
  promiseAt: number | null;
  /** The last time its numbers changed or it was in use. */
  busyAt: number;
  /** Whom and when (by the hub's clock) the last `measure: true` went to, and whether a measurement or a failure came back since. */
  askedDevice: string | null;
  askedAt: number | null;
  answered: boolean;
  /** How many `measure: true` in a row got nothing back. */
  unanswered: number;
  /** The least interval of the asked device, and when it last asked. */
  minIntervalMs: number | null;
  askAt: number | null;
};

/** Failures in a row of one device's measurements of a subscription. */
type Pause = {count: number; kind: string; at: number};

/** How long a device waits after failing: at once for a client signed out or unfit, else longer each time in a row. */
function backOff(pause: Pause): number {
  if (pause.kind === 'not_logged_in' || pause.kind === 'unsupported') return IDLE_CAP_MS;
  return Math.min(BASE_INTERVAL_MS * 2 ** (pause.count - 1), IDLE_CAP_MS);
}

/** How often a subscription with little left is measured, by how long it has been quiet. */
function lowInterval(quietMs: number): number {
  if (quietMs < 3_600_000) return 60_000;
  if (quietMs < 3 * 3_600_000) return 120_000;
  return 300_000;
}

const signatureOf = (windows: {id: string; usedPercent: number}[]) =>
  JSON.stringify(windows.map(w => [w.id, Math.round(w.usedPercent * 100)]).sort(([a], [b]) => String(a).localeCompare(String(b))));

export type RefreshDuty = {holder: string | null; until: number | null; live: boolean};
type Request = {view: RefreshRequest; device: string; baseline: number | null; freshnessFrom: number};
type Capability = {paced: boolean; at: number; minIntervalMs: number | null};
const pending = (request: RefreshRequest) => request.finishedAt === null;

export class Cadence {
  private readonly requests = new Map<string, Request>();
  private readonly capabilities = new Map<string, Map<string, Capability>>();
  /** When each device last delivered, by the hub's clock. */
  private readonly heardAt = new Map<string, number>();

  /** The latest check-in of this subscription, including a return to the legacy protocol. */
  capability(key: string, device: string, paced: boolean, minIntervalMs: number | null, now: number) {
    let devices = this.capabilities.get(key);
    if (!devices) this.capabilities.set(key, (devices = new Map()));
    devices.set(device, {paced, at: now, minIntervalMs});
    const request = this.requests.get(key);
    if (request && pending(request.view) && request.device === device && request.view.dispatchAt === null) {
      request.view.notBefore = this.notBefore(this.paces.get(key), minIntervalMs, request.view.requestedAt);
      // A lowered minimum cannot move the wait into the past: it counts from when measuring may start.
      request.view.deadline = Math.max(request.view.notBefore, now) + REFRESH_WAIT_MS;
    }
  }

  /** One evaluator for reads and commands; reads never mutate a request. */
  refresh(key: string, duty: RefreshDuty, now: number): {value: Refresh; changesAt: number | null} {
    const capability = duty.holder === null ? undefined : this.capabilities.get(key)?.get(duty.holder);
    const pause = duty.holder === null ? null : this.pausedUntil(key, duty.holder, now);
    // Silence counts from the holder's last word: asking, or delivering what it measures one by
    // one after asking, for at most as long as it measures.
    const heardAt = capability ? Math.min(this.heardAt.get(duty.holder!) ?? capability.at, capability.at + REFRESH_WAIT_MS) : null;
    const silentAt = capability ? Math.max(capability.at, heardAt!) + SILENT_AFTER_MS + 1 : null;
    // A holder measuring what it was told to asks nothing: its silence is expected then.
    const working = this.workingUntil(key, duty.holder, capability, now);
    const unavailable: Refresh['unavailable'] =
      !duty.holder || !duty.live || duty.until === null || duty.until <= now
        ? 'no_device'
        : !capability?.paced
          ? 'unsupported'
          : silentAt! <= now && working === null
            ? 'silent'
            : pause !== null
              ? 'paused'
              : null;
    const stored = this.requests.get(key);
    let request = stored ? {...stored.view} : null;
    const changes: number[] = [];
    if (request && pending(request)) {
      const ends: {at: number; status: 'unavailable' | 'no_result'}[] = [{at: request.deadline, status: 'no_result'}];
      // A holder that asks keeps duty or takes it again, whatever its lease: only its silence
      // tells it is gone. Once told to measure, it measures its subscriptions one after
      // another, asking nothing meanwhile: its silence is not a loss then either.
      if (request.dispatchAt === null && silentAt !== null) ends.push({at: silentAt, status: 'unavailable'});
      if (duty.holder !== stored!.device || !duty.live || !capability?.paced || pause !== null) ends.push({at: now, status: 'unavailable'});
      ends.sort((a, b) => a.at - b.at);
      const end = ends[0];
      if (end.at <= now) request = {...request, status: end.status, finishedAt: end.at};
      else changes.push(end.at);
    }
    if (request?.finishedAt !== null && request?.finishedAt !== undefined) {
      const hideAt = request.finishedAt + REFRESH_KEEP_MS;
      if (hideAt <= now) request = null;
      else changes.push(hideAt);
    }
    const retryAt = stored && stored.view.requestedAt + MIN_INTERVAL_MS > now ? stored.view.requestedAt + MIN_INTERVAL_MS : null;
    for (const at of [duty.until, silentAt, working, pause, retryAt]) if (at !== null && at > now) changes.push(at);
    return {value: {unavailable, availableAt: unavailable === 'paused' ? pause : null, retryAt, request}, changesAt: changes.length ? Math.min(...changes) : null};
  }

  /** Freeze elapsed transitions before a mutation changes their evidence. */
  settleRefresh(key: string, duty: RefreshDuty, now: number) {
    const stored = this.requests.get(key);
    if (!stored) return;
    const {request} = this.refresh(key, duty, now).value;
    if (request) stored.view = request;
    else this.requests.delete(key);
  }

  requestRefresh(key: string, duty: RefreshDuty, baseline: number | null, now: number): {status: 'accepted' | 'unavailable' | 'too_soon'; retryAt?: number} {
    this.settleRefresh(key, duty, now);
    const state = this.refresh(key, duty, now).value;
    if (state.request && pending(state.request)) return {status: 'accepted'};
    if (state.retryAt !== null) return {status: 'too_soon', retryAt: state.retryAt};
    if (state.unavailable !== null) return {status: 'unavailable'};
    const pace = this.paces.get(key);
    const device = duty.holder!;
    const capability = this.capabilities.get(key)!.get(device)!;
    // Joins the command under way; one given up waits for its retry.
    const dispatchAt = this.workingUntil(key, device, capability, now) === null ? null : pace!.askedAt;
    const notBefore = this.notBefore(pace, capability.minIntervalMs, now);
    this.requests.set(key, {
      device,
      baseline,
      freshnessFrom: dispatchAt === null ? now : Math.min(now, dispatchAt),
      view: {
        requestedAt: now,
        notBefore,
        dispatchAt,
        deadline: (dispatchAt === null ? notBefore : Math.max(now, dispatchAt)) + REFRESH_WAIT_MS,
        status: dispatchAt === null ? 'queued' : 'waiting',
        finishedAt: null,
      },
    });
    return {status: 'accepted'};
  }

  /** Fresh data may come from any device; a failure belongs only to the bound device. */
  refreshResult(key: string, device: string, at: number, success: boolean, now: number) {
    const request = this.requests.get(key);
    if (!request || !pending(request.view) || at < request.freshnessFrom - CLOCK_TOLERANCE_MS) return;
    if (success ? request.baseline !== null && at <= request.baseline : device !== request.device) return;
    request.view = {...request.view, status: success ? 'updated' : 'failed', finishedAt: now};
  }

  /** Subscriptions known through check-ins or requests, even with no running sessions. */
  keysOf(devices: string[]): string[] {
    const keys = new Set<string>();
    for (const [key, capabilities] of this.capabilities) if (devices.some(device => capabilities.has(device))) keys.add(key);
    for (const [key, request] of this.requests) if (devices.includes(request.device)) keys.add(key);
    return [...keys];
  }

  /** A device delivered measurements or failures: none of its subscriptions is silent then. */
  heard(device: string, now: number) {
    this.heardAt.set(device, Math.max(now, this.heardAt.get(device) ?? now));
  }

  /** Revocation also reaches subscriptions with no running coding agents. */
  forget(devices: string[], now: number): string[] {
    for (const device of devices) this.heardAt.delete(device);
    const keys = new Set<string>();
    for (const [key, capabilities] of this.capabilities) for (const device of devices) if (capabilities.delete(device)) keys.add(key);
    for (const [key, request] of this.requests)
      if (devices.includes(request.device)) {
        keys.add(key);
        if (pending(request.view)) request.view = {...request.view, status: 'unavailable', finishedAt: now};
      }
    return [...keys];
  }

  /**
   * Until when the holder is measuring what it was told to, null when it is not: it asks
   * nothing while it measures its providers one by one. Asking again with no answer given
   * means the command was lost. At most as long as duty stays with it for that (Duty).
   */
  private workingUntil(key: string, holder: string | null, capability: Capability | undefined, now: number): number | null {
    const pace = this.paces.get(key);
    if (!holder || !capability || !pace || pace.askedDevice !== holder || pace.answered || pace.askedAt === null || capability.at > pace.askedAt) return null;
    const until = pace.askedAt + REFRESH_WAIT_MS;
    return until > now ? until : null;
  }

  /** The earliest a device may be told to measure: past its floor after the last measurement or command, and past the retry of a command left unanswered. */
  private notBefore(pace: Pace | undefined, minimum: number | null, fallback: number): number {
    const times = [pace?.lastAt, pace?.askedAt].filter((at): at is number => at != null);
    const at = times.length ? Math.max(fallback, Math.max(...times) + floorOf(minimum)) : fallback;
    return pace?.askedAt != null && !pace.answered ? Math.max(at, retryAt(pace, floorOf(minimum))) : at;
  }

  private readonly paces = new Map<string, Pace>();
  /** By subscription and device. */
  private readonly pauses = new Map<string, Pause>();
  /** The subscription each device was last told to measure, by device and provider: whose its failures are. */
  private readonly measured = new Map<string, string>();

  /** A measurement of subscription `key` was accepted; `busy` is whether it is in use as it arrives. */
  delivered(key: string, device: string, windows: {id: string; usedPercent: number}[], observedAt: number, staleAfterMs: number, busy: boolean, now: number) {
    const pace = this.pace(key, now);
    const signature = signatureOf(windows);
    if (pace.signature === null) {
      pace.stretch = 1;
      pace.changed = false;
    } else {
      pace.changed = signature !== pace.signature;
      pace.stretch = pace.changed || busy ? 1 : Math.min(pace.stretch * 2, 8);
    }
    if (pace.changed || busy) pace.busyAt = now;
    pace.signature = signature;
    // Never later than this measurement goes stale, whoever took it and however it was asked for.
    // Whole milliseconds: the times the hub answers with are whole numbers (spec).
    pace.promiseAt = observedAt + Math.ceil(Math.max(MIN_INTERVAL_MS, (staleAfterMs - 60_000) / 1.2));
    pace.lastAt = observedAt;
    this.answeredBy(pace, device, observedAt);
    const pause = this.pauses.get(pauseKey(key, device));
    if (pause && observedAt > pause.at) this.pauses.delete(pauseKey(key, device));
  }

  /** The subscription a device was last told to measure for a provider: its failures are about that one. */
  measuredBy(device: string, provider: string): string | null {
    return this.measured.get(`${device}\n${provider}`) ?? null;
  }

  /** A device failed to measure subscription `key` at `at`: it waits longer each time. Older failures and repeats count once. */
  failed(key: string, device: string, kind: string, at: number) {
    const pace = this.paces.get(key);
    const pause = this.pauses.get(pauseKey(key, device));
    if ((pace?.lastAt != null && at <= pace.lastAt) || (pause && at <= pause.at)) return false;
    this.pauses.set(pauseKey(key, device), {count: (pause?.count ?? 0) + 1, kind, at});
    if (pace) this.answeredBy(pace, device, at);
    return true;
  }

  /** When a device's pause after failing ends, if it is in one at `now`. */
  pausedUntil(key: string, device: string, now: number): number | null {
    const pause = this.pauses.get(pauseKey(key, device));
    if (!pause) return null;
    const end = pause.at + backOff(pause);
    return end > now ? end : null;
  }

  /** A paced holder of subscription `key` asks whether to measure now. */
  answer(key: string, device: string, provider: string, now: number, minIntervalMs: number | null, signals: Signals): Answer {
    const pace = this.pace(key, now);
    // In use as it asks: the pace counts its quiet from now. Only asks and measurements move it, so `view` stays a reading.
    if (signals.inUse) pace.busyAt = now;
    const floor = floorOf(minIntervalMs);
    if (pace.askedDevice !== null && pace.askedDevice !== device) {
      // A new holder measures at once, as a device taking duty always has; the old one's questions and failures are its own.
      pace.askedAt = null;
      pace.answered = false;
      pace.unanswered = 0;
      const paused = this.pausedUntil(key, device, now);
      if (paused !== null) return {measure: false, onDuty: true, askInMs: askIn(paused - now)};
      const {interval} = pace.lastAt === null ? {interval: BASE_INTERVAL_MS} : this.interval(pace, now, signals, floor);
      return this.ask(pace, key, device, provider, now, minIntervalMs, interval);
    }
    pace.minIntervalMs = minIntervalMs;
    pace.askAt = now;
    const plan = this.plan(pace, key, device, now, signals, floor);
    if (plan.at <= now) return this.ask(pace, key, device, provider, now, minIntervalMs, plan.interval);
    return {measure: false, onDuty: true, askInMs: askIn(plan.at - now)};
  }

  /**
   * When the next measurement of subscription `key` comes and why, for the board: only
   * while `holder`, on duty, follows the pace, asks and is not waiting out failures.
   */
  view(key: string, holder: string | null, now: number, signals: Signals): {next: number; why: Why} | null {
    return this.viewed(key, holder, now, signals).value;
  }

  /**
   * The first moment after `now` `view` may answer otherwise with nothing new told to the
   * hub and the same signals (the holder falls silent, a measurement under way is over, a
   * pause ends, a window with little left resets, the pace of a low one slows down); null
   * when only news changes it. Never later than the change, sometimes sooner.
   */
  viewChangesAt(key: string, holder: string | null, now: number, signals: Signals): number | null {
    return this.viewed(key, holder, now, signals).changesAt;
  }

  private viewed(key: string, holder: string | null, now: number, signals: Signals): {value: {next: number; why: Why} | null; changesAt: number | null} {
    const pace = this.paces.get(key);
    if (!pace || holder === null || pace.askedDevice !== holder || pace.lastAt === null || pace.askAt === null) return {value: null, changesAt: null};
    if (now - pace.askAt > SILENT_AFTER_MS) return {value: null, changesAt: null};
    const paused = this.pausedUntil(key, holder, now);
    if (paused !== null) return {value: null, changesAt: paused};
    const plan = this.plan(pace, key, holder, now, signals, floorOf(pace.minIntervalMs));
    // Told to measure and not heard from yet: the measurement is under way, the next one is that.
    const measuring = pace.askedAt !== null && !pace.answered && now - pace.askedAt <= MEASURING_MS;
    const changes = [pace.askAt + SILENT_AFTER_MS + 1, ...(measuring ? [pace.askedAt! + MEASURING_MS + 1] : []), ...intervalChanges(pace, now, signals)];
    return {value: {next: measuring ? pace.askedAt! : plan.at, why: plan.why as Why}, changesAt: Math.min(...changes)};
  }

  /** Tells a holder to measure now, promising the next measurement within twice the interval (it never slows down faster than that). */
  private ask(pace: Pace, key: string, device: string, provider: string, now: number, minIntervalMs: number | null, interval: number): Answer {
    const floor = floorOf(minIntervalMs);
    pace.unanswered = pace.askedAt !== null && !pace.answered ? pace.unanswered + 1 : 0;
    pace.askedDevice = device;
    pace.askedAt = now;
    pace.answered = false;
    pace.minIntervalMs = minIntervalMs;
    pace.askAt = now;
    this.measured.set(`${device}\n${provider}`, key);
    const request = this.requests.get(key);
    if (request && pending(request.view) && request.device === device && request.view.dispatchAt === null)
      request.view = {...request.view, dispatchAt: now, deadline: now + REFRESH_WAIT_MS, status: 'waiting'};
    // The floor is at most the longest gap: the promise never outlives the measurement.
    const nextInMs = Math.max(Math.min(IDLE_CAP_MS, 2 * interval), floor);
    return {measure: true, onDuty: true, askInMs: ASK_EVERY_MS, nextInMs: Math.round(nextInMs)};
  }

  /** When `device` should measure next. */
  private plan(pace: Pace, key: string, device: string, now: number, signals: Signals, floor: number): {at: number; why: Why | 'first'; interval: number} {
    if (pace.lastAt === null && pace.askedAt === null) return {at: now, why: 'first', interval: BASE_INTERVAL_MS};
    let {interval, why} = this.interval(pace, now, signals, floor);
    let at: number;
    if (pace.askedAt !== null && !pace.answered) {
      at = retryAt(pace, floor);
    } else {
      at = (pace.lastAt ?? pace.askedAt!) + interval;
      if (pace.lastAt !== null) {
        const lastAt = pace.lastAt;
        const reset = Math.min(...signals.windows.flatMap(w => (w.resetAt !== null && w.resetAt > lastAt ? [w.resetAt] : [])));
        const afterReset = Math.max(reset + RESET_GRACE_MS, lastAt + floor);
        if (afterReset < at) {
          at = afterReset;
          why = 'reset';
        }
        // A measurement taken without asking, or promised sooner when the pace was quicker, is not left to go stale.
        if (pace.promiseAt !== null && pace.promiseAt < at) at = pace.promiseAt;
      }
    }
    const request = this.requests.get(key);
    if (request && pending(request.view) && request.device === device && request.view.dispatchAt === null && request.view.deadline > now)
      at = Math.min(at, request.view.notBefore);
    at = Math.max(at, this.notBefore(pace, floor, -Infinity));
    const paused = this.pausedUntil(key, device, now);
    if (paused !== null) at = Math.max(at, paused);
    return {at, why, interval};
  }

  /** The interval the signals call for, never below the device's own least one. */
  private interval(pace: Pace, now: number, signals: Signals, floor: number): {interval: number; why: Why} {
    const low = lowWindows(signals, now).length > 0;
    let interval: number;
    let why: Why;
    if (low) [interval, why] = [lowInterval(now - pace.busyAt), 'low'];
    else if (signals.inUse) [interval, why] = [BASE_INTERVAL_MS, 'inUse'];
    else [interval, why] = [Math.min(BASE_INTERVAL_MS * pace.stretch, IDLE_CAP_MS), pace.changed ? 'changed' : 'idle'];
    return {interval: Math.max(interval, floor), why};
  }

  /** A measurement or a failure came from the device last told to measure: its question is answered. */
  private answeredBy(pace: Pace, device: string, at: number) {
    if (device !== pace.askedDevice || pace.askedAt === null || at < pace.askedAt - CLOCK_TOLERANCE_MS) return;
    pace.answered = true;
    pace.unanswered = 0;
  }

  private pace(key: string, now: number): Pace {
    let pace = this.paces.get(key);
    if (!pace) {
      pace = {
        stretch: 1,
        signature: null,
        changed: false,
        lastAt: null,
        promiseAt: null,
        busyAt: now,
        askedDevice: null,
        askedAt: null,
        answered: false,
        unanswered: 0,
        minIntervalMs: null,
        askAt: null,
      };
      this.paces.set(key, pace);
    }
    return pace;
  }
}

const pauseKey = (key: string, device: string) => `${key}\n${device}`;

/**
 * Nothing came back for the last `measure: true`: ask again, later each time it stays unanswered.
 * Never more often than the device agrees to, though.
 */
const retryAt = (pace: Pace, floor: number) => pace.askedAt! + Math.max(UNANSWERED_MS[Math.min(pace.unanswered, UNANSWERED_MS.length - 1)], floor);

/** The windows with little left and not reset yet: while there are any, the subscription is measured more often. */
const lowWindows = (signals: Signals, now: number) =>
  signals.windows.filter(w => w.remaining > 0 && w.remaining <= LOW_LEFT && (w.resetAt === null || w.resetAt > now));

/** When the interval the signals call for changes with time alone: a low window resets, or the quiet of a low one passes an hour or three. */
function intervalChanges(pace: Pace, now: number, signals: Signals): number[] {
  const low = lowWindows(signals, now);
  if (!low.length) return [];
  const resets = low.flatMap(w => (w.resetAt === null ? [] : [w.resetAt]));
  return [...resets, pace.busyAt + 3_600_000, pace.busyAt + 3 * 3_600_000].filter(at => at > now);
}

/** How soon to ask again: a whole number of milliseconds, never later than a regular ask. */
const askIn = (ms: number) => Math.ceil(Math.min(ms, ASK_EVERY_MS));

/** The least interval a device accepts: its own if it set one, never below a minute nor past the longest gap. */
const floorOf = (minIntervalMs: number | null) => Math.min(Math.max(MIN_INTERVAL_MS, minIntervalMs ?? 0), MAX_GAP_MS);
