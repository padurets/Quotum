import {createHash, timingSafeEqual} from 'node:crypto';
import {config} from './config.js';
import type {CollectorStatus} from './collector.js';
import {accountKey, parseBatch, toMeasurement} from './domain/ingest.js';
import {staleAfter} from './domain/quota.js';
import type {Store} from './store/store.js';

export type IngestResult = {accepted: number; duplicates: number; failures: number};

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Measurements pushed by agents (ingest format v1). A batch is parsed whole before
 * anything is stored; tokens are compared in constant time.
 */
export class Ingest {
  private readonly tokens: Buffer[];
  private batches = 0;
  private lastAt = 0;

  /** `useDefaults`: the first account of a provider takes its default source (no collector writes there). */
  constructor(
    private readonly store: Store,
    tokens: readonly string[],
    private readonly useDefaults: boolean,
  ) {
    this.tokens = tokens.map(digest);
  }

  authorized(header: string | undefined): boolean {
    const match = /^Bearer (\S+)$/.exec(header ?? '');
    if (!match) return false;
    const given = digest(match[1]);
    return this.tokens.some(token => timingSafeEqual(token, given));
  }

  accept(body: unknown, now = Date.now()): IngestResult {
    const batch = parseBatch(body);
    const result: IngestResult = {accepted: 0, duplicates: 0, failures: 0};

    for (const snapshot of [...batch.snapshots].sort((a, b) => a.observedAt - b.observedAt)) {
      const account = accountKey(snapshot, batch.machine.id);
      const source = this.store.agentSource(snapshot.provider, account, this.useDefaults, now);
      this.store.seenMachine(batch.machine, batch.agent, snapshot.provider, source, now);
      const state = this.store.state(source);
      // Resent after a lost answer, or already delivered by another machine of the same account.
      const known = state.scope === account && state.successAt !== null && snapshot.observedAt <= state.successAt;
      if (known || snapshot.observedAt > now + 60_000) {
        result.duplicates++;
        continue;
      }
      const confidence = snapshot.account ? 'provider' : 'agent-machine';
      if (this.store.record(source, toMeasurement(snapshot), snapshot.observedAt, {scope: account, confidence})) result.accepted++;
    }

    for (const failure of batch.failures) {
      const source = this.store.machineSource(batch.machine.id, failure.provider);
      if (!source) continue;
      const state = this.store.state(source);
      // Another machine may measure the same account fine; only a source gone quiet shows the problem.
      if (state.successAt !== null && failure.observedAt - state.successAt <= staleAfter(state)) continue;
      this.store.fail(source, `agent_${failure.error}`, failure.observedAt);
      result.failures++;
    }

    this.batches++;
    this.lastAt = now;
    return result;
  }

  status(now = Date.now()): CollectorStatus {
    const intervalMs = config.ingest.intervalMs;
    return {collecting: false, cycle: this.batches, intervalMs, nextAt: (this.lastAt || now) + intervalMs};
  }
}
