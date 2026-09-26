import {secretKind} from './domain/auth.js';
import {Invalid, parseBatch, parseCheckin, parseSessions, subscriptionKey, toMeasurement, type AgentSender} from './domain/ingest.js';
import {Sessions} from './sessions.js';
import type {Duty} from './duty.js';
import type {Provider} from './domain/sources.js';
import type {Device, Directory, Token} from './store/directory.js';
import type {Store} from './store/store.js';

export type IngestResult = {accepted: number; duplicates: number; failures: number; device: {id: string}};

export type CheckinResult = {subscriptions: {provider: Provider; measure: boolean; until: string}[]};

/** Who is delivering: a device with its own token, or a machine with its person's machine token. */
export type Credential = {kind: 'device'; device: Device} | {kind: 'token'; token: Token};

/** Why a known agent is refused: its device or token was disconnected, or the machine is connected with a code already. */
export class IngestError extends Error {
  constructor(readonly code: 'device_revoked' | 'device_conflict') {
    super(code);
  }
}

/** Clocks within this of the hub's are taken as they are; beyond it, agent times are shifted. */
const CLOCK_TOLERANCE_MS = 30_000;

/**
 * Measurements pushed by agents (ingest format v1). A batch is parsed whole, then
 * stored in one transaction. Every batch comes from one device of one person; its
 * snapshots are filed under subscriptions kept once on the hub, so one account measured
 * by many devices, of one person or several, is one source, held by each of them.
 */
export class Ingest {
  /** The coding agents running on the devices right now. */
  readonly live: Sessions;

  constructor(
    private readonly store: Store,
    private readonly directory: Directory,
    private readonly duty: Duty,
  ) {
    this.live = new Sessions(store);
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

    return this.directory.transaction(() => {
      const device = this.device(credential, batch, now);
      const result: IngestResult = {accepted: 0, duplicates: 0, failures: 0, device: {id: device.id}};

      for (const snapshot of [...batch.snapshots].sort((a, b) => a.observedAt - b.observedAt)) {
        const observedAt = snapshot.observedAt + skew;
        const account = subscriptionKey(snapshot, device.userId);
        const source = this.store.source(snapshot.provider, account, now);
        this.store.hold(source, device.userId, now);
        this.store.seenDevice(device.id, snapshot.provider, source, now);
        const {successAt} = this.store.state(source);
        // Resent after a lost answer, or already delivered by another device of the same account.
        if (successAt !== null && observedAt <= successAt) {
          result.duplicates++;
          continue;
        }
        this.store.record(source, {...toMeasurement(snapshot), observedAt});
        result.accepted++;
        this.duty.delivered(account, device.id, observedAt, snapshot.staleAfterMs, now);
      }

      for (const failure of batch.failures) {
        const at = failure.observedAt + skew;
        this.store.deviceFailed(device.id, failure.provider, failure.error, failure.detail, at);
        const source = this.store.deviceSource(device.id, failure.provider);
        if (!source) continue;
        const state = this.store.state(source);
        // Another device may measure the same account fine; only a source gone quiet shows the problem.
        if (state.successAt !== null && state.staleAfterMs !== null && at - state.successAt <= state.staleAfterMs) continue;
        this.store.fail(source, failure.error);
        result.failures++;
      }
      return result;
    });
  }

  /** Tells a device which of its subscriptions to measure now and when to ask again for the rest. */
  checkin(credential: Credential, body: unknown, now = Date.now()): CheckinResult {
    const request = parseCheckin(body);
    const device = this.device(credential, request, now);
    return {
      subscriptions: request.subscriptions.map(s => {
        const directive = this.duty.claim(subscriptionKey(s, device.userId), device.id, s.active, now);
        return {provider: s.provider, measure: directive.measure, until: new Date(directive.until).toISOString()};
      }),
    };
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
        return [{...session, startedAt: Math.min(now, session.startedAt + skew), sentStartedAt: session.startedAt, source, device: {id: device.id, name}}];
      });
      this.live.report(device.id, device.userId, sessions, now);
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
