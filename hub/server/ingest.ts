import type {Attention} from './attention.js';
import {secretKind} from './domain/auth.js';
import {CLOCK_TOLERANCE_MS, Invalid, parseBatch, parseCheckin, parseSessions, subscriptionKey, toMeasurement, type AgentSender} from './domain/ingest.js';
import {Forecasts} from './forecasts.js';
import {Sessions} from './sessions.js';
import {ACTIVE_WITHIN_MS, type Cadence, type Signals, type Why} from './cadence.js';
import type {Duty} from './duty.js';
import {providers, type Provider} from './domain/sources.js';
import type {Device, Directory, Token} from './store/directory.js';
import type {Store} from './store/store.js';
import {tell, type Touches} from './touches.js';

export type IngestResult = {accepted: number; duplicates: number; failures: number; device: {id: string}};

/** What a device is told of each subscription; a device following the hub's pace also learns whether it is on duty and when to ask again. */
export type CheckinResult = {
  subscriptions: {provider: Provider; measure: boolean; until: string; onDuty?: boolean; askInMs?: number; nextInMs?: number}[];
};

/** Who is delivering: a device with its own token, or a machine with its person's machine token. */
export type Credential = {kind: 'device'; device: Device} | {kind: 'token'; token: Token};

/** Why a known agent is refused: its device or token was disconnected, or the machine is connected with a code already. */
export class IngestError extends Error {
  constructor(readonly code: 'device_revoked' | 'device_conflict') {
    super(code);
  }
}

/**
 * Measurements pushed by agents (ingest format v1). A batch is parsed whole, then
 * stored in one transaction. Every batch comes from one device of one person; its
 * snapshots are filed under subscriptions kept once on the hub, so one account measured
 * by many devices, of one person or several, is one source, held by each of them.
 */
export class Ingest {
  /** The coding agents running on the devices right now. */
  readonly live: Sessions;
  /** Where the recent pace of each weekly window leads, one forecast per window for every board and /api/overview. */
  readonly forecasts: Forecasts;
  private observer: Touches | null = null;
  attention: Attention | null = null;

  constructor(
    private readonly store: Store,
    private readonly directory: Directory,
    private readonly duty: Duty,
    private readonly cadence: Cadence,
  ) {
    this.live = new Sessions(store);
    this.forecasts = new Forecasts(store);
  }

  /** Tells `observer` which sources every delivery, check-in and list of agents touches (events of open dashboards). */
  setObserver(observer: Touches) {
    this.observer = observer;
  }

  /** The credential of an `Authorization` header; 'revoked' for a disconnected device or a revoked token. */
  authenticate(header: string | undefined): Credential | 'revoked' | null {
    const secret = /^Bearer (\S+)$/i.exec(header ?? '')?.[1];
    if (!secret) return null;
    switch (secretKind(secret)) {
      case 'qt_d': {
        const found = this.directory.deviceBySecret(secret);
        if (!found) return null;
        return found.revoked ? 'revoked' : {kind: 'device', device: found};
      }
      case 'qt_m': {
        const found = this.directory.tokenBySecret(secret);
        if (!found) return null;
        return found.revoked ? 'revoked' : {kind: 'token', token: found};
      }
      default:
        return null;
    }
  }

  accept(credential: Credential, body: unknown, now = Date.now()): IngestResult {
    const batch = parseBatch(body);
    // An agent whose clock is off: its times are moved by the difference, measured at sending.
    const skew = Math.abs(now - batch.sentAt) > CLOCK_TOLERANCE_MS ? now - batch.sentAt : 0;
    // A measurement from the future would hide every real one after it as a duplicate.
    const future = [...batch.snapshots, ...batch.failures].find(item => item.observedAt + skew > now + CLOCK_TOLERANCE_MS);
    if (future) throw new Invalid('observedAt');

    const attention = this.attention?.begin();
    const accepted = this.directory.transaction(() => {
      const device = this.device(credential, batch, now);
      const result: IngestResult = {accepted: 0, duplicates: 0, failures: 0, device: {id: device.id}};
      // Every source the batch is about: its pace and its holder's duty move even when nothing new is recorded.
      const touched = new Set<string>();

      for (const snapshot of [...batch.snapshots].sort((a, b) => a.observedAt - b.observedAt)) {
        const observedAt = snapshot.observedAt + skew;
        const account = subscriptionKey(snapshot, device.userId);
        const source = this.store.source(snapshot.provider, account, now);
        touched.add(source);
        this.store.hold(source, device.userId, now);
        this.store.seenDevice(device.id, snapshot.provider, source, now);
        const {successAt} = this.store.state(source);
        // Resent after a lost answer, or already delivered by another device of the same account.
        if (successAt !== null && observedAt <= successAt) {
          result.duplicates++;
          continue;
        }
        this.cadence.settleRefresh(account, this.refreshDuty(account), now);
        this.cadence.refreshResult(account, device.id, observedAt, true, now);
        const measurement = {...toMeasurement(snapshot), observedAt};
        attention?.record(this.store.state(source), measurement, now);
        this.store.record(source, measurement);
        result.accepted++;
        this.duty.delivered(account, device.id, observedAt, snapshot.staleAfterMs, now);
        // A delivery can hand duty to its device: the request of the one before ends now, not when next read.
        this.cadence.settleRefresh(account, this.refreshDuty(account), now);
        this.cadence.delivered(account, device.id, snapshot.windows, observedAt, snapshot.staleAfterMs, this.signals(source, account, now).inUse, now);
      }

      for (const failure of batch.failures) {
        const at = failure.observedAt + skew;
        const source = this.store.deviceSource(device.id, failure.provider);
        // The device waits out its failures, whether or not another device measures the subscription fine.
        const key = this.cadence.measuredBy(device.id, failure.provider) ?? (source && this.store.account(source));
        if (key) {
          this.cadence.settleRefresh(key, this.refreshDuty(key), now);
          if (this.cadence.failed(key, device.id, failure.error, at)) {
            this.duty.failed(key, device.id, at);
            if (this.duty.holder(key) === device.id) this.duty.schedule(key, null);
            this.cadence.refreshResult(key, device.id, at, false, now);
          }
          this.cadence.settleRefresh(key, this.refreshDuty(key), now);
        }
        const paused = key && this.store.findSource(failure.provider, key);
        if (paused) touched.add(paused);
        if (source) touched.add(source);
        this.store.deviceFailed(device.id, failure.provider, failure.error, failure.detail, at);
        if (!source) continue;
        const state = this.store.state(source);
        // Another device may measure the same account fine; only a source gone quiet shows the problem.
        if (state.successAt !== null && state.staleAfterMs !== null && at - state.successAt <= state.staleAfterMs) continue;
        this.store.fail(source, failure.error);
        result.failures++;
      }
      // Heard from, the device is not silent: nor are the subscriptions it holds, those its
      // measurements just handed it included, and delivers nothing for now.
      const held = this.cadence.keysOf([device.id]).filter(key => this.duty.holder(key) === device.id);
      for (const key of held) this.cadence.settleRefresh(key, this.refreshDuty(key), now);
      this.cadence.heard(device.id, held, now);
      for (const source of held.flatMap(key => providers.flatMap(provider => this.store.findSource(provider, key) ?? []))) touched.add(source);
      // Waiting protection uses the whole batch's accepted data and bounded evidence of contact.
      for (const source of touched) this.protect(source, this.store.account(source)!, now);
      tell(this.observer, o => o.touchSources([...touched]));
      return result;
    });
    attention?.committed();
    return accepted;
  }

  /**
   * Tells a device which of its subscriptions to measure now and when to ask again for the
   * rest. A device following the hub's pace measures a subscription it is on duty for only
   * when its pace says so, and does not take duty while it waits out its failures.
   */
  checkin(credential: Credential, body: unknown, now = Date.now()): CheckinResult {
    const request = parseCheckin(body);
    const device = this.device(credential, request, now);
    const iso = (ms: number) => new Date(ms).toISOString();
    // Asking moves the pace and who is on duty, which the board shows.
    tell(this.observer, o => o.touchSources(request.subscriptions.flatMap(s => this.store.findSource(s.provider, subscriptionKey(s, device.userId)) ?? [])));
    return {
      subscriptions: request.subscriptions.map(s => {
        const key = subscriptionKey(s, device.userId);
        const source = this.store.findSource(s.provider, key);
        this.restoreFixed(source, key, now);
        this.cadence.settleRefresh(key, this.refreshDuty(key), now);
        this.cadence.capability(key, device.id, request.paced, s.minIntervalMs, now);
        this.protect(source, key, now);
        this.cadence.settleRefresh(key, this.refreshDuty(key), now);
        if (!request.paced) {
          const directive = this.duty.claim(key, device.id, s.active, now);
          this.cadence.settleRefresh(key, this.refreshDuty(key), now);
          return {provider: s.provider, measure: directive.measure, until: iso(directive.until)};
        }
        const paused = this.cadence.pausedUntil(key, device.id, now);
        const holder = this.duty.holder(key);
        const leased = (this.duty.until(key) ?? 0) > now;
        if (paused !== null && !(holder === device.id && leased)) {
          // Another device measures it, or none does until this one's pause is over.
          const askInMs = Math.ceil(Math.min(paused - now, 10 * 60_000));
          return {provider: s.provider, measure: false, onDuty: !(holder !== null && holder !== device.id && leased), askInMs, until: iso(now + askInMs)};
        }
        const directive = this.duty.claim(key, device.id, s.active, now);
        this.cadence.settleRefresh(key, this.refreshDuty(key), now);
        if (!directive.measure) {
          return {provider: s.provider, measure: false, onDuty: false, askInMs: directive.until - now, until: iso(directive.until)};
        }
        const answer = this.cadence.answer(key, device.id, s.provider, now, s.minIntervalMs, this.signals(source, key, now));
        if (answer.measure) this.duty.asked(key, device.id, now);
        this.protect(source, key, now);
        return {provider: s.provider, ...answer, until: iso(now + answer.askInMs)};
      }),
    };
  }

  /**
   * When a subscription is measured next and why, while its holder follows the hub's pace
   * (null otherwise), and the first moment that may change with nothing new told to the
   * hub: the pace's own (Cadence.viewChangesAt), or the subscription no longer in use.
   */
  nextMeasurement(source: string, key: string, now: number): {value: {next: number; why: Why} | null; changesAt: number | null} {
    const holder = this.duty.holder(key);
    const until = this.duty.until(key);
    if (holder === null || until === null || until <= now || !this.directory.deviceLive(holder)) return {value: null, changesAt: null};
    const signals = this.signals(source, key, now);
    const value = this.cadence.view(key, holder, now, signals);
    const boundary = this.cadence.viewChangesAt(key, holder, now, signals);
    const own = value === null ? boundary : Math.min(boundary ?? Infinity, until);
    if (value === null || !signals.inUse) return {value, changesAt: own};
    const activeAt = this.duty.activeAt(key);
    const ends = [
      own,
      this.live.workingChangesAt(source, now),
      activeAt !== null && activeAt + ACTIVE_WITHIN_MS >= now ? activeAt + ACTIVE_WITHIN_MS + 1 : null,
    ].filter((at): at is number => at !== null);
    return {value, changesAt: ends.length ? Math.min(...ends) : null};
  }

  private refreshDuty(key: string) {
    const holder = this.duty.holder(key);
    return {holder, until: this.duty.until(key), live: holder !== null && this.directory.deviceLive(holder)};
  }

  refresh(source: string, now: number) {
    const key = this.store.account(source)!;
    return this.cadence.refresh(key, this.refreshDuty(key), now);
  }

  requestRefresh(source: string, now: number) {
    const key = this.store.account(source)!;
    const result = this.cadence.requestRefresh(key, this.refreshDuty(key), this.store.state(source).successAt, now);
    tell(this.observer, o => o.touchSources([source]));
    return result;
  }

  /** Frequency writes update duty synchronously before any reader or competing check-in can see them. */
  frequencyChanged(source: string, now: number) {
    const key = this.store.account(source)!;
    this.restoreFixed(source, key, now);
    this.protect(source, key, now);
    tell(this.observer, o => o.touchSources([source]));
  }

  private protect(source: string | null, key: string, now: number) {
    const holder = this.duty.holder(key);
    if (holder === null) return;
    const plan = this.directory.deviceLive(holder) ? this.cadence.waitingLease(key, holder, now, this.signals(source, key, now)) : null;
    this.duty.schedule(key, plan == null ? plan : plan.until, plan?.extend);
  }

  private restoreFixed(source: string | null, key: string, now: number) {
    if (source === null || this.store.measureInterval(source) === null) return;
    const state = this.store.state(source);
    if (state.successAt !== null && state.staleAfterMs !== null) this.cadence.restore(key, state.successAt, state.staleAfterMs, state.windows, now);
  }

  /** What the hub knows of a subscription now: its windows, and whether it is in use on any machine. */
  private signals(source: string | null, key: string, now: number): Signals {
    const activeAt = this.duty.activeAt(key);
    return {
      windows: source ? this.store.state(source).windows : [],
      measureIntervalMs: source ? this.store.measureInterval(source) : null,
      inUse: (source !== null && this.live.working(source, now)) || (activeAt !== null && now - activeAt <= ACTIVE_WITHIN_MS),
    };
  }

  /** Devices taken off the hub: their agents stop showing at once. */
  forget(devices: string[], now = Date.now()) {
    for (const key of this.cadence.keysOf(devices)) this.cadence.settleRefresh(key, this.refreshDuty(key), now);
    const keys = this.cadence.forget(devices, now);
    const sources = [
      ...devices.flatMap(device => [...this.live.sourcesOf(device), ...providers.flatMap(provider => this.store.deviceSource(device, provider) ?? [])]),
      ...keys.flatMap(key => providers.flatMap(provider => this.store.findSource(provider, key) ?? [])),
    ];
    this.live.forget(devices);
    tell(this.observer, o => o.touchSources([...new Set(sources)]));
  }

  /**
   * Which coding agents run on a device now. A session is filed under the subscription
   * it names, else under the one this device last delivered for its provider; one the
   * hub does not know, or its person does not hold, is left out.
   */
  sessions(credential: Credential, body: unknown, now = Date.now()): {accepted: number} {
    const report = parseSessions(body);
    const skew = Math.abs(now - report.sentAt) > CLOCK_TOLERANCE_MS ? now - report.sentAt : 0;
    return this.directory.transaction(() => {
      const device = this.device(credential, report, now);
      const name = device.label ?? device.name;
      const sessions = report.sessions.flatMap(({provider, account, accountName, ...session}) => {
        const source =
          account || accountName
            ? this.store.findSource(provider, subscriptionKey({provider, account, accountName}, device.userId))
            : this.store.deviceSource(device.id, provider);
        // Only a subscription the device's person holds: naming someone else's account shows nothing on it.
        if (!source || !this.store.holds(device.userId, source)) return [];
        const startedAt = Math.min(now, session.startedAt + skew);
        const lastWorkedAt = session.lastWorkedAt === null ? null : Math.max(startedAt, Math.min(now, session.lastWorkedAt + skew));
        return [{...session, startedAt, sentStartedAt: session.startedAt, lastWorkedAt, source, device: {id: device.id, name}}];
      });
      const before = this.live.sourcesOf(device.id);
      this.live.report(device.id, device.userId, sessions, now);
      tell(this.observer, o => o.touchSources([...new Set([...before, ...sessions.map(s => s.source)])]));
      return {accepted: sessions.length};
    });
  }

  /**
   * The device a request comes from. A device token names it; with a machine token the
   * machine joins its person on first contact. A machine disconnected by hand cannot
   * come back with the token it had, but a new token (after rotating a leaked one)
   * takes it back.
   */
  private device(credential: Credential, sender: AgentSender, now: number): Device {
    if (credential.kind === 'device') {
      this.directory.touchDevice(credential.device.id, sender.machine, sender.agent, now);
      return credential.device;
    }
    const {token} = credential;
    const existing = this.directory.deviceByMachine(token.userId, sender.machine.id);
    // A machine connected with a code keeps its own token; a machine token cannot take it over.
    if (existing?.byCode && !existing.revoked) throw new IngestError('device_conflict');
    if (existing?.revoked && existing.tokenId === token.id) throw new IngestError('device_revoked');
    this.directory.touchToken(token.id, now);
    return this.directory.saveDevice({userId: token.userId, machine: sender.machine, agent: sender.agent, tokenId: token.id}, now);
  }
}
