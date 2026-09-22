import {config} from './config.js';
import {hash, type Source} from './domain/sources.js';
import {COLLECTION_ERRORS, normalize} from './domain/normalize.js';
import {LocalIdentity} from './identity/local.js';
import type {VendorClient} from './sources/vendor.js';
import type {Guard, Store} from './store/store.js';

export type CollectorStatus = {collecting: boolean; nextAt: number; cycle: number; intervalMs: number};

/**
 * The single scheduled collector: one non-overlapping cycle every two minutes, all
 * sources read concurrently inside it, exponential backoff after fully failed cycles.
 * Browsers never trigger provider reads; collection continues with no tab open.
 */
export class Collector {
  private collecting = false;
  private closing = false;
  private cycle = 0;
  private failures = 0;
  private nextAt = Date.now();
  private timer?: NodeJS.Timeout;
  private abort?: AbortController;

  constructor(
    private readonly store: Store,
    private readonly vendor: VendorClient,
    private readonly identity = new LocalIdentity(),
    private readonly log: (event: object) => void = event => console.log(JSON.stringify(event)),
  ) {}

  status(): CollectorStatus {
    return {collecting: this.collecting, nextAt: this.nextAt, cycle: this.cycle, intervalMs: config.collection.intervalMs};
  }

  start() {
    void this.run();
  }

  async stop() {
    this.closing = true;
    clearTimeout(this.timer);
    this.abort?.abort();
    for (let i = 0; this.collecting && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 50));
  }

  private async run() {
    if (this.collecting || this.closing) return;
    this.collecting = true;
    this.cycle++;
    const started = Date.now();
    this.abort = new AbortController();
    const timeout = setTimeout(() => this.abort?.abort(), config.collection.timeoutMs);

    const results = await Promise.all(this.store.sources().map(source => this.collectOne(source, started)));
    const successes = results.filter(Boolean).length;

    clearTimeout(timeout);
    this.collecting = false;
    this.failures = successes ? 0 : this.failures + 1;
    const delay = config.collection.intervalMs * Math.min(config.collection.maxBackoff, 2 ** Math.max(0, this.failures - 1));
    this.nextAt = Math.max(started + delay, Date.now() + 1000);
    this.store.prune(Date.now());
    this.log({event: 'collection', cycle: this.cycle, successes, durationMs: Date.now() - started, nextAt: this.nextAt});
    if (!this.closing) this.timer = setTimeout(() => void this.run(), this.nextAt - Date.now());
  }

  private async collectOne(source: Source, startedAt: number): Promise<boolean> {
    this.store.register(source, startedAt);
    const {provider} = source;
    const before = this.identity.credentialSignature(provider);
    const beforeAccount = await this.identity.googleAccount(provider);
    try {
      const payload = await this.vendor.usage(provider, this.abort?.signal);
      const at = Date.now();
      const measurement = normalize(provider, payload, at);
      const guard = await this.guardFor(source, measurement.identity, measurement.plan, before, beforeAccount);
      return this.store.record(source.id, measurement, at, guard);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reason = (COLLECTION_ERRORS as readonly string[]).includes(message) ? message : 'source_unavailable';
      this.store.fail(source.id, reason, Date.now());
      return false;
    }
  }

  /**
   * Identity for providers whose payload has no account id. A rotation of the same
   * account is not an account change; an ambiguous change opens a fresh segment.
   */
  private async guardFor(
    source: Source,
    identity: string | null,
    plan: string,
    before: string | null,
    beforeAccount: string | null,
  ): Promise<Guard> {
    const after = this.identity.credentialSignature(source.provider);
    let guard = this.store.scope(source.id, identity, after);
    if (identity) return guard;

    const profile = this.identity.profileAccount(source.provider);
    if (profile) guard = {scope: `${profile}:${hash(plan)}:${guard.scope}`, confidence: 'local-profile'};

    const afterAccount = await this.identity.googleAccount(source.provider);
    if (beforeAccount && beforeAccount === afterAccount) {
      return {scope: `${beforeAccount}:${hash(plan)}`, confidence: 'local-id-token'};
    }
    if (before !== after || beforeAccount !== afterAccount) {
      return {scope: crypto.randomUUID(), confidence: 'unknown'};
    }
    return guard;
  }
}
