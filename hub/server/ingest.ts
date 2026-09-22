import {createHash, timingSafeEqual} from 'node:crypto';
import {config} from './config.js';
import type {CollectorStatus} from './collector.js';
import {secretKind} from './domain/auth.js';
import {parseBatch, subscriptionKey, toMeasurement, type AgentBatch} from './domain/ingest.js';
import {staleAfter} from './domain/quota.js';
import {DEFAULT_BOARD} from './domain/sources.js';
import type {Device, Directory, Token} from './store/directory.js';
import type {Store} from './store/store.js';

export type IngestResult = {accepted: number; duplicates: number; failures: number; device: {id: string; owner: string}};

/** Who is delivering: a device with its own token, a board token, or a static token of the default board. */
export type Credential = {kind: 'device'; device: Device} | {kind: 'board'; token: Token} | {kind: 'static'};

export class IngestError extends Error {
  constructor(readonly code: 'device_revoked') {
    super(code);
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Measurements pushed by agents (ingest format v1). A batch is parsed whole before
 * anything is stored. Every batch comes from one device of one board; its snapshots
 * are filed under the board's subscriptions, so one account measured by many devices
 * is one source.
 */
export class Ingest {
  private readonly statics: Buffer[];
  private batches = 0;
  private lastAt = 0;

  /** `useDefaults`: the first account of a provider on the default board takes its default source. */
  constructor(
    private readonly store: Store,
    private readonly directory: Directory,
    staticTokens: readonly string[],
    private readonly useDefaults: boolean,
  ) {
    this.statics = staticTokens.map(digest);
  }

  authenticate(header: string | undefined): Credential | null {
    const secret = /^Bearer (\S+)$/.exec(header ?? '')?.[1];
    if (!secret) return null;
    if (secretKind(secret) === 'al_d') {
      const device = this.directory.deviceBySecret(secret);
      return device ? {kind: 'device', device} : null;
    }
    if (secretKind(secret) === 'al_b') {
      const token = this.directory.tokenBySecret(secret);
      return token ? {kind: 'board', token} : null;
    }
    const given = digest(secret);
    return this.statics.some(token => timingSafeEqual(token, given)) ? {kind: 'static'} : null;
  }

  accept(credential: Credential, body: unknown, now = Date.now()): IngestResult {
    const batch = parseBatch(body);
    const device = this.device(credential, batch, now);
    const ownerKey = device.ownerUserId ? `user:${device.ownerUserId}` : `owner:${device.owner.toLowerCase()}`;
    const result: IngestResult = {accepted: 0, duplicates: 0, failures: 0, device: {id: device.id, owner: device.owner}};

    for (const snapshot of [...batch.snapshots].sort((a, b) => a.observedAt - b.observedAt)) {
      const account = subscriptionKey(snapshot, ownerKey);
      const source = this.store.agentSource(device.boardId, snapshot.provider, account, this.useDefaults, now);
      this.store.seenDevice(device.id, snapshot.provider, source, now);
      const state = this.store.state(source);
      // Resent after a lost answer, or already delivered by another device of the same account.
      const known = state.scope === account && state.successAt !== null && snapshot.observedAt <= state.successAt;
      if (known || snapshot.observedAt > now + 60_000) {
        result.duplicates++;
        continue;
      }
      const confidence = snapshot.account ? 'provider' : 'agent-machine';
      if (this.store.record(source, toMeasurement(snapshot), snapshot.observedAt, {scope: account, confidence})) result.accepted++;
    }

    for (const failure of batch.failures) {
      const source = this.store.deviceSource(device.id, failure.provider);
      if (!source) continue;
      const state = this.store.state(source);
      // Another device may measure the same account fine; only a source gone quiet shows the problem.
      if (state.successAt !== null && failure.observedAt - state.successAt <= staleAfter(state)) continue;
      this.store.fail(source, `agent_${failure.error}`, failure.observedAt);
      result.failures++;
    }

    this.batches++;
    this.lastAt = now;
    return result;
  }

  /**
   * The device a batch comes from. A device token names it; with a board token the
   * machine joins the board on first contact, and its owner is the configured name, or
   * the e-mail a client reports (matched to a member), or whoever created the token.
   */
  private device(credential: Credential, batch: AgentBatch, now: number): Device {
    if (credential.kind === 'device') {
      this.directory.touchDevice(credential.device.id, batch.machine, batch.agent, now);
      return credential.device;
    }
    const board = credential.kind === 'board' ? credential.token.boardId : DEFAULT_BOARD;
    const existing = this.directory.deviceByMachine(board, batch.machine.id);
    if (existing?.revoked) throw new IngestError('device_revoked');
    if (credential.kind === 'board') this.directory.touchToken(credential.token.id, now);

    const members = this.directory.members(board);
    const claimed = batch.owner.name ?? batch.owner.email;
    const member = claimed ? members.find(m => m.email === claimed.toLowerCase()) : undefined;
    const fallback = credential.kind === 'board' ? this.directory.user(credential.token.createdBy) : (members[0] ?? null);
    const owner = member
      ? {owner: member.name, ownerUserId: member.id}
      : claimed
        ? {owner: claimed, ownerUserId: null}
        : fallback
          ? {owner: fallback.name, ownerUserId: fallback.id}
          : {owner: batch.machine.name, ownerUserId: null};
    const tokenId = credential.kind === 'board' ? credential.token.id : null;
    return this.directory.saveDevice({boardId: board, machine: batch.machine, agent: batch.agent, ...owner, tokenId}, now);
  }

  status(now = Date.now()): CollectorStatus {
    const intervalMs = config.ingest.intervalMs;
    return {collecting: false, cycle: this.batches, intervalMs, nextAt: (this.lastAt || now) + intervalMs};
  }
}
