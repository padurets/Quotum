import {secretKind} from './domain/auth.js';
import {parseBatch, parseCheckin, subscriptionKey, toMeasurement, type AgentSender} from './domain/ingest.js';
import type {Duty} from './duty.js';
import type {Provider} from './domain/sources.js';
import type {Device, Directory, Token} from './store/directory.js';
import type {Store} from './store/store.js';

export type IngestResult = {accepted: number; duplicates: number; failures: number; device: {id: string; owner: string}};

export type CheckinResult = {subscriptions: {provider: Provider; measure: boolean; until: string}[]};

/** Who is delivering: a device with its own token, or a machine with a board token. */
export type Credential = {kind: 'device'; device: Device} | {kind: 'board'; token: Token};

/** Why a known agent is refused: its device was removed from the board, or the machine is connected with a code already. */
export class IngestError extends Error {
  constructor(readonly code: 'device_revoked' | 'device_conflict') {
    super(code);
  }
}

/** Clocks within this of the hub's are taken as they are; beyond it, agent times are shifted. */
const CLOCK_TOLERANCE_MS = 30_000;

/** Subscriptions a client does not identify are keyed by their owner. */
const ownerKeyOf = (device: Device) => (device.ownerUserId ? `user:${device.ownerUserId}` : `owner:${device.owner.toLowerCase()}`);

/**
 * Measurements pushed by agents (ingest format v1). A batch is parsed whole before
 * anything is stored. Every batch comes from one device of one board; its snapshots
 * are filed under the board's subscriptions, so one account measured by many devices
 * is one source.
 */
export class Ingest {
  constructor(
    private readonly store: Store,
    private readonly directory: Directory,
    private readonly duty: Duty,
  ) {}

  /** The credential of an `Authorization` header; 'revoked' for the token of a removed device. */
  authenticate(header: string | undefined): Credential | 'revoked' | null {
    const secret = /^Bearer (\S+)$/i.exec(header ?? '')?.[1];
    if (!secret) return null;
    switch (secretKind(secret)) {
      case 'qt_d': {
        const found = this.directory.deviceBySecret(secret);
        if (!found) return null;
        return found.revoked ? 'revoked' : {kind: 'device', device: found};
      }
      case 'qt_b': {
        const token = this.directory.tokenBySecret(secret);
        return token ? {kind: 'board', token} : null;
      }
      default:
        return null;
    }
  }

  accept(credential: Credential, body: unknown, now = Date.now()): IngestResult {
    const batch = parseBatch(body);
    const device = this.device(credential, batch, now);
    const ownerKey = ownerKeyOf(device);
    // An agent whose clock is off: its times are moved by the difference, measured at sending.
    const skew = Math.abs(now - batch.sentAt) > CLOCK_TOLERANCE_MS ? now - batch.sentAt : 0;
    const result: IngestResult = {accepted: 0, duplicates: 0, failures: 0, device: {id: device.id, owner: device.owner}};

    for (const snapshot of [...batch.snapshots].sort((a, b) => a.observedAt - b.observedAt)) {
      const observedAt = snapshot.observedAt + skew;
      const account = subscriptionKey(snapshot, ownerKey);
      const source = this.store.source(device.boardId, snapshot.provider, account, now);
      this.store.seenDevice(device.id, snapshot.provider, source, now);
      const {successAt} = this.store.state(source);
      // Resent after a lost answer, or already delivered by another device of the same account.
      if (successAt !== null && observedAt <= successAt) {
        result.duplicates++;
        continue;
      }
      this.store.record(source, {...toMeasurement(snapshot), observedAt});
      result.accepted++;
      this.duty.delivered(device.boardId, account, device.id, observedAt, snapshot.staleAfterMs, now);
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
  }

  /** Tells a device which of its subscriptions to measure now and when to ask again for the rest. */
  checkin(credential: Credential, body: unknown, now = Date.now()): CheckinResult {
    const request = parseCheckin(body);
    const device = this.device(credential, request, now);
    const ownerKey = ownerKeyOf(device);
    return {
      subscriptions: request.subscriptions.map(s => {
        const directive = this.duty.claim(device.boardId, subscriptionKey(s, ownerKey), device.id, s.active, now);
        return {provider: s.provider, measure: directive.measure, until: new Date(directive.until).toISOString()};
      }),
    };
  }

  /**
   * The device a request comes from. A device token names it; with a board token the
   * machine joins the board on first contact and belongs to the owner it declares (a
   * member when the name is a member's email), else to whoever created the token.
   */
  private device(credential: Credential, sender: AgentSender, now: number): Device {
    if (credential.kind === 'device') {
      this.directory.touchDevice(credential.device.id, sender.machine, sender.agent, now);
      return credential.device;
    }
    const {token} = credential;
    const existing = this.directory.deviceByMachine(token.boardId, sender.machine.id);
    if (existing?.revoked) throw new IngestError('device_revoked');
    // A machine connected with a code keeps its own token; a board token cannot take it over.
    if (existing?.byCode) throw new IngestError('device_conflict');
    this.directory.touchToken(token.id, now);

    const claimed = sender.owner.name;
    const member = claimed ? this.directory.members(token.boardId).find(m => m.email === claimed.toLowerCase()) : undefined;
    const creator = this.directory.user(token.createdBy);
    const owner = member
      ? {owner: member.name, ownerUserId: member.id}
      : claimed
        ? {owner: claimed, ownerUserId: null}
        : {owner: creator?.name ?? sender.machine.name, ownerUserId: creator?.id ?? null};
    return this.directory.saveDevice({boardId: token.boardId, machine: sender.machine, agent: sender.agent, ...owner, tokenId: token.id}, now);
  }
}
