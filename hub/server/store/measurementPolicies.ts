import type {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {clientProviders, type ClientProvider} from '../domain/providers.js';
import type {MeasurementPolicy, Participation, SourcePreference} from '../domain/measurementPolicy.js';
import {transaction} from '../touches.js';

export const RECEIPT_LIFETIME_MS = 7 * 86_400_000;
export class PolicyError extends Error {
  constructor(readonly code: 'measurement_conflict' | 'mutation_conflict' | 'mutation_capacity', readonly retryAfter?: number) {super(code);}
}

/** Durable intent and launch barriers share the ingest database and its commit boundary. */
export class MeasurementPolicies {
  readonly authority: string;
  constructor(private readonly db: DatabaseSync) {
    db.prepare("INSERT OR IGNORE INTO meta VALUES ('measurementAuthority', ?)").run(randomUUID());
    this.authority = String(db.prepare("SELECT value FROM meta WHERE key='measurementAuthority'").get()!.value);
  }

  device(device: string): MeasurementPolicy {
    const row = this.db.prepare('SELECT payload FROM device_measurement_policies WHERE device_id=?').get(device);
    return row ? JSON.parse(String(row.payload)) : {version: 1, authority: this.authority, revision: 0, enabled: true,
      collectors: Object.fromEntries(clientProviders.map(id => [id, {enabled: true, epoch: 0, requiresEpoch: false, changedAt: null}])) as MeasurementPolicy['collectors']};
  }

  preference(source: string): SourcePreference {
    const row = this.db.prepare('SELECT revision,device_id AS device FROM source_measurement_preferences WHERE source_id=?').get(source);
    return row ? {revision: Number(row.revision), device: row.device as string | null} : {revision: 0, device: null};
  }

  /** Guards run at the service boundary before replay; apply runs only for a new operation. */
  mutate<T>(writer: string, operation: string, payload: unknown, now: number, apply: () => T): {result: T; replayed: boolean} {
    return transaction(this.db, () => {
      const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const prior = this.db.prepare('SELECT hash,result FROM measurement_mutations WHERE writer=? AND operation=? AND created_at>?').get(writer, operation, now-RECEIPT_LIFETIME_MS);
      if (prior) {
        if (prior.hash !== hash) throw new PolicyError('mutation_conflict');
        return {result: JSON.parse(String(prior.result)) as T, replayed: true};
      }
      this.prune(now);
      const capacity = this.db.prepare('SELECT count(*) AS n,min(created_at) AS first FROM measurement_mutations WHERE writer=? AND created_at>?').get(writer, now-RECEIPT_LIFETIME_MS)!;
      if (Number(capacity.n) >= 1024) throw new PolicyError('mutation_capacity', Math.max(1, Math.ceil((Number(capacity.first)+RECEIPT_LIFETIME_MS-now)/1000)));
      const result = apply();
      this.db.prepare('INSERT OR REPLACE INTO measurement_mutations VALUES (?,?,?,?,?)').run(writer, operation, hash, JSON.stringify(result), now);
      return {result, replayed: false};
    });
  }

  saveDevice(device: string, revision: number, desired: Participation, now: number): {policy: MeasurementPolicy; changed: ClientProvider[]} {
    const policy = this.device(device);
    if (policy.revision !== revision) throw new PolicyError('measurement_conflict');
    const changed: ClientProvider[] = [];
    const edited = policy.enabled !== desired.enabled || clientProviders.some(id => policy.collectors[id].enabled !== desired.collectors[id]);
    if (!edited) return {policy, changed};
    for (const id of clientProviders) {
      const gate = policy.collectors[id];
      if ((policy.enabled && gate.enabled) !== (desired.enabled && desired.collectors[id])) {
        gate.epoch++; gate.requiresEpoch = true; gate.changedAt = now; changed.push(id);
      }
      gate.enabled = desired.collectors[id];
    }
    policy.enabled = desired.enabled;
    policy.revision++;
    this.db.prepare('INSERT INTO device_measurement_policies VALUES (?,?) ON CONFLICT(device_id) DO UPDATE SET payload=excluded.payload').run(device, JSON.stringify(policy));
    return {policy, changed};
  }

  savePreference(source: string, revision: number, device: string | null): SourcePreference {
    const prior = this.preference(source);
    if (prior.revision !== revision) throw new PolicyError('measurement_conflict');
    if (prior.device === device) return prior;
    const next = {revision: revision+1, device};
    this.db.prepare('INSERT INTO source_measurement_preferences VALUES (?,?,?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,device_id=excluded.device_id').run(source, next.revision, device);
    return next;
  }

  confirm(device: string, capable: boolean, revision: number | null, authority: string | null): {changed:boolean;capabilityChanged:boolean} {
    const policy = this.device(device);
    const ack = capable && authority === policy.authority && revision === policy.revision ? revision : null;
    const prior = this.db.prepare('SELECT capable,confirmed_revision FROM device_measurement_control WHERE device_id=?').get(device);
    if (prior && Number(prior.capable) === Number(capable) && prior.confirmed_revision === ack) return {changed:false,capabilityChanged:false};
    const capabilityChanged=Number(prior?.capable??0)!==Number(capable);
    this.db.prepare('INSERT INTO device_measurement_control VALUES (?,?,?) ON CONFLICT(device_id) DO UPDATE SET capable=excluded.capable,confirmed_revision=excluded.confirmed_revision').run(device, Number(capable), ack);
    return {changed:true,capabilityChanged};
  }

  control(device: string): {capable: boolean; confirmedRevision: number | null} {
    const row = this.db.prepare('SELECT capable,confirmed_revision AS revision FROM device_measurement_control WHERE device_id=?').get(device);
    return {capable: row?.capable === 1, confirmedRevision: row ? row.revision as number | null : null};
  }

  prune(now: number) {
    this.db.prepare('DELETE FROM measurement_mutations WHERE (writer,operation) IN (SELECT writer,operation FROM measurement_mutations WHERE created_at<=? ORDER BY created_at LIMIT 128)').run(now-RECEIPT_LIFETIME_MS);
  }
}
